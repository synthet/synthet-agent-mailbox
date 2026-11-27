//! The peer receiver on TCP 47832 (`src/peer/peer.ts` `listen`).
//!
//! - `GET /identity?nonce=<uuid>`: the signed advert.
//! - `GET /capabilities`: the envelope versions accepted; 1.1 must stay listed for TS senders.
//! - `POST /message`: a sealed packet; 200 with a signed receipt, 409 for a reused id with other
//!   content, 413 above 220,000 bytes, 400 for anything rejected.
//!
//! The accept loop caps open connections at 64 and gives each one a header deadline and a total
//! deadline, as the TS server does with `maxConnections` and its timeouts.

use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use mail_core::envelope::{Envelope, ENVELOPE_VERSIONS};
use mail_core::js::is_uuid;
use mail_core::store::{now_ms, Received, Store};
use mail_core::wire::{receipt, unseal};
use mail_core::Identity;
use tokio::net::TcpListener;
use tokio::sync::Semaphore;

use crate::advert::advertisement;

pub const MAX_BODY_BYTES: usize = 220_000;
pub const MAX_CONNECTIONS: usize = 64;
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
const BODY_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(30);

pub struct Receiver {
    pub identity: Identity,
    pub store: Mutex<Store>,
    /// The port this listener is bound to, advertised in `/identity`.
    pub port: u16,
}

/// Serves until the task is dropped or aborted.
pub async fn serve(listener: TcpListener, receiver: Arc<Receiver>) {
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        // Take a slot before accepting, so connection 65 waits in the OS backlog.
        let Ok(slot) = slots.clone().acquire_owned().await else {
            return;
        };
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(error) => {
                crate::log!("agent-maild: accept failed: {error}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let receiver = receiver.clone();
        tokio::spawn(async move {
            let service = service_fn(move |request| handle(request, receiver.clone()));
            let connection = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(HEADER_TIMEOUT)
                .serve_connection(TokioIo::new(stream), service);
            let _ = tokio::time::timeout(CONNECTION_TIMEOUT, connection).await;
            drop(slot);
        });
    }
}

type Reply = Response<Full<Bytes>>;

fn reply(status: StatusCode, body: impl Into<Bytes>, json: bool) -> Reply {
    let mut builder = Response::builder().status(status);
    if json {
        builder = builder.header("content-type", "application/json");
    }
    builder
        .body(Full::new(body.into()))
        .expect("static response parts")
}

fn empty(status: StatusCode) -> Reply {
    reply(status, Bytes::new(), false)
}

async fn handle(request: Request<Incoming>, receiver: Arc<Receiver>) -> Result<Reply, Infallible> {
    let path = request.uri().path().to_owned();
    let query = request.uri().query().map(str::to_owned);
    Ok(match (request.method().clone(), path.as_str(), query) {
        (Method::GET, "/identity", Some(query)) => identity(&receiver, &query),
        (Method::GET, "/capabilities", None) => reply(
            StatusCode::OK,
            serde_json::json!({ "envelope": ENVELOPE_VERSIONS }).to_string(),
            true,
        ),
        (Method::POST, "/message", None) => message(request, receiver).await,
        _ => empty(StatusCode::NOT_FOUND),
    })
}

fn identity(receiver: &Receiver, query: &str) -> Reply {
    let nonce = query
        .split('&')
        .find_map(|pair| pair.strip_prefix("nonce="));
    match nonce
        .filter(|nonce| is_uuid(nonce))
        .map(|nonce| advertisement(&receiver.identity, receiver.port, nonce))
    {
        Some(Ok(packet)) => reply(
            StatusCode::OK,
            serde_json::to_string(&packet).expect("packet serializes"),
            true,
        ),
        _ => empty(StatusCode::BAD_REQUEST),
    }
}

async fn message(request: Request<Incoming>, receiver: Arc<Receiver>) -> Reply {
    let body = match tokio::time::timeout(
        BODY_TIMEOUT,
        Limited::new(request.into_body(), MAX_BODY_BYTES).collect(),
    )
    .await
    {
        Ok(Ok(collected)) => collected.to_bytes(),
        Ok(Err(error))
            if error
                .downcast_ref::<http_body_util::LengthLimitError>()
                .is_some() =>
        {
            return empty(StatusCode::PAYLOAD_TOO_LARGE)
        }
        _ => return rejected(),
    };
    // Unsealing and the SQLite write block, so they run off the async workers.
    let outcome = tokio::task::spawn_blocking(move || accept(&receiver, &body)).await;
    match outcome {
        Ok(Ok(Accepted::Receipt(json))) => reply(StatusCode::OK, json, true),
        Ok(Ok(Accepted::Conflict)) => empty(StatusCode::CONFLICT),
        Ok(Err(Failure::Rejected)) => rejected(),
        Ok(Err(Failure::Store(error))) => {
            crate::log!("agent-maild: store error: {error}");
            empty(StatusCode::INTERNAL_SERVER_ERROR)
        }
        Err(_) => empty(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

fn rejected() -> Reply {
    reply(
        StatusCode::BAD_REQUEST,
        r#"{"error":"Message rejected"}"#,
        false,
    )
}

enum Accepted {
    Receipt(String),
    Conflict,
}

enum Failure {
    Rejected,
    Store(mail_core::Error),
}

fn accept(receiver: &Receiver, body: &[u8]) -> Result<Accepted, Failure> {
    let packet: serde_json::Value = serde_json::from_slice(body).map_err(|_| Failure::Rejected)?;
    let mut store = receiver
        .store
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let message = {
        let trusted = |fp: &str| {
            store
                .contact(fp)
                .ok()
                .flatten()
                .map(|contact| contact.identity)
        };
        unseal(
            &receiver.identity,
            packet,
            trusted,
            Envelope::LATEST,
            now_ms(),
        )
        .map_err(|_| Failure::Rejected)?
    };
    // The receipt goes out only after the message is committed.
    match store.receive(&message).map_err(Failure::Store)? {
        Received::Conflict => Ok(Accepted::Conflict),
        Received::New | Received::Duplicate => {
            let packet = receipt(&receiver.identity, &message).map_err(Failure::Store)?;
            Ok(Accepted::Receipt(
                serde_json::to_string(&packet).expect("packet serializes"),
            ))
        }
    }
}
