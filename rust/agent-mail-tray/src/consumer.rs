//! The tray's consumer (ADR 0005 decision 4): what happens to received mail. It replaces the TS
//! `agent-mail dispatch` poller and keeps its rules (`src/fabric/dispatch.ts`):
//!
//! - It does nothing while `dispatch.enabled` is false, and its first enabled pass only records the
//!   backlog.
//! - Each message is marked handled before anything happens, so a crash can drop an action but
//!   never send a second reply.
//! - It never acknowledges a message, so the owner and any session still see it.
//! - Every decision writes one body-free line to `ledger.jsonl`.
//! - Replies go through `mail_core::send::reply` (`automatic: true`, policy checked, loop guards)
//!   into the outbox, and the mailer delivers them.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use mail_core::dispatch::{
    append_ledger, compute_answer, decide, ledger_line, live_notice, run_prompt, CheckoutMatch,
    Context, Decision, DispatchPolicy, LiveSession, Tier, WakeTarget, WakeVia, CLAUDE_CODE,
};
use mail_core::envelope::{AgentMeta, Message};
use mail_core::outbox::Delivery;
use mail_core::policy::Policy;
use mail_core::runs::{new_run_token, Run};
use mail_core::send::{new_uuid, reply, ReplyRequest, SendError};
use mail_core::store::{now_ms, Store};
use mail_core::{ipc, Identity};

use crate::runner::{collected_reply, reply_file_text, ClaudeRunner, RunRequest, Runner};

const POLL: Duration = Duration::from_secs(3);
const BATCH: usize = 20;
/// How long after its time limit a run token still works (the runner kills the run at the limit).
const RUN_TOKEN_MARGIN_MS: u64 = 60_000;

/// Per-peer sliding one-minute window over the actions this process started (TS `RateWindow`).
#[derive(Default)]
pub struct RateWindow {
    hits: HashMap<String, Vec<u64>>,
}

impl RateWindow {
    pub fn allows(&mut self, peer: &str, now: u64, per_minute: u32) -> bool {
        let recent = self.hits.entry(peer.to_owned()).or_default();
        recent.retain(|at| now.saturating_sub(*at) < 60_000);
        recent.len() < per_minute as usize
    }

    pub fn record(&mut self, peer: &str, now: u64) {
        self.hits.entry(peer.to_owned()).or_default().push(now);
    }
}

/// What one pass did with one message, for tests and the log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub message_id: String,
    pub step: String,
    pub detail: String,
}

/// Picks the runner `dispatch.runners` names first. T-6 knows only `claude`.
pub type RunnerFactory = Arc<dyn Fn(&DispatchPolicy) -> Box<dyn Runner> + Send + Sync>;

pub fn default_runners() -> RunnerFactory {
    Arc::new(|dispatch: &DispatchPolicy| {
        Box::new(ClaudeRunner {
            command: dispatch
                .claude_command
                .clone()
                .unwrap_or_else(|| PathBuf::from("claude")),
        }) as Box<dyn Runner>
    })
}

/// Runs passes every few seconds on its own thread until the process exits.
pub fn spawn(home: PathBuf, runners: RunnerFactory) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut rate = RateWindow::default();
        // One tray per home: a run still open now belongs to a process that is gone.
        if let Err(error) = Store::open(&home).and_then(|store| store.expire_unfinished_runs()) {
            eprintln!("agent-mail-tray: consumer: expiring old runs: {error}");
        }
        loop {
            if let Err(error) = tick(&home, &mut rate, &runners) {
                eprintln!("agent-mail-tray: consumer: {error}");
            }
            std::thread::sleep(POLL);
        }
    })
}

type Failure = Box<dyn std::error::Error>;

/// One pass over unhandled mail, with Claude Code's session records in their usual place.
pub fn tick(
    home: &Path,
    rate: &mut RateWindow,
    runners: &RunnerFactory,
) -> Result<Vec<Record>, Failure> {
    tick_in(home, rate, runners, crate::live::sessions_dir().as_deref())
}

/// One pass over unhandled mail, reading live Claude Code sessions from `sessions` (ADR 0006).
pub fn tick_in(
    home: &Path,
    rate: &mut RateWindow,
    runners: &RunnerFactory,
    sessions: Option<&Path>,
) -> Result<Vec<Record>, Failure> {
    // No valid policy means no dispatch, never a default.
    let Ok(policy) = Policy::load(home) else {
        return Ok(Vec::new());
    };
    let dispatch = policy.dispatch_policy()?;
    if !dispatch.enabled {
        return Ok(Vec::new());
    }
    let identity = Identity::load(home)?;
    let mut store = Store::open(home)?;
    if !store.consumer_started()? {
        store.record_backlog()?;
        return Ok(Vec::new());
    }
    let live = sessions.map(crate::live::live_sessions).unwrap_or_default();
    let live_context: Vec<LiveSession> = live
        .iter()
        .map(|session| LiveSession {
            session_id: session.session_id.clone(),
            harness: Some(CLAUDE_CODE.into()),
            harness_session_id: None,
            display_name: session.name.clone(),
        })
        .collect();
    let mut records = Vec::new();
    for message in store.unhandled_inbox(BATCH)? {
        store.mark_handled(&message.sender, &message.id)?;
        let peer = dispatch.peer(&message.sender, &policy.auto_answer_types);
        let now = now_ms();
        let context = Context {
            rate_ok: rate.allows(&message.sender, now, dispatch.limits.per_peer_per_minute),
            already_answered: store.has_auto_reply(&message.id, None)?,
            sessions: live_context.clone(),
            sent_in_conversation: store.sessions_sent_in(&message.conversation_id)?,
            checkout: checkout_match(home, &policy, &message, &live),
            ..Context::default()
        };
        let decision = decide(
            &message,
            peer.as_ref(),
            &context,
            &policy.workspaces,
            policy.default_workspace.as_ref(),
        );
        let mut record = |step: &str, detail: String, harness: Option<&str>, cost: Option<f64>| {
            let line = ledger_line(
                &message.sender,
                &message,
                "dispatch",
                &format!("{step}: {detail}"),
                Some(&message.text),
                harness,
                cost,
            );
            let _ = append_ledger(home, &line);
            records.push(Record {
                message_id: message.id.clone(),
                step: step.into(),
                detail,
            });
        };
        match decision {
            Decision::Skip(reason) => record("skip", reason.as_str().into(), None, None),
            Decision::Answer(query) => {
                rate.record(&message.sender, now);
                let workspace = peer
                    .as_ref()
                    .and_then(|peer| peer.workspace.clone())
                    .expect("decide checked the workspace");
                let text = serde_json::json!({ "query": query.as_str(), "answer": compute_answer(query, &workspace) }).to_string();
                let detail = send_reply(home, &identity, &mut store, &message, &text)
                    .map(|(status, _)| status);
                record(
                    "answer",
                    format!(
                        "{} {}",
                        query.as_str(),
                        detail.unwrap_or_else(|error| error)
                    ),
                    None,
                    None,
                );
            }
            Decision::Wake(target) => {
                rate.record(&message.sender, now);
                let label = store
                    .contact(&message.sender)
                    .ok()
                    .flatten()
                    .map(|contact| contact.identity.name);
                let notice = live_notice(&message, label.as_deref());
                let claude = dispatch
                    .claude_command
                    .clone()
                    .unwrap_or_else(|| PathBuf::from("claude"));
                let relay = |addressee: crate::relay::Addressee<'_>| {
                    crate::relay::relay(
                        &claude,
                        &addressee,
                        &live,
                        &notice,
                        dispatch.limits.budget_usd,
                        &crate::relay::workdir(home),
                    )
                };
                let outcome = match &target {
                    WakeTarget::ClaudeSession { session_id, .. } => {
                        match live
                            .iter()
                            .find(|session| &session.session_id == session_id)
                        {
                            None => "the session is gone".to_owned(),
                            Some(session) => {
                                // The pipe first; "written" because it sends no acknowledgement.
                                let direct = match (dispatch.live.enabled, sessions) {
                                    (true, Some(dir)) => {
                                        Some(crate::live::write_notice(dir, session, &notice))
                                    }
                                    _ => None,
                                };
                                match (direct, dispatch.live.relay) {
                                    (Some(Ok(())), _) => "written".to_owned(),
                                    (Some(Err(error)), true) => {
                                        format!(
                                            "{error}; {}",
                                            relay(crate::relay::Addressee::Session(session))
                                        )
                                    }
                                    (Some(Err(error)), false) => error.to_string(),
                                    (None, true) => {
                                        relay(crate::relay::Addressee::Session(session))
                                    }
                                    (None, false) => "live delivery is off".to_owned(),
                                }
                            }
                        }
                    }
                    WakeTarget::Claude { name, .. } if dispatch.live.relay => {
                        relay(crate::relay::Addressee::Name(name))
                    }
                    WakeTarget::Claude { .. } => "live delivery is off".to_owned(),
                    // Codex wakes are not ported yet; the message waits in the inbox.
                    WakeTarget::Codex { .. } => "not available yet".to_owned(),
                };
                record(
                    "wake",
                    format!("{}: {outcome}", describe(&target)),
                    None,
                    None,
                );
            }
            Decision::Run {
                workspace,
                tier,
                project,
            } => {
                rate.record(&message.sender, now);
                let runner = runners(&dispatch);
                let model = peer
                    .as_ref()
                    .and_then(|peer| peer.responder.as_ref())
                    .and_then(|r| r.model.clone());
                let (detail, cost) = run_and_reply(
                    home,
                    &identity,
                    &mut store,
                    &message,
                    &dispatch,
                    runner.as_ref(),
                    workspace,
                    tier,
                    project,
                    model,
                )?;
                record("run", detail, Some(runner.name()), cost);
            }
        }
    }
    Ok(records)
}

/// ADR 0006 decision 4.3: which live session, if any, works in the checkout the message names.
fn checkout_match(
    home: &Path,
    policy: &Policy,
    message: &Message,
    live: &[crate::live::ClaudeSession],
) -> CheckoutMatch {
    let Some(checkout) = &message.checkout else {
        return CheckoutMatch::None;
    };
    let resolver = mail_core::checkout::Resolver {
        home,
        roots: &policy.checkout_roots,
        aliases: &policy.origin_aliases,
    };
    let want = mail_core::checkout::RepoId {
        roots: checkout.roots.clone(),
        origin: checkout.origin.clone(),
    };
    let Ok(folder) = resolver.resolve(&want) else {
        return CheckoutMatch::None;
    };
    match crate::live::inside(live, &folder).as_slice() {
        [] => CheckoutMatch::None,
        [only] => CheckoutMatch::One(only.session_id.clone()),
        _ => CheckoutMatch::Ambiguous,
    }
}

fn describe(target: &WakeTarget) -> String {
    let via = |via: &WakeVia| match via {
        WakeVia::ToSession => "to_session",
        WakeVia::Lease => "lease",
        WakeVia::Checkout => "checkout",
        WakeVia::Destination => "destination",
    };
    match target {
        WakeTarget::Claude { via: v, .. } => format!("claude via {}", via(v)),
        WakeTarget::ClaudeSession { via: v, .. } => format!("claude-code via {}", via(v)),
        WakeTarget::Codex { via: v, .. } => format!("codex via {}", via(v)),
    }
}

/// Sends an automatic reply through the shared send path, then wakes the mailer. Returns the
/// delivery status and the reply id, or why it was refused.
fn send_reply(
    home: &Path,
    identity: &Identity,
    store: &mut Store,
    message: &Message,
    text: &str,
) -> Result<(String, String), String> {
    let request = ReplyRequest {
        sender: message.sender.clone(),
        message_id: message.id.clone(),
        text: text.to_owned(),
        automatic: true,
        reply_id: None,
        agent: Some(AgentMeta {
            harness: Some("agent-mail-tray".into()),
            ..AgentMeta::default()
        }),
    };
    match reply(home, identity, store, request, |fp| ipc::envelope(home, fp)) {
        Ok(delivery) => {
            ipc::poke(home);
            let (status, id) = match &delivery {
                Delivery::Queued { message_id, .. } => ("queued", message_id.clone()),
                Delivery::Delivered { message_id, .. } => ("delivered", message_id.clone()),
            };
            let line = ledger_line(
                &message.sender,
                message,
                "dispatch:reply",
                status,
                Some(text),
                None,
                None,
            );
            let _ = append_ledger(home, &line);
            Ok((status.into(), id))
        }
        Err(SendError::Refused(reason)) => Err(format!("refused: {reason}")),
        Err(SendError::Other(error)) => Err(format!("failed: {error}")),
    }
}

/// One headless run: request file, runner, reply capture, outbox. The run row records every step.
#[allow(clippy::too_many_arguments)]
fn run_and_reply(
    home: &Path,
    identity: &Identity,
    store: &mut Store,
    message: &Message,
    dispatch: &DispatchPolicy,
    runner: &dyn Runner,
    workspace: PathBuf,
    tier: Tier,
    project: Option<String>,
    model: Option<String>,
) -> Result<(String, Option<f64>), Failure> {
    // T-6 runs read tier only; reply and edit tools arrive with T-7 and T-8.
    let tier = tier.min(Tier::Read);
    let run_id = new_uuid();
    let run_dir = home.join("runs").join(&run_id);
    std::fs::create_dir_all(&run_dir)?;
    let reply_file = run_dir.join("reply.md");
    std::fs::write(&reply_file, "")?;
    let label = store
        .contact(&message.sender)?
        .map(|contact| contact.identity.name);
    let prompt = run_prompt(message, label.as_deref(), &reply_file, tier);
    std::fs::write(run_dir.join("request.md"), &prompt)?;
    store.start_run(&Run {
        run_id: run_id.clone(),
        sender: message.sender.clone(),
        message_id: message.id.clone(),
        conversation_id: message.conversation_id.clone(),
        project,
        workspace: workspace.display().to_string(),
        tier: tier.as_str().into(),
        runner: runner.name().into(),
        state: "running".into(),
        outcome: None,
        cost_usd: None,
        reply_id: None,
        created_at: now_ms(),
        finished_at: None,
    })?;
    // AC-15: only this run's agent gets the token, in its environment; mail.db keeps the hash.
    // The token stops working at the run's time limit plus a margin, even if the tray dies.
    let run_token = new_run_token();
    let deadline = now_ms() + dispatch.limits.timeout_ms + RUN_TOKEN_MARGIN_MS;
    store.bind_run_token(&run_id, &run_token, deadline)?;
    if !workspace.is_dir() {
        store.finish_run(&run_id, "failed", "no_workspace_folder", None, None)?;
        return Ok((
            format!("{}: workspace folder is missing", runner.name()),
            None,
        ));
    }
    let result = runner.run(&RunRequest {
        run_id: run_id.clone(),
        home: home.to_path_buf(),
        workspace,
        prompt,
        reply_file: reply_file.clone(),
        run_token,
        timeout: Duration::from_millis(dispatch.limits.timeout_ms),
        budget_usd: dispatch.limits.budget_usd,
        model,
    });
    // Close the run-bound window first, so a late reply_to_message can't make a second reply.
    store.close_run(&run_id)?;
    // AC-14: a run-bound reply (T-7) wins, then reply.md, then the final stdout message.
    if store.run_reply(&run_id)?.is_some() {
        store.finish_run(&run_id, "done", &result.outcome, result.cost_usd, None)?;
        return Ok((
            format!(
                "{}: {} (replied during the run)",
                runner.name(),
                result.outcome
            ),
            result.cost_usd,
        ));
    }
    let text = collected_reply(
        &result.outcome,
        reply_file_text(&reply_file),
        result.stdout_reply.clone(),
    );
    let Some(text) = text else {
        store.finish_run(&run_id, "failed", &result.outcome, result.cost_usd, None)?;
        let why = if result.outcome == "ok" {
            "empty reply"
        } else {
            &result.outcome
        };
        return Ok((format!("{}: {why}", runner.name()), result.cost_usd));
    };
    match send_reply(home, identity, store, message, &text) {
        Ok((status, reply_id)) => {
            store.finish_run(
                &run_id,
                "done",
                &result.outcome,
                result.cost_usd,
                Some(&reply_id),
            )?;
            Ok((format!("{} {status}", runner.name()), result.cost_usd))
        }
        Err(error) => {
            store.finish_run(&run_id, "failed", "reply_refused", result.cost_usd, None)?;
            Ok((format!("{} reply {error}", runner.name()), result.cost_usd))
        }
    }
}
