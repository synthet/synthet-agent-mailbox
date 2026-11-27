//! `mail.db`: the local SQLite store shared by the mailer, CLI, MCP and tray (ADR 0005).
//!
//! It lives on local disk under the agent-mail home, never in a synced folder (ADR 0002). WAL mode
//! with a busy timeout lets several processes read and write it. Messages are stored as
//! `Message::json()` text, which is the exact form the receipt digest covers. Never re-serialize
//! them through `serde_json::Value`: that sorts the keys.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;

use crate::envelope::{Envelope, Message};
use crate::error::{invalid, Error, Result};
use crate::identity::{fingerprint, validate_public, PublicIdentity};

pub const DB_FILE: &str = "mail.db";
const SCHEMA_VERSION: i64 = 4;

/// Applied in order to bring an older `mail.db` up to `SCHEMA_VERSION`.
const MIGRATIONS: &[(i64, &str)] = &[
    (
        2,
        "ALTER TABLE outbox ADD COLUMN downgraded INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE sent ADD COLUMN delivery_json TEXT;",
    ),
    (
        3,
        "CREATE TABLE IF NOT EXISTS runs (
           run_id          TEXT PRIMARY KEY,
           sender          TEXT NOT NULL,
           message_id      TEXT NOT NULL,
           conversation_id TEXT NOT NULL,
           project         TEXT,
           workspace       TEXT NOT NULL,
           tier            TEXT NOT NULL,
           runner          TEXT NOT NULL,
           state           TEXT NOT NULL,
           outcome         TEXT,
           cost_usd        REAL,
           reply_id        TEXT,
           created_at      INTEGER NOT NULL,
           finished_at     INTEGER
         );
         CREATE INDEX IF NOT EXISTS runs_created ON runs (created_at);
         CREATE TABLE IF NOT EXISTS consumer_seen (
           sender  TEXT NOT NULL,
           id      TEXT NOT NULL,
           seen_at INTEGER NOT NULL,
           PRIMARY KEY (sender, id)
         );
         CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    ),
    (
        // T-7: the run-bound reply token (stored as its SHA-256), and the same-PC sessions,
        // conversation leases and local messages of the TS journal. Never synced.
        4,
        "ALTER TABLE runs ADD COLUMN token_sha256 TEXT;
         ALTER TABLE runs ADD COLUMN deadline_at INTEGER;
         CREATE TABLE IF NOT EXISTS agents (
           agent_id   TEXT PRIMARY KEY,
           alias      TEXT NOT NULL UNIQUE,
           created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS sessions (
           session_id         TEXT PRIMARY KEY,
           agent_id           TEXT NOT NULL,
           harness            TEXT,
           model              TEXT,
           harness_session_id TEXT,
           display_name       TEXT,
           workspace          TEXT,
           last_seen          INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS conversation_leases (
           conversation_id TEXT PRIMARY KEY,
           session_id      TEXT NOT NULL,
           lease_until     INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS local_messages (
           message_id      TEXT PRIMARY KEY,
           thread_id       TEXT NOT NULL,
           sender_agent    TEXT NOT NULL,
           sender_session  TEXT NOT NULL,
           subject         TEXT NOT NULL,
           body            TEXT NOT NULL,
           idempotency_key TEXT UNIQUE,
           created_at      INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS local_messages_sender ON local_messages (sender_session, created_at);
         CREATE TABLE IF NOT EXISTS local_audience (
           message_id TEXT NOT NULL,
           agent_id   TEXT NOT NULL,
           PRIMARY KEY (message_id, agent_id)
         );
         CREATE TABLE IF NOT EXISTS local_acks (
           session_id TEXT NOT NULL,
           message_id TEXT NOT NULL,
           acked_at   INTEGER NOT NULL,
           PRIMARY KEY (session_id, message_id)
         );",
    ),
];

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS contacts (
  fingerprint   TEXT PRIMARY KEY,
  identity_json TEXT NOT NULL,
  endpoint      TEXT,
  added_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hosts (
  fingerprint   TEXT NOT NULL,
  endpoint      TEXT NOT NULL,
  name          TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  source        TEXT NOT NULL,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  PRIMARY KEY (fingerprint, endpoint)
);
CREATE TABLE IF NOT EXISTS inbox (
  sender          TEXT NOT NULL,
  id              TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_json    TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  received_at     INTEGER NOT NULL,
  PRIMARY KEY (sender, id)
);
CREATE INDEX IF NOT EXISTS inbox_conversation ON inbox (conversation_id);
CREATE TABLE IF NOT EXISTS acks (
  sender   TEXT NOT NULL,
  id       TEXT NOT NULL,
  acked_at INTEGER NOT NULL,
  PRIMARY KEY (sender, id)
);
CREATE TABLE IF NOT EXISTS outbox (
  id              TEXT PRIMARY KEY,
  recipient       TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_json    TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'queued',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sent (
  id              TEXT PRIMARY KEY,
  recipient       TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_json    TEXT NOT NULL,
  sent_at         INTEGER NOT NULL
);
";

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A pinned peer. Only `trust` writes these; discovery never does.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Contact {
    pub fingerprint: String,
    pub identity: PublicIdentity,
    pub endpoint: Option<String>,
}

/// Where a host advert came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostSource {
    Multicast,
    Tailscale,
    Static,
}

impl HostSource {
    fn as_str(self) -> &'static str {
        match self {
            HostSource::Multicast => "multicast",
            HostSource::Tailscale => "tailscale",
            HostSource::Static => "static",
        }
    }
}

/// A host seen through a verified advert. Seeing a host grants it nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Host {
    pub fingerprint: String,
    pub endpoint: String,
    pub name: String,
    pub source: String,
    pub last_seen: u64,
    pub trusted: bool,
}

/// What `receive` did with a message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Received {
    New,
    /// The same message again, byte for byte: answer with another receipt.
    Duplicate,
    /// Same sender and id, different content: refuse (HTTP 409).
    Conflict,
}

pub struct Store {
    pub(crate) conn: Connection,
    path: PathBuf,
}

impl Store {
    /// Opens `<home>/mail.db` only if the home is set up (`identity.json` and `mail.db` exist), so a
    /// hook or reader pointed at a mistyped `--home` fails instead of creating an empty mailbox.
    pub fn open_existing(home: &Path) -> Result<Self> {
        if !home.join("identity.json").is_file() || !home.join(DB_FILE).is_file() {
            return Err(invalid(
                "home",
                format!(
                    "no agent-mail home at {} (identity.json or mail.db is missing); check --home",
                    home.display()
                ),
            ));
        }
        Store::open(home)
    }

    /// Opens or creates `<home>/mail.db`.
    pub fn open(home: &Path) -> Result<Self> {
        std::fs::create_dir_all(home)?;
        let path = home.join(DB_FILE);
        let conn = Connection::open(&path).map_err(db)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(db)?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(db)?;
        conn.pragma_update(None, "foreign_keys", "ON").map_err(db)?;
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(db)?;
        if version > SCHEMA_VERSION {
            return Err(invalid(
                "mail.db",
                format!("schema version {version} is newer than this build ({SCHEMA_VERSION})"),
            ));
        }
        conn.execute_batch(SCHEMA).map_err(db)?;
        let mut store = Store { conn, path };
        store.migrate()?;
        Ok(store)
    }

    /// Brings the schema to `SCHEMA_VERSION`. The version is read again inside an immediate
    /// transaction, so two processes opening the same file can't both apply a step.
    fn migrate(&mut self) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db)?;
        let version: i64 = tx
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(db)?;
        if version > SCHEMA_VERSION {
            return Err(invalid(
                "mail.db",
                format!("schema version {version} is newer than this build ({SCHEMA_VERSION})"),
            ));
        }
        // A fresh file has the current baseline tables but version 0; baseline is version 1.
        for (target, sql) in MIGRATIONS {
            if version.max(1) < *target {
                tx.execute_batch(sql).map_err(db)?;
            }
        }
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(db)?;
        tx.commit().map_err(db)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Pins a peer. The fingerprint, when given, must match the identity.
    pub fn trust(
        &self,
        identity: &PublicIdentity,
        expected: Option<&str>,
        endpoint: Option<&str>,
    ) -> Result<String> {
        validate_public(identity)?;
        let fp = fingerprint(identity)?;
        if expected.is_some_and(|expected| expected != fp) {
            return Err(invalid("fingerprint", "does not match the identity"));
        }
        self.conn
            .execute(
                "INSERT INTO contacts (fingerprint, identity_json, endpoint, added_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (fingerprint) DO UPDATE SET identity_json = excluded.identity_json,
                   endpoint = COALESCE(excluded.endpoint, contacts.endpoint)",
                params![fp, serde_json::to_string(identity)?, endpoint, now_ms() as i64],
            )
            .map_err(db)?;
        Ok(fp)
    }

    pub fn contact(&self, fp: &str) -> Result<Option<Contact>> {
        self.conn
            .query_row(
                "SELECT fingerprint, identity_json, endpoint FROM contacts WHERE fingerprint = ?1",
                [fp],
                contact_row,
            )
            .optional()
            .map_err(db)?
            .transpose()
    }

    pub fn contacts(&self) -> Result<Vec<Contact>> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT fingerprint, identity_json, endpoint FROM contacts ORDER BY fingerprint",
            )
            .map_err(db)?;
        let rows = statement.query_map([], contact_row).map_err(db)?;
        rows.map(|row| row.map_err(db)?).collect()
    }

    /// Stores a received message, or reports that it is a duplicate or a conflict. One immediate
    /// transaction, so two receivers racing on the same message can't both insert.
    pub fn receive(&mut self, message: &Message) -> Result<Received> {
        let json = message.json();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db)?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT message_json FROM inbox WHERE sender = ?1 AND id = ?2",
                params![message.sender, message.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db)?;
        let outcome = match existing {
            Some(stored) if stored == json => Received::Duplicate,
            Some(_) => Received::Conflict,
            None => {
                tx.execute(
                    "INSERT INTO inbox (sender, id, conversation_id, message_json, created_at, received_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![message.sender, message.id, message.conversation_id, json, message.created_at as i64, now_ms() as i64],
                )
                .map_err(db)?;
                Received::New
            }
        };
        tx.commit().map_err(db)?;
        Ok(outcome)
    }

    /// Unacknowledged inbox messages, oldest first.
    pub fn inbox(&self, limit: usize) -> Result<Vec<Message>> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT message_json FROM inbox i
                 WHERE NOT EXISTS (SELECT 1 FROM acks a WHERE a.sender = i.sender AND a.id = i.id)
                 ORDER BY created_at, received_at LIMIT ?1",
            )
            .map_err(db)?;
        let rows = statement
            .query_map([limit as i64], |row| row.get::<_, String>(0))
            .map_err(db)?;
        rows.map(|row| {
            let json = row.map_err(db)?;
            Message::parse_signed(serde_json::from_str(&json)?, Envelope::LATEST)
        })
        .collect()
    }

    /// Records a verified advert. `hosts` is separate from `contacts`, so this never pins anyone.
    pub fn saw_host(
        &self,
        identity: &PublicIdentity,
        endpoint: &str,
        source: HostSource,
    ) -> Result<()> {
        let fp = fingerprint(identity)?;
        let now = now_ms() as i64;
        self.conn
            .execute(
                "INSERT INTO hosts (fingerprint, endpoint, name, identity_json, source, first_seen, last_seen)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
                 ON CONFLICT (fingerprint, endpoint) DO UPDATE SET name = excluded.name,
                   identity_json = excluded.identity_json, source = excluded.source, last_seen = excluded.last_seen",
                params![fp, endpoint, identity.name, serde_json::to_string(identity)?, source.as_str(), now],
            )
            .map_err(db)?;
        Ok(())
    }

    /// Hosts seen since `since_ms`, most recent first, with whether each is pinned.
    pub fn hosts(&self, since_ms: u64) -> Result<Vec<Host>> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT h.fingerprint, h.endpoint, h.name, h.source, h.last_seen,
                        EXISTS (SELECT 1 FROM contacts c WHERE c.fingerprint = h.fingerprint)
                 FROM hosts h WHERE h.last_seen >= ?1 ORDER BY h.last_seen DESC",
            )
            .map_err(db)?;
        let rows = statement
            .query_map([since_ms as i64], |row| {
                Ok(Host {
                    fingerprint: row.get(0)?,
                    endpoint: row.get(1)?,
                    name: row.get(2)?,
                    source: row.get(3)?,
                    last_seen: row.get::<_, i64>(4)? as u64,
                    trusted: row.get(5)?,
                })
            })
            .map_err(db)?;
        rows.map(|row| row.map_err(db)).collect()
    }
}

pub(crate) fn contact_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<Contact>> {
    let fp: String = row.get(0)?;
    let identity_json: String = row.get(1)?;
    let endpoint: Option<String> = row.get(2)?;
    Ok(serde_json::from_str(&identity_json)
        .map_err(Error::from)
        .map(|identity| Contact {
            fingerprint: fp,
            identity,
            endpoint,
        }))
}

pub(crate) fn db(error: rusqlite::Error) -> Error {
    Error::Db(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_v3_mail_db_with_runs_upgrades_to_v4_and_keeps_its_rows() {
        let dir = tempfile::tempdir().unwrap();
        {
            // Build the v3 file the way an older build left it.
            let conn = Connection::open(dir.path().join(DB_FILE)).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            for (target, sql) in MIGRATIONS {
                if *target <= 3 {
                    conn.execute_batch(sql).unwrap();
                }
            }
            conn.pragma_update(None, "user_version", 3).unwrap();
            conn.execute(
                "INSERT INTO runs (run_id, sender, message_id, conversation_id, workspace, tier, runner, state, created_at)
                 VALUES ('old', 's', 'm', 'c', 'w', 'read', 'claude', 'done', 1)",
                [],
            )
            .unwrap();
        }
        let store = Store::open(dir.path()).unwrap();
        let version: i64 = store
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let runs = store.recent_runs(10).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].run_id, "old");
        let (token, deadline): (Option<String>, Option<i64>) = store
            .conn
            .query_row(
                "SELECT token_sha256, deadline_at FROM runs WHERE run_id = 'old'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((token, deadline), (None, None));
        assert_eq!(store.live_sessions().unwrap(), vec![]);
        // Opening again is a no-op.
        drop(store);
        assert!(Store::open(dir.path()).is_ok());
    }
}
