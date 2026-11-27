//! `agent-mail`: the CLI (ADR 0005). It never opens a network socket. `send` checks policy and
//! queues through `mail_core::send::submit`, then pokes the mailer (`agent-maild`) and waits briefly
//! to report delivered (exit 0) or queued (exit 2). Errors exit 1.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use agent_mail::install::{self, Program};
use agent_mail::ops::{self, Outcome};
use agent_mail::reply::RunContext;
use agent_mail::{harness, hook};
use clap::{Parser, Subcommand};
use mail_core::identity::{fingerprint, validate_public, Identity, PublicIdentity};
use mail_core::migrate::{import_journal, import_json_store};
use mail_core::policy::Policy;
use mail_core::send::{
    agent_profile, agent_profile_fixed, local_origin, validate_endpoint, ReplyRequest, SendRequest,
};
use mail_core::sessions::{Publish, Registration};
use mail_core::store::{now_ms, Store};
use mail_core::{ipc, js};
use serde_json::{json, Value};

#[derive(Parser)]
#[command(
    name = "agent-mail",
    version,
    about = "Direct encrypted peer messaging through the local agent-maild mailer"
)]
struct Cli {
    /// agent-mail home (identity.json, policy.json, mail.db). Required until the TS cutover (T-10).
    #[arg(long, global = true)]
    home: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Create local Ed25519/X25519 keys.
    Init {
        #[arg(long)]
        name: Option<String>,
    },
    /// Print this host's public identity.
    Identity,
    /// List hosts the mailer has seen recently (multicast, hosts.json, Tailscale).
    Discover {
        #[arg(long, default_value_t = 10)]
        since_minutes: u64,
    },
    /// Pin a peer: from a discovered host, or offline from its public.json.
    Trust {
        /// Discovered host name to match (optional with --file).
        name: Option<String>,
        #[arg(long)]
        fingerprint: String,
        #[arg(long)]
        file: Option<PathBuf>,
        #[arg(long)]
        endpoint: Option<String>,
    },
    /// Revoke a pinned peer.
    Untrust { fingerprint: String },
    /// List pinned peers.
    Peers,
    /// Queue a message for a pinned peer and wait briefly for delivery.
    Send {
        recipient: String,
        #[arg(long, conflicts_with = "file")]
        text: Option<String>,
        /// Read exact UTF-8 text from a file (- for stdin).
        #[arg(long)]
        file: Option<String>,
        #[arg(long)]
        message_id: Option<String>,
        #[arg(long)]
        conversation: Option<String>,
        #[arg(long)]
        harness: Option<String>,
        #[arg(long)]
        agent_name: Option<String>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        session: Option<String>,
        /// Project tag (agent-mail/1.2); dropped for peers that don't accept it.
        #[arg(long)]
        project: Option<String>,
        /// `auto`: send this folder's repo identity (root commits, origin, head, branch; agent-mail/1.3).
        #[arg(long, value_parser = ["auto"])]
        checkout: Option<String>,
        /// `notify` wakes a live session; `task` runs an agent in the matched checkout (agent-mail/1.3).
        #[arg(long, value_parser = ["notify", "task"])]
        intent: Option<String>,
        /// How long to wait for the mailer's first attempt before reporting "queued".
        #[arg(long, default_value_t = 8000)]
        wait_ms: u64,
    },
    /// Unacknowledged messages, oldest first.
    Inbox {
        #[arg(long, default_value_t = 50)]
        limit: usize,
    },
    /// Mark a received message read.
    Ack {
        message_id: String,
        #[arg(long)]
        sender: String,
    },
    /// Local history of one conversation.
    Thread { conversation_id: String },
    /// Queue counts and whether the mailer is running.
    Status,
    /// Make every queued message due now and wake the mailer.
    Flush,
    /// Import the TS JSON store (contacts, inbox, acked, outbox, sent); never changes the source.
    Migrate {
        /// TS home to read; defaults to --home.
        #[arg(long)]
        from: Option<PathBuf>,
    },
    /// Write a deny-all policy.json, or validate the existing one.
    Policy {
        #[command(subcommand)]
        action: PolicyAction,
    },
    /// Start agent-maild at logon for this home (a per-user task; no admin needed).
    Service {
        #[command(subcommand)]
        action: TaskAction,
        /// Mailer TCP port for `service install` (another than 47832 to run beside the TS listener).
        #[arg(long, default_value_t = 47832, global = true)]
        port: u16,
    },
    /// Start agent-mail-tray at logon for this home (a per-user task; no admin needed).
    Tray {
        #[command(subcommand)]
        action: TaskAction,
        /// Dashboard port for `tray install`.
        #[arg(long, default_value_t = 8788, global = true)]
        port: u16,
    },
    /// Serve the MCP tools on stdio (for mcp.json). Never opens a network socket.
    Mcp {
        /// Harness name sent as agent metadata (e.g. claude-code).
        #[arg(long)]
        harness: Option<String>,
        #[arg(long)]
        agent_name: Option<String>,
        #[arg(long)]
        model: Option<String>,
        /// Accepted for TS mcp.json compatibility; the Rust server never listens.
        #[arg(long, hide = true)]
        no_listen: bool,
        /// Run mode for a headless run: only the run-bound tools, token from AGENT_MAIL_RUN_TOKEN.
        #[arg(long, value_name = "RUN_ID")]
        run: Option<String>,
    },
    /// Reply to a received message in its thread. With --run, answer the run's own message
    /// (token from AGENT_MAIL_RUN_TOKEN, always automatic, once).
    Reply {
        /// Fingerprint of the peer that sent the message (not with --run).
        #[arg(long, required_unless_present = "run", conflicts_with = "run")]
        sender: Option<String>,
        /// Id of the received message (not with --run).
        #[arg(long, required_unless_present = "run", conflicts_with = "run")]
        message_id: Option<String>,
        #[arg(long, conflicts_with = "file")]
        text: Option<String>,
        /// Read exact UTF-8 text from a file (- for stdin).
        #[arg(long)]
        file: Option<String>,
        /// No human wrote or approved this reply: send it with auto_reply.
        #[arg(long, conflicts_with = "run")]
        automatic: bool,
        /// Reuse on retry to avoid a duplicate reply.
        #[arg(long, conflicts_with = "run")]
        reply_id: Option<String>,
        #[arg(long, value_name = "RUN_ID")]
        run: Option<String>,
        #[arg(long, default_value_t = 8000)]
        wait_ms: u64,
    },
    /// Register this session for same-PC mail (alias from --agent-name; default: this host).
    Register {
        #[arg(long)]
        session: String,
        #[arg(long)]
        agent_name: Option<String>,
        #[arg(long)]
        harness: Option<String>,
        #[arg(long)]
        model: Option<String>,
        /// The harness's own session, thread or chat id.
        #[arg(long)]
        harness_session: Option<String>,
        #[arg(long)]
        display_name: Option<String>,
        #[arg(long)]
        workspace: Option<String>,
    },
    /// Keep a session live (10 min TTL), end it (releases its leases), or list live sessions.
    Session {
        #[arg(value_parser = ["heartbeat", "end", "list"])]
        action: String,
        #[arg(long)]
        session: Option<String>,
    },
    /// 30 min conversation lease: one session answers a thread. Not a task claim, and not an access
    /// control. `claim` exits 2 on lease_conflict.
    Lease {
        #[arg(value_parser = ["claim", "release", "show"])]
        action: String,
        #[arg(long)]
        conversation: String,
        #[arg(long)]
        session: Option<String>,
    },
    /// Publish a direct message to an agent on this PC.
    Publish {
        /// Recipient agent id (from register or `session list`).
        agent_id: String,
        #[arg(long)]
        session: String,
        #[arg(long)]
        text: String,
        #[arg(long)]
        subject: Option<String>,
    },
    /// A short untrusted digest, or with --unseen this session's unacked mail it hasn't been shown.
    Digest {
        /// Defaults to AGENT_MAIL_SESSION.
        #[arg(long)]
        session: Option<String>,
        #[arg(long)]
        unseen: bool,
        /// With --unseen: include bodies (cut at 4000 characters).
        #[arg(long)]
        json: bool,
        /// Record shown messages (repeatable; KEY from --unseen).
        #[arg(long = "mark-seen", value_name = "KEY")]
        mark_seen: Vec<String>,
    },
    /// Hook entry points (inject|gate|ledger). Read the hook JSON on stdin; never break the session.
    Hook {
        verb: String,
        /// SessionStart, UserPromptSubmit or Stop (inject; defaults to hook_event_name).
        #[arg(long)]
        event: Option<String>,
        #[arg(long)]
        harness: Option<String>,
    },
    /// One JSON line per new message for this session: ids, thread and sender, never bodies.
    Watch {
        /// Defaults to AGENT_MAIL_SESSION.
        #[arg(long)]
        session: Option<String>,
        #[arg(long)]
        once: bool,
        /// Report the existing backlog on the first poll instead of starting from now.
        #[arg(long)]
        backlog: bool,
        #[arg(long, default_value_t = 2000)]
        interval: u64,
    },
    /// Project-local hook templates that run this agent-mail against this home.
    Harness {
        #[arg(value_parser = ["install", "inspect", "uninstall"])]
        action: String,
        #[arg(long)]
        target: PathBuf,
        /// claude, codex, cursor or agy (install).
        #[arg(long)]
        harness: Option<String>,
    },
}

#[derive(Subcommand)]
enum TaskAction {
    /// Register the logon task (replaces an existing one for this home).
    Install {
        /// Executable to run; defaults to the one next to agent-mail.
        #[arg(long)]
        exe: Option<PathBuf>,
        /// Also start it now.
        #[arg(long)]
        start: bool,
    },
    /// Remove the logon task.
    Uninstall,
    /// Whether the logon task exists.
    Status,
}

#[derive(Subcommand)]
enum PolicyAction {
    Init,
    Check,
}

type Failure = Box<dyn std::error::Error>;

fn main() -> ExitCode {
    let cli = Cli::parse();
    let Some(home) = cli.home else {
        // PreToolUse treats exit 1 as "no objection", so the send gate denies instead (fails closed).
        if let Command::Hook { verb, .. } = &cli.command {
            if verb == "gate" {
                let mut raw = String::new();
                let _ = std::io::stdin().read_to_string(&mut raw);
                if let Some(response) = hook::gate_without_home(&hook::ToolInput::parse(&raw)) {
                    println!("{response}");
                }
                return ExitCode::SUCCESS;
            }
        }
        eprintln!("agent-mail: --home is required (the Rust tools never default to the live TS home before cutover)");
        return ExitCode::from(1);
    };
    match run(&home, cli.command) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}

fn print(value: &impl serde::Serialize) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).expect("output serializes")
    );
}

fn run(home: &Path, command: Command) -> Result<ExitCode, Failure> {
    match command {
        Command::Init { name } => {
            let name = name.unwrap_or_else(|| local_origin().hostname);
            let identity = Identity::generate(&name)?;
            write_new(
                &home.join("identity.json"),
                &(serde_json::to_string_pretty(&identity)?),
            )?;
            Store::open(home)?;
            print(&ops::whoami(
                &identity,
                agent_profile(None, None, None, None).as_ref(),
            )?);
        }
        Command::Identity => print(&ops::whoami(
            &Identity::load(home)?,
            agent_profile(None, None, None, None).as_ref(),
        )?),
        Command::Discover { since_minutes } => {
            let since = now_ms().saturating_sub(since_minutes * 60_000);
            print(&Store::open(home)?.hosts(since)?);
            if !ops::mailer_running(home) {
                eprintln!(
                    "agent-maild is not running for this home, so this list is not being refreshed"
                );
            }
        }
        Command::Trust {
            name,
            fingerprint: expected,
            file,
            endpoint,
        } => {
            let expected = expected.to_lowercase();
            let store = Store::open(home)?;
            let (identity, endpoint) = match file {
                Some(file) => (read_public(&file)?, endpoint),
                None => {
                    let (identity, seen) = store
                        .seen_identity(&expected)?
                        .filter(|(identity, _)| name.as_ref().is_none_or(|name| identity.name.eq_ignore_ascii_case(name)))
                        .ok_or("No discovered peer matches that name and fingerprint; use --file for offline pairing")?;
                    (identity, endpoint.or(Some(seen)))
                }
            };
            if let Some(endpoint) = &endpoint {
                validate_endpoint(endpoint)?;
            }
            store.trust(&identity, Some(&expected), endpoint.as_deref())?;
            print(&json!({ "identity": identity, "endpoint": endpoint }));
        }
        Command::Untrust { fingerprint } => {
            let fingerprint = fingerprint.to_lowercase();
            if !js::is_fingerprint(&fingerprint) {
                return Err("Use the full fingerprint".into());
            }
            Store::open(home)?.untrust(&fingerprint)?;
            print(&json!({ "revoked": fingerprint }));
        }
        Command::Peers => print(&Store::open(home)?.contacts()?),
        Command::Send {
            recipient,
            text,
            file,
            message_id,
            conversation,
            harness,
            agent_name,
            model,
            session,
            project,
            checkout,
            intent,
            wait_ms,
        } => {
            let text = match (text, file) {
                (Some(text), None) => text,
                (None, Some(file)) => read_text(&file)?,
                _ => return Err("Provide exactly one of --text or --file".into()),
            };
            let request = SendRequest {
                recipient,
                text,
                message_id,
                conversation_id: conversation,
                agent: agent_profile(harness, agent_name, model, session),
                project,
                checkout: checkout_arg(checkout.as_deref())?,
                intent: intent_arg(intent.as_deref()),
                ..SendRequest::default()
            };
            return match ops::send_and_wait(home, request, Duration::from_millis(wait_ms))? {
                Outcome::Delivered(value) => {
                    print(&value);
                    Ok(ExitCode::SUCCESS)
                }
                Outcome::Queued(value) => {
                    print(&value);
                    Ok(ExitCode::from(2))
                }
            };
        }
        Command::Inbox { limit } => print(&Store::open(home)?.inbox(limit)?),
        Command::Ack { message_id, sender } => {
            Store::open(home)?.ack(&sender.to_lowercase(), &message_id)?;
            print(&json!({ "acknowledged": true }));
        }
        Command::Thread { conversation_id } => print(&Store::open(home)?.thread(&conversation_id)?),
        Command::Status => {
            let counts = Store::open(home)?.counts()?;
            print(
                &json!({ "pending": counts.pending, "unread": counts.unread, "sent": counts.sent, "mailer_running": ops::mailer_running(home) }),
            );
        }
        Command::Flush => {
            let queued = Store::open(home)?.retry_all()?;
            print(&json!({ "queued": queued, "mailer_running": ipc::poke(home) }));
        }
        Command::Migrate { from } => {
            let from = from.unwrap_or_else(|| home.to_path_buf());
            // The identity first: without it nothing is imported, rather than half the areas.
            let host = agent_mail::reply::host(&Identity::load(home)?)?;
            let store = Store::open(home)?;
            let mut report = serde_json::to_value(import_json_store(&from, &store)?)?;
            report["journal"] = serde_json::to_value(import_journal(&from, &store, &host)?)?;
            print(&report);
        }
        Command::Register {
            session,
            agent_name,
            harness,
            model,
            harness_session,
            display_name,
            workspace,
        } => {
            let host = agent_mail::reply::host(&Identity::load(home)?)?;
            print(&Store::open(home)?.register_session(
                &host,
                &Registration {
                    session_id: session,
                    alias: agent_name,
                    harness,
                    model,
                    harness_session_id: harness_session,
                    display_name,
                    workspace,
                },
            )?);
        }
        Command::Session { action, session } => {
            let mut store = Store::open(home)?;
            let session = || session.clone().ok_or("Missing --session");
            match action.as_str() {
                "list" => print(&store.live_sessions()?),
                "heartbeat" => print(&store.heartbeat(&session()?)?),
                _ => print(&store.end_session(&session()?)?),
            }
        }
        Command::Lease {
            action,
            conversation,
            session,
        } => {
            let mut store = Store::open(home)?;
            let session = || session.clone().ok_or("Missing --session");
            match action.as_str() {
                "show" => print(&json!({ "lease": store.conversation_lease(&conversation)? })),
                "release" => print(&store.release_conversation(&session()?, &conversation)?),
                _ => {
                    let result = store.lease_conversation(&session()?, &conversation)?;
                    print(&result);
                    if result["status"] == "lease_conflict" {
                        return Ok(ExitCode::from(2));
                    }
                }
            }
        }
        Command::Publish {
            agent_id,
            session,
            text,
            subject,
        } => print(&Store::open(home)?.publish_local(&Publish {
            session_id: session,
            body: text,
            subject,
            audience: None,
            agent_id: Some(agent_id),
            idempotency_key: None,
        })?),
        Command::Digest {
            session,
            unseen,
            json: bodies,
            mark_seen,
        } => {
            let session = session.or_else(|| std::env::var("AGENT_MAIL_SESSION").ok());
            if unseen || !mark_seen.is_empty() {
                let session = session.ok_or("Missing --session")?;
                let store = Store::open_existing(home)?;
                let seen = hook::SeenStore::new(home, &session)?;
                if !mark_seen.is_empty() {
                    print(&json!({ "ok": true, "marked": seen.mark(&mark_seen)? }));
                } else {
                    let messages = hook::unseen(&store, &seen, &session, 20, bodies)
                        .map_err(|error| error.to_string())?;
                    print(
                        &json!({ "ok": true, "untrusted": true, "session": session, "messages": messages }),
                    );
                }
            } else {
                let session = session.unwrap_or_else(|| "cli".into());
                match Store::open_existing(home).and_then(|store| store.local_digest(&session, 5)) {
                    Ok(digest) => print(&digest),
                    Err(error) => print(
                        &json!({ "ok": true, "untrusted": true, "messages": [], "warning": error.to_string() }),
                    ),
                }
            }
        }
        Command::Hook {
            verb,
            event,
            harness,
        } => run_hook(home, &verb, event, harness.as_deref()),
        Command::Watch {
            session,
            once,
            backlog,
            interval,
        } => {
            let session = session
                .or_else(|| std::env::var("AGENT_MAIL_SESSION").ok())
                .ok_or("Missing --session")?;
            let interval = Duration::from_millis(interval.max(500));
            let mut last_beat: Option<std::time::Instant> = None;
            // Opened once: each open takes a short write lock for the schema check.
            let mut store = Store::open_existing(home)?;
            loop {
                match hook::watch_poll(home, &store, &session, backlog)
                    .map_err(|error| error.to_string())
                    .inspect(|_| {
                        // Liveness goes to mail.db, not stdout: under a monitor every line wakes the model.
                        if last_beat.is_none_or(|at| at.elapsed() >= Duration::from_secs(300)) {
                            last_beat = Some(std::time::Instant::now());
                            let _ = store.heartbeat(&session);
                        }
                    }) {
                    Ok(lines) => {
                        for line in lines {
                            println!("{line}");
                        }
                    }
                    Err(error) if once => return Err(error.into()),
                    Err(error) => eprintln!("[agent-mail] watch: {error}"),
                }
                if once {
                    break;
                }
                std::thread::sleep(interval);
            }
        }
        Command::Harness {
            action,
            target,
            harness,
        } => print(&match action.as_str() {
            "install" => harness::install(
                &target,
                &harness.ok_or("Missing --harness")?,
                &std::env::current_exe()?,
                &std::path::absolute(home)?,
            )?,
            "inspect" => harness::inspect(&target)?,
            _ => harness::uninstall(&target)?,
        }),
        Command::Reply {
            sender,
            message_id,
            text,
            file,
            automatic,
            reply_id,
            run,
            wait_ms,
        } => {
            let text = match (text, file) {
                (Some(text), None) => text,
                (None, Some(file)) => read_text(&file)?,
                _ => return Err("Provide exactly one of --text or --file".into()),
            };
            let wait = Duration::from_millis(wait_ms);
            let agent = agent_profile(None, None, None, None);
            let outcome = match run {
                Some(run_id) => {
                    RunContext::from_env(run_id)?.reply_and_wait(home, text, agent, wait)?
                }
                None => ops::reply_and_wait(
                    home,
                    ReplyRequest {
                        sender: sender.unwrap_or_default(),
                        message_id: message_id.unwrap_or_default(),
                        text,
                        automatic,
                        reply_id,
                        agent,
                    },
                    wait,
                )?,
            };
            print(outcome.value());
            return Ok(match outcome {
                Outcome::Delivered(_) => ExitCode::SUCCESS,
                Outcome::Queued(_) => ExitCode::from(2),
            });
        }
        Command::Service { action, port } => print(&task(Program::Mailer { port }, home, action)?),
        Command::Tray { action, port } => print(&task(Program::Tray { port }, home, action)?),
        Command::Mcp {
            harness,
            agent_name,
            model,
            no_listen: _,
            run,
        } => {
            // The server's environment is fixed at start, so it never borrows a Claude session id.
            let agent = agent_profile_fixed(harness, agent_name, model, None);
            let run = run.map(RunContext::from_env).transpose()?;
            tokio::runtime::Runtime::new()?
                .block_on(agent_mail::mcp::serve(home.to_path_buf(), agent, run))
                .map_err(|error| error.to_string())?;
        }
        Command::Policy {
            action: PolicyAction::Init,
        } => {
            let (created, path) = Policy::init(home)?;
            print(&json!({ "created": created, "path": path }));
        }
        Command::Policy {
            action: PolicyAction::Check,
        } => print(&json!({ "ok": true, "policy": Policy::load(home)? })),
    }
    Ok(ExitCode::SUCCESS)
}

/// `hook inject|gate|ledger`. A hook must never break the session: problems go to stderr and the
/// exit code stays 0. The gate fails closed for a sending tool it can read.
fn run_hook(home: &Path, verb: &str, event: Option<String>, harness: Option<&str>) {
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    let raw = raw.trim();
    match verb {
        "gate" => {
            let input = hook::ToolInput::parse(raw);
            if let Some(response) = hook::gate(&input, home, harness) {
                println!("{response}");
            }
        }
        "ledger" => {
            let input = hook::ToolInput::parse(raw);
            if let Err(error) = hook::ledger_hook(&input, home, harness) {
                eprintln!("agent-mail hook ledger: {error}");
            }
        }
        "inject" => {
            let input = hook::HookInput::parse(raw);
            let event = event
                .or_else(|| input.hook_event_name.clone())
                .unwrap_or_default();
            let response = Store::open_existing(home)
                .map_err(|error| error.to_string())
                .and_then(|store| {
                    hook::inject(&event, &input, home, &store, harness.unwrap_or("hook"))
                        .map_err(|error| error.to_string())
                });
            match response {
                Ok(Some(response)) => println!("{response}"),
                Ok(None) => {}
                Err(error) => eprintln!("agent-mail hook: {error}"),
            }
        }
        _ => eprintln!("agent-mail hook: Use: hook inject|gate|ledger"),
    }
}

/// A peer's public.json. The extra fields `identity` prints (`fingerprint`, `origin`, `agent`)
/// are ignored, so its output can be passed along as is; anything else must be the strict public
/// identity.
fn read_public(path: &Path) -> Result<PublicIdentity, Failure> {
    let mut value: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    if let Some(object) = value.as_object_mut() {
        for key in ["fingerprint", "origin", "agent"] {
            object.remove(key);
        }
    }
    let identity: PublicIdentity = serde_json::from_value(value)?;
    validate_public(&identity)?;
    fingerprint(&identity)?;
    Ok(identity)
}

fn read_text(file: &str) -> Result<String, Failure> {
    if file == "-" {
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text)?;
        Ok(text)
    } else {
        Ok(std::fs::read_to_string(file)?)
    }
}

/// Creates a file that must not exist yet (private keys are never replaced).
fn write_new(path: &Path, text: &str) -> Result<(), Failure> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = options.open(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::AlreadyExists => {
            "Identity already exists; refusing to replace private keys".to_owned()
        }
        _ => error.to_string(),
    })?;
    std::io::Write::write_all(&mut file, text.as_bytes())?;
    Ok(())
}

fn task(program: Program, home: &Path, action: TaskAction) -> Result<Value, Failure> {
    Ok(match action {
        TaskAction::Install { exe, start } => install::install(&program, home, exe, start)?,
        TaskAction::Uninstall => install::uninstall(&program, home)?,
        TaskAction::Status => install::status(&program, home)?,
    })
}

/// `--checkout auto`: the repo identity of the current folder, or an error outside a checkout.
fn checkout_arg(
    value: Option<&str>,
) -> Result<Option<mail_core::envelope::Checkout>, Box<dyn std::error::Error>> {
    match value {
        None => Ok(None),
        Some(_) => {
            let here = std::env::current_dir()?;
            mail_core::checkout::local_checkout(&here)
                .map(Some)
                .ok_or_else(|| "--checkout auto: this folder is not inside a git checkout".into())
        }
    }
}

fn intent_arg(value: Option<&str>) -> Option<mail_core::envelope::Intent> {
    match value {
        Some("notify") => Some(mail_core::envelope::Intent::Notify),
        Some("task") => Some(mail_core::envelope::Intent::Task),
        _ => None,
    }
}
