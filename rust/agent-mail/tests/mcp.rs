//! `agent-mail mcp` driven by the official TypeScript MCP SDK client (`@modelcontextprotocol/sdk`,
//! already a dependency of this repo) over stdio, the way `mcp.json` launches it. Needs
//! `npm ci` and `npm run build` (for the TS peer).

use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::Command;

use agent_maild::{start, Config, Mailer};
use serde_json::{json, Value};

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Runs `calls` ([{name, arguments}]) in one MCP session and returns
/// {tools: [names], results: [{isError, text}]}.
const DRIVER: &str = r#"
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport, getDefaultEnvironment } = await import("@modelcontextprotocol/sdk/client/stdio.js");
// The SDK passes only a short allowlist of variables to the server; run mode needs the token too.
const env = process.env.AGENT_MAIL_RUN_TOKEN ? { ...getDefaultEnvironment(), AGENT_MAIL_RUN_TOKEN: process.env.AGENT_MAIL_RUN_TOKEN } : undefined;
const transport = new StdioClientTransport({ command: process.env.BIN, args: JSON.parse(process.env.ARGS), env, stderr: "pipe" });
const client = new Client({ name: "rust-mcp-test", version: "1.0.0" });
await client.connect(transport);
const tools = (await client.listTools()).tools;
const results = [];
for (const call of JSON.parse(process.env.CALLS)) {
  try {
    const result = await client.callTool(call);
    results.push({ isError: !!result.isError, text: result.content.map((c) => c.text).join("") });
  } catch (error) {
    results.push({ isError: true, protocol: true, text: String(error.message ?? error) });
  }
}
await client.close();
console.log(JSON.stringify({ server: client.getServerVersion(), tools: tools.map((t) => ({ name: t.name, input: t.inputSchema })), results }));
"#;

fn mcp(home: &Path, calls: Value) -> Value {
    mcp_run(home, None, calls)
}

/// `mcp`, or with `run = Some((run_id, token))` run mode: `--run <id>` and AGENT_MAIL_RUN_TOKEN.
fn mcp_run(home: &Path, run: Option<(&str, &str)>, calls: Value) -> Value {
    let mut args = json!([
        "--home",
        home,
        "mcp",
        "--harness",
        "claude-code",
        "--agent-name",
        "claude",
        "--no-listen"
    ]);
    let mut command = Command::new("node");
    command.env_remove("AGENT_MAIL_RUN_TOKEN");
    if let Some((run_id, token)) = run {
        args.as_array_mut()
            .unwrap()
            .extend([json!("--run"), json!(run_id)]);
        command.env("AGENT_MAIL_RUN_TOKEN", token);
    }
    let output = command
        .args(["--input-type=module", "-e", DRIVER])
        .current_dir(repo())
        .env("BIN", env!("CARGO_BIN_EXE_agent-mail"))
        .env("ARGS", args.to_string())
        .env("CALLS", calls.to_string())
        .env_remove("AGENT_MAIL_SESSION")
        .env_remove("CLAUDE_CODE_SESSION_ID")
        .output()
        .expect("node is on PATH");
    assert!(
        output.status.success(),
        "driver failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("driver JSON")
}

fn cli(home: &Path, args: &[&str]) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_agent-mail"))
        .arg("--home")
        .arg(home)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "agent-mail {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap_or(Value::Null)
}

fn text(result: &Value) -> Value {
    serde_json::from_str(result["text"].as_str().unwrap())
        .unwrap_or_else(|_| result["text"].clone())
}

async fn mailer(home: &Path) -> Mailer {
    let mut config = Config::receive_only(
        home.to_path_buf(),
        SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
    );
    config.deliver = true;
    start(config).await.unwrap()
}

fn public_file(dir: &Path, identity: &Value) -> PathBuf {
    let path = dir.join(format!(
        "{}-public.json",
        identity["name"].as_str().unwrap()
    ));
    std::fs::write(&path, identity.to_string()).unwrap();
    path
}

fn allow(home: &Path, peers: &[&str]) {
    cli(home, &["policy", "init"]);
    let mut policy: Value =
        serde_json::from_str(&std::fs::read_to_string(home.join("policy.json")).unwrap()).unwrap();
    policy["allowed_peers"] = json!(peers);
    std::fs::write(home.join("policy.json"), policy.to_string()).unwrap();
}

const PEER_TOOLS: [&str; 10] = [
    "whoami",
    "discover_peers",
    "list_agents",
    "send_message",
    "reply_to_message",
    "fetch_inbox",
    "acknowledge_message",
    "get_thread",
    "queue_status",
    "retry_outbox",
];

const SESSION_TOOLS: [&str; 11] = [
    "mailbox_register_session",
    "mailbox_list_sessions",
    "mailbox_session_heartbeat",
    "mailbox_session_end",
    "mailbox_lease_conversation",
    "mailbox_release_conversation",
    "mailbox_publish",
    "mailbox_list",
    "mailbox_ack",
    "mailbox_search",
    "mailbox_poll",
];

#[tokio::test(flavor = "multi_thread")]
async fn official_sdk_client_lists_and_calls_the_tools() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("solo");
    let identity = cli(&home, &["init", "--name", "solo"]);
    let out = tokio::task::spawn_blocking(move || {
        mcp(
            &home,
            json!([
                { "name": "whoami", "arguments": {} },
                { "name": "queue_status", "arguments": {} },
                { "name": "mailbox_claim_task", "arguments": { "session_id": "s", "task_id": "t" } },
                { "name": "fetch_inbox", "arguments": { "limit": 0 } },
                { "name": "send_message", "arguments": { "recipient": "nobody", "text": "hi", "bogus": 1 } },
            ]),
        )
    })
    .await
    .unwrap();

    let names: Vec<&str> = out["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    for tool in PEER_TOOLS.iter().chain(&SESSION_TOOLS).chain(&[
        "mailbox_subscribe",
        "mailbox_offer_task",
        "mailbox_claim_task",
        "mailbox_sync_status",
    ]) {
        assert!(names.contains(tool), "{tool} missing from {names:?}");
    }
    let send = out["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "send_message")
        .unwrap();
    let properties = send["input"]["properties"].as_object().unwrap();
    for field in [
        "recipient",
        "text",
        "message_id",
        "conversation_id",
        "to_session",
        "hop",
        "auto_reply",
        "in_reply_to",
        "project",
    ] {
        assert!(properties.contains_key(field), "send_message lacks {field}");
    }
    assert_eq!(out["server"]["name"], "agent-mail");

    let results = out["results"].as_array().unwrap();
    let whoami = text(&results[0]);
    assert_eq!(whoami["fingerprint"], identity["fingerprint"]);
    assert_eq!(whoami["agent"]["harness"], "claude-code");
    assert_eq!(text(&results[1])["pending"], 0);
    assert!(results[2]["isError"].as_bool().unwrap());
    assert!(results[2]["text"]
        .as_str()
        .unwrap()
        .starts_with("not_ported"));
    assert!(
        results[3]["isError"].as_bool().unwrap(),
        "limit 0 is refused"
    );
    assert!(
        results[4]["isError"].as_bool().unwrap(),
        "unknown arguments are refused"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn send_and_automatic_reply_over_mcp_keep_the_project_and_the_guards() {
    let dir = tempfile::tempdir().unwrap();
    let (alice, bob) = (dir.path().join("alice"), dir.path().join("bob"));
    let alice_id = cli(&alice, &["init", "--name", "alice"]);
    let bob_id = cli(&bob, &["init", "--name", "bob"]);
    let (alice_mailer, bob_mailer) = (mailer(&alice).await, mailer(&bob).await);
    let (alice_fp, bob_fp) = (
        alice_id["fingerprint"].as_str().unwrap(),
        bob_id["fingerprint"].as_str().unwrap(),
    );
    let to_bob = format!("http://127.0.0.1:{}", bob_mailer.port);
    let to_alice = format!("http://127.0.0.1:{}", alice_mailer.port);
    cli(
        &alice,
        &[
            "trust",
            "--file",
            public_file(dir.path(), &bob_id).to_str().unwrap(),
            "--fingerprint",
            bob_fp,
            "--endpoint",
            &to_bob,
        ],
    );
    cli(
        &bob,
        &[
            "trust",
            "--file",
            public_file(dir.path(), &alice_id).to_str().unwrap(),
            "--fingerprint",
            alice_fp,
            "--endpoint",
            &to_alice,
        ],
    );
    allow(&alice, &["bob"]);
    allow(&bob, &["alice"]);

    let home = alice.clone();
    let sent = tokio::task::spawn_blocking(move || {
        mcp(
            &home,
            json!([
                { "name": "send_message", "arguments": { "recipient": "bob", "text": "what is the build status?", "project": "synthet-agent-mailbox", "session_id": "alice-s1" } },
                { "name": "send_message", "arguments": { "recipient": "bob", "text": "token = abcdefghijkl" } },
            ]),
        )
    })
    .await
    .unwrap();
    let results = sent["results"].as_array().unwrap();
    let delivered = text(&results[0]);
    assert_eq!(delivered["status"], "delivered", "{delivered}");
    assert!(
        delivered.get("envelope_downgraded").is_none(),
        "Rust to Rust keeps 1.2"
    );
    assert!(results[1]["isError"].as_bool().unwrap());
    assert!(
        results[1]["text"]
            .as_str()
            .unwrap()
            .contains("send refused"),
        "policy is checked on MCP sends too"
    );

    let question = &cli(&bob, &["inbox"])[0];
    assert_eq!(question["project"], "synthet-agent-mailbox");
    let (sender, id) = (
        question["sender"].as_str().unwrap().to_owned(),
        question["id"].as_str().unwrap().to_owned(),
    );
    let home = bob.clone();
    let replied = tokio::task::spawn_blocking(move || {
        let reply = |text: &str| json!({ "name": "reply_to_message", "arguments": { "sender": sender, "message_id": id, "text": text, "automatic": true } });
        mcp(&home, json!([reply("green on main"), reply("a second automatic reply")]))
    })
    .await
    .unwrap();
    let results = replied["results"].as_array().unwrap();
    assert_eq!(text(&results[0])["status"], "delivered", "{}", results[0]);
    assert!(results[1]["isError"].as_bool().unwrap());
    assert!(results[1]["text"]
        .as_str()
        .unwrap()
        .contains("already has an automatic reply"));

    let answer = &cli(&alice, &["inbox"])[0];
    assert_eq!(answer["text"], "green on main");
    assert_eq!(answer["auto_reply"], true);
    assert_eq!(answer["hop"], 1);
    assert_eq!(answer["in_reply_to"], question["id"]);
    assert_eq!(answer["conversation_id"], question["conversation_id"]);
    assert_eq!(
        answer["to_session"], "alice-s1",
        "the reply goes back to the asking session"
    );
    assert_eq!(
        answer["project"], "synthet-agent-mailbox",
        "a reply stays in the question's project"
    );

    // An automatic reply to an automatic message is refused before anything is queued.
    let (sender, id) = (
        answer["sender"].as_str().unwrap().to_owned(),
        answer["id"].as_str().unwrap().to_owned(),
    );
    let home = alice.clone();
    let loop_guard = tokio::task::spawn_blocking(move || {
        mcp(&home, json!([{ "name": "reply_to_message", "arguments": { "sender": sender, "message_id": id, "text": "thanks", "automatic": true } }]))
    })
    .await
    .unwrap();
    assert!(loop_guard["results"][0]["text"]
        .as_str()
        .unwrap()
        .contains("itself an automatic reply"));
}

#[tokio::test(flavor = "multi_thread")]
async fn same_pc_sessions_leases_and_direct_messages_over_mcp() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("solo");
    let identity = cli(&home, &["init", "--name", "solo"]);
    let host_fp = identity["fingerprint"].as_str().unwrap().to_owned();
    let first = {
        let home = home.clone();
        tokio::task::spawn_blocking(move || {
            mcp(
                &home,
                json!([
                    { "name": "mailbox_lease_conversation", "arguments": { "session_id": "main", "conversation_id": "c1" } },
                    { "name": "mailbox_register_session", "arguments": { "session_id": "main", "workspace": "D:/w", "display_name": "main" } },
                    { "name": "mailbox_register_session", "arguments": { "session_id": "rev", "alias": "reviewer", "harness": "codex" } },
                    { "name": "mailbox_lease_conversation", "arguments": { "session_id": "main", "conversation_id": "c1" } },
                    { "name": "mailbox_lease_conversation", "arguments": { "session_id": "rev", "conversation_id": "c1" } },
                    { "name": "mailbox_list_sessions", "arguments": {} },
                    { "name": "mailbox_publish", "arguments": { "session_id": "main", "agent_id": "nope", "body": "x" } },
                    { "name": "mailbox_publish", "arguments": { "session_id": "main", "audience": "broadcast", "scope_id": "all", "body": "x" } },
                ]),
            )
        })
        .await
        .unwrap()
    };
    let results = first["results"].as_array().unwrap();
    assert!(
        results[0]["isError"].as_bool().unwrap(),
        "unregistered session"
    );
    assert_eq!(text(&results[1])["agent_id"], host_fp.as_str());
    let reviewer = text(&results[2])["agent_id"].as_str().unwrap().to_owned();
    assert_eq!(text(&results[3])["status"], "leased");
    assert_eq!(text(&results[4])["status"], "lease_conflict");
    let sessions = text(&results[5]);
    let main = sessions
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["session_id"] == "main")
        .unwrap();
    assert_eq!(main["alias"], "solo");
    assert_eq!(main["workspace"], "D:/w");
    assert_eq!(main["leases"][0]["conversation_id"], "c1");
    assert!(
        !sessions.to_string().contains("body"),
        "no bodies in the directory"
    );
    assert!(text(&results[6]).to_string().contains("Unknown agent"));
    assert!(text(&results[7]).to_string().contains("not_ported"));

    let second = {
        let home = home.clone();
        tokio::task::spawn_blocking(move || {
            mcp(
                &home,
                json!([
                    { "name": "mailbox_publish", "arguments": { "session_id": "main", "agent_id": reviewer, "subject": "review #7", "body": "please look at the diff" } },
                    { "name": "mailbox_poll", "arguments": { "session_id": "rev" } },
                    { "name": "mailbox_search", "arguments": { "session_id": "rev", "query": "diff" } },
                    { "name": "mailbox_list", "arguments": { "session_id": "rev" } },
                    { "name": "mailbox_session_heartbeat", "arguments": { "session_id": "main" } },
                    { "name": "mailbox_release_conversation", "arguments": { "session_id": "main", "conversation_id": "c1" } },
                    { "name": "mailbox_session_end", "arguments": { "session_id": "rev" } },
                ]),
            )
        })
        .await
        .unwrap()
    };
    let results = second["results"].as_array().unwrap();
    let published = text(&results[0]);
    let message_id = published["message_id"].as_str().unwrap().to_owned();
    let poll = text(&results[1]);
    assert_eq!(poll["messages"][0]["subject"], "review #7");
    assert!(
        !poll.to_string().contains("please look"),
        "poll is metadata only"
    );
    assert!(!text(&results[2]).to_string().contains("please look"));
    assert_eq!(text(&results[3])[0]["body"], "please look at the diff");
    assert_eq!(text(&results[3])[0]["untrusted"], true);
    assert_eq!(text(&results[4])["leases_renewed"], 1);
    assert_eq!(text(&results[5])["released"], true);
    assert_eq!(text(&results[6])["session_id"], "rev");

    let acked = tokio::task::spawn_blocking(move || {
        mcp(
            &home,
            json!([
                { "name": "mailbox_ack", "arguments": { "session_id": "rev", "message_id": message_id } },
                { "name": "mailbox_list", "arguments": { "session_id": "rev" } },
            ]),
        )
    })
    .await
    .unwrap();
    assert_eq!(text(&acked["results"][0])["acknowledged"], true);
    assert_eq!(text(&acked["results"][1]), json!([]));
}

/// Two paired homes with mailers; Bob asks Alice a question and Alice's store gets a running run
/// for it, bound to `token`. Returns (alice home, bob home, question, mailers).
async fn run_for_question(dir: &Path, token: &str) -> (PathBuf, PathBuf, Value, (Mailer, Mailer)) {
    let (alice, bob) = (dir.join("alice"), dir.join("bob"));
    let alice_id = cli(&alice, &["init", "--name", "alice"]);
    let bob_id = cli(&bob, &["init", "--name", "bob"]);
    let (alice_mailer, bob_mailer) = (mailer(&alice).await, mailer(&bob).await);
    for (home, other, port) in [
        (&alice, &bob_id, bob_mailer.port),
        (&bob, &alice_id, alice_mailer.port),
    ] {
        cli(
            home,
            &[
                "trust",
                "--file",
                public_file(dir, other).to_str().unwrap(),
                "--fingerprint",
                other["fingerprint"].as_str().unwrap(),
                "--endpoint",
                &format!("http://127.0.0.1:{port}"),
            ],
        );
    }
    allow(&alice, &["bob"]);
    allow(&bob, &["alice"]);
    let home = bob.clone();
    tokio::task::spawn_blocking(move || {
        mcp(
            &home,
            json!([{ "name": "send_message", "arguments": { "recipient": "alice", "text": "which version?", "session_id": "bob-s1" } }]),
        )
    })
    .await
    .unwrap();
    let question = cli(&alice, &["inbox"])[0].clone();
    let store = mail_core::store::Store::open(&alice).unwrap();
    store
        .start_run(&mail_core::runs::Run {
            run_id: "run-1".into(),
            sender: question["sender"].as_str().unwrap().into(),
            message_id: question["id"].as_str().unwrap().into(),
            conversation_id: question["conversation_id"].as_str().unwrap().into(),
            project: None,
            workspace: "w".into(),
            tier: "reply".into(),
            runner: "claude".into(),
            state: "running".into(),
            outcome: None,
            cost_usd: None,
            reply_id: None,
            created_at: mail_core::store::now_ms(),
            finished_at: None,
        })
        .unwrap();
    store
        .bind_run_token("run-1", token, mail_core::store::now_ms() + 120_000)
        .unwrap();
    (alice, bob, question, (alice_mailer, bob_mailer))
}

#[tokio::test(flavor = "multi_thread")]
async fn run_mode_offers_only_the_run_bound_tools_and_replies_once_to_the_runs_message() {
    let dir = tempfile::tempdir().unwrap();
    let (alice, bob, question, _mailers) = run_for_question(dir.path(), "tok-1").await;
    let (sender, id) = (
        question["sender"].as_str().unwrap().to_owned(),
        question["id"].as_str().unwrap().to_owned(),
    );
    let reviewer = {
        let home = alice.clone();
        tokio::task::spawn_blocking(move || {
            mcp(&home, json!([{ "name": "mailbox_register_session", "arguments": { "session_id": "rev", "alias": "reviewer" } }]))
        })
        .await
        .unwrap()
    };
    let reviewer = text(&reviewer["results"][0])["agent_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let wrong = {
        let (home, sender, id) = (alice.clone(), sender.clone(), id.clone());
        tokio::task::spawn_blocking(move || {
            mcp_run(
                &home,
                Some(("run-1", "not-the-token")),
                json!([
                    { "name": "reply_to_message", "arguments": { "sender": sender, "message_id": id, "text": "v1" } },
                    { "name": "mailbox_list_sessions", "arguments": {} },
                ]),
            )
        })
        .await
        .unwrap()
    };
    for result in wrong["results"].as_array().unwrap() {
        assert!(result["isError"].as_bool().unwrap());
        assert!(
            result["text"].as_str().unwrap().contains("wrong run token"),
            "{result}"
        );
    }

    let other_id = mail_core::send::new_uuid();
    let alice_home = alice.clone();
    let run = tokio::task::spawn_blocking(move || {
        mcp_run(
            &alice,
            Some(("run-1", "tok-1")),
            json!([
                { "name": "send_message", "arguments": { "recipient": "bob", "text": "hi" } },
                { "name": "fetch_inbox", "arguments": {} },
                { "name": "mailbox_register_session", "arguments": { "session_id": "x" } },
                { "name": "mailbox_list_sessions", "arguments": {} },
                { "name": "mailbox_publish", "arguments": { "session_id": "rev", "agent_id": reviewer, "body": "bob asked which version" } },
                { "name": "reply_to_message", "arguments": { "sender": sender, "message_id": other_id, "text": "redirected" } },
                { "name": "reply_to_message", "arguments": { "sender": sender, "message_id": id, "text": "v0.4.0", "automatic": false } },
                { "name": "reply_to_message", "arguments": { "sender": sender, "message_id": id, "text": "again" } },
            ]),
        )
    })
    .await
    .unwrap();
    let mut listed: Vec<&str> = run["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    listed.sort();
    assert_eq!(
        listed,
        [
            "mailbox_list_sessions",
            "mailbox_publish",
            "reply_to_message"
        ],
        "run mode lists only its tools"
    );
    let results = run["results"].as_array().unwrap();
    for refused in &results[0..3] {
        assert!(refused["isError"].as_bool().unwrap(), "{refused}");
    }
    assert!(!results[3]["isError"].as_bool().unwrap(), "{}", results[3]);
    let published = text(&results[4]);
    assert_eq!(published["duplicate"], false, "{published}");
    assert!(results[5]["text"]
        .as_str()
        .unwrap()
        .contains("only the message it was started for"));
    assert_eq!(text(&results[6])["status"], "delivered", "{}", results[6]);
    assert!(
        results[7]["text"]
            .as_str()
            .unwrap()
            .contains("already replied"),
        "{}",
        results[7]
    );

    // The run published under its own alias, not as this PC's host agent.
    let host_fp = cli(&alice_home, &["identity"])["fingerprint"].clone();
    let note = tokio::task::spawn_blocking(move || {
        mcp(
            &alice_home,
            json!([{ "name": "mailbox_list", "arguments": { "session_id": "rev" } }]),
        )
    })
    .await
    .unwrap();
    let note = text(&note["results"][0])[0].clone();
    assert_eq!(note["sender_session"], "run:run-1");
    assert_ne!(note["sender_agent"], host_fp);

    let answer = cli(&bob, &["inbox"])[0].clone();
    assert_eq!(answer["text"], "v0.4.0");
    assert_eq!(
        answer["auto_reply"], true,
        "a run's reply is always automatic"
    );
    assert_eq!(answer["in_reply_to"], question["id"]);
    assert_eq!(answer["conversation_id"], question["conversation_id"]);
    assert_eq!(answer["to_session"], "bob-s1");
}

#[tokio::test(flavor = "multi_thread")]
async fn cli_reply_in_run_mode_checks_the_token() {
    let dir = tempfile::tempdir().unwrap();
    let (alice, bob, question, _mailers) = run_for_question(dir.path(), "tok-2").await;
    let reply = |token: &str| {
        Command::new(env!("CARGO_BIN_EXE_agent-mail"))
            .arg("--home")
            .arg(&alice)
            .args(["reply", "--run", "run-1", "--text", "from the cli"])
            .env("AGENT_MAIL_RUN_TOKEN", token)
            .output()
            .unwrap()
    };
    let wrong = reply("nope");
    assert_eq!(wrong.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&wrong.stderr).contains("wrong run token"));
    let right = reply("tok-2");
    assert_eq!(
        right.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&right.stderr)
    );
    let again = reply("tok-2");
    assert!(String::from_utf8_lossy(&again.stderr).contains("already replied"));
    let answer = cli(&bob, &["inbox"])[0].clone();
    assert_eq!(answer["text"], "from the cli");
    assert_eq!(answer["in_reply_to"], question["id"]);
}

#[test]
fn migrate_leaves_policy_json_and_the_ts_home_alone() {
    let dir = tempfile::tempdir().unwrap();
    let (home, ts) = (dir.path().join("rs"), dir.path().join("ts"));
    cli(&home, &["init", "--name", "solo"]);
    cli(&home, &["policy", "init"]);
    std::fs::create_dir_all(ts.join("inbox")).unwrap();
    std::fs::write(ts.join("policy.json"), "{\"allowed_peers\":[\"x\"]}").unwrap();
    let before = (
        std::fs::read(home.join("policy.json")).unwrap(),
        std::fs::read(ts.join("policy.json")).unwrap(),
    );
    let report = cli(&home, &["migrate", "--from", ts.to_str().unwrap()]);
    assert_eq!(
        report["journal"],
        Value::Null,
        "no journal.db, nothing to import"
    );
    let after = (
        std::fs::read(home.join("policy.json")).unwrap(),
        std::fs::read(ts.join("policy.json")).unwrap(),
    );
    assert_eq!(before, after);

    // Without an identity nothing is imported at all.
    let bare = dir.path().join("bare");
    let out = Command::new(env!("CARGO_BIN_EXE_agent-mail"))
        .arg("--home")
        .arg(&bare)
        .args(["migrate", "--from", ts.to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(!bare.join("mail.db").exists());
}
