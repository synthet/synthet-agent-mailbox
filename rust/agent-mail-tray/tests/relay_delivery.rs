//! The relay through the consumer (ADR 0006 decision 5.2): with the pipe off and `live.relay` on, the
//! notice for the checkout's live session goes through a restricted `claude -p`. A stub `claude.cmd`
//! stands in, so the test sees whether it ran and with what.
#![cfg(windows)]

use std::path::Path;
use std::process::{Command, Stdio};

use agent_mail_tray::consumer::{default_runners, tick_in, RateWindow};
use agent_mail_tray::live::process_start;
use mail_core::envelope::{Envelope, Intent, Message, Origin};
use mail_core::store::{now_ms, Store};
use mail_core::Identity;
use serde_json::json;

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"])
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?}");
}

fn message(
    from: &Identity,
    to: &str,
    id: &str,
    checkout: mail_core::envelope::Checkout,
) -> Message {
    Message {
        id: id.into(),
        conversation_id: "00000000-0000-4000-8000-0000000000d1".into(),
        sender: from.fingerprint().unwrap(),
        recipient: to.into(),
        text: "BODY-THAT-MUST-NOT-REACH-THE-PIPE".into(),
        created_at: now_ms(),
        origin: Origin {
            hostname: "alpha".into(),
            platform: "win32".into(),
            arch: "x64".into(),
            addresses: vec![],
        },
        agent: None,
        to_session: None,
        hop: None,
        auto_reply: None,
        in_reply_to: None,
        project: None,
        checkout: Some(checkout),
        intent: Some(Intent::Notify),
        signature: String::new(),
    }
    .sign(from, Envelope::V1_3)
    .unwrap()
}

fn policy(home: &Path, peer: &str, roots: &Path, relay: bool, claude: &Path) {
    std::fs::write(
        home.join("policy.json"),
        json!({
            "allowed_peers": [], "max_bytes": 16384, "checkout_roots": [roots],
            "dispatch": { "enabled": true, "claude_command": claude, "live": { "enabled": false, "relay": relay },
                "limits": { "per_peer_per_minute": 10, "timeout_ms": 30000, "budget_usd": 0.1 },
                "peers": { peer: {} } }
        })
        .to_string(),
    )
    .unwrap();
}

#[test]
fn with_the_pipe_off_the_relay_messages_the_checkout_session_and_only_when_enabled() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("bob");
    std::fs::create_dir_all(&home).unwrap();
    let bob = Identity::generate("bob").unwrap();
    std::fs::write(
        home.join("identity.json"),
        serde_json::to_string(&bob).unwrap(),
    )
    .unwrap();
    let alice = Identity::generate("alice").unwrap();
    let alice_fp = alice.fingerprint().unwrap();
    Store::open(&home)
        .unwrap()
        .trust(&alice.public(), None, None)
        .unwrap();

    let src = dir.path().join("src");
    std::fs::create_dir_all(&src).unwrap();
    git(&src, &["init", "-q"]);
    git(&src, &["commit", "-q", "--allow-empty", "-m", "root"]);
    let roots = dir.path().join("roots");
    std::fs::create_dir_all(&roots).unwrap();
    let app = roots.join("app");
    git(
        dir.path(),
        &[
            "clone",
            "-q",
            &src.to_string_lossy(),
            &app.to_string_lossy(),
        ],
    );
    let checkout = mail_core::checkout::local_checkout(&src).unwrap();

    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let pid = std::process::id();
    std::fs::write(
        sessions.join(format!("{pid}.json")),
        json!({ "pid": pid, "sessionId": "bob-session", "cwd": app, "kind": "interactive",
                "procStart": process_start(pid).unwrap().to_string(),
                "messagingSocketPath": format!(r"\\.\pipe\LOCAL\cc-msg-{pid}"), "name": "work" })
        .to_string(),
    )
    .unwrap();

    let stub = dir.path().join("stub");
    std::fs::create_dir_all(&stub).unwrap();
    let marker = stub.join("ran.txt");
    let claude = stub.join("claude.cmd");
    std::fs::write(
        &claude,
        format!(
            "@echo off\r\necho %* > \"{m}\"\r\necho config=%CLAUDE_CONFIG_DIR%>> \"{m}\"\r\nmore >> \"{m}\"\r\necho {{\"type\":\"result\"}}\r\n",
            m = marker.display()
        ),
    )
    .unwrap();

    let runners = default_runners();
    let mut window = RateWindow::default();
    policy(&home, &alice_fp, &roots, true, &claude);
    assert!(tick_in(&home, &mut window, &runners, Some(&sessions))
        .unwrap()
        .is_empty());

    let first = message(
        &alice,
        &bob.fingerprint().unwrap(),
        "00000000-0000-4000-8000-0000000000f1",
        checkout.clone(),
    );
    Store::open(&home).unwrap().receive(&first).unwrap();
    let records = tick_in(&home, &mut window, &runners, Some(&sessions)).unwrap();
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0].detail, "claude-code via checkout: relayed");
    let seen = std::fs::read_to_string(&marker).unwrap();
    assert!(
        seen.contains("SendMessage") && seen.contains("--strict-mcp-config"),
        "{seen}"
    );
    assert!(
        seen.contains("\"work\""),
        "a unique name is the address: {seen}"
    );
    assert!(
        seen.contains("MAIL thread=") && !seen.contains("BODY-THAT-MUST-NOT"),
        "the notice, never the body"
    );
    assert!(
        seen.contains(&format!("config={}", dir.path().display())),
        "the relay gets the folder the tray read the sessions from: {seen}"
    );
    std::fs::remove_file(&marker).unwrap();

    // Relay off as well: no session is read and no process starts.
    policy(&home, &alice_fp, &roots, false, &claude);
    let second = message(
        &alice,
        &bob.fingerprint().unwrap(),
        "00000000-0000-4000-8000-0000000000f2",
        checkout,
    );
    Store::open(&home).unwrap().receive(&second).unwrap();
    let records = tick_in(&home, &mut window, &runners, Some(&sessions)).unwrap();
    assert_eq!(
        (records[0].step.as_str(), records[0].detail.as_str()),
        ("skip", "no_live_owner")
    );
    assert!(!marker.exists(), "no relay run with live.relay off");
}
