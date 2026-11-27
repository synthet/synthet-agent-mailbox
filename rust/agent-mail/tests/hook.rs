//! T-10 (AC-20): the hooks, digest, watch and session commands against `mail.db`. Ported from
//! `test/hook-inject.test.mjs`, run through the real `agent-mail` binary the way a harness does.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use mail_core::envelope::{AgentMeta, Envelope, Message};
use mail_core::send::{local_origin, new_uuid};
use mail_core::store::{now_ms, Store};
use mail_core::Identity;
use serde_json::{json, Value};

const TAG: &str = "untrusted-remote-message";

struct Pc {
    _dir: tempfile::TempDir,
    home: PathBuf,
    me: Identity,
    them: Identity,
}

fn pc() -> Pc {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("me");
    std::fs::create_dir_all(&home).unwrap();
    let (me, them) = (
        Identity::generate("Alpha").unwrap(),
        Identity::generate("Beta").unwrap(),
    );
    std::fs::write(
        home.join("identity.json"),
        serde_json::to_string(&me).unwrap(),
    )
    .unwrap();
    Store::open(&home)
        .unwrap()
        .trust(&them.public(), None, None)
        .unwrap();
    Pc {
        _dir: dir,
        home,
        me,
        them,
    }
}

impl Pc {
    /// Stores a signed message from Beta in Alpha's inbox, as the mailer would.
    fn deliver(&self, text: &str) -> Message {
        let message = Message {
            id: new_uuid(),
            conversation_id: new_uuid(),
            sender: self.them.fingerprint().unwrap(),
            recipient: self.me.fingerprint().unwrap(),
            text: text.into(),
            created_at: now_ms(),
            origin: local_origin(),
            agent: Some(AgentMeta {
                session_id: Some("beta-s".into()),
                ..AgentMeta::default()
            }),
            to_session: None,
            hop: None,
            auto_reply: None,
            in_reply_to: None,
            project: None,
            checkout: None,
            intent: None,
            signature: String::new(),
        }
        .sign(&self.them, Envelope::V1_2)
        .unwrap();
        Store::open(&self.home).unwrap().receive(&message).unwrap();
        message
    }

    fn run(&self, args: &[&str], stdin: &str) -> Output {
        let mut child = Command::new(env!("CARGO_BIN_EXE_agent-mail"))
            .arg("--home")
            .arg(&self.home)
            .args(args)
            .env_remove("AGENT_MAIL_SESSION")
            .env_remove("CLAUDE_CODE_SESSION_ID")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(stdin.as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    }

    fn json(&self, args: &[&str], stdin: &str) -> Value {
        let out = self.run(args, stdin);
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).unwrap_or(Value::Null)
    }

    fn inject(&self, event: &str, input: Value) -> Option<Value> {
        let out = self.run(
            &["hook", "inject", "--event", event, "--harness", "claude"],
            &input.to_string(),
        );
        assert_eq!(
            out.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let stdout = String::from_utf8_lossy(&out.stdout);
        (!stdout.trim().is_empty()).then(|| serde_json::from_str(&stdout).unwrap())
    }
}

#[test]
fn user_prompt_submit_injects_unseen_mail_once_and_stop_blocks_once() {
    let pc = pc();
    pc.deliver("first");
    let prompt = pc
        .inject("UserPromptSubmit", json!({ "session_id": "s1" }))
        .unwrap();
    assert_eq!(
        prompt["hookSpecificOutput"]["hookEventName"],
        "UserPromptSubmit"
    );
    let context = prompt["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap();
    assert!(
        context.contains("first")
            && context.contains(&format!("<{TAG} from=\"Beta\" source=\"peer\"")),
        "{context}"
    );
    assert!(
        pc.inject("UserPromptSubmit", json!({ "session_id": "s1" }))
            .is_none(),
        "already shown"
    );
    pc.deliver("second");
    assert!(
        pc.inject(
            "Stop",
            json!({ "session_id": "s1", "stop_hook_active": true })
        )
        .is_none(),
        "no Stop loop"
    );
    let stop = pc.inject("Stop", json!({ "session_id": "s1" })).unwrap();
    assert_eq!(stop["decision"], "block");
    let reason = stop["reason"].as_str().unwrap();
    assert!(reason.contains("second") && !reason.contains("first"));
    assert!(
        pc.inject("Stop", json!({ "session_id": "s1" })).is_none(),
        "nothing new, nothing printed"
    );
    assert!(
        pc.inject("PostToolUse", json!({ "session_id": "s2" }))
            .is_none(),
        "unsupported events stay silent"
    );
    // Seen is not read: the inbox still lists both until ack.
    assert_eq!(pc.json(&["inbox"], "").as_array().unwrap().len(), 2);
}

#[test]
fn one_call_injects_at_most_five_messages_each_body_capped() {
    let pc = pc();
    for _ in 0..7 {
        pc.deliver(&"y".repeat(4005));
    }
    let first = pc
        .inject("SessionStart", json!({ "session_id": "s" }))
        .unwrap();
    let first = first["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(first.matches(&format!("<{TAG} ")).count(), 5);
    assert!(first.contains("truncated=\"true\""));
    let rest = pc
        .inject("UserPromptSubmit", json!({ "session_id": "s" }))
        .unwrap();
    let rest = rest["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap();
    assert_eq!(
        rest.matches(&format!("<{TAG} ")).count(),
        2,
        "the remainder arrives on the next call"
    );
}

#[test]
fn hook_inject_reads_stdin_and_exits_0_on_bad_input_or_an_unknown_verb() {
    let pc = pc();
    pc.deliver("via cli");
    let ok = pc.run(
        &["hook", "inject"],
        &json!({ "session_id": "cli-s", "hook_event_name": "UserPromptSubmit" }).to_string(),
    );
    assert_eq!(ok.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&ok.stdout).contains("via cli"));
    let bad = pc.run(&["hook", "inject", "--event", "Stop"], "{not json");
    assert_eq!(
        bad.status.code(),
        Some(0),
        "bad stdin never fails the session"
    );
    let wrong = pc.run(&["hook", "bogus"], "");
    assert_eq!(wrong.status.code(), Some(0));
    assert!(wrong.stdout.is_empty());
}

#[test]
fn same_pc_messages_are_injected_and_listed_in_the_unseen_digest() {
    let pc = pc();
    pc.json(&["register", "--session", "main"], "");
    let reviewer = pc.json(
        &["register", "--session", "rev", "--agent-name", "reviewer"],
        "",
    )["agent_id"]
        .as_str()
        .unwrap()
        .to_owned();
    pc.json(
        &[
            "publish",
            &reviewer,
            "--session",
            "main",
            "--text",
            "local note",
            "--subject",
            "hi",
        ],
        "",
    );
    let unseen = pc.json(&["digest", "--session", "rev", "--unseen", "--json"], "");
    let messages = unseen["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["source"], "journal");
    assert_eq!(messages[0]["body"], "local note");
    let key = messages[0]["key"].as_str().unwrap().to_owned();
    let metadata = pc.json(&["digest", "--session", "rev", "--unseen"], "");
    assert!(
        metadata["messages"][0].get("body").is_none(),
        "bodies only with --json"
    );
    assert_eq!(
        pc.json(&["digest", "--session", "rev", "--mark-seen", &key], "")["marked"],
        1
    );
    assert_eq!(
        pc.json(&["digest", "--session", "rev", "--unseen"], "")["messages"],
        json!([])
    );
    let plain = pc.json(&["digest", "--session", "rev"], "");
    assert_eq!(plain["messages"][0]["subject"], "hi");
    assert!(
        !plain.to_string().contains("local note"),
        "the plain digest has no body"
    );
}

#[test]
fn sessions_and_leases_from_the_cli() {
    let pc = pc();
    pc.json(&["register", "--session", "a", "--workspace", "D:/w"], "");
    pc.json(&["register", "--session", "b", "--agent-name", "other"], "");
    assert_eq!(
        pc.json(
            &["lease", "claim", "--conversation", "c1", "--session", "a"],
            ""
        )["status"],
        "leased"
    );
    let conflict = pc.run(
        &["lease", "claim", "--conversation", "c1", "--session", "b"],
        "",
    );
    assert_eq!(conflict.status.code(), Some(2), "lease_conflict exits 2");
    assert_eq!(
        pc.json(&["lease", "show", "--conversation", "c1"], "")["lease"]["session_id"],
        "a"
    );
    let list = pc.json(&["session", "list"], "");
    assert_eq!(list.as_array().unwrap().len(), 2);
    assert_eq!(
        pc.json(&["session", "heartbeat", "--session", "a"], "")["leases_renewed"],
        1
    );
    assert_eq!(
        pc.json(&["session", "end", "--session", "a"], "")["released"],
        1
    );
    assert_eq!(
        pc.json(&["lease", "show", "--conversation", "c1"], "")["lease"],
        Value::Null
    );
}

#[test]
fn watch_starts_from_now_and_prints_metadata_only() {
    let pc = pc();
    pc.deliver("old backlog");
    let first = pc.run(&["watch", "--session", "w", "--once"], "");
    assert!(first.status.success());
    assert!(
        first.stdout.is_empty(),
        "a new watcher records the backlog silently"
    );
    let message = pc.deliver("secret body text");
    let out = pc.run(&["watch", "--session", "w", "--once"], "");
    let line: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(line["type"], "mail");
    assert_eq!(line["id"], message.id.as_str());
    assert_eq!(line["from"], "Beta");
    assert!(!String::from_utf8_lossy(&out.stdout).contains("secret body"));
    let backlog = pc.run(&["watch", "--session", "w2", "--once", "--backlog"], "");
    assert_eq!(String::from_utf8_lossy(&backlog.stdout).lines().count(), 2);
    // The watcher's seen file is its own: the inject hook still shows the body.
    assert!(pc
        .inject("UserPromptSubmit", json!({ "session_id": "w" }))
        .is_some());
}

fn policy(home: &Path, peers: Value) {
    std::fs::write(
        home.join("policy.json"),
        json!({ "allowed_peers": peers, "max_bytes": 16384, "forbid_action_requests": false, "auto_answer_types": [] }).to_string(),
    )
    .unwrap();
}

#[test]
fn gate_fails_closed_denies_secrets_and_unlisted_peers_and_ledger_keeps_only_hashes() {
    let pc = pc();
    let gate = |input: Value| {
        let out = pc.run(&["hook", "gate", "--harness", "claude"], &input.to_string());
        assert_eq!(out.status.code(), Some(0));
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        (!stdout.trim().is_empty()).then(|| serde_json::from_str::<Value>(&stdout).unwrap())
    };
    let send = |recipient: &str, text: &str| json!({ "session_id": "s", "tool_name": "mcp__agent-mail__send_message", "tool_input": { "recipient": recipient, "text": text } });
    let no_policy = gate(send("Beta", "hello")).expect("no policy denies");
    assert_eq!(
        no_policy["hookSpecificOutput"]["permissionDecision"],
        "deny"
    );
    policy(&pc.home, json!(["Beta"]));
    assert!(
        gate(send("Beta", "hello")).is_none(),
        "an allowed send has no objection"
    );
    assert!(gate(send("Gamma", "hello")).is_some(), "unlisted peer");
    let secret = gate(send("Beta", "-----BEGIN PRIVATE KEY-----")).unwrap();
    assert!(secret["hookSpecificOutput"]["permissionDecisionReason"]
        .as_str()
        .unwrap()
        .contains("secret"));
    assert!(
        gate(json!({ "tool_name": "Read", "tool_input": {} })).is_none(),
        "other tools pass"
    );
    let publish = json!({ "tool_name": "mcp__agent-mail__mailbox_publish", "tool_input": { "body": "-----BEGIN PRIVATE KEY-----" } });
    assert!(
        gate(publish).is_some(),
        "mailbox_publish bodies are checked too"
    );

    let post = json!({ "session_id": "s", "tool_name": "mcp__agent-mail__send_message", "tool_input": { "recipient": "Beta", "text": "the body" },
        "tool_response": { "content": [{ "type": "text", "text": "{\"status\":\"delivered\",\"message_id\":\"m1\",\"conversation_id\":\"c1\"}" }] } });
    assert_eq!(
        pc.run(
            &["hook", "ledger", "--harness", "claude"],
            &post.to_string()
        )
        .status
        .code(),
        Some(0)
    );
    let ledger = std::fs::read_to_string(pc.home.join("ledger.jsonl")).unwrap();
    assert!(
        !ledger.contains("the body") && !ledger.contains("PRIVATE KEY"),
        "no bodies in the ledger"
    );
    let last: Value = serde_json::from_str(ledger.lines().last().unwrap()).unwrap();
    assert_eq!(last["decision"], "delivered");
    assert_eq!(last["message_id"], "m1");
    assert_eq!(last["conversation_id"], "c1");
    assert_eq!(last["harness"], "claude");
    assert_eq!(last["sha256"].as_str().unwrap().len(), 64);
    assert_eq!(
        ledger
            .lines()
            .filter(|line| line.contains("denied:"))
            .count(),
        4
    );
}

#[test]
fn harness_install_points_the_hooks_at_this_binary_and_home() {
    let pc = pc();
    let target = pc.home.parent().unwrap().join("project");
    std::fs::create_dir_all(&target).unwrap();
    let out = pc.json(
        &[
            "harness",
            "install",
            "--target",
            target.to_str().unwrap(),
            "--harness",
            "claude",
        ],
        "",
    );
    assert!(out["wrote"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f == ".claude/agent-mailbox.hooks.json"));
    let hooks: Value = serde_json::from_str(
        &std::fs::read_to_string(target.join(".claude/agent-mailbox.hooks.json")).unwrap(),
    )
    .unwrap();
    let cmd = hooks["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap();
    assert!(
        cmd.contains("agent-mail")
            && cmd.contains("hook inject --event UserPromptSubmit --harness claude"),
        "{cmd}"
    );
    assert!(
        cmd.contains(
            &serde_json::to_string(&std::path::absolute(&pc.home).unwrap().display().to_string())
                .unwrap()
        ),
        "{cmd}"
    );
    assert_eq!(
        pc.json(
            &["harness", "inspect", "--target", target.to_str().unwrap()],
            ""
        )["installed"],
        true
    );
    pc.json(
        &["harness", "uninstall", "--target", target.to_str().unwrap()],
        "",
    );
    assert!(!target.join(".claude/agent-mailbox.hooks.json").exists());
}

fn bare(args: &[&str], stdin: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_agent-mail"))
        .args(args)
        .env_remove("AGENT_MAIL_SESSION")
        .env_remove("CLAUDE_CODE_SESSION_ID")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn readers_pointed_at_a_missing_home_fail_and_create_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("typo");
    let home = missing.to_str().unwrap();
    let input = json!({ "session_id": "s", "hook_event_name": "UserPromptSubmit" }).to_string();
    let inject = bare(&["--home", home, "hook", "inject"], &input);
    assert_eq!(
        inject.status.code(),
        Some(0),
        "a hook never breaks the session"
    );
    assert!(String::from_utf8_lossy(&inject.stderr).contains("no agent-mail home"));
    for args in [
        vec!["--home", home, "digest", "--session", "s", "--unseen"],
        vec!["--home", home, "watch", "--session", "s", "--once"],
    ] {
        assert_eq!(bare(&args, "").status.code(), Some(1), "{args:?}");
    }
    let plain = bare(&["--home", home, "digest", "--session", "s"], "");
    assert!(String::from_utf8_lossy(&plain.stdout).contains("no agent-mail home"));
    assert!(!missing.exists(), "nothing was created");
}

#[test]
fn the_gate_fails_closed_without_a_home_a_policy_or_a_readable_field() {
    let send = json!({ "tool_name": "mcp__agent-mail__send_message", "tool_input": { "recipient": "Beta", "text": "hi" } });
    let no_home = bare(&["hook", "gate"], &send.to_string());
    assert_eq!(no_home.status.code(), Some(0));
    let deny: Value = serde_json::from_slice(&no_home.stdout).unwrap();
    assert_eq!(deny["hookSpecificOutput"]["permissionDecision"], "deny");
    let other = bare(
        &["hook", "gate"],
        &json!({ "tool_name": "Read" }).to_string(),
    );
    assert!(other.stdout.is_empty());

    let pc = pc();
    let gate = |input: &str| {
        let out = pc.run(&["hook", "gate"], input);
        assert_eq!(out.status.code(), Some(0));
        String::from_utf8_lossy(&out.stdout).to_string()
    };
    std::fs::write(pc.home.join("policy.json"), "{not json").unwrap();
    assert!(
        gate(&send.to_string()).contains("deny"),
        "an invalid policy denies"
    );
    policy(&pc.home, json!(["Beta"]));
    let big = json!({ "tool_name": "mcp__agent-mail__send_message", "tool_input": { "recipient": "Beta", "text": "x".repeat(20000) } });
    assert!(gate(&big.to_string()).contains("max_bytes"));
    assert_eq!(gate("{not json"), "", "unreadable stdin names no tool");
    // A wrong-typed field doesn't drop the rest of the payload.
    let odd = json!({ "session_id": 5, "tool_name": "mcp__agent-mail__send_message", "tool_input": { "recipient": "Gamma", "text": "hi" } });
    assert!(gate(&odd.to_string()).contains("deny"));
}

#[test]
fn unseen_needs_a_session_and_lease_show_has_the_expiry() {
    let pc = pc();
    assert_eq!(pc.run(&["digest", "--unseen"], "").status.code(), Some(1));
    pc.json(&["register", "--session", "a"], "");
    pc.json(
        &["lease", "claim", "--conversation", "c1", "--session", "a"],
        "",
    );
    let shown = pc.json(&["lease", "show", "--conversation", "c1"], "");
    assert!(shown["lease"]["lease_until"].as_u64().unwrap() > now_ms());
}
