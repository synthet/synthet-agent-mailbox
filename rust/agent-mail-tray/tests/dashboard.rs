//! The tray dashboard over a temp home: loopback only, Host-checked, TS JSON shape, and a kill
//! switch that changes `dispatch.enabled` and nothing else.

use std::net::{Ipv4Addr, SocketAddr};
use std::path::Path;

use agent_mail_tray::dashboard::start;
use mail_core::envelope::{Envelope, Message, Origin};
use mail_core::store::{now_ms, Store};
use mail_core::Identity;
use serde_json::{json, Value};

/// A home with one contact, one received message and one queued message.
fn home(dir: &Path) -> std::path::PathBuf {
    let home = dir.join("tray-home");
    std::fs::create_dir_all(&home).unwrap();
    let me = Identity::generate("this-pc").unwrap();
    std::fs::write(
        home.join("identity.json"),
        serde_json::to_string(&me).unwrap(),
    )
    .unwrap();
    let peer = Identity::generate("pc2").unwrap();
    let mut store = Store::open(&home).unwrap();
    store.trust(&peer.public(), None, None).unwrap();
    let message = |from: &Identity, to: &Identity, id: &str, text: &str| Message {
        id: id.into(),
        conversation_id: "00000000-0000-4000-8000-00000000c0de".into(),
        sender: from.fingerprint().unwrap(),
        recipient: to.fingerprint().unwrap(),
        text: text.into(),
        created_at: now_ms(),
        origin: Origin {
            hostname: "pc2".into(),
            platform: "win32".into(),
            arch: "x64".into(),
            addresses: vec![],
        },
        agent: None,
        to_session: None,
        hop: None,
        auto_reply: None,
        in_reply_to: None,
        project: Some("demo".into()),
        checkout: None,
        intent: None,
        signature: String::new(),
    };
    let received = message(
        &peer,
        &me,
        "00000000-0000-4000-8000-000000000001",
        "build is green",
    )
    .sign(&peer, Envelope::V1_2)
    .unwrap();
    store.receive(&received).unwrap();
    store
        .queue(
            &message(&me, &peer, "00000000-0000-4000-8000-000000000002", "thanks"),
            false,
        )
        .unwrap();
    home
}

async fn get(
    port: u16,
    path: &str,
    host: Option<&str>,
) -> (u16, String, reqwest::header::HeaderMap) {
    let mut request = reqwest::Client::new().get(format!("http://127.0.0.1:{port}{path}"));
    if let Some(host) = host {
        request = request.header("host", host);
    }
    let response = request.send().await.unwrap();
    let (status, headers) = (response.status().as_u16(), response.headers().clone());
    (status, response.text().await.unwrap(), headers)
}

async fn post_dispatch(port: u16, body: &str, action: bool, origin: Option<&str>) -> (u16, String) {
    let mut request = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/api/dispatch"))
        .header("content-type", "application/json")
        .body(body.to_owned());
    if action {
        request = request.header("x-agent-mail-action", "1");
    }
    if let Some(origin) = origin {
        request = request.header("origin", origin);
    }
    let response = request.send().await.unwrap();
    (response.status().as_u16(), response.text().await.unwrap())
}

#[tokio::test]
async fn serves_the_ts_shape_from_mail_db_on_loopback_only() {
    let dir = tempfile::tempdir().unwrap();
    let home = home(dir.path());
    assert!(
        start(home.clone(), SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)))
            .await
            .is_err(),
        "non-loopback bind is refused"
    );
    let (port, _server) = start(home, SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .await
        .unwrap();

    let (status, body, _) = get(port, "/api/dashboard", None).await;
    assert_eq!(status, 200);
    let view: Value = serde_json::from_str(&body).unwrap();
    for key in [
        "mode",
        "generated_at",
        "agent",
        "mailbox",
        "wake",
        "agents",
        "remote",
        "local",
        "recent",
        "outbox",
        "log",
        "version",
        "hosts",
        "mailer",
        "dispatch",
    ] {
        assert!(view.get(key).is_some(), "missing {key}");
    }
    assert_eq!(view["agent"]["id"], "this-pc");
    assert_eq!(
        view["mailbox"]["connected"], false,
        "no mailer runs for this temp home"
    );
    assert_eq!(view["remote"]["inbox"]["unread"], 1);
    assert_eq!(view["local"]["pending"], 1);
    assert_eq!(view["recent"][0]["message"]["sender"], "pc2");
    assert_eq!(
        view["recent"][0]["message"]["body"]["text"],
        "build is green"
    );
    assert_eq!(view["recent"][0]["message"]["project"], "demo");
    assert_eq!(view["outbox"][0]["recipient"], "pc2");
    assert_eq!(
        view["dispatch"]["enabled"],
        Value::Null,
        "no policy.json yet"
    );

    let (status, page, headers) = get(port, "/dashboard", None).await;
    assert_eq!(status, 200);
    assert!(page.contains("renderHosts") && page.contains("/api/dashboard"));
    assert!(headers["content-security-policy"]
        .to_str()
        .unwrap()
        .contains("default-src 'none'"));

    for path in ["/dashboard", "/api/dashboard", "/favicon.ico"] {
        assert_eq!(
            get(port, path, Some(&format!("evil.example:{port}")))
                .await
                .0,
            403,
            "{path} needs a loopback Host"
        );
    }
    assert_eq!(get(port, "/health", Some("anything")).await.0, 200);
}

#[tokio::test]
async fn kill_switch_needs_its_header_and_changes_only_dispatch_enabled() {
    let dir = tempfile::tempdir().unwrap();
    let home = home(dir.path());
    let (port, _server) = start(home.clone(), SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .await
        .unwrap();

    assert_eq!(
        post_dispatch(port, r#"{"enabled":true}"#, true, None)
            .await
            .0,
        409,
        "no policy.json to change"
    );
    let policy = json!({
        "allowed_peers": ["pc2"],
        "max_bytes": 4096,
        "forbid_action_requests": true,
        "dispatch": { "enabled": false, "limits": { "concurrency": 1, "per_peer_per_minute": 2, "timeout_ms": 60000, "budget_usd": 0.25 }, "peers": {} }
    });
    let original = serde_json::to_string_pretty(&policy).unwrap();
    std::fs::write(home.join("policy.json"), &original).unwrap();

    assert_eq!(
        post_dispatch(port, r#"{"enabled":true}"#, false, None)
            .await
            .0,
        403,
        "the custom header is required"
    );
    assert_eq!(
        post_dispatch(
            port,
            r#"{"enabled":true}"#,
            true,
            Some("http://evil.example")
        )
        .await
        .0,
        403,
        "a foreign Origin is refused"
    );
    assert_eq!(
        post_dispatch(port, r#"{"on":true}"#, true, None).await.0,
        400
    );
    assert_eq!(
        std::fs::read_to_string(home.join("policy.json")).unwrap(),
        original,
        "refused requests change nothing"
    );

    let (status, body) = post_dispatch(
        port,
        r#"{"enabled":true}"#,
        true,
        Some(&format!("http://127.0.0.1:{port}")),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let written = std::fs::read_to_string(home.join("policy.json")).unwrap();
    let mut expected = policy.clone();
    expected["dispatch"]["enabled"] = json!(true);
    assert_eq!(
        serde_json::from_str::<Value>(&written).unwrap(),
        expected,
        "only dispatch.enabled changed"
    );
    assert!(
        written.find("allowed_peers").unwrap() < written.find("dispatch").unwrap(),
        "key order is kept"
    );

    let view: Value = serde_json::from_str(&get(port, "/api/dashboard", None).await.1).unwrap();
    assert_eq!(view["dispatch"]["enabled"], true);
    assert_eq!(view["wake"]["mode"], "on");
}
