//! What the CLI and the MCP server both do: queue through `mail_core::send`, poke the mailer and
//! wait briefly for its first attempt. Neither opens a network socket.

use std::path::Path;
use std::time::{Duration, Instant};

use mail_core::envelope::{AgentMeta, Envelope};
use mail_core::outbox::Delivery;
use mail_core::send::{local_origin, reply, submit, ReplyRequest, SendError, SendRequest};
use mail_core::store::Store;
use mail_core::{ipc, Identity};
use serde_json::{json, Value};

/// How long `send` waits for the mailer's first attempt by default.
pub const DEFAULT_WAIT: Duration = Duration::from_secs(8);

/// Delivered (verified receipt) or still queued. Both carry the JSON result to show.
#[derive(Debug)]
pub enum Outcome {
    Delivered(Value),
    Queued(Value),
}

impl Outcome {
    pub fn value(&self) -> &Value {
        match self {
            Outcome::Delivered(value) | Outcome::Queued(value) => value,
        }
    }
}

#[derive(Debug)]
pub enum OpError {
    /// Policy or a reply guard refused it; nothing was queued.
    Refused(String),
    Failed(String),
}

impl std::fmt::Display for OpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpError::Refused(reason) if reason.starts_with("reply_refused") => f.write_str(reason),
            OpError::Refused(reason) => write!(f, "send refused: {reason}"),
            OpError::Failed(error) => f.write_str(error),
        }
    }
}

impl std::error::Error for OpError {}

impl From<SendError> for OpError {
    fn from(error: SendError) -> Self {
        match error {
            SendError::Refused(reason) => OpError::Refused(reason),
            SendError::Other(error) => OpError::Failed(error.to_string()),
        }
    }
}

impl From<mail_core::Error> for OpError {
    fn from(error: mail_core::Error) -> Self {
        OpError::Failed(error.to_string())
    }
}

/// Queue a message, wake the mailer and wait up to `wait` for its first attempt.
pub fn send_and_wait(
    home: &Path,
    request: SendRequest,
    wait: Duration,
) -> Result<Outcome, OpError> {
    let identity = Identity::load(home)?;
    let mut store = Store::open(home)?;
    let queued = submit(home, &identity, &mut store, request)?;
    wait_for_delivery(home, &store, queued, wait)
}

/// Reply to a stored message (`reply_to_message`); the mailer confirms an automatic reply's peer
/// takes agent-mail/1.1.
pub fn reply_and_wait(
    home: &Path,
    request: ReplyRequest,
    wait: Duration,
) -> Result<Outcome, OpError> {
    let identity = Identity::load(home)?;
    let mut store = Store::open(home)?;
    let queued = reply(home, &identity, &mut store, request, |fp| {
        envelope_via_mailer(home, fp)
    })?;
    wait_for_delivery(home, &store, queued, wait)
}

pub fn wait_for_delivery(
    home: &Path,
    store: &Store,
    queued: Delivery,
    wait: Duration,
) -> Result<Outcome, OpError> {
    let id = match &queued {
        Delivery::Delivered { .. } => return Ok(Outcome::Delivered(to_value(&queued))),
        Delivery::Expired { .. } => return Ok(Outcome::Queued(to_value(&queued))),
        Delivery::Queued { message_id, .. } => message_id.clone(),
    };
    if !ipc::poke(home) {
        let mut result = to_value(&queued);
        result["error"] =
            json!("agent-maild is not running for this home; the message stays queued");
        return Ok(Outcome::Queued(result));
    }
    let started = Instant::now();
    loop {
        let state = store
            .delivery(&id)?
            .ok_or_else(|| OpError::Failed("queued message vanished".into()))?;
        match &state {
            Delivery::Delivered { .. } => return Ok(Outcome::Delivered(to_value(&state))),
            // Given up on: report it as not delivered (exit 2), with its reason.
            Delivery::Expired { .. } => return Ok(Outcome::Queued(to_value(&state))),
            Delivery::Queued { attempts, .. } if *attempts > 0 || started.elapsed() >= wait => {
                return Ok(Outcome::Queued(to_value(&state)))
            }
            Delivery::Queued { .. } => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

fn to_value(delivery: &Delivery) -> Value {
    serde_json::to_value(delivery).expect("delivery serializes")
}

/// Asks the mailer which envelope a pinned peer accepts. `None` when no mailer answers.
pub fn envelope_via_mailer(home: &Path, fp: &str) -> Option<Envelope> {
    ipc::envelope(home, fp)
}

/// Whether a mailer answers for this home.
pub fn mailer_running(home: &Path) -> bool {
    ipc::request(home, "status", Duration::from_secs(2)).is_ok_and(|reply| reply.starts_with('{'))
}

/// TS `whoami()`: public identity, fingerprint, origin and agent metadata.
pub fn whoami(identity: &Identity, agent: Option<&AgentMeta>) -> Result<Value, OpError> {
    Ok(json!({
        "name": identity.name,
        "signing_key": identity.signing_key,
        "encryption_key": identity.encryption_key,
        "fingerprint": identity.fingerprint()?,
        "origin": local_origin(),
        "agent": agent,
    }))
}
