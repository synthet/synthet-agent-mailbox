//! Live Claude Code sessions on this PC, read from Claude Code's own session records, and the
//! direct inbox-pipe writer (ADR 0006 decisions 4 and 5).
//!
//! None of this is a supported Claude Code contract. The record fields, the key file and the
//! message line were verified on Claude Code 2.1.332 (Windows), so everything here reads leniently
//! and re-reads the record right before writing. The peer token is read only to authenticate one
//! write, is never logged, and never leaves this module.

use std::io::Write;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;

const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// The notice is a few ids; anything longer is refused rather than cut.
pub const MAX_NOTICE_BYTES: usize = 8 * 1024;

pub use mail_core::claude_sessions::{
    inside, is_alive, live_sessions, process_start, read_record, read_sessions, sessions_dir,
    ClaudeSession,
};

/// Why a write didn't happen. Never carries the token.
#[derive(Debug, PartialEq, Eq)]
pub enum WriteError {
    Gone,
    NoKey,
    TooLong,
    Failed(String),
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WriteError::Gone => write!(f, "the session ended or its record changed"),
            WriteError::NoKey => write!(f, "no readable peer key for the session"),
            WriteError::TooLong => write!(f, "notice longer than {MAX_NOTICE_BYTES} bytes"),
            WriteError::Failed(why) => write!(f, "pipe write failed: {why}"),
        }
    }
}

/// The single `<pid>.*.key` file's `peerToken`.
fn peer_token(dir: &Path, pid: u32) -> Option<String> {
    let prefix = format!("{pid}.");
    let mut keys = std::fs::read_dir(dir).ok()?.flatten().filter(|entry| {
        let name = entry.file_name().to_string_lossy().into_owned();
        name.starts_with(&prefix) && name.ends_with(".key")
    });
    let (key, None) = (keys.next()?, keys.next()) else {
        return None;
    };
    let value: Value = serde_json::from_str(&std::fs::read_to_string(key.path()).ok()?).ok()?;
    value
        .get("peerToken")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
}

fn open(endpoint: &str) -> std::io::Result<Box<dyn Write + Send>> {
    #[cfg(windows)]
    {
        Ok(Box::new(
            std::fs::OpenOptions::new().write(true).open(endpoint)?,
        ))
    }
    #[cfg(unix)]
    {
        let path = endpoint.strip_prefix("uds:").unwrap_or(endpoint);
        Ok(Box::new(std::os::unix::net::UnixStream::connect(path)?))
    }
}

/// Writes one notice into `target`'s inbox. The record is re-read first, so a session that ended,
/// restarted or moved its pipe is not written to. No acknowledgement comes back, so success means
/// "written", never "delivered".
pub fn write_notice(dir: &Path, target: &ClaudeSession, notice: &str) -> Result<(), WriteError> {
    if notice.len() > MAX_NOTICE_BYTES {
        return Err(WriteError::TooLong);
    }
    let fresh = read_record(dir, target.pid).ok_or(WriteError::Gone)?;
    if fresh.session_id != target.session_id || !is_alive(&fresh) {
        return Err(WriteError::Gone);
    }
    let token = peer_token(dir, fresh.pid).ok_or(WriteError::NoKey)?;
    let frames = format!(
        "{}\n{}\n",
        serde_json::json!({ "type": "auth", "token": token }),
        serde_json::json!({ "type": "user", "message": { "role": "user", "content": notice } })
    );
    let endpoint = fresh.endpoint;
    let (sender, received) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = open(&endpoint).and_then(|mut pipe| {
            pipe.write_all(frames.as_bytes())?;
            pipe.flush()
        });
        let _ = sender.send(result.map_err(|error| error.kind().to_string()));
    });
    match received.recv_timeout(WRITE_TIMEOUT) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(kind)) => Err(WriteError::Failed(kind)),
        Err(_) => Err(WriteError::Failed("timed out".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(
        dir: &Path,
        pid: u32,
        session_id: &str,
        cwd: &str,
        start: Option<u64>,
        endpoint: &str,
    ) {
        let value = serde_json::json!({
            "pid": pid, "sessionId": session_id, "cwd": cwd, "kind": "interactive",
            "procStart": start.map(|s| s.to_string()), "messagingSocketPath": endpoint, "name": "work",
        });
        std::fs::write(dir.join(format!("{pid}.json")), value.to_string()).unwrap();
    }

    fn session(pid: u32, cwd: &str) -> ClaudeSession {
        ClaudeSession {
            pid,
            session_id: format!("s{pid}"),
            name: None,
            cwd: PathBuf::from(cwd),
            endpoint: "e".into(),
            proc_start: None,
            kind: None,
        }
    }

    #[test]
    fn records_are_read_leniently_and_key_files_are_never_parsed_as_records() {
        let dir = tempfile::tempdir().unwrap();
        record(dir.path(), 11, "a", "C:\\r\\app", Some(42), r"\\.\pipe\x");
        std::fs::write(dir.path().join("12.json"), "not json").unwrap();
        std::fs::write(dir.path().join("13.abc.key"), r#"{"peerToken":"t"}"#).unwrap();
        std::fs::write(dir.path().join("notes.json"), "{}").unwrap();
        let sessions = read_sessions(dir.path());
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].proc_start, Some(42));
        assert_eq!(sessions[0].kind.as_deref(), Some("interactive"));
    }

    #[test]
    fn a_folder_is_inside_the_checkout_only_at_a_path_boundary() {
        let sessions = [
            session(1, "C:\\r\\APP\\src"),
            session(2, "c:/r/app"),
            session(3, "C:\\r\\app2"),
        ];
        let found: Vec<u32> = inside(&sessions, Path::new("C:\\r\\app"))
            .iter()
            .map(|s| s.pid)
            .collect();
        assert_eq!(found, vec![1, 2]);
    }

    #[cfg(windows)]
    #[test]
    fn liveness_needs_the_recorded_start_time() {
        let pid = std::process::id();
        let start = process_start(pid).unwrap();
        let mut me = session(pid, "C:\\");
        me.proc_start = Some(start);
        assert!(is_alive(&me));
        me.proc_start = Some(start - 50_000_000);
        assert!(!is_alive(&me), "a reused pid has another start time");
        me.proc_start = None;
        assert!(!is_alive(&me));
    }

    #[cfg(windows)]
    #[test]
    fn the_writer_authenticates_then_sends_one_user_line_and_never_leaks_the_token() {
        use tokio::io::AsyncBufReadExt;
        let dir = tempfile::tempdir().unwrap();
        let pid = std::process::id();
        let pipe = format!(
            r"\\.\pipe\agent-mail-live-test-{pid}-{}",
            std::process::id() ^ 0x5a5a
        );
        record(
            dir.path(),
            pid,
            "me",
            "C:\\r\\app",
            process_start(pid),
            &pipe,
        );
        std::fs::write(
            dir.path().join(format!("{pid}.0123abcd.key")),
            r#"{"peerToken":"tok-123","procStartFt":"1","pidDomain":"x"}"#,
        )
        .unwrap();

        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _context = runtime.enter();
        let server = tokio::net::windows::named_pipe::ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe)
            .unwrap();
        let lines = runtime.spawn(async move {
            server.connect().await.unwrap();
            let mut reader = tokio::io::BufReader::new(server).lines();
            let mut got = Vec::new();
            while let Ok(Some(line)) = reader.next_line().await {
                got.push(line);
            }
            got
        });
        let target = read_sessions(dir.path()).remove(0);
        write_notice(dir.path(), &target, "MAIL thread=t from=a id=i").unwrap();
        let got = runtime.block_on(lines).unwrap();
        assert_eq!(got.len(), 2);
        let auth: Value = serde_json::from_str(&got[0]).unwrap();
        assert_eq!(
            auth,
            serde_json::json!({ "type": "auth", "token": "tok-123" })
        );
        let user: Value = serde_json::from_str(&got[1]).unwrap();
        assert_eq!(user["type"], "user");
        assert_eq!(user["message"]["content"], "MAIL thread=t from=a id=i");

        // The pid was reused (another start time): refused before anything is written.
        record(
            dir.path(),
            pid,
            "me",
            "C:\\r\\app",
            process_start(pid).map(|s| s - 50_000_000),
            &pipe,
        );
        assert_eq!(
            write_notice(dir.path(), &target, "x"),
            Err(WriteError::Gone)
        );
        // The record now names another session: nothing is written.
        record(
            dir.path(),
            pid,
            "someone-else",
            "C:\\r\\app",
            process_start(pid),
            &pipe,
        );
        assert_eq!(
            write_notice(dir.path(), &target, "x"),
            Err(WriteError::Gone)
        );
        // Two key files: refuse rather than guess.
        record(
            dir.path(),
            pid,
            "me",
            "C:\\r\\app",
            process_start(pid),
            &pipe,
        );
        std::fs::write(
            dir.path().join(format!("{pid}.ffff.key")),
            r#"{"peerToken":"other"}"#,
        )
        .unwrap();
        let error = write_notice(dir.path(), &target, "x").unwrap_err();
        assert_eq!(error, WriteError::NoKey);
        std::fs::remove_file(dir.path().join(format!("{pid}.ffff.key"))).unwrap();
        // Nobody listening: a failure whose text never carries the token.
        let error = write_notice(dir.path(), &target, "x").unwrap_err();
        assert!(matches!(error, WriteError::Failed(_)), "{error:?}");
        assert!(
            !error.to_string().contains("tok-123") && !format!("{error:?}").contains("tok-123")
        );
        assert_eq!(
            write_notice(dir.path(), &target, &"x".repeat(MAX_NOTICE_BYTES + 1)),
            Err(WriteError::TooLong)
        );
    }
}
