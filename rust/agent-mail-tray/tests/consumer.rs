//! The consumer end to end: two Rust mailers on 127.0.0.1, a stub harness in place of `claude`.
//! Mail tagged with a project gets a headless run in that project's folder, and the reply comes
//! back through the outbox; the loop guards stop automatic and deep mail.

use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use agent_mail_tray::consumer::{default_runners, spawn, tick, RateWindow};
use agent_maild::{start, Config, Mailer};
use mail_core::envelope::Message;
use mail_core::send::{submit, SendRequest};
use mail_core::store::Store;
use mail_core::{ipc, Identity};
use serde_json::{json, Value};

const STUB_JS: &str = r#"
const fs = require("fs");
const path = require("path");
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({
    args: process.argv.slice(2), cwd: process.cwd(),
    claude_env: Object.keys(process.env).filter((k) => k.toUpperCase().startsWith("CLAUDE")),
    run_id: process.env.AGENT_MAIL_RUN_ID, tags: (prompt.match(/<\/untrusted-remote-message>/g) || []).length,
  }) + "\n");
  if (!prompt.includes("STDOUT-ONLY")) fs.writeFileSync(process.env.AGENT_MAIL_REPLY_FILE, "answer from reply.md\n");
  const result = prompt.includes("EMPTY-STDOUT") ? "" : "answer from stdout";
  console.log(JSON.stringify({ type: "result", is_error: false, result, total_cost_usd: 0.0123 }));
});
"#;

struct Pc {
    home: PathBuf,
    identity: Identity,
    _mailer: Mailer,
}

async fn pc(dir: &Path, name: &str) -> Pc {
    let home = dir.join(name);
    std::fs::create_dir_all(&home).unwrap();
    let identity = Identity::generate(name).unwrap();
    std::fs::write(
        home.join("identity.json"),
        serde_json::to_string(&identity).unwrap(),
    )
    .unwrap();
    let mut config = Config::receive_only(home.clone(), SocketAddr::from((Ipv4Addr::LOCALHOST, 0)));
    config.deliver = true;
    let mailer = start(config).await.unwrap();
    Pc {
        home,
        identity,
        _mailer: mailer,
    }
}

fn pin(from: &Pc, to: &Pc, port: u16) {
    Store::open(&from.home)
        .unwrap()
        .trust(
            &to.identity.public(),
            None,
            Some(&format!("http://127.0.0.1:{port}")),
        )
        .unwrap();
}

async fn wait_for<T>(mut probe: impl FnMut() -> Option<T>) -> T {
    let started = Instant::now();
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(started.elapsed() < Duration::from_secs(20), "timed out");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn inbox(home: &Path) -> Vec<Message> {
    Store::open(home).unwrap().inbox(100).unwrap()
}

fn send(
    from: &Pc,
    to: &str,
    text: &str,
    project: Option<&str>,
    tweak: impl FnOnce(&mut SendRequest),
) -> String {
    let mut request = SendRequest {
        recipient: to.into(),
        text: text.into(),
        project: project.map(str::to_owned),
        ..SendRequest::default()
    };
    tweak(&mut request);
    let mut store = Store::open(&from.home).unwrap();
    let delivery = submit(&from.home, &from.identity, &mut store, request).unwrap();
    ipc::poke(&from.home);
    serde_json::to_value(delivery).unwrap()["message_id"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn tagged_mail_runs_in_its_folder_and_the_reply_comes_back_with_the_guards_holding() {
    let dir = tempfile::tempdir().unwrap();
    let (alice, bob) = (pc(dir.path(), "alice").await, pc(dir.path(), "bob").await);
    pin(&alice, &bob, bob._mailer.port);
    pin(&bob, &alice, alice._mailer.port);
    let workspace = dir.path().join("demo-project");
    std::fs::create_dir_all(&workspace).unwrap();
    let stub = dir.path().join("stub");
    std::fs::create_dir_all(&stub).unwrap();
    std::fs::write(stub.join("stub.js"), STUB_JS).unwrap();
    std::fs::write(
        stub.join("claude.cmd"),
        "@echo off\r\nnode \"%~dp0stub.js\" %*\r\n",
    )
    .unwrap();

    let alice_fp = alice.identity.fingerprint().unwrap();
    std::fs::write(
        alice.home.join("policy.json"),
        json!({ "allowed_peers": ["bob"], "max_bytes": 16384 }).to_string(),
    )
    .unwrap();
    std::fs::write(bob.home.join("policy.json"), json!({
        "allowed_peers": ["alice"], "max_bytes": 16384,
        "workspaces": { "demo": { "path": workspace, "tier": "read" } },
        "dispatch": {
            "enabled": true,
            "claude_command": stub.join("claude.cmd"),
            "limits": { "per_peer_per_minute": 10, "timeout_ms": 30000, "budget_usd": 0.1 },
            "peers": { alice_fp.clone(): { "responder": { "enabled": true, "harness": "claude" } } }
        }
    }).to_string()).unwrap();
    std::env::set_var("CLAUDE_CONFIG_DIR_TEST_SHOULD_NOT_LEAK", "1");

    let runners = default_runners();
    let mut rate = RateWindow::default();
    let bob_home = bob.home.clone();
    let mut pass = move || {
        let (home, runners) = (bob_home.clone(), runners.clone());
        let mut window = std::mem::take(&mut rate);
        let records = tick(&home, &mut window, &runners).unwrap();
        rate = window;
        records
    };

    // A message that arrived before the consumer's first pass is backlog: recorded, never answered.
    send(
        &alice,
        "bob",
        "old mail from before dispatch",
        Some("demo"),
        |_| {},
    );
    wait_for(|| (inbox(&bob.home).len() == 1).then_some(())).await;
    assert!(pass().is_empty(), "the first pass only records the backlog");
    assert!(pass().is_empty());

    // Tagged mail: a run in the demo folder; reply.md beats stdout.
    let asked = send(
        &alice,
        "bob",
        "what is the build status?",
        Some("demo"),
        |r| {
            r.agent = Some(mail_core::envelope::AgentMeta {
                session_id: Some("alice-s1".into()),
                ..Default::default()
            })
        },
    );
    wait_for(|| inbox(&bob.home).iter().any(|m| m.id == asked).then_some(())).await;
    let records = pass();
    assert_eq!(records.len(), 1);
    assert_eq!(
        (records[0].step.as_str(), records[0].detail.as_str()),
        ("run", "claude queued")
    );
    let answer = wait_for(|| {
        inbox(&alice.home)
            .into_iter()
            .find(|m| m.in_reply_to.as_deref() == Some(asked.as_str()))
    })
    .await;
    assert_eq!(answer.text, "answer from reply.md");
    assert_eq!(answer.auto_reply, Some(true));
    assert_eq!(answer.hop, Some(1));
    assert_eq!(answer.project.as_deref(), Some("demo"));
    assert_eq!(answer.to_session.as_deref(), Some("alice-s1"));

    // No reply.md: the final stdout message is the reply.
    let second = send(
        &alice,
        "bob",
        "answer via STDOUT-ONLY please",
        Some("demo"),
        |_| {},
    );
    wait_for(|| {
        inbox(&bob.home)
            .iter()
            .any(|m| m.id == second)
            .then_some(())
    })
    .await;
    assert_eq!(pass()[0].detail, "claude queued");
    let answer = wait_for(|| {
        inbox(&alice.home)
            .into_iter()
            .find(|m| m.in_reply_to.as_deref() == Some(second.as_str()))
    })
    .await;
    assert_eq!(answer.text, "answer from stdout");

    // reply.md written, but the final stdout result is empty (`empty_output`): reply.md still wins.
    let third = send(
        &alice,
        "bob",
        "answer in reply.md only, EMPTY-STDOUT",
        Some("demo"),
        |_| {},
    );
    wait_for(|| inbox(&bob.home).iter().any(|m| m.id == third).then_some(())).await;
    assert_eq!(pass()[0].detail, "claude queued");
    let answer = wait_for(|| {
        inbox(&alice.home)
            .into_iter()
            .find(|m| m.in_reply_to.as_deref() == Some(third.as_str()))
    })
    .await;
    assert_eq!(answer.text, "answer from reply.md");

    // The guards: automatic mail, deep mail and an unmapped project never start a run.
    let automatic = send(&alice, "bob", "an automatic note", Some("demo"), |r| {
        r.auto_reply = Some(true)
    });
    let deep = send(&alice, "bob", "deep in an exchange", Some("demo"), |r| {
        r.hop = Some(6)
    });
    let unmapped = send(
        &alice,
        "bob",
        "for a project bob doesn't map",
        Some("elsewhere"),
        |_| {},
    );
    wait_for(|| {
        let ids: Vec<String> = inbox(&bob.home).into_iter().map(|m| m.id).collect();
        [&automatic, &deep, &unmapped]
            .iter()
            .all(|id| ids.contains(id))
            .then_some(())
    })
    .await;
    let mut skips: Vec<(String, String)> = pass().into_iter().map(|r| (r.step, r.detail)).collect();
    skips.sort();
    assert_eq!(
        skips,
        vec![
            ("skip".to_owned(), "hop_limit".to_owned()),
            ("skip".to_owned(), "no_live_owner".to_owned()),
            ("skip".to_owned(), "no_workspace".to_owned()),
        ]
    );
    assert!(pass().is_empty(), "each message is handled once");

    // What the stub saw: read tools only, the mapped folder, no CLAUDE* settings, one closing tag.
    let calls: Vec<Value> = std::fs::read_to_string(stub.join("calls.jsonl"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(
        calls.len(),
        3,
        "three runs, nothing for the backlog or the guarded mail"
    );
    for call in &calls {
        let args: Vec<&str> = call["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap())
            .collect();
        let tools = &args[args.iter().position(|a| *a == "--tools").unwrap() + 1
            ..args.iter().position(|a| *a == "--allowedTools").unwrap()];
        assert_eq!(tools, ["Read", "Grep", "Glob"]);
        assert!(args.contains(&"--strict-mcp-config"));
        assert_eq!(
            PathBuf::from(call["cwd"].as_str().unwrap())
                .canonicalize()
                .unwrap(),
            workspace.canonicalize().unwrap()
        );
        assert_eq!(
            call["claude_env"],
            json!([]),
            "no CLAUDE* variables reach the run"
        );
        assert_eq!(
            call["tags"], 1,
            "remote text sits inside exactly one untrusted tag"
        );
    }

    // Runs table and dashboard view.
    let runs = Store::open(&bob.home).unwrap().recent_runs(10).unwrap();
    assert_eq!(runs.len(), 3);
    let mut outcomes: Vec<&str> = runs
        .iter()
        .filter_map(|run| run.outcome.as_deref())
        .collect();
    outcomes.sort();
    assert_eq!(outcomes, ["empty_output", "ok", "ok"]);
    assert!(runs
        .iter()
        .all(|run| run.state == "done" && run.reply_id.is_some() && run.tier == "read"));
    assert!(runs
        .iter()
        .all(|run| run.cost_usd == Some(0.0123) && run.project.as_deref() == Some("demo")));
    let view = agent_mail_tray::dashboard::snapshot(&bob.home);
    assert_eq!(view["runs"].as_array().unwrap().len(), 3);
    assert_eq!(view["runs"][0]["runner"], "claude");

    // Ledger: one line per decision plus one per reply, bodies only as hashes.
    let ledger = std::fs::read_to_string(bob.home.join("ledger.jsonl")).unwrap();
    let lines: Vec<Value> = ledger
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines.iter().filter(|l| l["tool"] == "dispatch").count(), 6);
    assert_eq!(
        lines
            .iter()
            .filter(|l| l["tool"] == "dispatch:reply")
            .count(),
        3
    );
    assert!(lines
        .iter()
        .all(|l| l["sha256"].as_str().is_some_and(|h| h.len() == 64)));
    for text in [
        "what is the build status?",
        "answer from reply.md",
        "deep in an exchange",
    ] {
        assert!(
            !ledger.contains(text),
            "the ledger never holds message text"
        );
    }
    assert!(
        inbox(&bob.home).len() >= 7,
        "the consumer never acknowledges mail"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_running_consumer_handles_new_mail_within_two_seconds() {
    let dir = tempfile::tempdir().unwrap();
    let (alice, bob) = (pc(dir.path(), "alice").await, pc(dir.path(), "bob").await);
    pin(&alice, &bob, bob._mailer.port);
    pin(&bob, &alice, alice._mailer.port);
    let alice_fp = alice.identity.fingerprint().unwrap();
    std::fs::write(
        alice.home.join("policy.json"),
        json!({ "allowed_peers": ["bob"], "max_bytes": 16384 }).to_string(),
    )
    .unwrap();
    // A listed peer with nothing configured: each message is a quick, logged skip.
    std::fs::write(bob.home.join("policy.json"), json!({
        "allowed_peers": ["alice"], "max_bytes": 16384,
        "dispatch": { "enabled": true, "limits": { "per_peer_per_minute": 10 }, "peers": { alice_fp: {} } }
    }).to_string()).unwrap();

    let _consumer = spawn(bob.home.clone(), default_runners());
    let home = bob.home.clone();
    wait_for(move || {
        Store::open(&home)
            .unwrap()
            .consumer_started()
            .unwrap()
            .then_some(())
    })
    .await;

    let id = send(&alice, "bob", "are you there?", None, |_| {});
    let bob_home = bob.home.clone();
    let wanted = id.clone();
    wait_for(move || {
        inbox(&bob_home)
            .iter()
            .any(|m| m.id == wanted)
            .then_some(())
    })
    .await;
    let stored = Instant::now();
    let ledger = bob.home.join("ledger.jsonl");
    let handled = loop {
        if std::fs::read_to_string(&ledger)
            .unwrap_or_default()
            .contains(&id)
        {
            break stored.elapsed();
        }
        assert!(
            stored.elapsed() < Duration::from_secs(10),
            "the consumer never handled it"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert!(
        handled < Duration::from_secs(2),
        "handled {handled:?} after it was stored"
    );
}
