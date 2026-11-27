//! Claude Code's own session records on this PC (`<CLAUDE_CONFIG_DIR or ~/.claude>/sessions`), read
//! leniently: the schema is internal to Claude Code (ADR 0006). Read-only; key files are never
//! opened here. Used by the tray (live delivery) and the inject hook (who a message is for).

use std::path::{Path, PathBuf};

use serde_json::Value;

/// One live session as its record describes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaudeSession {
    pub pid: u32,
    pub session_id: String,
    pub name: Option<String>,
    pub cwd: PathBuf,
    pub endpoint: String,
    pub proc_start: Option<u64>,
    pub kind: Option<String>,
}

/// `<CLAUDE_CONFIG_DIR or ~/.claude>/sessions`.
pub fn sessions_dir() -> Option<PathBuf> {
    if let Some(config) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(config).join("sessions"));
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    Some(PathBuf::from(home).join(".claude").join("sessions"))
}

fn parse_record(pid: u32, value: &Value) -> Option<ClaudeSession> {
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    let proc_start = match value.get("procStart") {
        Some(Value::String(text)) => text.parse().ok(),
        Some(Value::Number(number)) => number.as_u64(),
        _ => None,
    };
    Some(ClaudeSession {
        pid,
        session_id: text("sessionId").filter(|id| !id.is_empty() && id.len() <= 200)?,
        name: text("name"),
        cwd: PathBuf::from(text("cwd")?),
        endpoint: text("messagingSocketPath").filter(|path| !path.is_empty())?,
        proc_start,
        kind: text("kind"),
    })
}

pub fn read_record(dir: &Path, pid: u32) -> Option<ClaudeSession> {
    let text = std::fs::read_to_string(dir.join(format!("{pid}.json"))).ok()?;
    parse_record(pid, &serde_json::from_str(&text).ok()?)
}

/// Every record `<pid>.json` that parses. Other files (key files included) are never opened.
pub fn read_sessions(dir: &Path) -> Vec<ClaudeSession> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut sessions: Vec<ClaudeSession> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let pid = name.strip_suffix(".json")?.parse::<u32>().ok()?;
            read_record(dir, pid)
        })
        .collect();
    sessions.sort_by_key(|session| session.pid);
    sessions
}

/// Live interactive sessions: the process exists and started when the record says (no PID reuse).
/// A record without `kind` counts, since the report could not confirm that field.
pub fn live_sessions(dir: &Path) -> Vec<ClaudeSession> {
    read_sessions(dir)
        .into_iter()
        .filter(|session| {
            session
                .kind
                .as_deref()
                .is_none_or(|kind| kind == "interactive")
        })
        .filter(is_alive)
        .collect()
}

/// The start time, as Windows FILETIME ticks (the unit `procStart` uses there), of a process that is
/// still running. `None` once it has exited, even while some handle keeps the process object open.
#[cfg(windows)]
pub fn process_start(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    const STILL_ACTIVE: u32 = 259;
    let empty = || FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    // SAFETY: the handle is checked, used for one query and closed.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let (mut created, mut exited, mut kernel, mut user) = (empty(), empty(), empty(), empty());
        let ok = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user);
        let mut code = 0u32;
        let running = GetExitCodeProcess(handle, &mut code) != 0 && code == STILL_ACTIVE;
        CloseHandle(handle);
        (ok != 0 && running)
            .then(|| (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }
}

#[cfg(not(windows))]
pub fn process_start(_pid: u32) -> Option<u64> {
    None
}

pub fn is_alive(session: &ClaudeSession) -> bool {
    if cfg!(windows) {
        match (process_start(session.pid), session.proc_start) {
            // Within a second: the record may round the start time.
            (Some(actual), Some(recorded)) => actual.abs_diff(recorded) <= 10_000_000,
            _ => false,
        }
    } else {
        Path::new("/proc").join(session.pid.to_string()).exists()
    }
}

fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    text.trim_end_matches('\\').to_lowercase()
}

/// Sessions whose working folder is the checkout or inside it.
pub fn inside<'a>(sessions: &'a [ClaudeSession], checkout: &Path) -> Vec<&'a ClaudeSession> {
    let root = path_key(checkout);
    sessions
        .iter()
        .filter(|session| {
            let cwd = path_key(&session.cwd);
            cwd == root || cwd.starts_with(&format!("{root}\\"))
        })
        .collect()
}
