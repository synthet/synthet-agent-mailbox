//! Outbox, sent mail and the read views the CLI needs, on top of `Store`.
//!
//! A queued message is stored unsigned. The mailer decides the envelope on its first attempt,
//! signs, and writes the signed form back; every retry then reuses those exact bytes, as the TS
//! sender reuses the message "as it was signed". Imported TS outbox rows arrive already signed.

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::Value;

use crate::envelope::{AgentMeta, Envelope, Message};
use crate::error::{invalid, Error, Result};
use crate::store::{db, now_ms, Contact, Store};

/// A queued message as the mailer sees it.
#[derive(Clone, Debug)]
pub struct OutboxRow {
    pub id: String,
    pub recipient: String,
    pub message: Message,
    pub attempts: u32,
}

/// Where a message id stands.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Delivery {
    Queued {
        message_id: String,
        conversation_id: String,
        attempts: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Delivered {
        message_id: String,
        conversation_id: String,
        #[serde(flatten)]
        details: Value,
    },
    /// Given up: the outbox no longer retries it (a task held past [`TASK_HOLD_LIMIT_MS`]).
    Expired {
        message_id: String,
        conversation_id: String,
        error: String,
    },
}

/// How long a task waits for a peer that can't take agent-mail/1.3 before it expires (ADR 0006).
pub const TASK_HOLD_LIMIT_MS: u64 = 24 * 60 * 60 * 1000;

/// Whether a task created at `created_at` has been held too long at `now`.
pub fn task_hold_expired(created_at: u64, now: u64) -> bool {
    now.saturating_sub(created_at) >= TASK_HOLD_LIMIT_MS
}

/// Queue/sent/inbox counts, as `status` reports them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Counts {
    pub pending: u64,
    pub unread: u64,
    pub sent: u64,
}

fn parse_stored(json: &str) -> Result<Message> {
    serde_json::from_str::<Message>(json)?.normalized(Envelope::LATEST)
}

/// TS `conflicts()`: the same id must mean the same message.
fn conflicts(existing: &Message, wanted: &Message, explicit_conversation: bool) -> bool {
    if existing.text != wanted.text || existing.recipient != wanted.recipient {
        return true;
    }
    if explicit_conversation && existing.conversation_id != wanted.conversation_id {
        return true;
    }
    let (old, new) = (
        existing.agent.clone().unwrap_or_default(),
        wanted.agent.clone().unwrap_or_default(),
    );
    let differs = |a: &Option<String>, b: &Option<String>| b.is_some() && a != b;
    let AgentMeta {
        harness,
        name,
        model,
        session_id,
    } = new;
    differs(&old.harness, &harness)
        || differs(&old.name, &name)
        || differs(&old.model, &model)
        || differs(&old.session_id, &session_id)
}

impl Store {
    /// TS `contact()`: a full fingerprint, or a name that matches exactly one contact.
    pub fn resolve_contact(&self, recipient: &str) -> Result<Contact> {
        let wanted = recipient.to_lowercase();
        let matches: Vec<Contact> = self
            .contacts()?
            .into_iter()
            .filter(|contact| {
                contact.fingerprint == wanted || contact.identity.name.to_lowercase() == wanted
            })
            .collect();
        match matches.len() {
            1 => Ok(matches.into_iter().next().expect("one match")),
            0 => Err(invalid(
                "recipient",
                "Unknown peer; discover and trust its verified fingerprint first",
            )),
            _ => Err(invalid(
                "recipient",
                "Ambiguous peer name; use full fingerprint",
            )),
        }
    }

    pub fn untrust(&self, fp: &str) -> Result<bool> {
        Ok(self
            .conn
            .execute("DELETE FROM contacts WHERE fingerprint = ?1", [fp])
            .map_err(db)?
            > 0)
    }

    /// A verified receipt from this address: remember it for later sends.
    pub fn set_contact_endpoint(&self, fp: &str, endpoint: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE contacts SET endpoint = ?2 WHERE fingerprint = ?1",
                params![fp, endpoint],
            )
            .map_err(db)?;
        Ok(())
    }

    /// Endpoints recently seen advertising this fingerprint, newest first.
    pub fn endpoints_seen(&self, fp: &str, since_ms: u64) -> Result<Vec<String>> {
        let mut statement = self
            .conn
            .prepare("SELECT endpoint FROM hosts WHERE fingerprint = ?1 AND last_seen >= ?2 ORDER BY last_seen DESC")
            .map_err(db)?;
        let rows = statement
            .query_map(params![fp, since_ms as i64], |row| row.get(0))
            .map_err(db)?;
        rows.map(|row| row.map_err(db)).collect()
    }

    /// Queues an unsigned message. A repeat with the same id and content is accepted as is; the
    /// same id with other content is refused.
    pub fn queue(&mut self, message: &Message, explicit_conversation: bool) -> Result<Delivery> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db)?;
        let existing: Option<(String, bool)> = tx
            .query_row(
                "SELECT message_json, 1 FROM sent WHERE id = ?1 UNION ALL SELECT message_json, 0 FROM outbox WHERE id = ?1 LIMIT 1",
                [&message.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db)?;
        if let Some((json, _)) = &existing {
            if conflicts(&parse_stored(json)?, message, explicit_conversation) {
                return Err(invalid(
                    "message_id",
                    "Message id already used with different content",
                ));
            }
        } else {
            tx.execute(
                "INSERT INTO outbox (id, recipient, conversation_id, message_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![message.id, message.recipient, message.conversation_id, message.json(), now_ms() as i64],
            )
            .map_err(db)?;
        }
        tx.commit().map_err(db)?;
        self.delivery(&message.id)?
            .ok_or_else(|| Error::Db("queued message vanished".into()))
    }

    /// Where an id stands, or `None` if this host never queued it.
    pub fn delivery(&self, id: &str) -> Result<Option<Delivery>> {
        let sent: Option<(String, String, Option<String>)> = self
            .conn
            .query_row(
                "SELECT id, conversation_id, delivery_json FROM sent WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(db)?;
        if let Some((message_id, conversation_id, details)) = sent {
            let details = details
                .and_then(|json| serde_json::from_str(&json).ok())
                .unwrap_or(Value::Object(Default::default()));
            return Ok(Some(Delivery::Delivered {
                message_id,
                conversation_id,
                details,
            }));
        }
        self.conn
            .query_row(
                "SELECT id, conversation_id, attempts, last_error, state FROM outbox WHERE id = ?1",
                [id],
                |row| {
                    let state: String = row.get(4)?;
                    Ok(if state == "expired" {
                        Delivery::Expired {
                            message_id: row.get(0)?,
                            conversation_id: row.get(1)?,
                            error: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                        }
                    } else {
                        Delivery::Queued {
                            message_id: row.get(0)?,
                            conversation_id: row.get(1)?,
                            attempts: row.get::<_, i64>(2)? as u32,
                            error: row.get(3)?,
                        }
                    })
                },
            )
            .optional()
            .map_err(db)
    }

    /// Queued messages whose next attempt is due, oldest first.
    pub fn due_outbox(&self, now: u64, limit: usize) -> Result<Vec<OutboxRow>> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT id, recipient, message_json, attempts FROM outbox
                 WHERE state = 'queued' AND next_attempt_at <= ?1 ORDER BY created_at LIMIT ?2",
            )
            .map_err(db)?;
        let rows = statement
            .query_map(params![now as i64, limit as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(db)?;
        rows.map(|row| {
            let (id, recipient, json, attempts) = row.map_err(db)?;
            Ok(OutboxRow {
                id,
                recipient,
                message: parse_stored(&json)?,
                attempts: attempts as u32,
            })
        })
        .collect()
    }

    /// Stores the signed form so retries send the same bytes.
    pub fn mark_signed(&self, id: &str, signed: &Message, downgraded: bool) -> Result<()> {
        self.conn
            .execute(
                "UPDATE outbox SET message_json = ?2, downgraded = ?3 WHERE id = ?1",
                params![id, signed.json(), downgraded],
            )
            .map_err(db)?;
        Ok(())
    }

    pub fn was_downgraded(&self, id: &str) -> Result<bool> {
        Ok(self
            .conn
            .query_row("SELECT downgraded FROM outbox WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(db)?
            .unwrap_or(false))
    }

    /// Moves a delivered message from the outbox to `sent`, in one transaction.
    pub fn delivered(&mut self, id: &str, signed: &Message, details: &Value) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db)?;
        tx.execute(
            "INSERT OR IGNORE INTO sent (id, recipient, conversation_id, message_json, sent_at, delivery_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, signed.recipient, signed.conversation_id, signed.json(), now_ms() as i64, details.to_string()],
        )
        .map_err(db)?;
        tx.execute("DELETE FROM outbox WHERE id = ?1", [id])
            .map_err(db)?;
        tx.commit().map_err(db)
    }

    /// Stops retrying `id`: it stays in the outbox as `expired` with `error`, for status and the owner.
    pub fn expire(&self, id: &str, error: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE outbox SET state = 'expired', last_error = ?2 WHERE id = ?1",
                params![id, error],
            )
            .map_err(db)?;
        Ok(())
    }

    pub fn failed_attempt(&self, id: &str, error: &str, next_attempt_at: u64) -> Result<()> {
        self.conn
            .execute(
                // An expired row keeps its reason and attempt count.
                "UPDATE outbox SET attempts = attempts + 1, last_error = ?2, next_attempt_at = ?3 WHERE id = ?1 AND state = 'queued'",
                params![id, error, next_attempt_at as i64],
            )
            .map_err(db)?;
        Ok(())
    }

    /// `flush`: every queued message becomes due now. Returns how many are queued.
    pub fn retry_all(&self) -> Result<usize> {
        self.conn
            .execute(
                "UPDATE outbox SET next_attempt_at = 0 WHERE state = 'queued'",
                [],
            )
            .map_err(db)
    }

    /// TS `acknowledge()`: only a message in the inbox can be acknowledged.
    pub fn ack(&self, sender: &str, id: &str) -> Result<()> {
        let known: bool = self
            .conn
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM inbox WHERE sender = ?1 AND id = ?2)",
                params![sender, id],
                |row| row.get(0),
            )
            .map_err(db)?;
        if !known {
            return Err(invalid("message_id", "Unknown inbox message"));
        }
        self.conn
            .execute(
                "INSERT OR IGNORE INTO acks (sender, id, acked_at) VALUES (?1, ?2, ?3)",
                params![sender, id, now_ms() as i64],
            )
            .map_err(db)?;
        Ok(())
    }

    /// Inbox, sent and outbox messages in one conversation, oldest first.
    pub fn thread(&self, conversation_id: &str) -> Result<Vec<Message>> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT message_json FROM inbox WHERE conversation_id = ?1
                 UNION ALL SELECT message_json FROM sent WHERE conversation_id = ?1
                 UNION ALL SELECT message_json FROM outbox WHERE conversation_id = ?1",
            )
            .map_err(db)?;
        let rows = statement
            .query_map([conversation_id], |row| row.get::<_, String>(0))
            .map_err(db)?;
        let mut messages = rows
            .map(|row| parse_stored(&row.map_err(db)?))
            .collect::<Result<Vec<_>>>()?;
        messages.sort_by_key(|message| message.created_at);
        Ok(messages)
    }

    pub fn counts(&self) -> Result<Counts> {
        self.conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM outbox WHERE state = 'queued'),
                        (SELECT COUNT(*) FROM inbox i WHERE NOT EXISTS
                           (SELECT 1 FROM acks a WHERE a.sender = i.sender AND a.id = i.id)),
                        (SELECT COUNT(*) FROM sent)",
                [],
                |row| {
                    Ok(Counts {
                        pending: row.get::<_, i64>(0)? as u64,
                        unread: row.get::<_, i64>(1)? as u64,
                        sent: row.get::<_, i64>(2)? as u64,
                    })
                },
            )
            .map_err(db)
    }

    /// A contact, inserted only if absent (migration never overwrites).
    pub(crate) fn import_contact(&self, contact: &Contact) -> Result<bool> {
        Ok(self
            .conn
            .execute(
                "INSERT OR IGNORE INTO contacts (fingerprint, identity_json, endpoint, added_at) VALUES (?1, ?2, ?3, ?4)",
                params![contact.fingerprint, serde_json::to_string(&contact.identity)?, contact.endpoint, now_ms() as i64],
            )
            .map_err(db)?
            > 0)
    }

    pub(crate) fn import_inbox(&self, message: &Message) -> Result<bool> {
        Ok(self
            .conn
            .execute(
                "INSERT OR IGNORE INTO inbox (sender, id, conversation_id, message_json, created_at, received_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![message.sender, message.id, message.conversation_id, message.json(), message.created_at as i64],
            )
            .map_err(db)?
            > 0)
    }

    pub(crate) fn import_ack(&self, sender: &str, id: &str) -> Result<bool> {
        Ok(self
            .conn
            .execute(
                "INSERT OR IGNORE INTO acks (sender, id, acked_at) VALUES (?1, ?2, ?3)",
                params![sender, id, now_ms() as i64],
            )
            .map_err(db)?
            > 0)
    }

    pub(crate) fn import_outbox(&self, message: &Message) -> Result<bool> {
        let delivered: bool = self
            .conn
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM sent WHERE id = ?1)",
                [&message.id],
                |row| row.get(0),
            )
            .map_err(db)?;
        if delivered {
            return Ok(false);
        }
        Ok(self
            .conn
            .execute(
                "INSERT OR IGNORE INTO outbox (id, recipient, conversation_id, message_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![message.id, message.recipient, message.conversation_id, message.json(), message.created_at as i64],
            )
            .map_err(db)?
            > 0)
    }

    pub(crate) fn import_sent(&self, message: &Message) -> Result<bool> {
        Ok(self
            .conn
            .execute(
                "INSERT OR IGNORE INTO sent (id, recipient, conversation_id, message_json, sent_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![message.id, message.recipient, message.conversation_id, message.json(), message.created_at as i64],
            )
            .map_err(db)?
            > 0)
    }

    /// The most recently seen advert for a fingerprint: its identity and endpoint. Used by
    /// `trust NAME --fingerprint FP`, which pins only a fingerprint the owner typed.
    pub fn seen_identity(
        &self,
        fp: &str,
    ) -> Result<Option<(crate::identity::PublicIdentity, String)>> {
        let row: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT identity_json, endpoint FROM hosts WHERE fingerprint = ?1 ORDER BY last_seen DESC LIMIT 1",
                [fp],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db)?;
        row.map(|(identity, endpoint)| Ok((serde_json::from_str(&identity)?, endpoint)))
            .transpose()
    }

    /// A received message by sender and id, read or not.
    pub fn inbox_message(&self, sender: &str, id: &str) -> Result<Option<Message>> {
        let json: Option<String> = self
            .conn
            .query_row(
                "SELECT message_json FROM inbox WHERE sender = ?1 AND id = ?2",
                params![sender, id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db)?;
        json.map(|json| parse_stored(&json)).transpose()
    }

    /// Whether an automatic reply to `original_id` is already sent or queued (other than `except`).
    pub fn has_auto_reply(&self, original_id: &str, except: Option<&str>) -> Result<bool> {
        self.conn
            .query_row(
                "SELECT EXISTS (
                   SELECT 1 FROM sent WHERE json_extract(message_json, '$.in_reply_to') = ?1
                     AND json_extract(message_json, '$.auto_reply') = 1 AND id <> ?2
                   UNION ALL
                   SELECT 1 FROM outbox WHERE json_extract(message_json, '$.in_reply_to') = ?1
                     AND json_extract(message_json, '$.auto_reply') = 1 AND id <> ?2)",
                params![original_id, except.unwrap_or("")],
                |row| row.get(0),
            )
            .map_err(db)
    }

    /// Newest inbox messages with whether each was acknowledged, for the dashboard.
    pub fn recent_inbox(&self, limit: usize) -> Result<Vec<(Message, bool)>> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT message_json, EXISTS (SELECT 1 FROM acks a WHERE a.sender = i.sender AND a.id = i.id)
                 FROM inbox i ORDER BY created_at DESC LIMIT ?1",
            )
            .map_err(db)?;
        let rows = statement
            .query_map([limit as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
            })
            .map_err(db)?;
        rows.map(|row| {
            let (json, acked) = row.map_err(db)?;
            Ok((parse_stored(&json)?, acked))
        })
        .collect()
    }

    /// Newest delivered messages, for the dashboard.
    pub fn recent_sent(&self, limit: usize) -> Result<Vec<Message>> {
        let mut statement = self
            .conn
            .prepare("SELECT message_json FROM sent ORDER BY sent_at DESC LIMIT ?1")
            .map_err(db)?;
        let rows = statement
            .query_map([limit as i64], |row| row.get::<_, String>(0))
            .map_err(db)?;
        rows.map(|row| parse_stored(&row.map_err(db)?)).collect()
    }

    /// Queued messages with their attempts and last error, newest first, for the dashboard.
    /// Recent outbox rows with their attempts, last error and state (`queued` or `expired`).
    #[allow(clippy::type_complexity)]
    pub fn outbox_rows(&self, limit: usize) -> Result<Vec<(Message, u32, Option<String>, String)>> {
        let mut statement = self
            .conn
            .prepare("SELECT message_json, attempts, last_error, state FROM outbox ORDER BY created_at DESC LIMIT ?1")
            .map_err(db)?;
        let rows = statement
            .query_map([limit as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(db)?;
        rows.map(|row| {
            let (json, attempts, error, state) = row.map_err(db)?;
            Ok((parse_stored(&json)?, attempts as u32, error, state))
        })
        .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_expired_row_is_not_retried_counted_or_reported_as_queued() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let alice = crate::Identity::generate("alice").unwrap();
        let bob = crate::Identity::generate("bob").unwrap();
        store.trust(&bob.public(), None, None).unwrap();
        let message = crate::envelope::Message {
            id: "00000000-0000-4000-8000-0000000000a9".into(),
            conversation_id: "00000000-0000-4000-8000-0000000000a8".into(),
            sender: alice.fingerprint().unwrap(),
            recipient: bob.fingerprint().unwrap(),
            text: "do this".into(),
            created_at: 1,
            origin: crate::envelope::Origin {
                hostname: "pc".into(),
                platform: "win32".into(),
                arch: "x64".into(),
                addresses: vec![],
            },
            agent: None,
            to_session: None,
            hop: None,
            auto_reply: None,
            in_reply_to: None,
            project: None,
            checkout: None,
            intent: Some(crate::envelope::Intent::Task),
            signature: String::new(),
        };
        store.queue(&message, true).unwrap();
        assert_eq!(store.due_outbox(i64::MAX as u64, 10).unwrap().len(), 1);
        assert_eq!(store.counts().unwrap().pending, 1);
        store.expire(&message.id, "task_expired: test").unwrap();
        assert!(
            store.due_outbox(i64::MAX as u64, 10).unwrap().is_empty(),
            "never retried again"
        );
        assert_eq!(store.counts().unwrap().pending, 0);
        let state = store.delivery(&message.id).unwrap().unwrap();
        assert!(
            matches!(&state, Delivery::Expired { error, .. } if error.contains("task_expired")),
            "{state:?}"
        );
        assert_eq!(serde_json::to_value(&state).unwrap()["status"], "expired");
        // The mailer's usual failure bookkeeping leaves an expired row alone.
        store
            .failed_attempt(&message.id, "task_expired", 0)
            .unwrap();
        let rows = store.outbox_rows(10).unwrap();
        assert_eq!(rows[0].1, 0, "attempts don't grow");
        assert_eq!(
            rows[0].2.as_deref(),
            Some("task_expired: test"),
            "the full reason is kept"
        );
        assert_eq!(rows[0].3, "expired");
    }

    #[test]
    fn a_task_expires_after_the_hold_limit() {
        assert!(!task_hold_expired(1_000, 1_000 + TASK_HOLD_LIMIT_MS - 1));
        assert!(task_hold_expired(1_000, 1_000 + TASK_HOLD_LIMIT_MS));
        assert!(
            !task_hold_expired(5_000, 1_000),
            "a clock behind the message doesn't expire it"
        );
    }
}
