//! The tray's loopback dashboard (`src/peer/dashboard-server.ts`, served from `mail.db`).
//!
//! - `GET /dashboard`: the page (`assets/dashboard.html`), with the TS page's CSP.
//! - `GET /api/dashboard`: the TS JSON shape, plus `hosts`, `mailer` and `dispatch`.
//! - `POST /api/dispatch` `{"enabled": bool}`: the kill switch. It changes `dispatch.enabled` in
//!   `policy.json` and nothing else.
//! - `GET /health`, `/favicon.ico`, `/` (redirect).
//!
//! Every route checks the Host header against the loopback address and port, so a DNS-rebinding page
//! can't read mail. The write also needs a custom header (which forces a CORS preflight this server
//! never answers) and, when the browser sends one, a loopback Origin.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use mail_core::identity::Identity;
use mail_core::policy::Policy;
use mail_core::store::{now_ms, Store};
use serde_json::{json, Value};
use tokio::net::TcpListener;

pub const DEFAULT_PORT: u16 = 8788;
const PAGE: &str = include_str!("../assets/dashboard.html");
const FAVICON: &[u8] = include_bytes!("../../../assets/favicon.ico");
const CSP: &str = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'";
const RECENT: usize = 40;
const HOSTS_WITHIN_MS: u64 = 10 * 60_000;

pub struct Dashboard {
    pub home: PathBuf,
    pub port: u16,
}

/// Binds loopback only and serves until the task is aborted. Returns the bound port.
pub async fn start(
    home: PathBuf,
    listen: SocketAddr,
) -> std::io::Result<(u16, tokio::task::JoinHandle<()>)> {
    if !listen.ip().is_loopback() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "the dashboard listens on loopback only",
        ));
    }
    let listener = TcpListener::bind(listen).await?;
    let port = listener.local_addr()?.port();
    let dashboard = Arc::new(Dashboard { home, port });
    Ok((port, tokio::spawn(serve(listener, dashboard))))
}

async fn serve(listener: TcpListener, dashboard: Arc<Dashboard>) {
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        let dashboard = dashboard.clone();
        tokio::spawn(async move {
            let service = service_fn(move |request| handle(request, dashboard.clone()));
            let connection = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(Duration::from_secs(10))
                .serve_connection(TokioIo::new(stream), service);
            let _ = tokio::time::timeout(Duration::from_secs(60), connection).await;
        });
    }
}

type Reply = Response<Full<Bytes>>;

fn reply(status: StatusCode, content_type: &str, body: impl Into<Bytes>) -> Reply {
    Response::builder()
        .status(status)
        .header("content-type", content_type)
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .body(Full::new(body.into()))
        .expect("static response parts")
}

fn json_reply(status: StatusCode, value: &Value) -> Reply {
    reply(status, "application/json", value.to_string())
}

fn header<'a>(request: &'a Request<Incoming>, name: &str) -> Option<&'a str> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
}

/// `loopbackHost()`: the Host must name this listener on a loopback address.
fn loopback_host(host: Option<&str>, port: u16) -> bool {
    let host = host.unwrap_or("").to_ascii_lowercase();
    [
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        format!("[::1]:{port}"),
    ]
    .contains(&host)
}

fn loopback_origin(origin: Option<&str>, port: u16) -> bool {
    match origin {
        None => true,
        Some(origin) => {
            let origin = origin.to_ascii_lowercase();
            [
                format!("http://127.0.0.1:{port}"),
                format!("http://localhost:{port}"),
                format!("http://[::1]:{port}"),
            ]
            .contains(&origin)
        }
    }
}

async fn handle(
    request: Request<Incoming>,
    dashboard: Arc<Dashboard>,
) -> Result<Reply, Infallible> {
    let path = request.uri().path().to_owned();
    if path == "/health" {
        return Ok(json_reply(
            StatusCode::OK,
            &json!({ "ok": true, "service": "agent-mail-tray" }),
        ));
    }
    if !loopback_host(header(&request, "host"), dashboard.port) {
        return Ok(reply(StatusCode::FORBIDDEN, "text/plain", "Forbidden host"));
    }
    Ok(match (request.method().clone(), path.as_str()) {
        (Method::GET, "/") => Response::builder()
            .status(StatusCode::FOUND)
            .header("location", "/dashboard")
            .body(Full::new(Bytes::new()))
            .expect("static response parts"),
        (Method::GET, "/favicon.ico") => {
            reply(StatusCode::OK, "image/x-icon", Bytes::from_static(FAVICON))
        }
        (Method::GET, "/dashboard") => {
            let mut page = reply(StatusCode::OK, "text/html; charset=utf-8", PAGE);
            page.headers_mut().insert(
                "content-security-policy",
                CSP.parse().expect("static header"),
            );
            page
        }
        (Method::GET, "/api/dashboard") => {
            let home = dashboard.home.clone();
            let view = tokio::task::spawn_blocking(move || snapshot(&home)).await;
            json_reply(
                StatusCode::OK,
                &view.unwrap_or_else(|error| failed_snapshot(&error.to_string())),
            )
        }
        (Method::POST, "/api/dispatch") => dispatch(request, dashboard).await,
        _ => reply(StatusCode::NOT_FOUND, "text/plain", "Not found"),
    })
}

async fn dispatch(request: Request<Incoming>, dashboard: Arc<Dashboard>) -> Reply {
    if header(&request, "x-agent-mail-action") != Some("1")
        || !loopback_origin(header(&request, "origin"), dashboard.port)
    {
        return reply(StatusCode::FORBIDDEN, "text/plain", "Forbidden");
    }
    if !header(&request, "content-type").is_some_and(|value| value.starts_with("application/json"))
    {
        return reply(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "text/plain",
            "Expected application/json",
        );
    }
    let body = match Limited::new(request.into_body(), 256).collect().await {
        Ok(body) => body.to_bytes(),
        Err(_) => return reply(StatusCode::PAYLOAD_TOO_LARGE, "text/plain", "Too large"),
    };
    let Some(enabled) = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|value| value.get("enabled")?.as_bool())
    else {
        return reply(
            StatusCode::BAD_REQUEST,
            "text/plain",
            "Expected {\"enabled\": true|false}",
        );
    };
    let home = dashboard.home.clone();
    match tokio::task::spawn_blocking(move || set_dispatch_enabled(&home, enabled)).await {
        Ok(Ok(())) => json_reply(StatusCode::OK, &json!({ "enabled": enabled })),
        Ok(Err(error)) => reply(StatusCode::CONFLICT, "text/plain", error),
        Err(error) => reply(
            StatusCode::INTERNAL_SERVER_ERROR,
            "text/plain",
            error.to_string(),
        ),
    }
}

/// The kill switch: sets `dispatch.enabled` in `policy.json` and changes nothing else. The
/// existing policy must be valid, and the result is checked again before it replaces the file.
pub fn set_dispatch_enabled(home: &Path, enabled: bool) -> Result<(), String> {
    Policy::load(home)?;
    let path = Policy::path(home);
    let text = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let mut value: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let object = value
        .as_object_mut()
        .ok_or("policy.json is not an object")?;
    let dispatch = object.entry("dispatch").or_insert_with(|| json!({}));
    dispatch
        .as_object_mut()
        .ok_or("dispatch is not an object")?
        .insert("enabled".into(), Value::Bool(enabled));
    let updated = serde_json::to_string_pretty(&value).map_err(|error| error.to_string())? + "\n";
    let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&temp, &updated).map_err(|error| error.to_string())?;
    if let Err(error) = Policy::parse(&updated) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("refusing to write an invalid policy.json: {error}"));
    }
    std::fs::rename(&temp, &path).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        error.to_string()
    })?;
    Policy::load(home).map(|_| ())
}

/// `dispatch.enabled` from `policy.json`, or `None` without a valid policy.
fn dispatch_state(home: &Path) -> (Option<bool>, Option<String>) {
    match Policy::load(home) {
        Ok(policy) => (
            Some(
                policy
                    .dispatch
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            ),
            None,
        ),
        Err(error) => (None, Some(error)),
    }
}

pub use mail_core::js::iso;

fn version() -> Value {
    json!({ "app": env!("CARGO_PKG_VERSION"), "commit": null, "built": null })
}

fn failed_snapshot(message: &str) -> Value {
    json!({
        "mode": "peer", "version": version(), "generated_at": iso(now_ms()),
        "agent": { "id": "peer" },
        "mailbox": { "url": "agent-maild", "candidates": ["agent-maild"], "connected": false, "fatal": message },
        "wake": { "mode": "off", "client": "tray" },
        "agents": { "agents": [] }, "agents_error": message,
        "remote": null, "remote_error": message, "local": null, "recent": [], "outbox": [], "log": message,
        "hosts": [], "runs": [], "mailer": { "running": false }, "dispatch": { "enabled": null },
    })
}

/// The TS `/api/dashboard` view, read from `mail.db`.
pub fn snapshot(home: &Path) -> Value {
    match try_snapshot(home) {
        Ok(view) => view,
        Err(error) => failed_snapshot(&error),
    }
}

fn try_snapshot(home: &Path) -> Result<Value, String> {
    let identity = Identity::load(home).map_err(|error| error.to_string())?;
    let me = identity.fingerprint().map_err(|error| error.to_string())?;
    let store = Store::open(home).map_err(|error| error.to_string())?;
    let contacts = store.contacts().map_err(|error| error.to_string())?;
    let name_of = |fp: &str| -> String {
        if fp == me {
            return identity.name.clone();
        }
        contacts
            .iter()
            .find(|contact| contact.fingerprint == fp)
            .map(|contact| contact.identity.name.clone())
            .unwrap_or_else(|| fp.chars().take(12).collect())
    };
    let inbox = store
        .recent_inbox(RECENT)
        .map_err(|error| error.to_string())?;
    let sent = store
        .recent_sent(RECENT)
        .map_err(|error| error.to_string())?;
    let outbox = store
        .outbox_rows(RECENT)
        .map_err(|error| error.to_string())?;
    let counts = store.counts().map_err(|error| error.to_string())?;
    let hosts = store
        .hosts(now_ms().saturating_sub(HOSTS_WITHIN_MS))
        .map_err(|error| error.to_string())?;
    let runs = store
        .recent_runs(RECENT)
        .map_err(|error| error.to_string())?;
    let running = agent_mail_running(home);
    let (dispatch, policy_error) = dispatch_state(home);

    let mut recent: Vec<(u64, Value)> = inbox
        .iter()
        .map(|(message, acked)| {
            (message.created_at, json!({
                "status": if *acked { "acked" } else { "new" }, "source": "peer",
                "message": { "created_at": iso(message.created_at), "sender": name_of(&message.sender), "type": "inbox",
                    "body": { "text": message.text }, "conversation_id": message.conversation_id, "project": message.project },
            }))
        })
        .chain(sent.iter().map(|message| {
            (message.created_at, json!({
                "status": "delivered", "source": "peer",
                "message": { "created_at": iso(message.created_at), "sender": name_of(&message.recipient), "type": "sent",
                    "body": { "text": message.text }, "conversation_id": message.conversation_id, "project": message.project },
            }))
        }))
        .collect();
    recent.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    recent.truncate(RECENT);

    let mut log: Vec<(u64, String)> = inbox
        .iter()
        .map(|(m, _)| {
            (
                m.created_at,
                format!(
                    "{} peer from {} {}",
                    iso(m.created_at),
                    name_of(&m.sender),
                    m.text
                ),
            )
        })
        .chain(sent.iter().map(|m| {
            (
                m.created_at,
                format!(
                    "{} peer to {} {}",
                    iso(m.created_at),
                    name_of(&m.recipient),
                    m.text
                ),
            )
        }))
        .chain(outbox.iter().map(|(m, _, _, state)| {
            (
                m.created_at,
                format!(
                    "{} peer {state} {} {}",
                    iso(m.created_at),
                    name_of(&m.recipient),
                    m.text
                ),
            )
        }))
        .collect();
    log.sort_by_key(|entry| entry.0);
    let log: Vec<String> = log
        .into_iter()
        .rev()
        .take(RECENT)
        .rev()
        .map(|entry| entry.1)
        .collect();

    let mut agents = vec![json!({ "id": identity.name, "source": "peer" })];
    agents.extend(
        contacts
            .iter()
            .map(|contact| json!({ "id": contact.identity.name, "source": "peer" })),
    );

    Ok(json!({
        "mode": "peer",
        "journal": false,
        "generated_at": iso(now_ms()),
        "version": version(),
        "agent": { "id": identity.name },
        "mailbox": { "url": "agent-maild", "candidates": ["agent-maild"], "connected": running,
            "fatal": if running { Value::Null } else { json!("agent-maild is not running for this home") } },
        "wake": { "mode": if dispatch == Some(true) { "on" } else { "off" }, "client": "tray" },
        "agents": { "agents": agents },
        "agents_error": null,
        "remote": { "inbox": { "unread": counts.unread, "stored": inbox.len() }, "tasks": { "delivered": counts.sent } },
        "remote_error": null,
        "local": { "pending": counts.pending },
        "recent": recent.into_iter().map(|entry| entry.1).collect::<Vec<_>>(),
        "outbox": outbox.iter().map(|(message, attempts, error, state)| json!({
            "created_at": iso(message.created_at), "recipient": name_of(&message.recipient), "type": "peer",
            "status": state, "attempts": attempts, "last_error": error.clone().unwrap_or_default(),
        })).collect::<Vec<_>>(),
        "log": log.join("\n"),
        "hosts": hosts,
        "runs": runs,
        "mailer": { "running": running },
        "dispatch": { "enabled": dispatch, "policy_error": policy_error },
    }))
}

fn agent_mail_running(home: &Path) -> bool {
    mail_core::ipc::request(home, "status", Duration::from_secs(1))
        .is_ok_and(|reply| reply.starts_with('{'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_matches_to_iso_string() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_763_337_600_000), "2025-11-17T00:00:00.000Z");
        assert_eq!(iso(951_782_400_123), "2000-02-29T00:00:00.123Z");
    }

    #[test]
    fn host_and_origin_checks() {
        assert!(loopback_host(Some("127.0.0.1:8788"), 8788));
        assert!(loopback_host(Some("LOCALHOST:8788"), 8788));
        assert!(!loopback_host(Some("evil.example:8788"), 8788));
        assert!(!loopback_host(Some("127.0.0.1:9999"), 8788));
        assert!(!loopback_host(None, 8788));
        assert!(loopback_origin(None, 8788));
        assert!(loopback_origin(Some("http://127.0.0.1:8788"), 8788));
        assert!(!loopback_origin(Some("http://evil.example"), 8788));
    }
}
