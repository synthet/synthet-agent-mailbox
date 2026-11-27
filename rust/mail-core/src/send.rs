//! The one way to send (ADR 0005 decision 9). The CLI, MCP and the tray all call `submit`, which
//! loads `policy.json`, runs `check_outbound`, builds the message and queues it. Nothing here
//! touches the network; the mailer delivers.

use std::path::Path;

use crate::envelope::{AgentMeta, Checkout, Envelope, Intent, Message, Origin};
use crate::error::{invalid, Result};
use crate::identity::Identity;
use crate::outbox::Delivery;
use crate::policy::{check_outbound, Policy};
use crate::store::{now_ms, Store};

/// What a caller asks to send. Mirrors TS `peerSendShape`, plus the 1.2 `project` tag and the 1.3
/// `checkout` and `intent`.
#[derive(Clone, Debug, Default)]
pub struct SendRequest {
    pub recipient: String,
    pub text: String,
    pub message_id: Option<String>,
    pub conversation_id: Option<String>,
    pub agent: Option<AgentMeta>,
    pub to_session: Option<String>,
    pub hop: Option<u8>,
    pub auto_reply: Option<bool>,
    pub in_reply_to: Option<String>,
    pub project: Option<String>,
    pub checkout: Option<Checkout>,
    pub intent: Option<Intent>,
}

/// Why a send didn't queue.
#[derive(Debug)]
pub enum SendError {
    /// `check_outbound` or a missing/invalid policy refused it.
    Refused(String),
    Other(crate::Error),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SendError::Refused(reason) => write!(f, "send refused: {reason}"),
            SendError::Other(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for SendError {}

impl From<crate::Error> for SendError {
    fn from(error: crate::Error) -> Self {
        SendError::Other(error)
    }
}

/// Checks policy, then queues the message unsigned. The recipient must be a pinned contact.
pub fn submit(
    home: &Path,
    identity: &Identity,
    store: &mut Store,
    request: SendRequest,
) -> std::result::Result<Delivery, SendError> {
    let policy = Policy::load(home).map_err(SendError::Refused)?;
    check_outbound(&request.text, Some(&request.recipient), &policy, store)
        .map_err(SendError::Refused)?;
    let contact = store.resolve_contact(&request.recipient)?;
    let explicit_conversation = request.conversation_id.is_some();
    let message = Message {
        id: request.message_id.unwrap_or_else(new_uuid),
        conversation_id: request.conversation_id.unwrap_or_else(new_uuid),
        sender: identity.fingerprint()?,
        recipient: contact.fingerprint,
        text: request.text,
        created_at: now_ms(),
        origin: local_origin(),
        agent: request.agent.filter(|agent| *agent != AgentMeta::default()),
        to_session: request.to_session,
        hop: request.hop,
        auto_reply: request.auto_reply,
        in_reply_to: request.in_reply_to,
        project: request.project,
        // The owner can keep the repo identity on this PC (ADR 0006 decision 2).
        checkout: request
            .checkout
            .filter(|_| policy.share_checkout != Some(false)),
        intent: request.intent,
        signature: String::new(),
    }
    .normalized(Envelope::LATEST)?;
    Ok(store.queue(&message, explicit_conversation)?)
}

/// ADR 0003 loop guard: an automatic reply is refused once the exchange reaches this depth.
pub const MAX_AUTO_HOP: u8 = 6;

/// TS `peerReplyShape`: answer a stored message.
#[derive(Clone, Debug, Default)]
pub struct ReplyRequest {
    pub sender: String,
    pub message_id: String,
    pub text: String,
    /// No human wrote or approved this reply: sent with `auto_reply`, and guarded.
    pub automatic: bool,
    pub reply_id: Option<String>,
    /// Agent metadata for the reply (the sender's own harness and session).
    pub agent: Option<AgentMeta>,
}

/// TS `Peer.reply`. The recipient, conversation, `in_reply_to`, hop and `to_session` come from the
/// stored message, never from the caller. `accepts` reports which envelope the peer takes (through
/// the mailer); `None` means it couldn't be checked, which refuses an automatic reply.
pub fn reply(
    home: &Path,
    identity: &Identity,
    store: &mut Store,
    request: ReplyRequest,
    accepts: impl FnOnce(&str) -> Option<Envelope>,
) -> std::result::Result<Delivery, SendError> {
    let sender = request.sender.to_lowercase();
    let original = store
        .inbox_message(&sender, &request.message_id)?
        .ok_or_else(|| SendError::Other(invalid("message_id", "Unknown inbox message")))?;
    let depth = original.hop.unwrap_or(0);
    if request.automatic {
        if original.auto_reply == Some(true) {
            return Err(SendError::Refused(
                "reply_refused: the message is itself an automatic reply".into(),
            ));
        }
        if depth >= MAX_AUTO_HOP {
            return Err(SendError::Refused(format!(
                "reply_refused: hop limit {MAX_AUTO_HOP} reached"
            )));
        }
        if store.has_auto_reply(&original.id, request.reply_id.as_deref())? {
            return Err(SendError::Refused(
                "reply_refused: this message already has an automatic reply".into(),
            ));
        }
        match accepts(&original.sender) {
            Some(envelope) if envelope >= Envelope::V1_1 => {}
            Some(_) => {
                return Err(SendError::Refused(
                    "reply_refused: the peer does not accept agent-mail/1.1, so it would not see auto_reply".into(),
                ))
            }
            None => {
                return Err(SendError::Refused(
                    "reply_refused: couldn't confirm the peer accepts agent-mail/1.1 (is agent-maild running?)".into(),
                ))
            }
        }
    }
    submit(
        home,
        identity,
        store,
        SendRequest {
            recipient: original.sender.clone(),
            text: request.text,
            message_id: request.reply_id,
            conversation_id: Some(original.conversation_id.clone()),
            agent: request.agent,
            to_session: original
                .agent
                .as_ref()
                .and_then(|agent| agent.session_id.clone()),
            hop: Some((depth + 1).min(crate::envelope::MAX_HOP)),
            auto_reply: request.automatic.then_some(true),
            in_reply_to: Some(original.id.clone()),
            // A reply stays in the project the question was about.
            project: original.project.clone(),
            // ...and names the same repo, so the asker's PC can find the asking session's checkout.
            checkout: original.checkout.clone(),
            intent: None,
        },
    )
}

/// AC-15: the reply a headless run sends through the run-bound `agent-mail reply` or MCP
/// `reply_to_message`. The run token is checked against the run row, the recipient, thread and
/// message come from the stored message the run answers (never from the caller), the reply is
/// always automatic, and a run replies at most once.
#[allow(clippy::too_many_arguments)]
pub fn reply_for_run(
    home: &Path,
    identity: &Identity,
    store: &mut Store,
    run_id: &str,
    token: &str,
    text: String,
    agent: Option<AgentMeta>,
    accepts: impl FnOnce(&str) -> Option<Envelope>,
) -> std::result::Result<Delivery, SendError> {
    let reply_id = new_uuid();
    let message = store
        .claim_run_reply(run_id, token, &reply_id)?
        .map_err(|refusal| SendError::Refused(refusal.to_string()))?;
    let outcome = reply(
        home,
        identity,
        store,
        ReplyRequest {
            sender: message.sender,
            message_id: message.message_id,
            text,
            automatic: true,
            reply_id: Some(reply_id.clone()),
            agent,
        },
        accepts,
    );
    if outcome.is_err() {
        store.release_run_reply(run_id, &reply_id)?;
    }
    outcome
}

/// A random (v4) UUID.
pub fn new_uuid() -> String {
    let mut bytes = [0u8; 16];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// `localOrigin()`: Node's platform and arch names, and non-loopback addresses, sorted, at most 16.
pub fn local_origin() -> Origin {
    let platform = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    };
    let mut addresses: Vec<String> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|interface| !interface.is_loopback())
        .map(|interface| interface.ip().to_string())
        .collect();
    addresses.sort();
    addresses.dedup();
    addresses.truncate(16);
    let hostname = gethostname::gethostname().to_string_lossy().into_owned();
    Origin {
        hostname: if hostname.trim().is_empty() {
            "unknown".into()
        } else {
            hostname
        },
        platform: platform.into(),
        arch: arch.into(),
        addresses,
    }
}

/// Agent metadata from flags, falling back to `AGENT_MAIL_*` (`agentProfileFromEnv`).
pub fn agent_profile(
    harness: Option<String>,
    name: Option<String>,
    model: Option<String>,
    session_id: Option<String>,
) -> Option<AgentMeta> {
    let pick = |value: Option<String>, env: &str| {
        value
            .or_else(|| std::env::var(env).ok())
            .filter(|value| !value.trim().is_empty())
    };
    let agent = AgentMeta {
        harness: pick(harness, "AGENT_MAIL_HARNESS"),
        name: pick(name, "AGENT_MAIL_AGENT_NAME"),
        model: pick(model, "AGENT_MAIL_MODEL"),
        // Claude Code exports its own session id to hooks and Bash (ADR 0006 decision 1).
        session_id: pick(session_id, "AGENT_MAIL_SESSION")
            .or_else(|| pick(None, "CLAUDE_CODE_SESSION_ID")),
    };
    (agent != AgentMeta::default()).then_some(agent)
}

/// Validates an endpoint as TS `validateEndpoint` does: `http://host:port` and nothing else.
pub fn validate_endpoint(endpoint: &str) -> Result<()> {
    let rest = endpoint
        .strip_prefix("http://")
        .ok_or_else(|| invalid("endpoint", "must start with http://"))?;
    let authority = rest.strip_suffix('/').unwrap_or(rest);
    if authority.is_empty() || authority.contains(['/', '?', '#', '@', ' ']) {
        return Err(invalid(
            "endpoint",
            "must be http://host:port without credentials, path, query, or fragment",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runs::Run;

    struct RunFixture {
        _dir: tempfile::TempDir,
        home: std::path::PathBuf,
        alice: Identity,
        bob_fp: String,
        message: Message,
        store: Store,
    }

    /// Alice's home holds a message from Bob and a running run for it, bound to `token`.
    fn run_fixture(token: &str) -> RunFixture {
        run_fixture_with(token, Some(1), None, now_ms() + 60_000)
    }

    /// The question carries `hop` and `auto_reply`; the run token works until `deadline`.
    fn run_fixture_with(
        token: &str,
        hop: Option<u8>,
        auto_reply: Option<bool>,
        deadline: u64,
    ) -> RunFixture {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("alice");
        let alice = Identity::generate("alice").unwrap();
        let bob = Identity::generate("bob").unwrap();
        let bob_fp = bob.fingerprint().unwrap();
        let mut store = Store::open(&home).unwrap();
        store.trust(&bob.public(), None, None).unwrap();
        Policy::init(&home).unwrap();
        let mut policy: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(Policy::path(&home)).unwrap()).unwrap();
        policy["allowed_peers"] = serde_json::json!([bob_fp]);
        std::fs::write(Policy::path(&home), policy.to_string()).unwrap();
        let message = Message {
            id: new_uuid(),
            conversation_id: new_uuid(),
            sender: bob_fp.clone(),
            recipient: alice.fingerprint().unwrap(),
            text: "what version are you on?".into(),
            created_at: now_ms(),
            origin: local_origin(),
            agent: Some(AgentMeta {
                session_id: Some("bob-session".into()),
                ..AgentMeta::default()
            }),
            to_session: None,
            hop,
            auto_reply,
            in_reply_to: None,
            project: None,
            checkout: None,
            intent: None,
            signature: String::new(),
        }
        .sign(&bob, Envelope::V1_2)
        .unwrap();
        store.receive(&message).unwrap();
        store
            .start_run(&Run {
                run_id: "run-1".into(),
                sender: bob_fp.clone(),
                message_id: message.id.clone(),
                conversation_id: message.conversation_id.clone(),
                project: None,
                workspace: "w".into(),
                tier: "reply".into(),
                runner: "claude".into(),
                state: "running".into(),
                outcome: None,
                cost_usd: None,
                reply_id: None,
                created_at: now_ms(),
                finished_at: None,
            })
            .unwrap();
        store.bind_run_token("run-1", token, deadline).unwrap();
        RunFixture {
            _dir: dir,
            home,
            alice,
            bob_fp,
            message,
            store,
        }
    }

    fn run_reply(f: &mut RunFixture, token: &str) -> std::result::Result<Delivery, SendError> {
        reply_for_run(
            &f.home,
            &f.alice,
            &mut f.store,
            "run-1",
            token,
            "v0.4.0".into(),
            None,
            |_| Some(Envelope::V1_2),
        )
    }

    #[test]
    fn a_wrong_run_token_is_refused_and_nothing_is_queued() {
        let mut f = run_fixture("right-token");
        for token in ["wrong-token", ""] {
            let error = run_reply(&mut f, token).unwrap_err().to_string();
            assert!(error.contains("wrong run token"), "{error}");
        }
        assert_eq!(f.store.counts().unwrap().pending, 0);
        assert_eq!(f.store.run_reply("run-1").unwrap(), None);
    }

    #[test]
    fn the_recipient_and_thread_come_from_the_stored_message_and_a_second_reply_is_refused() {
        let mut f = run_fixture("right-token");
        let reply_id = match run_reply(&mut f, "right-token").unwrap() {
            Delivery::Queued { message_id, .. }
            | Delivery::Delivered { message_id, .. }
            | Delivery::Expired { message_id, .. } => message_id,
        };
        assert_eq!(
            f.store.run_reply("run-1").unwrap().as_deref(),
            Some(reply_id.as_str())
        );
        let thread =
            serde_json::to_value(f.store.thread(&f.message.conversation_id).unwrap()).unwrap();
        let sent = thread
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row.to_string().contains(&reply_id))
            .expect("the reply is in the original thread")
            .to_string();
        assert!(sent.contains(&f.bob_fp), "addressed to the original sender");
        assert!(
            sent.contains(&f.message.id),
            "in_reply_to the run's message"
        );
        assert!(sent.contains("bob-session"), "to the sender's session");
        assert!(
            sent.contains("\"auto_reply\":true"),
            "always automatic: {sent}"
        );
        assert!(sent.contains("\"hop\":2"), "hop + 1: {sent}");

        let error = run_reply(&mut f, "right-token").unwrap_err().to_string();
        assert!(error.contains("already replied"), "{error}");
        assert_eq!(f.store.counts().unwrap().pending, 1);
    }

    #[test]
    fn a_finished_run_cannot_reply_and_a_refused_send_gives_the_slot_back() {
        let mut f = run_fixture("t");
        // A policy refusal (secret-looking text) must not use up the run's one reply.
        let refused = reply_for_run(
            &f.home,
            &f.alice,
            &mut f.store,
            "run-1",
            "t",
            "-----BEGIN PRIVATE KEY-----".into(),
            None,
            |_| Some(Envelope::V1_2),
        );
        assert!(refused.is_err());
        assert_eq!(f.store.run_reply("run-1").unwrap(), None);
        f.store
            .finish_run("run-1", "done", "ok", None, None)
            .unwrap();
        let error = run_reply(&mut f, "t").unwrap_err().to_string();
        assert!(error.contains("finished"), "{error}");
    }

    #[test]
    fn the_run_path_keeps_the_hop_limit_and_never_answers_an_automatic_message() {
        let mut deep = run_fixture_with("t", Some(MAX_AUTO_HOP), None, now_ms() + 60_000);
        let error = run_reply(&mut deep, "t").unwrap_err().to_string();
        assert!(error.contains("hop limit"), "{error}");
        assert_eq!(
            deep.store.run_reply("run-1").unwrap(),
            None,
            "the slot is given back"
        );
        let mut automatic = run_fixture_with("t", Some(1), Some(true), now_ms() + 60_000);
        let error = run_reply(&mut automatic, "t").unwrap_err().to_string();
        assert!(error.contains("itself an automatic reply"), "{error}");
        assert_eq!(automatic.store.counts().unwrap().pending, 0);
    }

    #[test]
    fn expired_failed_and_closed_runs_cannot_reply() {
        let mut expired = run_fixture_with("t", Some(1), None, now_ms().saturating_sub(1));
        let error = run_reply(&mut expired, "t").unwrap_err().to_string();
        assert!(error.contains("time limit"), "{error}");

        let mut failed = run_fixture("t");
        failed
            .store
            .finish_run("run-1", "failed", "timeout", None, None)
            .unwrap();
        assert!(run_reply(&mut failed, "t")
            .unwrap_err()
            .to_string()
            .contains("finished"));

        // The consumer closes the window before picking its own reply: a late call is refused.
        let mut closed = run_fixture("t");
        assert!(closed.store.close_run("run-1").unwrap());
        assert!(
            !closed.store.close_run("run-1").unwrap(),
            "only a running run closes"
        );
        assert!(run_reply(&mut closed, "t")
            .unwrap_err()
            .to_string()
            .contains("finished"));
        assert_eq!(closed.store.run_reply("run-1").unwrap(), None);

        // A tray that died mid-run: at the next start the run expires and its token stops working.
        let mut orphan = run_fixture("t");
        assert_eq!(orphan.store.expire_unfinished_runs().unwrap(), 1);
        let run = &orphan.store.recent_runs(1).unwrap()[0];
        assert_eq!(
            (run.state.as_str(), run.outcome.as_deref()),
            ("failed", Some("expired"))
        );
        assert!(run_reply(&mut orphan, "t").is_err());
    }

    #[test]
    fn finishing_a_run_ends_its_own_session() {
        use crate::runs::{run_session_id, RUN_ALIAS};
        use crate::sessions::{Host, Registration};
        let f = run_fixture("t");
        let host = Host {
            fingerprint: f.alice.fingerprint().unwrap(),
            name: "alice".into(),
        };
        let registration = Registration {
            session_id: run_session_id("run-1"),
            alias: Some(RUN_ALIAS.into()),
            ..Registration::default()
        };
        let agent = f.store.register_session(&host, &registration).unwrap()["agent_id"].clone();
        assert_ne!(
            agent,
            serde_json::json!(host.fingerprint),
            "a run never speaks as the host agent"
        );
        assert_eq!(f.store.live_sessions().unwrap().len(), 1);
        f.store
            .finish_run("run-1", "done", "ok", None, None)
            .unwrap();
        assert!(f.store.live_sessions().unwrap().is_empty());
    }

    #[test]
    fn uuids_are_v4() {
        let id = new_uuid();
        assert!(crate::js::is_uuid(&id));
        assert_eq!(&id[14..15], "4");
    }

    #[test]
    fn endpoints() {
        assert!(validate_endpoint("http://192.168.1.20:47832").is_ok());
        assert!(validate_endpoint("http://[fe80::1]:47832/").is_ok());
        assert!(validate_endpoint("https://pc2:47832").is_err());
        assert!(validate_endpoint("http://user@pc2:47832").is_err());
        assert!(validate_endpoint("http://pc2:47832/path").is_err());
    }

    #[test]
    fn origin_uses_node_names() {
        let origin = local_origin();
        assert!(!origin.hostname.is_empty());
        assert!(origin.addresses.len() <= 16);
        if cfg!(windows) {
            assert_eq!(origin.platform, "win32");
        }
    }
}
