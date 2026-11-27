//! The owner's send policy, `<home>/policy.json` (ADR 0003 decision 6, `src/peer/policy.ts`).
//!
//! There is no permissive default: a missing or invalid policy refuses every send. ADR 0005 moves
//! this check into the send path itself, so every way of sending (CLI, MCP, tray, replies) passes
//! through `check_outbound`, not only sends a PreToolUse hook happens to see.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{invalid, Error, Result};
use crate::store::Store;

pub const POLICY_FILE: &str = "policy.json";

/// The TS schema's fields. Unknown keys are refused, as `policySchema.strict()` does. The
/// `dispatch` section is kept as JSON until the consumer (T-6) types it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub allowed_peers: Vec<String>,
    pub max_bytes: u32,
    #[serde(default)]
    pub forbid_action_requests: bool,
    #[serde(default)]
    pub auto_answer_types: Vec<String>,
    #[serde(default = "empty_object")]
    pub dispatch: Value,
    /// ADR 0005: project tag -> folder a headless run may use, and at what tier.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub workspaces: std::collections::BTreeMap<String, crate::dispatch::WorkspacePolicy>,
    /// The folder for mail whose tag matches no `workspaces` key; without it such mail isn't run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_workspace: Option<crate::dispatch::WorkspacePolicy>,
    /// Folders whose direct children may be checkouts that a peer's repo identity resolves to
    /// (`checkout.rs`). Absolute paths; the owner's list, never the peer's.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checkout_roots: Vec<PathBuf>,
    /// Renamed repos: an old normalized origin (`host/owner/name`) mapped to the current one.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub origin_aliases: std::collections::BTreeMap<String, String>,
    /// `false` keeps the repo identity (envelope 1.3 `checkout`) on this PC (ADR 0006 decision 2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share_checkout: Option<bool>,
}

fn empty_object() -> Value {
    Value::Object(Default::default())
}

impl Policy {
    /// `POLICY_TEMPLATE`: allows nobody. The owner adds peers by hand.
    pub fn template() -> Self {
        Policy {
            allowed_peers: Vec::new(),
            max_bytes: 16384,
            forbid_action_requests: false,
            auto_answer_types: Vec::new(),
            dispatch: serde_json::json!({
                "enabled": false,
                "limits": { "concurrency": 1, "per_peer_per_minute": 2, "timeout_ms": 60000, "budget_usd": 0.25 },
                "peers": {}
            }),
            workspaces: Default::default(),
            default_workspace: None,
            checkout_roots: Vec::new(),
            origin_aliases: Default::default(),
            share_checkout: None,
        }
    }

    /// The typed `dispatch` section. `load` already checked it, so this only fails for a policy
    /// built by hand.
    pub fn dispatch_policy(&self) -> std::result::Result<crate::dispatch::DispatchPolicy, String> {
        crate::dispatch::DispatchPolicy::parse(&self.dispatch)
    }

    pub fn path(home: &Path) -> PathBuf {
        home.join(POLICY_FILE)
    }

    /// `loadPolicy()`: the reason is meant for the person, so it says what to do next.
    pub fn load(home: &Path) -> std::result::Result<Self, String> {
        let path = Self::path(home);
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(
                    "No policy.json; run `agent-mail policy init`, then add allowed_peers".into(),
                )
            }
            Err(error) => return Err(format!("Invalid policy.json: {error}")),
        };
        Self::parse(&text)
    }

    /// Parses and validates policy text, as `load` does for the file.
    pub fn parse(text: &str) -> std::result::Result<Self, String> {
        let policy: Policy =
            serde_json::from_str(text).map_err(|error| format!("Invalid policy.json: {error}"))?;
        policy
            .validate()
            .map_err(|error| format!("Invalid policy.json: {error}"))?;
        Ok(policy)
    }

    fn validate(&self) -> Result<()> {
        if !(1..=64 * 1024).contains(&self.max_bytes) {
            return Err(invalid("max_bytes", "must be 1-65536"));
        }
        if self
            .allowed_peers
            .iter()
            .chain(&self.auto_answer_types)
            .any(String::is_empty)
        {
            return Err(invalid("policy", "entries cannot be empty"));
        }
        if !self.dispatch.is_object() {
            return Err(invalid("dispatch", "must be an object"));
        }
        crate::dispatch::DispatchPolicy::parse(&self.dispatch)
            .map_err(|error| invalid("dispatch", error))?;
        for (tag, workspace) in self.workspaces.iter().map(|(t, w)| (t.as_str(), w)).chain(
            self.default_workspace
                .iter()
                .map(|w| ("default_workspace", w)),
        ) {
            if !workspace.path.is_absolute() {
                return Err(invalid(
                    "workspaces",
                    format!("{tag}: path must be absolute"),
                ));
            }
        }
        if let Some(root) = self.checkout_roots.iter().find(|root| !root.is_absolute()) {
            return Err(invalid(
                "checkout_roots",
                format!("{}: path must be absolute", root.display()),
            ));
        }
        for (from, to) in &self.origin_aliases {
            for origin in [from, to] {
                if crate::checkout::norm_origin(&format!("https://{origin}")).as_deref()
                    != Some(origin.as_str())
                {
                    return Err(invalid(
                        "origin_aliases",
                        format!("{origin}: use the lowercase host/owner/name form"),
                    ));
                }
            }
        }
        Ok(())
    }

    /// `initPolicy()`: writes the template, never over an existing file.
    pub fn init(home: &Path) -> Result<(bool, PathBuf)> {
        let path = Self::path(home);
        let text = serde_json::to_string_pretty(&Self::template())? + "\n";
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                std::io::Write::write_all(&mut file, text.as_bytes())?;
                Ok((true, path))
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok((false, path)),
            Err(error) => Err(Error::Io(error)),
        }
    }
}

fn secret_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    // JS `\b` is ASCII-only, hence `(?-u:\b)`. Built from parts so this file never looks like a
    // leaked credential.
    PATTERNS.get_or_init(|| {
        [
            "-----BEGIN [A-Z ]*PRIVATE KEY-----".to_owned(),
            r"(?-u:\b)(?:sk|rk)-[A-Za-z0-9_-]{20,}".to_owned(),
            r"(?-u:\b)gh[pousr]_[A-Za-z0-9]{36,}".to_owned(),
            format!(r"(?-u:\b)A{}[0-9A-Z]{{16}}(?-u:\b)", "KIA"),
            r"(?-u:\b)xox[baprs]-[A-Za-z0-9-]{10,}".to_owned(),
            r"(?i)(?-u:\b)(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{8,}".to_owned(),
        ]
        .iter()
        .map(|pattern| Regex::new(pattern).expect("static pattern"))
        .collect()
    })
}

fn action_request() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)(?-u:\b)(?:git\s+push|force[- ]push|push\s+--force|rm\s+-rf|agent-mail\s+(?:un)?trust)(?-u:\b)")
            .expect("static pattern")
    })
}

/// `checkOutbound()`: `Err(reason)` refuses the send. `Ok` means no objection, not permission.
pub fn check_outbound(
    text: &str,
    recipient: Option<&str>,
    policy: &Policy,
    store: &Store,
) -> std::result::Result<(), String> {
    if secret_patterns()
        .iter()
        .any(|pattern| pattern.is_match(text))
    {
        return Err("Outbound agent-mail looks like it contains a secret. Send a hash or a summary instead.".into());
    }
    if text.len() > policy.max_bytes as usize {
        return Err(format!(
            "Message is {} bytes, over policy max_bytes {}. Send hashes or a summary.",
            text.len(),
            policy.max_bytes
        ));
    }
    if let Some(recipient) = recipient {
        if !peer_allowed(recipient, policy, store) {
            return Err(format!(
                "Peer \"{recipient}\" is not in policy allowed_peers."
            ));
        }
    }
    if policy.forbid_action_requests && action_request().is_match(text) {
        return Err("Asking a peer for a side-effectful action (push, delete, trust) needs the owner's approval first.".into());
    }
    Ok(())
}

/// A recipient matches by exact entry, or through its contact's fingerprint or name.
fn peer_allowed(recipient: &str, policy: &Policy, store: &Store) -> bool {
    let allowed: Vec<String> = policy
        .allowed_peers
        .iter()
        .map(|peer| peer.to_lowercase())
        .collect();
    if allowed.contains(&recipient.to_lowercase()) {
        return true;
    }
    match store.resolve_contact(recipient) {
        Ok(contact) => {
            allowed.contains(&contact.fingerprint)
                || allowed.contains(&contact.identity.name.to_lowercase())
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> Policy {
        Policy {
            allowed_peers: vec!["bob".into()],
            max_bytes: 100,
            forbid_action_requests: true,
            ..Policy::template()
        }
    }

    #[test]
    fn refuses_secrets_size_unlisted_peers_and_action_requests() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let policy = policy();
        assert!(check_outbound("status is green", Some("bob"), &policy, &store).is_ok());
        assert!(check_outbound("status is green", Some("BOB"), &policy, &store).is_ok());
        let token = format!("gh{}_{}", "p", "a".repeat(36));
        assert!(
            check_outbound(&format!("here: {token}"), Some("bob"), &policy, &store)
                .unwrap_err()
                .contains("secret")
        );
        assert!(check_outbound("api_key = abcdefgh123", Some("bob"), &policy, &store).is_err());
        assert!(
            check_outbound(&"x".repeat(101), Some("bob"), &policy, &store)
                .unwrap_err()
                .contains("max_bytes")
        );
        assert!(check_outbound("hi", Some("mallory"), &policy, &store)
            .unwrap_err()
            .contains("allowed_peers"));
        assert!(
            check_outbound("please git push origin main", Some("bob"), &policy, &store).is_err()
        );
        let relaxed = Policy {
            forbid_action_requests: false,
            ..policy
        };
        assert!(
            check_outbound("please git push origin main", Some("bob"), &relaxed, &store).is_ok()
        );
    }

    #[test]
    fn checkout_roots_must_be_absolute_and_aliases_normalized() {
        let base = serde_json::to_value(Policy::template()).unwrap();
        let with = |key: &str, value: serde_json::Value| {
            let mut policy = base.clone();
            policy[key] = value;
            Policy::parse(&policy.to_string())
        };
        let root = if cfg!(windows) { r"C:\Repos" } else { "/repos" };
        let ok = with("checkout_roots", serde_json::json!([root])).unwrap();
        assert_eq!(ok.checkout_roots, vec![PathBuf::from(root)]);
        assert!(with("checkout_roots", serde_json::json!(["Repos"]))
            .unwrap_err()
            .contains("absolute"));
        let aliases = with(
            "origin_aliases",
            serde_json::json!({ "github.com/old/app": "github.com/new/app" }),
        )
        .unwrap();
        assert_eq!(
            aliases.origin_aliases["github.com/old/app"],
            "github.com/new/app"
        );
        assert!(with(
            "origin_aliases",
            serde_json::json!({ "https://github.com/old/app": "github.com/new/app" })
        )
        .is_err());
        assert!(with(
            "origin_aliases",
            serde_json::json!({ "github.com/Old/App": "github.com/new/app" })
        )
        .is_err());
        assert_eq!(
            serde_json::to_value(Policy::template())
                .unwrap()
                .get("checkout_roots"),
            None,
            "the template does not gain keys"
        );
    }

    #[test]
    fn missing_or_invalid_policy_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        assert!(Policy::load(dir.path())
            .unwrap_err()
            .contains("policy init"));
        assert!(Policy::init(dir.path()).unwrap().0);
        assert!(!Policy::init(dir.path()).unwrap().0, "never overwrites");
        assert_eq!(Policy::load(dir.path()).unwrap(), Policy::template());
        std::fs::write(
            Policy::path(dir.path()),
            r#"{"allowed_peers":[],"max_bytes":10,"typo":1}"#,
        )
        .unwrap();
        assert!(Policy::load(dir.path()).is_err());
        std::fs::write(
            Policy::path(dir.path()),
            r#"{"allowed_peers":[],"max_bytes":0}"#,
        )
        .unwrap();
        assert!(Policy::load(dir.path()).is_err());
    }
}
