//! The `agent-mail` CLI with in-process mailers, and against the TypeScript peer (`dist/`).
//! Every home is a temp folder and every listener binds 127.0.0.1 on a random port.

use std::collections::BTreeMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use agent_maild::{start, Config, Mailer};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, BufReader};

struct Run {
    code: i32,
    out: Value,
    err: String,
}

fn cli_sync(home: &Path, args: &[&str]) -> Run {
    let output = Command::new(env!("CARGO_BIN_EXE_agent-mail"))
        .arg("--home")
        .arg(home)
        .args(args)
        .env_remove("AGENT_MAIL_HARNESS")
        .env_remove("AGENT_MAIL_AGENT_NAME")
        .env_remove("AGENT_MAIL_MODEL")
        .env_remove("AGENT_MAIL_SESSION")
        .env_remove("CLAUDE_CODE_SESSION_ID")
        .output()
        .unwrap();
    Run {
        code: output.status.code().unwrap_or(-1),
        out: serde_json::from_slice(&output.stdout).unwrap_or(Value::Null),
        err: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

/// `cli_sync` run from `cwd` with extra environment, off the runtime like `cli`.
async fn cli_in(home: &Path, cwd: &Path, env: &[(&str, &str)], args: &[&str]) -> Run {
    let mut command = Command::new(env!("CARGO_BIN_EXE_agent-mail"));
    command
        .arg("--home")
        .arg(home)
        .args(args)
        .current_dir(cwd)
        .env_remove("AGENT_MAIL_HARNESS")
        .env_remove("AGENT_MAIL_AGENT_NAME")
        .env_remove("AGENT_MAIL_MODEL")
        .env_remove("AGENT_MAIL_SESSION")
        .env_remove("CLAUDE_CODE_SESSION_ID");
    for (key, value) in env {
        command.env(key, value);
    }
    let output = tokio::task::spawn_blocking(move || command.output().unwrap())
        .await
        .unwrap();
    Run {
        code: output.status.code().unwrap_or(-1),
        out: serde_json::from_slice(&output.stdout).unwrap_or(Value::Null),
        err: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

/// CLI calls block, and `send` waits on a mailer running on this runtime, so run them off it.
async fn cli(home: &Path, args: &[&str]) -> Run {
    let home = home.to_path_buf();
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    tokio::task::spawn_blocking(move || {
        cli_sync(&home, &args.iter().map(String::as_str).collect::<Vec<_>>())
    })
    .await
    .unwrap()
}

fn node_cli(home: &Path, args: &[&str]) -> Run {
    let cli = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../dist/cli.js");
    assert!(
        cli.exists(),
        "dist/ is missing: run `npm run build` (or `npm run test:rust`) first"
    );
    let output = Command::new("node")
        .arg(cli)
        .arg("--home")
        .arg(home)
        .args(args)
        .env_remove("AGENT_MAIL_HOME")
        .output()
        .unwrap();
    Run {
        code: output.status.code().unwrap_or(-1),
        out: serde_json::from_slice(&output.stdout).unwrap_or(Value::Null),
        err: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

fn public_file(dir: &Path, name: &str, identity: &Value) -> PathBuf {
    let path = dir.join(format!("{name}-public.json"));
    let public = json!({ "name": identity["name"], "signing_key": identity["signing_key"], "encryption_key": identity["encryption_key"] });
    std::fs::write(&path, public.to_string()).unwrap();
    path
}

fn allow(home: &Path, peers: &[&str]) {
    let mut policy: Value =
        serde_json::from_str(&std::fs::read_to_string(home.join("policy.json")).unwrap()).unwrap();
    policy["allowed_peers"] = json!(peers);
    std::fs::write(home.join("policy.json"), policy.to_string()).unwrap();
}

async fn mailer(home: &Path, deliver: bool) -> Mailer {
    let mut config = Config::receive_only(
        home.to_path_buf(),
        SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
    );
    config.deliver = deliver;
    start(config).await.unwrap()
}

struct Pair {
    dir: TempDir,
    alice: PathBuf,
    bob: PathBuf,
    bob_fp: String,
    bob_mailer: Mailer,
}

/// alice and bob pin each other; bob's mailer runs; alice's policy allows bob.
async fn pair() -> Pair {
    let dir = tempfile::tempdir().unwrap();
    let (alice, bob) = (dir.path().join("alice"), dir.path().join("bob"));
    let alice_id = cli(&alice, &["init", "--name", "alice"]).await.out;
    let bob_id = cli(&bob, &["init", "--name", "bob"]).await.out;
    let bob_mailer = mailer(&bob, false).await;
    let bob_fp = bob_id["fingerprint"].as_str().unwrap().to_owned();
    let alice_fp = alice_id["fingerprint"].as_str().unwrap().to_owned();
    let endpoint = format!("http://127.0.0.1:{}", bob_mailer.port);
    let bob_file = public_file(dir.path(), "bob", &bob_id);
    let alice_file = public_file(dir.path(), "alice", &alice_id);
    let trusted = cli(
        &alice,
        &[
            "trust",
            "--file",
            bob_file.to_str().unwrap(),
            "--fingerprint",
            &bob_fp,
            "--endpoint",
            &endpoint,
        ],
    )
    .await;
    assert_eq!(trusted.code, 0, "{}", trusted.err);
    assert_eq!(
        cli(
            &bob,
            &[
                "trust",
                "--file",
                alice_file.to_str().unwrap(),
                "--fingerprint",
                &alice_fp
            ]
        )
        .await
        .code,
        0
    );
    assert_eq!(cli(&alice, &["policy", "init"]).await.out["created"], true);
    allow(&alice, &["bob"]);
    Pair {
        dir,
        alice,
        bob,
        bob_fp,
        bob_mailer,
    }
}

async fn wait_for(mut done: impl FnMut() -> bool) {
    let started = Instant::now();
    while !done() {
        assert!(
            started.elapsed() < Duration::from_secs(15),
            "timed out waiting"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn queued_while_the_mailer_is_down_then_drained() {
    let p = pair().await;
    let queued = cli(
        &p.alice,
        &["send", "bob", "--text", "first", "--project", "demo"],
    )
    .await;
    assert_eq!(queued.code, 2, "{}", queued.err);
    assert_eq!(queued.out["status"], "queued");
    assert!(queued.out["error"]
        .as_str()
        .unwrap()
        .contains("not running"));
    assert_eq!(cli(&p.alice, &["status"]).await.out["pending"], 1);

    let _alice_mailer = mailer(&p.alice, true).await;
    let alice = p.alice.clone();
    wait_for(|| cli_sync(&alice, &["status"]).out["pending"] == 0).await;
    let inbox = cli(&p.bob, &["inbox"]).await.out;
    assert_eq!(inbox[0]["text"], "first");
    assert_eq!(
        inbox[0]["project"], "demo",
        "Rust to Rust keeps the 1.2 tag"
    );

    let sent = cli(
        &p.alice,
        &[
            "send",
            &p.bob_fp,
            "--text",
            "second",
            "--message-id",
            "00000000-0000-4000-8000-0000000000b2",
        ],
    )
    .await;
    assert_eq!(sent.code, 0, "{} {}", sent.out, sent.err);
    assert_eq!(sent.out["status"], "delivered");
    let again = cli(
        &p.alice,
        &[
            "send",
            "bob",
            "--text",
            "second",
            "--message-id",
            "00000000-0000-4000-8000-0000000000b2",
        ],
    )
    .await;
    assert_eq!(
        (again.code, again.out["status"].clone()),
        (0, json!("delivered")),
        "a retry of a delivered id is a no-op"
    );
    let clash = cli(
        &p.alice,
        &[
            "send",
            "bob",
            "--text",
            "other",
            "--message-id",
            "00000000-0000-4000-8000-0000000000b2",
        ],
    )
    .await;
    assert_eq!(clash.code, 1);
    assert!(clash.err.contains("already used"), "{}", clash.err);
    assert_eq!(
        cli(&p.bob, &["inbox"]).await.out.as_array().unwrap().len(),
        2
    );
    assert_eq!(cli(&p.alice, &["status"]).await.out["sent"], 2);
    drop(p.bob_mailer);
}

#[tokio::test(flavor = "multi_thread")]
async fn policy_refuses_before_anything_is_queued() {
    let p = pair().await;
    let token = format!("gh{}_{}", "p", "a".repeat(36));
    let secret = cli(
        &p.alice,
        &["send", "bob", "--text", &format!("use {token}")],
    )
    .await;
    assert_eq!(secret.code, 1);
    assert!(secret.err.contains("secret"), "{}", secret.err);

    allow(&p.alice, &["somebody-else"]);
    let unlisted = cli(&p.alice, &["send", "bob", "--text", "hi"]).await;
    assert_eq!(unlisted.code, 1);
    assert!(unlisted.err.contains("allowed_peers"), "{}", unlisted.err);

    std::fs::remove_file(p.alice.join("policy.json")).unwrap();
    let no_policy = cli(&p.alice, &["send", "bob", "--text", "hi"]).await;
    assert_eq!(no_policy.code, 1);
    assert!(no_policy.err.contains("policy init"), "{}", no_policy.err);

    assert_eq!(
        cli(&p.alice, &["status"]).await.out["pending"],
        0,
        "nothing was queued"
    );
    let _ = p.dir;
}

const TS_LISTEN: &str = r#"
const { loadIdentity, fingerprint } = await import(process.env.DIST + "/peer/identity.js");
const { Peer } = await import(process.env.DIST + "/peer/peer.js");
const identity = loadIdentity(process.env.TS_HOME);
const peer = new Peer(identity, process.env.TS_HOME, { tailscale: false });
const listener = await peer.listen({ port: 0, bind: "127.0.0.1", discovery: false });
console.log(JSON.stringify({ fingerprint: fingerprint(identity), port: listener.port }));
process.stdin.on("end", async () => { await listener.close(); process.exit(0); });
process.stdin.resume();
"#;

/// Starts a TS listener on an existing TS home; returns the child and its port.
async fn ts_listener(home: &Path) -> (tokio::process::Child, u16) {
    let dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../dist");
    let mut child = tokio::process::Command::new("node")
        .args(["--input-type=module", "-e", TS_LISTEN])
        .env(
            "DIST",
            format!("file:///{}", dist.to_string_lossy().replace('\\', "/")),
        )
        .env("TS_HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let started: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    (child, started["port"].as_u64().unwrap() as u16)
}

#[tokio::test(flavor = "multi_thread")]
async fn rust_delivers_to_a_typescript_peer_and_drops_the_project_tag() {
    let p = pair().await;
    let ts = p.dir.path().join("ts");
    let ts_id = node_cli(&ts, &["init", "--name", "tspeer"]);
    assert_eq!(ts_id.code, 0, "{}", ts_id.err);
    let ts_id = node_cli(&ts, &["identity"]).out;
    let (_listener, port) = ts_listener(&ts).await;

    let alice_id = cli(&p.alice, &["identity"]).await.out;
    let alice_file = public_file(p.dir.path(), "alice", &alice_id);
    assert_eq!(
        node_cli(
            &ts,
            &[
                "trust",
                "--file",
                alice_file.to_str().unwrap(),
                "--fingerprint",
                alice_id["fingerprint"].as_str().unwrap()
            ]
        )
        .code,
        0
    );
    let ts_file = public_file(p.dir.path(), "tspeer", &ts_id);
    let ts_fp = ts_id["fingerprint"].as_str().unwrap();
    let endpoint = format!("http://127.0.0.1:{port}");
    assert_eq!(
        cli(
            &p.alice,
            &[
                "trust",
                "--file",
                ts_file.to_str().unwrap(),
                "--fingerprint",
                ts_fp,
                "--endpoint",
                &endpoint
            ]
        )
        .await
        .code,
        0
    );
    allow(&p.alice, &["bob", "tspeer"]);

    let _alice_mailer = mailer(&p.alice, true).await;
    let sent = cli(
        &p.alice,
        &[
            "send",
            "tspeer",
            "--text",
            "hello TS from Rust",
            "--project",
            "demo",
            "--session",
            "s-1",
        ],
    )
    .await;
    assert_eq!(sent.code, 0, "{} {}", sent.out, sent.err);
    assert_eq!(sent.out["status"], "delivered");
    assert_eq!(
        sent.out["envelope_downgraded"], true,
        "TS lists only agent-mail/1.1"
    );

    let inbox = node_cli(&ts, &["inbox"]).out;
    assert_eq!(inbox[0]["text"], "hello TS from Rust");
    assert_eq!(inbox[0]["agent"]["session_id"], "s-1");
    assert!(inbox[0].get("project").is_none());

    // agent-mail/1.3: a task is held for a peer that can't take it, never sent as a plain message.
    let task = cli(
        &p.alice,
        &[
            "send",
            "tspeer",
            "--text",
            "do this",
            "--intent",
            "task",
            "--wait-ms",
            "3000",
        ],
    )
    .await;
    assert_eq!(task.code, 2, "{} {}", task.out, task.err);
    assert_eq!(task.out["status"], "queued");
    assert!(
        task.out["error"]
            .as_str()
            .unwrap_or("")
            .contains("task held"),
        "{}",
        task.out
    );
    assert_eq!(
        node_cli(&ts, &["inbox"]).out.as_array().unwrap().len(),
        1,
        "nothing else arrived"
    );
}

/// File name -> contents for every JSON file under the TS store areas.
fn snapshot(home: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut files = BTreeMap::new();
    for area in ["contacts", "inbox", "acked", "outbox", "sent"] {
        if let Ok(entries) = std::fs::read_dir(home.join(area)) {
            for entry in entries.flatten() {
                files.insert(
                    format!("{area}/{}", entry.file_name().to_string_lossy()),
                    std::fs::read(entry.path()).unwrap(),
                );
            }
        }
    }
    files
}

#[tokio::test(flavor = "multi_thread")]
async fn migrate_imports_a_typescript_store_once_and_leaves_it_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let (x, y) = (dir.path().join("x"), dir.path().join("y"));
    assert_eq!(node_cli(&x, &["init", "--name", "x"]).code, 0);
    assert_eq!(node_cli(&y, &["init", "--name", "y"]).code, 0);
    let (x_id, y_id) = (
        node_cli(&x, &["identity"]).out,
        node_cli(&y, &["identity"]).out,
    );
    let (x_fp, y_fp) = (
        x_id["fingerprint"].as_str().unwrap(),
        y_id["fingerprint"].as_str().unwrap(),
    );
    let (listener, port) = ts_listener(&y).await;
    let endpoint = format!("http://127.0.0.1:{port}");
    assert_eq!(
        node_cli(
            &x,
            &[
                "trust",
                "--file",
                public_file(dir.path(), "y", &y_id).to_str().unwrap(),
                "--fingerprint",
                y_fp,
                "--endpoint",
                &endpoint
            ]
        )
        .code,
        0
    );
    assert_eq!(
        node_cli(
            &y,
            &[
                "trust",
                "--file",
                public_file(dir.path(), "x", &x_id).to_str().unwrap(),
                "--fingerprint",
                x_fp
            ]
        )
        .code,
        0
    );

    let quiet = ["--no-tailscale", "--timeout", "50"];
    let delivered = node_cli(
        &x,
        &[&["send", "y", "--text", "delivered by TS"][..], &quiet[..]].concat(),
    );
    assert_eq!(delivered.code, 0, "{}", delivered.err);
    let read = node_cli(
        &x,
        &[&["send", "y", "--text", "read by y"][..], &quiet[..]].concat(),
    );
    assert_eq!(read.code, 0);
    assert_eq!(
        node_cli(
            &y,
            &[
                "ack",
                read.out["message_id"].as_str().unwrap(),
                "--sender",
                x_fp
            ]
        )
        .code,
        0
    );
    drop(listener);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let queued = node_cli(
        &x,
        &[&["send", "y", "--text", "still queued"][..], &quiet[..]].concat(),
    );
    assert_eq!(queued.code, 2, "y is down, so this stays in x's outbox");

    let (x_before, y_before) = (snapshot(&x), snapshot(&y));
    let first = cli(&x, &["migrate"]).await;
    assert_eq!(first.code, 0, "{}", first.err);
    assert_eq!(first.out["contacts"]["imported"], 1);
    assert_eq!(first.out["sent"]["imported"], 2);
    assert_eq!(first.out["outbox"]["imported"], 1);
    let y_report = cli(&y, &["migrate"]).await.out;
    assert_eq!(
        (
            y_report["inbox"]["imported"].clone(),
            y_report["acked"]["imported"].clone()
        ),
        (json!(2), json!(1))
    );

    let again = cli(&x, &["migrate"]).await.out;
    for area in ["contacts", "inbox", "acked", "outbox", "sent"] {
        assert_eq!(
            again[area]["imported"], 0,
            "second run imports nothing new in {area}"
        );
        assert!(again[area]["invalid"].as_array().unwrap().is_empty());
    }
    assert_eq!(snapshot(&x), x_before, "x's JSON store is unchanged");
    assert_eq!(snapshot(&y), y_before, "y's JSON store is unchanged");

    let status = cli(&x, &["status"]).await.out;
    assert_eq!(
        (status["pending"].clone(), status["sent"].clone()),
        (json!(1), json!(2))
    );
    let inbox = cli(&y, &["inbox"]).await.out;
    assert_eq!(
        inbox.as_array().unwrap().len(),
        1,
        "the acked message stays read"
    );
    assert_eq!(inbox[0]["text"], "delivered by TS");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_mailer_on_the_same_home_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("solo");
    assert_eq!(cli(&home, &["init", "--name", "solo"]).await.code, 0);
    let first = mailer(&home, true).await;
    let mut config = Config::receive_only(home.clone(), SocketAddr::from((Ipv4Addr::LOCALHOST, 0)));
    config.deliver = true;
    let second = start(config).await;
    assert!(second.is_err(), "two mailers would both drain one outbox");
    assert_eq!(cli(&home, &["status"]).await.out["mailer_running"], true);
    drop(first);
}

#[tokio::test(flavor = "multi_thread")]
async fn identity_output_can_be_passed_straight_to_trust() {
    let dir = tempfile::tempdir().unwrap();
    let (a, b) = (dir.path().join("a"), dir.path().join("b"));
    assert_eq!(cli(&a, &["init", "--name", "a"]).await.code, 0);
    let identity = cli(&b, &["init", "--name", "b"]).await.out;
    let file = dir.path().join("b-identity.json");
    std::fs::write(&file, identity.to_string()).unwrap();
    let fp = identity["fingerprint"].as_str().unwrap();
    let trusted = cli(
        &a,
        &[
            "trust",
            "--file",
            file.to_str().unwrap(),
            "--fingerprint",
            fp,
        ],
    )
    .await;
    assert_eq!(trusted.code, 0, "{}", trusted.err);
    std::fs::write(&file, json!({ "name": "b", "signing_key": identity["signing_key"], "encryption_key": identity["encryption_key"], "extra": 1 }).to_string()).unwrap();
    assert_eq!(
        cli(
            &a,
            &[
                "trust",
                "--file",
                file.to_str().unwrap(),
                "--fingerprint",
                fp
            ]
        )
        .await
        .code,
        1,
        "other fields are still refused"
    );
    let wrong = "0".repeat(64);
    std::fs::write(&file, identity.to_string()).unwrap();
    assert_eq!(
        cli(
            &a,
            &[
                "trust",
                "--file",
                file.to_str().unwrap(),
                "--fingerprint",
                &wrong
            ]
        )
        .await
        .code,
        1,
        "fingerprint must match"
    );
}

fn git_repo(dir: &Path, origin: &str) {
    std::fs::create_dir_all(dir).unwrap();
    for args in [
        vec!["init", "-q"],
        vec![
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.invalid",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "root",
        ],
        vec!["remote", "add", "origin", origin],
    ] {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(&args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn rust_to_rust_carries_the_checkout_intent_and_claude_session() {
    let p = pair().await;
    let repo = p.dir.path().join("repos").join("app");
    git_repo(&repo, "git@github.com:Owner/App.git");
    let sub = repo.join("src");
    std::fs::create_dir_all(&sub).unwrap();
    let _alice_mailer = mailer(&p.alice, true).await;
    let sent = cli_in(
        &p.alice,
        &sub,
        &[("CLAUDE_CODE_SESSION_ID", "cc-session-1")],
        &[
            "send",
            "bob",
            "--text",
            "look at this",
            "--checkout",
            "auto",
            "--intent",
            "notify",
        ],
    )
    .await;
    assert_eq!(sent.code, 0, "{} {}", sent.out, sent.err);
    assert_eq!(sent.out["status"], "delivered");
    assert!(
        sent.out
            .get("envelope_downgraded")
            .is_none_or(|v| v == false),
        "bob takes 1.3: {}",
        sent.out
    );

    let inbox = cli(&p.bob, &["inbox"]).await.out;
    let message = &inbox[0];
    assert_eq!(message["intent"], "notify");
    assert_eq!(message["checkout"]["origin"], "github.com/owner/app");
    assert_eq!(message["checkout"]["name"], "app");
    assert_eq!(message["checkout"]["roots"].as_array().unwrap().len(), 1);
    assert_eq!(message["agent"]["session_id"], "cc-session-1");
    let text = message.to_string();
    assert!(
        !text.contains(&*repo.to_string_lossy().replace('\\', "\\\\")),
        "no path leaves the PC"
    );

    let outside = cli_in(
        &p.alice,
        p.dir.path(),
        &[],
        &["send", "bob", "--text", "x", "--checkout", "auto"],
    )
    .await;
    assert_ne!(
        outside.code, 0,
        "--checkout auto outside a checkout is an error"
    );
}
