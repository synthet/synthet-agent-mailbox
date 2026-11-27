//! Headless runs (ADR 0005 decision 7). T-6 has the Claude CLI at read tier; the swarm and API
//! runners, the other tiers and the fallback chain arrive with T-8.
//!
//! The prompt goes on stdin, never on the command line. The folder is the working directory, the
//! tools are read-only, no MCP server is loaded, and the run can't outlive its time limit: the whole
//! process tree is killed.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

/// Everything a runner needs; all of it comes from `policy.json` or the consumer, none from mail.
#[derive(Clone)]
pub struct RunRequest {
    pub run_id: String,
    pub home: PathBuf,
    pub workspace: PathBuf,
    pub prompt: String,
    pub reply_file: PathBuf,
    /// For the run-bound reply tools (`agent-mail mcp --run`); passed only in the environment.
    pub run_token: String,
    pub timeout: Duration,
    pub budget_usd: f64,
    pub model: Option<String>,
}

/// The prompt and run token never appear in debug output.
impl std::fmt::Debug for RunRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunRequest")
            .field("run_id", &self.run_id)
            .field("home", &self.home)
            .field("workspace", &self.workspace)
            .field("prompt", &format_args!("<{} bytes>", self.prompt.len()))
            .field("reply_file", &self.reply_file)
            .field("run_token", &format_args!("<redacted>"))
            .field("timeout", &self.timeout)
            .field("budget_usd", &self.budget_usd)
            .field("model", &self.model)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RunResult {
    /// `ok`, `not_installed`, `auth_required`, `rate_limited`, `timeout`, `empty_output` or `error`.
    pub outcome: String,
    /// The final message from stdout, when the run ended normally.
    pub stdout_reply: Option<String>,
    pub cost_usd: Option<f64>,
}

pub trait Runner: Send + Sync {
    fn name(&self) -> &str;
    fn run(&self, request: &RunRequest) -> RunResult;
}

/// `claude -p` at read tier.
pub struct ClaudeRunner {
    /// `claude` on PATH unless `dispatch.claude_command` names an absolute path.
    pub command: PathBuf,
}

const READ_TOOLS: [&str; 3] = ["Read", "Grep", "Glob"];
const MAX_OUTPUT: usize = 100 * 1024;

impl ClaudeRunner {
    pub fn args(request: &RunRequest) -> Vec<String> {
        let mut args: Vec<String> = vec![
            "-p".into(),
            "--output-format".into(),
            "json".into(),
            "--permission-mode".into(),
            "dontAsk".into(),
        ];
        args.push("--tools".into());
        args.extend(READ_TOOLS.iter().map(|tool| tool.to_string()));
        args.push("--allowedTools".into());
        args.extend(READ_TOOLS.iter().map(|tool| tool.to_string()));
        args.extend(
            [
                "--strict-mcp-config",
                "--no-session-persistence",
                "--disable-slash-commands",
                "--max-budget-usd",
            ]
            .iter()
            .map(|arg| arg.to_string()),
        );
        args.push(format!("{}", request.budget_usd));
        if let Some(model) = &request.model {
            args.push("--model".into());
            args.push(model.clone());
        }
        args
    }
}

impl Runner for ClaudeRunner {
    fn name(&self) -> &str {
        "claude"
    }

    fn run(&self, request: &RunRequest) -> RunResult {
        let mut command = Command::new(&self.command);
        command
            .args(Self::args(request))
            .current_dir(&request.workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // A run must not inherit the calling Claude session's settings or identity.
        for (key, _) in std::env::vars_os() {
            if key
                .to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("CLAUDE")
            {
                command.env_remove(&key);
            }
        }
        command
            .env("AGENT_MAIL_RUN_ID", &request.run_id)
            .env("AGENT_MAIL_REPLY_FILE", &request.reply_file)
            .env("AGENT_MAIL_RUN_TOKEN", &request.run_token)
            .env("AGENT_MAIL_HOME", &request.home);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let (code, stdout, stderr) =
            match run_with_timeout(command, &request.prompt, request.timeout) {
                Spawned::NotFound => return failed("not_installed"),
                Spawned::Failed => return failed("error"),
                Spawned::TimedOut => return failed("timeout"),
                Spawned::Exited {
                    code,
                    stdout,
                    stderr,
                } => (code, stdout, stderr),
            };
        classify(code, &stdout, &stderr)
    }
}

fn failed(outcome: &str) -> RunResult {
    RunResult {
        outcome: outcome.into(),
        stdout_reply: None,
        cost_usd: None,
    }
}

/// Reads Claude's `--output-format json` result and names the outcome.
pub fn classify(code: Option<i32>, stdout: &str, stderr: &str) -> RunResult {
    let result: Option<Value> = stdout
        .lines()
        .rev()
        .find_map(|line| {
            serde_json::from_str::<Value>(line.trim())
                .ok()
                .filter(|value| value.get("result").is_some() || value.get("is_error").is_some())
        })
        .or_else(|| serde_json::from_str::<Value>(stdout.trim()).ok());
    let cost = result
        .as_ref()
        .and_then(|value| value.get("total_cost_usd")?.as_f64());
    let is_error = result
        .as_ref()
        .and_then(|value| value.get("is_error")?.as_bool())
        .unwrap_or(code != Some(0));
    let text = result
        .as_ref()
        .and_then(|value| value.get("result")?.as_str())
        .unwrap_or("")
        .trim()
        .to_owned();
    if is_error || code != Some(0) {
        let haystack = format!("{text}\n{stderr}").to_ascii_lowercase();
        let outcome = if haystack.contains("rate limit") || haystack.contains("rate_limit") {
            "rate_limited"
        } else if haystack.contains("log in")
            || haystack.contains("login")
            || haystack.contains("auth")
            || haystack.contains("api key")
        {
            "auth_required"
        } else {
            "error"
        };
        return RunResult {
            outcome: outcome.into(),
            stdout_reply: None,
            cost_usd: cost,
        };
    }
    if text.is_empty() {
        return RunResult {
            outcome: "empty_output".into(),
            stdout_reply: None,
            cost_usd: cost,
        };
    }
    RunResult {
        outcome: "ok".into(),
        stdout_reply: Some(text),
        cost_usd: cost,
    }
}

pub(crate) enum Spawned {
    NotFound,
    Failed,
    TimedOut,
    Exited {
        code: Option<i32>,
        stdout: String,
        stderr: String,
    },
}

/// Spawns, writes the prompt to stdin, and waits; on timeout kills the whole process tree.
pub(crate) fn run_with_timeout(mut command: Command, input: &str, timeout: Duration) -> Spawned {
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Spawned::NotFound,
        Err(_) => return Spawned::Failed,
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.as_bytes());
    }
    let read = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe
                    .by_ref()
                    .take(MAX_OUTPUT as u64)
                    .read_to_end(&mut buffer);
                // Drain the rest so the child never blocks on a full pipe.
                let _ = std::io::copy(&mut pipe, &mut std::io::sink());
            }
            String::from_utf8_lossy(&buffer).into_owned()
        })
    };
    let stdout = read(
        child
            .stdout
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
    );
    let stderr = read(
        child
            .stderr
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
    );
    let deadline = Instant::now() + timeout;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if Instant::now() >= deadline => {
                kill_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                return Spawned::TimedOut;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => return Spawned::Failed,
        }
    };
    Spawned::Exited {
        code,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    }
}

fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x0800_0000)
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
    }
}

/// The reply file's text, when the run wrote one.
pub fn reply_file_text(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

/// AC-14 (b) then (c): a non-empty `reply.md` wins over the final stdout message. `reply.md` counts
/// whenever the run ended cleanly, including with an empty stdout result; stdout counts only for `ok`.
pub fn collected_reply(
    outcome: &str,
    reply_file: Option<String>,
    stdout_reply: Option<String>,
) -> Option<String> {
    match outcome {
        "ok" => reply_file.or(stdout_reply),
        "empty_output" => reply_file,
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> RunRequest {
        RunRequest {
            run_id: "r1".into(),
            home: PathBuf::from("h"),
            workspace: PathBuf::from("w"),
            prompt: "secret prompt text".into(),
            reply_file: PathBuf::from("reply.md"),
            run_token: "token".into(),
            timeout: Duration::from_secs(1),
            budget_usd: 0.25,
            model: None,
        }
    }

    #[test]
    fn claude_gets_read_tools_no_mcp_and_no_prompt_on_argv() {
        let args = ClaudeRunner::args(&request());
        let tools = &args[args.iter().position(|a| a == "--tools").unwrap() + 1
            ..args.iter().position(|a| a == "--allowedTools").unwrap()];
        assert_eq!(tools, ["Read", "Grep", "Glob"]);
        for flag in [
            "--strict-mcp-config",
            "--no-session-persistence",
            "--disable-slash-commands",
            "-p",
        ] {
            assert!(args.iter().any(|a| a == flag), "{flag}");
        }
        assert_eq!(
            args[args.iter().position(|a| a == "--permission-mode").unwrap() + 1],
            "dontAsk"
        );
        assert_eq!(
            args[args.iter().position(|a| a == "--max-budget-usd").unwrap() + 1],
            "0.25"
        );
        assert!(
            !args.iter().any(|a| a.contains("secret prompt")),
            "the prompt goes on stdin"
        );
    }

    #[test]
    fn reply_md_wins_even_when_stdout_is_empty() {
        let file = || Some("from reply.md".to_owned());
        let stdout = || Some("from stdout".to_owned());
        assert_eq!(
            collected_reply("ok", file(), stdout()).as_deref(),
            Some("from reply.md")
        );
        assert_eq!(
            collected_reply("ok", None, stdout()).as_deref(),
            Some("from stdout")
        );
        assert_eq!(
            collected_reply("empty_output", file(), None).as_deref(),
            Some("from reply.md")
        );
        assert_eq!(collected_reply("empty_output", None, None), None);
        for failed in [
            "timeout",
            "error",
            "auth_required",
            "not_installed",
            "rate_limited",
        ] {
            assert_eq!(collected_reply(failed, file(), stdout()), None, "{failed}");
        }
    }

    #[test]
    fn classify_names_outcomes() {
        let ok = classify(
            Some(0),
            r#"{"type":"result","is_error":false,"result":" all green ","total_cost_usd":0.01}"#,
            "",
        );
        assert_eq!(
            ok,
            RunResult {
                outcome: "ok".into(),
                stdout_reply: Some("all green".into()),
                cost_usd: Some(0.01)
            }
        );
        assert_eq!(
            classify(Some(0), r#"{"is_error":false,"result":""}"#, "").outcome,
            "empty_output"
        );
        assert_eq!(
            classify(
                Some(1),
                r#"{"is_error":true,"result":"Please run /login"}"#,
                ""
            )
            .outcome,
            "auth_required"
        );
        assert_eq!(
            classify(Some(1), "", "API Error: rate limit reached").outcome,
            "rate_limited"
        );
        assert_eq!(classify(Some(2), "garbage", "boom").outcome, "error");
    }

    #[test]
    fn a_missing_command_is_not_installed() {
        let runner = ClaudeRunner {
            command: PathBuf::from("definitely-not-a-real-command-xyz"),
        };
        let mut request = request();
        request.workspace = std::env::temp_dir();
        assert_eq!(runner.run(&request).outcome, "not_installed");
    }
}
