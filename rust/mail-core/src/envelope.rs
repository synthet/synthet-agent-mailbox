//! The signed message (`src/peer/wire.ts` `messageSchema`, `src/peer/metadata.ts`).
//!
//! Field order matters. The receipt digest is `sha256(JSON.stringify(message))` over the
//! zod-parsed message, whose keys follow the schema order. serde writes struct fields in
//! declaration order, so the fields below are declared in exactly that order.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::canonical::canonical;
use crate::error::{invalid, Error, Result};
use crate::identity::{Identity, PublicIdentity};
use crate::js::{is_fingerprint, is_ip, is_uuid, trim, utf16_len};

pub const ENVELOPE_V1_1: &str = "agent-mail/1.1";
/// Adds the optional signed `project` tag (ADR 0005).
pub const ENVELOPE_V1_2: &str = "agent-mail/1.2";
/// Adds the optional signed `checkout` identity and `intent` (ADR 0006).
pub const ENVELOPE_V1_3: &str = "agent-mail/1.3";
/// What a Rust receiver lists at `GET /capabilities` under `envelope`.
pub const ENVELOPE_VERSIONS: [&str; 3] = [ENVELOPE_V1_1, ENVELOPE_V1_2, ENVELOPE_V1_3];

pub const MAX_TEXT_BYTES: usize = 64 * 1024;
pub const MAX_MESSAGE_BYTES: usize = 96 * 1024;
pub const MAX_HOP: u8 = 16;

/// Which optional fields a parser accepts. Unknown fields are always rejected, as zod `.strict()` does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Envelope {
    /// Plain `agent-mail/1`: a receiver that answers `/capabilities` with 404 or not at all.
    V1_0,
    /// `agent-mail/1` plus the 1.1 routing fields: what TypeScript peers accept.
    V1_1,
    /// Also accepts `project`.
    V1_2,
    /// Also accepts `checkout` and `intent`.
    V1_3,
}

impl Envelope {
    /// The newest envelope this build parses: what it accepts from its own store and signs with.
    pub const LATEST: Envelope = Envelope::V1_3;
}

impl Envelope {
    /// Which envelope a `/capabilities` answer allows: the highest version it lists.
    pub fn accepted_by(versions: &[String]) -> Envelope {
        if versions.iter().any(|v| v == ENVELOPE_V1_3) {
            Envelope::V1_3
        } else if versions.iter().any(|v| v == ENVELOPE_V1_2) {
            Envelope::V1_2
        } else if versions.iter().any(|v| v == ENVELOPE_V1_1) {
            Envelope::V1_1
        } else {
            Envelope::V1_0
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Origin {
    pub hostname: String,
    pub platform: String,
    pub arch: String,
    pub addresses: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// The sender's repo, as ADR 0006 decision 1 shares it: what identifies the repo across PCs, never
/// a path. The receiver resolves it to its own checkout (`checkout.rs`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Checkout {
    /// Root commit hashes, 1-4, lowercase hex.
    pub roots: Vec<String>,
    /// `host/owner/name`, lowercase (`checkout::norm_origin`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The checkout folder's own name, a label only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// What the sender wants done (ADR 0006): wake a live session, or run an agent in the checkout.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Intent {
    Notify,
    Task,
}

/// A peer message. `signature` is empty until the message is signed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub sender: String,
    pub recipient: String,
    pub text: String,
    pub created_at: u64,
    pub origin: Origin,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentMeta>,
    // agent-mail/1.1 routing fields (ADR 0003).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_reply: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    // agent-mail/1.2 (ADR 0005). TypeScript peers reject it, so it is sent only to 1.2 receivers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    // agent-mail/1.3 (ADR 0006). Sent only to 1.3 receivers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkout: Option<Checkout>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent: Option<Intent>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub signature: String,
}

impl Message {
    /// Parses a signed message the way `messageSchema.parse` does: strict fields, trimmed labels,
    /// every limit checked.
    pub fn parse_signed(value: Value, accept: Envelope) -> Result<Self> {
        let message = Self::parse(value, accept)?;
        if message.signature.is_empty() {
            return Err(invalid("signature", "required"));
        }
        Ok(message)
    }

    /// Parses an unsigned message (`unsignedSchema.parse`); a `signature` field is rejected.
    pub fn parse_unsigned(value: Value, accept: Envelope) -> Result<Self> {
        let message = Self::parse(value, accept)?;
        if !message.signature.is_empty() {
            return Err(invalid("signature", "unexpected on an unsigned message"));
        }
        Ok(message)
    }

    fn parse(value: Value, accept: Envelope) -> Result<Self> {
        // zod's optional() accepts a missing key, never null; serde would read null as None.
        reject_null(&value)?;
        if value
            .get("signature")
            .is_some_and(|signature| !signature.is_string())
        {
            return Err(invalid("signature", "must be a string"));
        }
        let message: Message = serde_json::from_value(value)?;
        message.normalized(accept)
    }

    /// Trims and validates every field, returning the value the TypeScript schema would produce.
    pub fn normalized(mut self, accept: Envelope) -> Result<Self> {
        check_uuid("id", &self.id)?;
        check_uuid("conversation_id", &self.conversation_id)?;
        if !is_fingerprint(&self.sender) {
            return Err(invalid("sender", "must be 64 lowercase hex characters"));
        }
        if !is_fingerprint(&self.recipient) {
            return Err(invalid("recipient", "must be 64 lowercase hex characters"));
        }
        if self.text.is_empty() || self.text.len() > MAX_TEXT_BYTES {
            return Err(invalid("text", "must be 1 byte to 64 KiB"));
        }
        if self.created_at > 9_007_199_254_740_991 {
            return Err(invalid("created_at", "above Number.MAX_SAFE_INTEGER"));
        }
        self.origin.hostname = label("origin.hostname", &self.origin.hostname, 255)?;
        self.origin.platform = label("origin.platform", &self.origin.platform, 32)?;
        self.origin.arch = label("origin.arch", &self.origin.arch, 32)?;
        if self.origin.addresses.len() > 16 {
            return Err(invalid("origin.addresses", "at most 16"));
        }
        if let Some(address) = self.origin.addresses.iter().find(|address| !is_ip(address)) {
            return Err(invalid(
                "origin.addresses",
                format!("invalid IP {address:?}"),
            ));
        }
        if let Some(agent) = self.agent.as_mut() {
            agent.harness = optional_label("agent.harness", agent.harness.take(), 80)?;
            agent.name = optional_label("agent.name", agent.name.take(), 120)?;
            agent.model = optional_label("agent.model", agent.model.take(), 120)?;
            agent.session_id = optional_label("agent.session_id", agent.session_id.take(), 200)?;
            if *agent == AgentMeta::default() {
                return Err(invalid("agent", "metadata is empty"));
            }
        }
        self.to_session = optional_label("to_session", self.to_session.take(), 200)?;
        if accept < Envelope::V1_1 && self.has_routing_fields() {
            return Err(Error::Json("routing fields need agent-mail/1.1".into()));
        }
        if self.hop.is_some_and(|hop| hop > MAX_HOP) {
            return Err(invalid("hop", "must be 0-16"));
        }
        if let Some(reply_to) = &self.in_reply_to {
            check_uuid("in_reply_to", reply_to)?;
        }
        if let Some(project) = &self.project {
            if accept < Envelope::V1_2 {
                return Err(Error::Json("unknown field `project`".into()));
            }
            check_project(project)?;
        }
        if accept < Envelope::V1_3 {
            if self.checkout.is_some() {
                return Err(Error::Json("unknown field `checkout`".into()));
            }
            if self.intent.is_some() {
                return Err(Error::Json("unknown field `intent`".into()));
            }
        }
        if let Some(checkout) = self.checkout.as_mut() {
            check_checkout(checkout)?;
        }
        if !self.signature.is_empty() {
            if utf16_len(&self.signature) > 128 {
                return Err(invalid("signature", "longer than 128 characters"));
            }
            if self.json().len() > MAX_MESSAGE_BYTES {
                return Err(invalid("message", "encoded message exceeds 96 KiB"));
            }
        }
        Ok(self)
    }

    /// `canonicalUnsigned()`: sorted-key JSON without the signature, the bytes that get signed.
    pub fn canonical_unsigned(&self) -> String {
        let mut unsigned = self.clone();
        unsigned.signature.clear();
        canonical(&serde_json::to_value(&unsigned).expect("message serializes"))
    }

    /// `JSON.stringify(message)` in schema order: the receipt digest input and the plaintext that
    /// gets sealed.
    pub fn json(&self) -> String {
        serde_json::to_string(self).expect("message serializes")
    }

    /// `sha256(JSON.stringify(message))`, as hex.
    pub fn digest(&self) -> String {
        hex::encode(Sha256::digest(self.json().as_bytes()))
    }

    /// `signMessage()`: normalizes, signs the canonical form, and checks the result verifies.
    pub fn sign(mut self, identity: &Identity, accept: Envelope) -> Result<Self> {
        self.signature.clear();
        let mut message = self.normalized(accept)?;
        message.signature = identity.sign(message.canonical_unsigned().as_bytes())?;
        let message = message.normalized(accept)?;
        if !message.verify(&identity.public()) {
            return Err(Error::BadSignature);
        }
        Ok(message)
    }

    /// `verifyMessage()` for an already-parsed message.
    pub fn verify(&self, sender: &PublicIdentity) -> bool {
        !self.signature.is_empty()
            && sender.verify(self.canonical_unsigned().as_bytes(), &self.signature)
    }

    /// Drops the fields a receiver below `accept` would reject, reporting whether anything was
    /// dropped (`envelope_downgraded`). Call before signing.
    pub fn downgrade_to(&mut self, accept: Envelope) -> bool {
        let mut dropped = false;
        if accept < Envelope::V1_3 {
            if self.checkout.take().is_some() {
                dropped = true;
            }
            // A notify is what a plain message means anyway. A task is never dropped: it would turn
            // into a message the receiver acts on differently, so the sender holds it instead.
            if self.intent == Some(Intent::Notify) {
                self.intent = None;
                dropped = true;
            }
        }
        if accept < Envelope::V1_2 && self.project.take().is_some() {
            dropped = true;
        }
        if accept < Envelope::V1_1 && self.has_routing_fields() {
            self.to_session = None;
            self.hop = None;
            self.auto_reply = None;
            self.in_reply_to = None;
            dropped = true;
        }
        dropped
    }

    /// The 1.1 routing fields (ADR 0003).
    pub fn has_routing_fields(&self) -> bool {
        self.to_session.is_some()
            || self.hop.is_some()
            || self.auto_reply.is_some()
            || self.in_reply_to.is_some()
    }

    /// The lowest envelope a receiver must accept to take this message unchanged.
    pub fn needs(&self) -> Envelope {
        if self.checkout.is_some() || self.intent.is_some() {
            Envelope::V1_3
        } else if self.project.is_some() {
            Envelope::V1_2
        } else if self.has_routing_fields() {
            Envelope::V1_1
        } else {
            Envelope::V1_0
        }
    }
}

fn reject_null(value: &Value) -> Result<()> {
    match value {
        Value::Null => Err(Error::Json("null is not allowed".into())),
        Value::Array(items) => items.iter().try_for_each(reject_null),
        Value::Object(map) => map.values().try_for_each(reject_null),
        _ => Ok(()),
    }
}

fn check_uuid(field: &'static str, value: &str) -> Result<()> {
    if is_uuid(value) {
        Ok(())
    } else {
        Err(invalid(field, "must be a UUID"))
    }
}

fn check_project(value: &str) -> Result<()> {
    let ok = (1..=100).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(invalid("project", "must match ^[A-Za-z0-9._-]{1,100}$"))
    }
}

fn is_hash(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_name(value: &str, max: usize, extra: &[u8]) -> bool {
    (1..=max).contains(&value.len())
        && value.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-') || extra.contains(&b)
        })
}

impl Checkout {
    /// True when the identity passes the 1.3 limits.
    pub fn is_valid(&self) -> bool {
        check_checkout(self).is_ok()
    }
}

/// ADR 0006 limits: hashes are lowercase hex, the origin is `host/owner/name`, the branch and the
/// folder name are plain labels.
fn check_checkout(checkout: &Checkout) -> Result<()> {
    if !(1..=4).contains(&checkout.roots.len()) || !checkout.roots.iter().all(|root| is_hash(root))
    {
        return Err(invalid("checkout.roots", "1-4 lowercase hex commit hashes"));
    }
    if let Some(origin) = &checkout.origin {
        let parts: Vec<&str> = origin.split('/').collect();
        let lower = origin.bytes().all(|b| !b.is_ascii_uppercase());
        if !lower
            || parts.len() != 3
            || !is_name(parts[0], 100, &[])
            || !is_name(parts[1], 100, &[])
            || !is_name(parts[2], 100, &[])
        {
            return Err(invalid(
                "checkout.origin",
                "must be lowercase host/owner/name",
            ));
        }
    }
    if checkout.head.as_deref().is_some_and(|head| !is_hash(head)) {
        return Err(invalid(
            "checkout.head",
            "must be a lowercase hex commit hash",
        ));
    }
    if checkout
        .branch
        .as_deref()
        .is_some_and(|branch| !is_name(branch, 200, b"/+@"))
    {
        return Err(invalid(
            "checkout.branch",
            "1-200 characters: letters, digits and ._-/+@",
        ));
    }
    if checkout
        .name
        .as_deref()
        .is_some_and(|name| !is_name(name, 100, &[]))
    {
        return Err(invalid(
            "checkout.name",
            "must match ^[A-Za-z0-9._-]{1,100}$",
        ));
    }
    Ok(())
}

/// metadata.ts `label(max)`: trim, then 1..=max UTF-16 units, then no line breaks.
fn label(field: &'static str, value: &str, max: usize) -> Result<String> {
    let value = trim(value);
    let len = utf16_len(value);
    if len == 0 || len > max {
        return Err(invalid(
            field,
            format!("must be 1-{max} characters after trimming"),
        ));
    }
    if value.contains(['\r', '\n']) {
        return Err(invalid(field, "cannot contain line breaks"));
    }
    Ok(value.to_owned())
}

fn optional_label(
    field: &'static str,
    value: Option<String>,
    max: usize,
) -> Result<Option<String>> {
    value.map(|value| label(field, &value, max)).transpose()
}
