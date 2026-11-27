//! The tray consumer's bookkeeping in `mail.db` (schema v3; run tokens and deadlines v4): which
//! inbox messages it has handled, the one-time backlog marker, and one row per headless run.
//!
//! A run's state goes `running` → `finishing` (the consumer closed the run-bound window) →
//! `done` or `failed`. Run-bound calls work only while `running` and before `deadline_at`.

use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::envelope::{Envelope, Message};
use crate::error::{invalid, Result};
use crate::store::{db, now_ms, Store};

const STARTED_KEY: &str = "consumer_started";

/// The message a run answers, once its token has been checked (AC-15).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunMessage {
    pub sender: String,
    pub message_id: String,
}

/// Why a run-bound call was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunRefusal {
    UnknownRun,
    WrongToken,
    NotRunning,
    Expired,
    AlreadyReplied,
}

impl std::fmt::Display for RunRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            RunRefusal::UnknownRun => "reply_refused: unknown run",
            RunRefusal::WrongToken => "reply_refused: wrong run token",
            RunRefusal::NotRunning => "reply_refused: the run has finished",
            RunRefusal::Expired => "reply_refused: the run's time limit has passed",
            RunRefusal::AlreadyReplied => "reply_refused: this run already replied",
        })
    }
}

/// The alias a run's own same-PC session publishes under, never the host's agent.
pub const RUN_ALIAS: &str = "agent-mail-run";

/// The session a run publishes from: one per run, ended when the run finishes.
pub fn run_session_id(run_id: &str) -> String {
    format!("run:{run_id}")
}

/// A fresh run token: 32 random bytes, hex. Only its SHA-256 is stored.
pub fn new_run_token() -> String {
    let mut bytes = [0u8; 32];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut bytes);
    hex::encode(bytes)
}

fn token_hash(token: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(token.as_bytes()))
}

/// Compares in time that doesn't depend on where the inputs differ.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |diff, (x, y)| diff | (x ^ y))
            == 0
}

/// One headless run, as the dashboard shows it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Run {
    pub run_id: String,
    pub sender: String,
    pub message_id: String,
    pub conversation_id: String,
    pub project: Option<String>,
    pub workspace: String,
    pub tier: String,
    pub runner: String,
    pub state: String,
    pub outcome: Option<String>,
    pub cost_usd: Option<f64>,
    pub reply_id: Option<String>,
    pub created_at: u64,
    pub finished_at: Option<u64>,
}

impl Store {
    /// Whether the consumer has run before for this home. Its first enabled pass only records the
    /// backlog, so turning dispatch on doesn't answer old mail.
    pub fn consumer_started(&self) -> Result<bool> {
        Ok(self
            .conn
            .query_row("SELECT 1 FROM meta WHERE key = ?1", [STARTED_KEY], |_| {
                Ok(())
            })
            .optional()
            .map_err(db)?
            .is_some())
    }

    /// Records the whole current inbox as handled and remembers that the consumer has started.
    pub fn record_backlog(&self) -> Result<usize> {
        let now = now_ms() as i64;
        let marked = self
            .conn
            .execute(
                "INSERT OR IGNORE INTO consumer_seen (sender, id, seen_at) SELECT sender, id, ?1 FROM inbox",
                [now],
            )
            .map_err(db)?;
        self.conn
            .execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
                params![STARTED_KEY, now.to_string()],
            )
            .map_err(db)?;
        Ok(marked)
    }

    /// Unacknowledged inbox messages the consumer hasn't handled, oldest first.
    pub fn unhandled_inbox(&self, limit: usize) -> Result<Vec<Message>> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT message_json FROM inbox i
                 WHERE NOT EXISTS (SELECT 1 FROM consumer_seen s WHERE s.sender = i.sender AND s.id = i.id)
                   AND NOT EXISTS (SELECT 1 FROM acks a WHERE a.sender = i.sender AND a.id = i.id)
                 ORDER BY created_at, received_at LIMIT ?1",
            )
            .map_err(db)?;
        let rows = statement
            .query_map([limit as i64], |row| row.get::<_, String>(0))
            .map_err(db)?;
        rows.map(|row| {
            Message::parse_signed(serde_json::from_str(&row.map_err(db)?)?, Envelope::LATEST)
        })
        .collect()
    }

    /// Marks a message handled before the consumer acts on it, so a crash can drop an action but
    /// never repeat one.
    pub fn mark_handled(&self, sender: &str, id: &str) -> Result<()> {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO consumer_seen (sender, id, seen_at) VALUES (?1, ?2, ?3)",
                params![sender, id, now_ms() as i64],
            )
            .map_err(db)?;
        Ok(())
    }

    pub fn start_run(&self, run: &Run) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO runs (run_id, sender, message_id, conversation_id, project, workspace, tier, runner, state, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    run.run_id,
                    run.sender,
                    run.message_id,
                    run.conversation_id,
                    run.project,
                    run.workspace,
                    run.tier,
                    run.runner,
                    run.state,
                    run.created_at as i64
                ],
            )
            .map_err(db)?;
        Ok(())
    }

    pub fn finish_run(
        &self,
        run_id: &str,
        state: &str,
        outcome: &str,
        cost_usd: Option<f64>,
        reply_id: Option<&str>,
    ) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET state = ?2, outcome = ?3, cost_usd = ?4, reply_id = COALESCE(?5, reply_id), finished_at = ?6
                 WHERE run_id = ?1",
                params![run_id, state, outcome, cost_usd, reply_id, now_ms() as i64],
            )
            .map_err(db)?;
        self.end_run_session(run_id)
    }

    /// The run's own same-PC session stops counting as live, and its leases go.
    fn end_run_session(&self, run_id: &str) -> Result<()> {
        let session = run_session_id(run_id);
        self.conn
            .execute(
                "UPDATE sessions SET last_seen = 0 WHERE session_id = ?1",
                [&session],
            )
            .map_err(db)?;
        self.conn
            .execute(
                "DELETE FROM conversation_leases WHERE session_id = ?1",
                [&session],
            )
            .map_err(db)?;
        Ok(())
    }

    /// Ends the run-bound window before the consumer picks the reply, so a late call from a
    /// still-running agent can't add a second one. False when the run wasn't running.
    pub fn close_run(&self, run_id: &str) -> Result<bool> {
        Ok(self
            .conn
            .execute(
                "UPDATE runs SET state = 'finishing' WHERE run_id = ?1 AND state = 'running'",
                [run_id],
            )
            .map_err(db)?
            == 1)
    }

    /// At consumer start, every run still `running` or `finishing` belongs to a process that is
    /// gone: mark it failed (`expired`) so its token stops working. Returns how many.
    pub fn expire_unfinished_runs(&self) -> Result<usize> {
        let ids: Vec<String> = self
            .conn
            .prepare("SELECT run_id FROM runs WHERE state IN ('running', 'finishing')")
            .map_err(db)?
            .query_map([], |row| row.get(0))
            .map_err(db)?
            .collect::<rusqlite::Result<_>>()
            .map_err(db)?;
        for id in &ids {
            self.finish_run(id, "failed", "expired", None, None)?;
        }
        Ok(ids.len())
    }

    /// Records the SHA-256 of the token handed to a run in `AGENT_MAIL_RUN_TOKEN`, and the time
    /// after which run-bound calls are refused.
    pub fn bind_run_token(&self, run_id: &str, token: &str, deadline_ms: u64) -> Result<()> {
        let changed = self
            .conn
            .execute(
                "UPDATE runs SET token_sha256 = ?2, deadline_at = ?3 WHERE run_id = ?1",
                params![run_id, token_hash(token), deadline_ms as i64],
            )
            .map_err(db)?;
        if changed == 0 {
            return Err(invalid("run_id", "unknown run"));
        }
        Ok(())
    }

    /// Checks a run token without using the run's reply. A run-bound call must come while the run
    /// is still running and before its deadline.
    pub fn check_run(
        &self,
        run_id: &str,
        token: &str,
    ) -> Result<std::result::Result<RunMessage, RunRefusal>> {
        type Row = (String, String, String, Option<String>, Option<i64>);
        let row: Option<Row> = self
            .conn
            .query_row(
                "SELECT sender, message_id, state, token_sha256, deadline_at FROM runs WHERE run_id = ?1",
                [run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()
            .map_err(db)?;
        let Some((sender, message_id, state, stored, deadline)) = row else {
            return Ok(Err(RunRefusal::UnknownRun));
        };
        let matches = stored.is_some_and(|stored| same(&stored, &token_hash(token)));
        if token.is_empty() || !matches {
            return Ok(Err(RunRefusal::WrongToken));
        }
        if state != "running" {
            return Ok(Err(RunRefusal::NotRunning));
        }
        if deadline.is_none_or(|deadline| now_ms() as i64 > deadline) {
            return Ok(Err(RunRefusal::Expired));
        }
        Ok(Ok(RunMessage { sender, message_id }))
    }

    /// Takes the run's one reply for `reply_id`, after checking the token. A second call, or a
    /// call racing the first, is refused. `release_run_reply` gives the slot back if sending fails.
    pub fn claim_run_reply(
        &self,
        run_id: &str,
        token: &str,
        reply_id: &str,
    ) -> Result<std::result::Result<RunMessage, RunRefusal>> {
        let message = match self.check_run(run_id, token)? {
            Ok(message) => message,
            Err(refusal) => return Ok(Err(refusal)),
        };
        let claimed = self
            .conn
            .execute(
                "UPDATE runs SET reply_id = ?2 WHERE run_id = ?1 AND reply_id IS NULL AND state = 'running'",
                params![run_id, reply_id],
            )
            .map_err(db)?;
        Ok(if claimed == 1 {
            Ok(message)
        } else {
            Err(RunRefusal::AlreadyReplied)
        })
    }

    /// Gives back a reply slot that `claim_run_reply` took, when the reply couldn't be queued.
    pub fn release_run_reply(&self, run_id: &str, reply_id: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET reply_id = NULL WHERE run_id = ?1 AND reply_id = ?2",
                params![run_id, reply_id],
            )
            .map_err(db)?;
        Ok(())
    }

    /// The reply a run already sent, if any (set by the consumer, or by a run-bound reply in T-7).
    pub fn run_reply(&self, run_id: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT reply_id FROM runs WHERE run_id = ?1",
                [run_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(db)?
            .flatten())
    }

    pub fn recent_runs(&self, limit: usize) -> Result<Vec<Run>> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT run_id, sender, message_id, conversation_id, project, workspace, tier, runner, state, outcome,
                        cost_usd, reply_id, created_at, finished_at
                 FROM runs ORDER BY created_at DESC LIMIT ?1",
            )
            .map_err(db)?;
        let rows = statement
            .query_map([limit as i64], |row| {
                Ok(Run {
                    run_id: row.get(0)?,
                    sender: row.get(1)?,
                    message_id: row.get(2)?,
                    conversation_id: row.get(3)?,
                    project: row.get(4)?,
                    workspace: row.get(5)?,
                    tier: row.get(6)?,
                    runner: row.get(7)?,
                    state: row.get(8)?,
                    outcome: row.get(9)?,
                    cost_usd: row.get(10)?,
                    reply_id: row.get(11)?,
                    created_at: row.get::<_, i64>(12)? as u64,
                    finished_at: row.get::<_, Option<i64>>(13)?.map(|at| at as u64),
                })
            })
            .map_err(db)?;
        rows.map(|row| row.map_err(db)).collect()
    }
}
