//! The receiver against Rust-sealed packets: receipts, duplicates, conflicts and limits.

use std::net::{Ipv4Addr, SocketAddr};

use agent_maild::{start, Config, Mailer};
use mail_core::envelope::{Envelope, Message, Origin};
use mail_core::store::{now_ms, Store};
use mail_core::wire::{seal, verify_receipt};
use mail_core::Identity;
use serde_json::Value;
use tempfile::TempDir;

struct Fixture {
    _dir: TempDir,
    home: std::path::PathBuf,
    mailer: Mailer,
    bob: Identity,
    alice: Identity,
}

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("bob");
    std::fs::create_dir_all(&home).unwrap();
    let bob = Identity::generate("bob").unwrap();
    std::fs::write(
        home.join("identity.json"),
        serde_json::to_string_pretty(&bob).unwrap(),
    )
    .unwrap();
    let alice = Identity::generate("alice").unwrap();
    Store::open(&home)
        .unwrap()
        .trust(&alice.public(), None, None)
        .unwrap();
    let mailer = start(Config::receive_only(
        home.clone(),
        SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
    ))
    .await
    .unwrap();
    Fixture {
        _dir: dir,
        home,
        mailer,
        bob,
        alice,
    }
}

fn message(from: &Identity, to: &Identity, id: &str, text: &str) -> Message {
    Message {
        id: id.into(),
        conversation_id: "00000000-0000-4000-8000-0000000000aa".into(),
        sender: from.fingerprint().unwrap(),
        recipient: to.fingerprint().unwrap(),
        text: text.into(),
        created_at: now_ms(),
        origin: Origin {
            hostname: "pc1".into(),
            platform: "win32".into(),
            arch: "x64".into(),
            addresses: vec![],
        },
        agent: None,
        to_session: None,
        hop: None,
        auto_reply: None,
        in_reply_to: None,
        project: Some("demo".into()),
        checkout: None,
        intent: None,
        signature: String::new(),
    }
    .sign(from, Envelope::V1_2)
    .unwrap()
}

async fn post(port: u16, body: String) -> (u16, String) {
    let response = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/message"))
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .unwrap();
    (response.status().as_u16(), response.text().await.unwrap())
}

#[tokio::test]
async fn stores_and_receipts_then_handles_duplicates_and_conflicts() {
    let f = fixture().await;
    let id = "00000000-0000-4000-8000-000000000001";
    let sent = message(&f.alice, &f.bob, id, "hello bob");
    let packet =
        serde_json::to_string(&seal(&f.alice, &f.bob.public(), &sent, now_ms()).unwrap()).unwrap();

    let (status, body) = post(f.mailer.port, packet.clone()).await;
    assert_eq!(status, 200);
    verify_receipt(&f.bob.public(), serde_json::from_str(&body).unwrap(), &sent).unwrap();
    let inbox = Store::open(&f.home).unwrap().inbox(10).unwrap();
    assert_eq!(
        inbox,
        vec![sent.clone()],
        "stored exactly, project included"
    );

    let (status, body) = post(f.mailer.port, packet).await;
    assert_eq!(status, 200, "a repeated delivery gets another receipt");
    verify_receipt(&f.bob.public(), serde_json::from_str(&body).unwrap(), &sent).unwrap();

    let other = message(&f.alice, &f.bob, id, "different text, same id");
    let packet =
        serde_json::to_string(&seal(&f.alice, &f.bob.public(), &other, now_ms()).unwrap()).unwrap();
    assert_eq!(post(f.mailer.port, packet).await.0, 409);
    assert_eq!(Store::open(&f.home).unwrap().inbox(10).unwrap().len(), 1);
}

#[tokio::test]
async fn rejects_untrusted_malformed_and_oversized() {
    let f = fixture().await;
    let mallory = Identity::generate("mallory").unwrap();
    let forged = message(
        &mallory,
        &f.bob,
        "00000000-0000-4000-8000-000000000002",
        "hi",
    );
    let packet =
        serde_json::to_string(&seal(&mallory, &f.bob.public(), &forged, now_ms()).unwrap())
            .unwrap();
    assert_eq!(
        post(f.mailer.port, packet).await,
        (400, r#"{"error":"Message rejected"}"#.to_owned())
    );
    assert_eq!(post(f.mailer.port, "not json".into()).await.0, 400);
    assert_eq!(post(f.mailer.port, "x".repeat(220_001)).await.0, 413);
    assert!(Store::open(&f.home).unwrap().inbox(10).unwrap().is_empty());
}

#[tokio::test]
async fn capabilities_identity_and_unknown_routes() {
    let f = fixture().await;
    let base = format!("http://127.0.0.1:{}", f.mailer.port);
    let client = reqwest::Client::new();
    let caps: Value = client
        .get(format!("{base}/capabilities"))
        .send()
        .await
        .unwrap()
        .json_value()
        .await;
    assert_eq!(
        caps,
        serde_json::json!({ "envelope": ["agent-mail/1.1", "agent-mail/1.2", "agent-mail/1.3"] })
    );

    let nonce = uuid::Uuid::new_v4().to_string();
    let body = client
        .get(format!("{base}/identity?nonce={nonce}"))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let found =
        agent_maild::advert::parse_advert(&body, "127.0.0.1".parse().unwrap(), &nonce).unwrap();
    assert_eq!(found.fingerprint, f.bob.fingerprint().unwrap());
    assert_eq!(found.endpoint, base);

    assert_eq!(
        client
            .get(format!("{base}/identity?nonce=nope"))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(
        client
            .get(format!("{base}/message"))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        client
            .get(format!("{base}/"))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
}

trait JsonValue {
    async fn json_value(self) -> Value;
}

impl JsonValue for reqwest::Response {
    async fn json_value(self) -> Value {
        serde_json::from_str(&self.text().await.unwrap()).unwrap()
    }
}
