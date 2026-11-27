//! Delivers the outbox (TS `Peer.send` / `deliver`, moved into the mailer by ADR 0005).
//!
//! For each due message: find endpoints (the contact's saved address first, then addresses recent
//! scans saw), decide the envelope from `/capabilities` only when the message carries 1.1 or 1.2
//! fields, sign once and store the signed form, then POST it and verify the receipt. A failure
//! leaves the message queued with a growing delay, as the TS outbox stays queued until a retry.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use mail_core::envelope::{Envelope, Message};
use mail_core::outbox::OutboxRow;
use mail_core::send::validate_endpoint;
use mail_core::store::{now_ms, Store};
use mail_core::wire::{seal, verify_receipt};
use mail_core::{Identity, PublicIdentity};
use serde_json::{json, Value};
use tokio::sync::Notify;

const POLL: Duration = Duration::from_secs(2);
const BATCH: usize = 32;
const SEND_TIMEOUT: Duration = Duration::from_secs(5);
const CAPABILITIES_TIMEOUT: Duration = Duration::from_millis(1500);
/// A definite `/capabilities` answer is reused this long (TS `CAPABILITY_TTL_MS`).
const CAPABILITY_TTL: Duration = Duration::from_secs(600);
const SEEN_WITHIN_MS: u64 = 24 * 60 * 60 * 1000;
const MAX_RECEIPT_BYTES: usize = 4096;

type BoxError = Box<dyn std::error::Error + Send + Sync>;

pub struct Outbox {
    pub home: PathBuf,
    pub identity: Identity,
    client: reqwest::Client,
    capabilities: Mutex<HashMap<String, (Instant, Envelope)>>,
}

/// Seconds before the next attempt: 5, 10, 20 ... capped at 15 minutes.
pub fn backoff(attempts: u32) -> Duration {
    Duration::from_secs(5u64.saturating_mul(1u64 << attempts.min(10)))
        .min(Duration::from_secs(15 * 60))
}

impl Outbox {
    pub fn new(home: PathBuf, identity: Identity) -> Self {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("static client configuration");
        Outbox {
            home,
            identity,
            client,
            capabilities: Mutex::new(HashMap::new()),
        }
    }

    /// Drains due messages, then waits for a poke or the next poll, forever.
    pub async fn run(self: Arc<Self>, notify: Arc<Notify>) {
        loop {
            if let Err(error) = self.drain_once().await {
                crate::log!("agent-maild: outbox: {error}");
            }
            tokio::select! {
                _ = notify.notified() => {}
                _ = tokio::time::sleep(POLL) => {}
            }
        }
    }

    /// One pass over the due messages. Returns how many were delivered.
    pub async fn drain_once(&self) -> Result<usize, BoxError> {
        let rows = self
            .store(|store| store.due_outbox(now_ms(), BATCH))
            .await?;
        let mut delivered = 0;
        for row in rows {
            let id = row.id.clone();
            let attempts = row.attempts;
            match self.deliver(row).await {
                Ok(()) => delivered += 1,
                Err(error) => {
                    let next = now_ms() + backoff(attempts).as_millis() as u64;
                    let error = error.to_string();
                    self.store(move |store| store.failed_attempt(&id, &error, next))
                        .await?;
                }
            }
        }
        Ok(delivered)
    }

    async fn store<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut Store) -> mail_core::Result<T> + Send + 'static,
    ) -> Result<T, BoxError> {
        let home = self.home.clone();
        Ok(tokio::task::spawn_blocking(move || {
            Store::open(&home).and_then(|mut store| work(&mut store))
        })
        .await??)
    }

    async fn deliver(&self, row: OutboxRow) -> Result<(), BoxError> {
        let (contact, endpoints) = self.endpoints_for(&row.recipient).await?;
        let fp = contact.fingerprint.clone();
        if endpoints.is_empty() {
            return Err("Peer offline or undiscoverable; message remains queued".into());
        }

        let (signed, downgraded) = if row.message.signature.is_empty() {
            let mut message = row.message.clone();
            let accept = match message.needs() {
                Envelope::V1_0 => Envelope::V1_0,
                _ => self.capabilities(&fp, &endpoints).await,
            };
            // Dropping auto_reply would let the receiver answer an automatic reply automatically.
            if message.auto_reply == Some(true) && accept < Envelope::V1_1 {
                return Err("Peer does not accept agent-mail/1.1, so it would not see auto_reply; automatic reply held".into());
            }
            // A task can't be downgraded into a plain message (ADR 0006 decision 1).
            if message.intent == Some(mail_core::envelope::Intent::Task) && accept < Envelope::V1_3
            {
                return Err(
                    "Peer does not accept agent-mail/1.3, so it can't take a task; task held"
                        .into(),
                );
            }
            let downgraded = message.downgrade_to(accept);
            let signed = message.sign(&self.identity, Envelope::LATEST)?;
            let (id, stored) = (row.id.clone(), signed.clone());
            self.store(move |store| store.mark_signed(&id, &stored, downgraded))
                .await?;
            (signed, downgraded)
        } else {
            let id = row.id.clone();
            (
                row.message.clone(),
                self.store(move |store| store.was_downgraded(&id)).await?,
            )
        };

        let mut failure: BoxError = "no endpoint answered".into();
        for endpoint in endpoints {
            match self.post(&endpoint, &contact.identity, &signed).await {
                Ok(()) => {
                    let mut details = serde_json::Map::new();
                    let changed = contact.endpoint.as_deref() != Some(endpoint.as_str());
                    if changed {
                        details.insert(
                            "endpoint_changed".into(),
                            json!({ "from": contact.endpoint, "to": endpoint }),
                        );
                    }
                    if downgraded {
                        details.insert("envelope_downgraded".into(), Value::Bool(true));
                    }
                    let (id, details, fp2) = (row.id.clone(), Value::Object(details), fp.clone());
                    self.store(move |store| {
                        store.delivered(&id, &signed, &details)?;
                        // The receipt is signed by the pinned key, so this address verifiably
                        // reaches that peer: keep it for later sends.
                        if changed {
                            store.set_contact_endpoint(&fp2, &endpoint)?;
                        }
                        Ok(())
                    })
                    .await?;
                    if changed {
                        self.capabilities
                            .lock()
                            .expect("capability cache")
                            .remove(&fp);
                    }
                    return Ok(());
                }
                Err(error) => failure = error,
            }
        }
        Err(failure)
    }

    /// The pinned contact and the endpoints to try for it: its saved address first, then
    /// addresses recent scans saw, with loopback first for this PC's own addresses.
    async fn endpoints_for(
        &self,
        recipient: &str,
    ) -> Result<(mail_core::store::Contact, Vec<String>), BoxError> {
        let recipient = recipient.to_owned();
        let contact = self
            .store(move |store| store.contact(&recipient))
            .await?
            .ok_or("Unknown peer; discover and trust its verified fingerprint first")?;
        let fp = contact.fingerprint.clone();
        let seen = self
            .store(move |store| store.endpoints_seen(&fp, now_ms().saturating_sub(SEEN_WITHIN_MS)))
            .await?;
        let mut candidates: Vec<String> = contact.endpoint.iter().cloned().collect();
        candidates.extend(
            seen.into_iter()
                .filter(|endpoint| Some(endpoint) != contact.endpoint.as_ref()),
        );
        let endpoints = prefer_local_loopback(candidates)
            .into_iter()
            .filter(|endpoint| validate_endpoint(endpoint).is_ok())
            .collect();
        Ok((contact, endpoints))
    }

    /// Which envelope a pinned peer accepts, for callers that must know before queueing (an
    /// automatic reply must not lose `auto_reply`).
    pub async fn envelope_for(&self, fp: &str) -> Result<Envelope, BoxError> {
        let (contact, endpoints) = self.endpoints_for(fp).await?;
        Ok(self.capabilities(&contact.fingerprint, &endpoints).await)
    }

    async fn post(
        &self,
        endpoint: &str,
        contact: &PublicIdentity,
        message: &Message,
    ) -> Result<(), BoxError> {
        let packet = seal(&self.identity, contact, message, now_ms())?;
        let mut response = self
            .client
            .post(format!("{}/message", endpoint.trim_end_matches('/')))
            .header("content-type", "application/json")
            .body(serde_json::to_string(&packet)?)
            .timeout(SEND_TIMEOUT)
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(
                format!("Peer refused message (HTTP {})", response.status().as_u16()).into(),
            );
        }
        let body = read_limited(&mut response)
            .await
            .ok_or("Oversized receipt")?;
        verify_receipt(contact, serde_json::from_slice(&body)?, message)?;
        Ok(())
    }

    /// Which envelope this peer accepts. Only a definite answer is cached; no answer at all means
    /// plain `agent-mail/1`, and leaving the extra fields out is harmless.
    async fn capabilities(&self, fp: &str, endpoints: &[String]) -> Envelope {
        if let Some((at, accept)) = self.capabilities.lock().expect("capability cache").get(fp) {
            if at.elapsed() < CAPABILITY_TTL {
                return *accept;
            }
        }
        for endpoint in endpoints {
            let request = self
                .client
                .get(format!("{}/capabilities", endpoint.trim_end_matches('/')))
                .timeout(CAPABILITIES_TIMEOUT);
            let Ok(mut response) = request.send().await else {
                continue;
            };
            let accept = if response.status().as_u16() == 404 {
                Envelope::V1_0
            } else if response.status().is_success() {
                let Some(body) = read_limited(&mut response).await else {
                    continue;
                };
                let versions: Vec<String> = serde_json::from_slice::<Value>(&body)
                    .ok()
                    .and_then(|value| value.get("envelope").cloned())
                    .and_then(|value| serde_json::from_value(value).ok())
                    .unwrap_or_default();
                Envelope::accepted_by(&versions)
            } else {
                continue;
            };
            self.capabilities
                .lock()
                .expect("capability cache")
                .insert(fp.to_owned(), (Instant::now(), accept));
            return accept;
        }
        Envelope::V1_0
    }
}

async fn read_limited(response: &mut reqwest::Response) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_RECEIPT_BYTES {
            return None;
        }
    }
    Some(body)
}

/// A same-PC listener is advertised under a LAN address; try loopback first so a listener bound to
/// 127.0.0.1 still receives (TS `preferLocalLoopback`).
pub fn prefer_local_loopback(endpoints: Vec<String>) -> Vec<String> {
    let mut local: Vec<String> = vec!["127.0.0.1".into()];
    local.extend(
        if_addrs::get_if_addrs()
            .unwrap_or_default()
            .into_iter()
            .filter(|interface| interface.ip().is_ipv4())
            .map(|interface| interface.ip().to_string()),
    );
    let mut ordered = Vec::new();
    for endpoint in endpoints {
        if let Some((host, port)) = endpoint
            .strip_prefix("http://")
            .and_then(|rest| rest.trim_end_matches('/').rsplit_once(':'))
        {
            if local.iter().any(|address| address == host) {
                ordered.push(format!("http://127.0.0.1:{port}"));
            }
        }
        ordered.push(endpoint);
    }
    let mut seen = std::collections::HashSet::new();
    ordered.retain(|endpoint| seen.insert(endpoint.clone()));
    ordered
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(backoff(0), Duration::from_secs(5));
        assert_eq!(backoff(3), Duration::from_secs(40));
        assert_eq!(backoff(30), Duration::from_secs(900));
    }

    #[test]
    fn loopback_first_for_local_addresses() {
        let ordered = prefer_local_loopback(vec![
            "http://127.0.0.1:9".into(),
            "http://203.0.113.5:9".into(),
        ]);
        assert_eq!(
            ordered,
            vec![
                "http://127.0.0.1:9".to_owned(),
                "http://203.0.113.5:9".to_owned()
            ]
        );
    }
}
