//! The local line protocol between the CLI (and later MCP and the tray) and the mailer.
//!
//! One request line, one reply line: `poke` (the outbox changed; reply `ok`) and `status` (a JSON
//! line). It is an optimization only: the mailer also polls `mail.db`, so a missed poke delays
//! delivery by a couple of seconds and loses nothing. The channel is per home, so two homes on one
//! PC (tests, or the TS and Rust stacks side by side) never share a mailer. Owning the channel is
//! also what keeps a second mailer off the same home.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use sha2::{Digest, Sha256};

/// A short stable key for a home: 16 hex characters of the sha256 of its absolute path (lowercased
/// on Windows, where paths are case-insensitive). Names the pipe, the tray's mutex and the logon
/// tasks, so two homes on one PC never collide.
pub fn home_key(home: &Path) -> String {
    let absolute = std::path::absolute(home).unwrap_or_else(|_| home.to_path_buf());
    let text = absolute.to_string_lossy();
    let key = if cfg!(windows) {
        text.to_lowercase()
    } else {
        text.into_owned()
    };
    hex::encode(Sha256::digest(key.as_bytes()))[..16].to_owned()
}

/// The channel name for a home: `\\.\pipe\agent-mail-<hash>` on Windows, `<home>/agent-maild.sock`
/// elsewhere.
pub fn endpoint(home: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(format!(r"\\.\pipe\agent-mail-{}", home_key(home)))
    } else {
        std::path::absolute(home)
            .unwrap_or_else(|_| home.to_path_buf())
            .join("agent-maild.sock")
    }
}

/// Sends one request and returns the reply line, or an error when no mailer answers in time.
pub fn request(home: &Path, line: &str, timeout: Duration) -> std::io::Result<String> {
    let path = endpoint(home);
    let line = line.to_owned();
    let (tx, rx) = mpsc::channel();
    // A wedged mailer must not hang the caller, so the blocking exchange runs on its own thread.
    std::thread::spawn(move || {
        let _ = tx.send(exchange(&path, &line));
    });
    rx.recv_timeout(timeout).unwrap_or_else(|_| {
        Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "mailer did not answer",
        ))
    })
}

#[cfg(windows)]
fn exchange(path: &Path, line: &str) -> std::io::Result<String> {
    let mut pipe = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?;
    pipe.write_all(format!("{line}\n").as_bytes())?;
    read_line(pipe)
}

#[cfg(unix)]
fn exchange(path: &Path, line: &str) -> std::io::Result<String> {
    let mut socket = std::os::unix::net::UnixStream::connect(path)?;
    socket.write_all(format!("{line}\n").as_bytes())?;
    read_line(socket)
}

fn read_line(reader: impl std::io::Read) -> std::io::Result<String> {
    let mut reply = String::new();
    BufReader::new(reader.take(64 * 1024)).read_line(&mut reply)?;
    Ok(reply.trim_end().to_owned())
}

/// Tells the mailer the outbox changed. False when no mailer is running for this home.
pub fn poke(home: &Path) -> bool {
    request(home, "poke", Duration::from_secs(2)).is_ok_and(|reply| reply == "ok")
}

/// Which envelope a pinned peer accepts, as the mailer probed it (`envelope <fp>`). `None` when no
/// mailer answers, which callers treat as "can't confirm".
pub fn envelope(home: &Path, fp: &str) -> Option<crate::envelope::Envelope> {
    use crate::envelope::{Envelope, ENVELOPE_V1_1, ENVELOPE_V1_2, ENVELOPE_V1_3};
    match request(home, &format!("envelope {fp}"), Duration::from_secs(6))
        .ok()?
        .as_str()
    {
        reply if reply == ENVELOPE_V1_3 => Some(Envelope::V1_3),
        reply if reply == ENVELOPE_V1_2 => Some(Envelope::V1_2),
        reply if reply == ENVELOPE_V1_1 => Some(Envelope::V1_1),
        "agent-mail/1" => Some(Envelope::V1_0),
        _ => None,
    }
}
