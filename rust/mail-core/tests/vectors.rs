//! Byte-level parity with the TypeScript peer, from `test/vectors/agent-mail-v1.json`
//! (written by `node test/gen-vectors.mjs --write`).

use std::path::PathBuf;

use mail_core::envelope::{Checkout, Envelope, Intent, Message, ENVELOPE_V1_2, ENVELOPE_V1_3};
use mail_core::wire::{receipt, seal, unseal, verify_receipt, Packet};
use mail_core::{fingerprint, Error, Identity, PublicIdentity};
use serde_json::{json, Value};

fn vectors() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/vectors/agent-mail-v1.json");
    serde_json::from_str(&std::fs::read_to_string(&path).expect("vector file"))
        .expect("vector JSON")
}

fn seed(value: &Value) -> [u8; 32] {
    hex::decode(value.as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap()
}

fn identity(vectors: &Value, name: &str) -> Identity {
    let v = &vectors["identities"][name];
    Identity::from_seeds(name, seed(&v["signing_seed"]), seed(&v["encryption_seed"]))
}

fn packet_timestamp(packet: &Value) -> u64 {
    let payload: Value = serde_json::from_str(packet["payload"].as_str().unwrap()).unwrap();
    payload["timestamp"].as_u64().unwrap()
}

#[test]
fn identities_match_node_pem_and_fingerprint() {
    let v = vectors();
    for name in ["alice", "bob"] {
        let id = identity(&v, name);
        let expected = &v["identities"][name];
        assert_eq!(
            id.signing_key,
            expected["signing_key"].as_str().unwrap(),
            "{name} signing PEM"
        );
        assert_eq!(
            id.encryption_key,
            expected["encryption_key"].as_str().unwrap(),
            "{name} encryption PEM"
        );
        assert_eq!(
            id.fingerprint().unwrap(),
            expected["fingerprint"].as_str().unwrap(),
            "{name} fingerprint"
        );
        id.check()
            .expect("private keys derive the stored public PEMs");
    }
}

#[test]
fn messages_sign_digest_receipt_and_unseal_like_typescript() {
    let v = vectors();
    let alice = identity(&v, "alice");
    let bob = identity(&v, "bob");
    let trusted = |fp: &str| (fp == alice.fingerprint().unwrap()).then(|| alice.public());
    for item in v["messages"].as_array().unwrap() {
        let label = item["label"].as_str().unwrap();
        let unsigned = Message::parse_unsigned(item["input"].clone(), Envelope::V1_1).unwrap();
        assert_eq!(
            unsigned.canonical_unsigned(),
            item["canonical"].as_str().unwrap(),
            "{label}: canonical"
        );

        // Ed25519 is deterministic, so the Rust signature must equal the TypeScript one exactly.
        let signed = unsigned.sign(&alice, Envelope::V1_1).unwrap();
        assert_eq!(
            signed.signature,
            item["signed"]["signature"].as_str().unwrap(),
            "{label}: signature"
        );
        assert_eq!(
            signed.json(),
            item["json"].as_str().unwrap(),
            "{label}: JSON.stringify order"
        );
        assert_eq!(
            signed.digest(),
            item["digest"].as_str().unwrap(),
            "{label}: digest"
        );

        let parsed = Message::parse_signed(item["signed"].clone(), Envelope::V1_1).unwrap();
        assert_eq!(parsed, signed, "{label}: parsing the TS message");
        assert!(
            parsed.verify(&alice.public()),
            "{label}: TS signature verifies"
        );

        let rust_receipt = receipt(&bob, &signed).unwrap();
        let ts_receipt: Packet = serde_json::from_value(item["receipt"].clone()).unwrap();
        assert_eq!(rust_receipt, ts_receipt, "{label}: receipt bytes");
        verify_receipt(&bob.public(), item["receipt"].clone(), &signed).unwrap();

        let now = packet_timestamp(&item["packet"]);
        let opened = unseal(&bob, item["packet"].clone(), trusted, Envelope::V1_1, now).unwrap();
        assert_eq!(opened, signed, "{label}: unsealed TS packet");
        let late = unseal(
            &bob,
            item["packet"].clone(),
            trusted,
            Envelope::V1_1,
            now + 300_001,
        );
        assert!(
            matches!(late, Err(Error::WrongRecipientOrExpired)),
            "{label}: expired packet refused"
        );
    }
}

#[test]
fn rejects_what_typescript_rejects() {
    let v = vectors();
    for item in v["invalid"].as_array().unwrap() {
        let label = item["label"].as_str().unwrap();
        assert!(
            Message::parse_signed(item["message"].clone(), Envelope::V1_1).is_err(),
            "{label} must be rejected"
        );
    }
    let mut with_null = v["messages"][0]["signed"].clone();
    with_null["agent"] = Value::Null;
    assert!(
        Message::parse_signed(with_null, Envelope::V1_1).is_err(),
        "null optional field"
    );
}

#[test]
fn project_needs_envelope_1_2() {
    let v = vectors();
    let unknown = v["invalid"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["label"] == "unknown-field")
        .unwrap();
    let parsed = Message::parse_signed(unknown["message"].clone(), Envelope::V1_2).unwrap();
    assert_eq!(parsed.project.as_deref(), Some("demo"));
    let mut bad = unknown["message"].clone();
    bad["project"] = json!("../etc");
    assert!(
        Message::parse_signed(bad, Envelope::V1_2).is_err(),
        "project is a key, not a path"
    );
    assert_eq!(ENVELOPE_V1_2, "agent-mail/1.2");
}

#[test]
fn rust_round_trip_and_tamper_checks() {
    let v = vectors();
    let alice = identity(&v, "alice");
    let bob = identity(&v, "bob");
    let alice_fp = alice.fingerprint().unwrap();
    let trusted = |fp: &str| (fp == alice_fp).then(|| alice.public());
    let mut unsigned =
        Message::parse_unsigned(v["messages"][0]["input"].clone(), Envelope::V1_1).unwrap();
    unsigned.project = Some("synthet-agent-mailbox".into());
    let signed = unsigned.clone().sign(&alice, Envelope::V1_2).unwrap();
    let now = 1_763_337_600_000;
    let packet = serde_json::to_value(seal(&alice, &bob.public(), &signed, now).unwrap()).unwrap();

    let opened = unseal(&bob, packet.clone(), trusted, Envelope::V1_2, now).unwrap();
    assert_eq!(opened.project.as_deref(), Some("synthet-agent-mailbox"));
    assert!(
        unseal(&bob, packet.clone(), trusted, Envelope::V1_1, now).is_err(),
        "a 1.1 receiver rejects project"
    );
    assert!(matches!(
        unseal(
            &bob,
            packet.clone(),
            |_: &str| None::<PublicIdentity>,
            Envelope::V1_2,
            now
        ),
        Err(Error::Untrusted)
    ));
    assert!(matches!(
        unseal(
            &alice,
            packet.clone(),
            |fp: &str| (fp == alice_fp).then(|| alice.public()),
            Envelope::V1_2,
            now
        ),
        Err(Error::WrongRecipientOrExpired)
    ));

    let mut tampered = packet.clone();
    let payload = tampered["payload"].as_str().unwrap().replacen(
        "\"ciphertext\":\"",
        "\"ciphertext\":\"A",
        1,
    );
    tampered["payload"] = json!(payload);
    assert!(
        matches!(
            unseal(&bob, tampered, trusted, Envelope::V1_2, now),
            Err(Error::Untrusted)
        ),
        "payload signature covers the ciphertext"
    );

    let mut downgraded = unsigned;
    assert!(downgraded.downgrade_to(Envelope::V1_1));
    assert!(downgraded.project.is_none());
    assert_eq!(
        fingerprint(&bob.public()).unwrap(),
        v["identities"]["bob"]["fingerprint"].as_str().unwrap()
    );
}

#[test]
fn generated_identity_is_consistent() {
    let carol = Identity::generate("carol").unwrap();
    carol.check().unwrap();
    assert!(Identity::generate("   ").is_err());
}

fn checkout() -> Checkout {
    Checkout {
        roots: vec!["a".repeat(40)],
        origin: Some("github.com/o/app".into()),
        head: Some("b".repeat(40)),
        branch: Some("feature/x".into()),
        name: Some("app".into()),
    }
}

#[test]
fn checkout_and_intent_need_envelope_1_3() {
    let v = vectors();
    let alice = identity(&v, "alice");
    let mut unsigned: Message = serde_json::from_value(v["messages"][0]["input"].clone()).unwrap();
    unsigned.checkout = Some(checkout());
    unsigned.intent = Some(Intent::Task);
    assert_eq!(unsigned.needs(), Envelope::V1_3);
    let signed = unsigned.clone().sign(&alice, Envelope::V1_3).unwrap();
    let json: Value = serde_json::from_str(&signed.json()).unwrap();
    assert_eq!(json["intent"], "task");
    assert_eq!(json["checkout"]["origin"], "github.com/o/app");
    assert_eq!(
        Message::parse_signed(json.clone(), Envelope::V1_3).unwrap(),
        signed
    );
    assert!(signed.verify(&alice.public()));
    assert!(
        Message::parse_signed(json, Envelope::V1_2).is_err(),
        "a 1.2 receiver rejects the new fields"
    );
    assert!(unsigned.clone().sign(&alice, Envelope::V1_2).is_err());
    assert_eq!(ENVELOPE_V1_3, "agent-mail/1.3");
    assert_eq!(
        Envelope::accepted_by(&["agent-mail/1.2".into(), "agent-mail/1.3".into()]),
        Envelope::V1_3
    );

    for vector in ["unknown-field-checkout", "unknown-field-intent"] {
        let item = v["invalid"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["label"] == vector)
            .unwrap_or_else(|| panic!("vector {vector}"));
        assert!(Message::parse_signed(item["message"].clone(), Envelope::V1_2).is_err());
        assert!(Message::parse_signed(item["message"].clone(), Envelope::V1_3).is_ok());
    }
}

#[test]
fn checkout_limits_are_enforced() {
    let v = vectors();
    let alice = identity(&v, "alice");
    let base: Message = serde_json::from_value(v["messages"][0]["input"].clone()).unwrap();
    let bad: [fn(&mut Checkout); 8] = [
        |c| c.roots = vec![],
        |c| c.roots = vec!["a".repeat(40); 5],
        |c| c.roots = vec!["A".repeat(40)],
        |c| c.origin = Some("github.com/O/app".into()),
        |c| c.origin = Some("https://github.com/o/app".into()),
        |c| c.head = Some("xyz".into()),
        |c| c.branch = Some("has space".into()),
        |c| c.name = Some("../etc".into()),
    ];
    for (i, spoil) in bad.iter().enumerate() {
        let mut message = base.clone();
        let mut c = checkout();
        spoil(&mut c);
        message.checkout = Some(c);
        assert!(message.sign(&alice, Envelope::V1_3).is_err(), "case {i}");
    }
}

#[test]
fn downgrade_drops_checkout_and_notify_but_never_a_task() {
    let v = vectors();
    let mut message: Message = serde_json::from_value(v["messages"][0]["input"].clone()).unwrap();
    message.checkout = Some(checkout());
    message.intent = Some(Intent::Notify);
    assert!(!message.clone().downgrade_to(Envelope::V1_3));
    let mut notify = message.clone();
    assert!(notify.downgrade_to(Envelope::V1_2));
    assert_eq!((notify.checkout, notify.intent), (None, None));
    let mut task = message;
    task.intent = Some(Intent::Task);
    assert!(task.downgrade_to(Envelope::V1_2));
    assert_eq!(
        task.intent,
        Some(Intent::Task),
        "a task stays a task; the outbox holds it"
    );
}
