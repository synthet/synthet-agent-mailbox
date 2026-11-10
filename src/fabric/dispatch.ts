import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MAX_AUTO_HOP, type Peer } from "../peer/peer.js";
import { appendLedger, checkOutbound, dispatchPeer, QUERY_TYPES, type DispatchPeer, type Policy, type QueryType } from "../peer/policy.js";
import { SeenStore, stripTags, UNTRUSTED_TAG } from "../peer/seen.js";
import type { Contact } from "../peer/store.js";
import type { PeerMessage } from "../peer/wire.js";
import type { LiveSession } from "./journal.js";

/**
 * `agent-mail dispatch` (ADR 0004): for each new peer message, answer a typed query from code, or wake
 * the live session that owns it with a metadata-only notice. The dispatcher never acknowledges a
 * message, never passes remote text to a wake, and takes every destination, tool and limit from
 * policy.json. With no live owner, a peer whose responder is enabled gets a read-only swarm run whose
 * reply the dispatcher checks and sends (decision 4.4); otherwise the message waits in the inbox.
 */

export type WakeVia = "to_session" | "lease" | "destination";
export type WakeTarget =
  | { harness: "claude"; name: string; via: WakeVia }
  | { harness: "codex"; thread: string; via: WakeVia };
export type Decision =
  | { action: "skip"; reason: "peer_not_listed" | "rate_limited" | "hop_limit" | "no_live_owner" }
  | { action: "answer"; query: QueryType }
  | { action: "wake"; target: WakeTarget }
  | { action: "respond" };

export interface DispatchContext {
  /** False while the peer is over its per-minute limit. */
  rateOk: boolean;
  sessions: Pick<LiveSession, "session_id" | "harness" | "harness_session_id" | "display_name">[];
  /** Session holding this conversation's lease, if any. */
  leaseHolder: string | null;
  /** Whether a session (by journal or harness id) has itself sent mail in this conversation. */
  sentInConversation: (ids: string[]) => boolean;
}

type Inbound = Pick<PeerMessage, "id" | "conversation_id" | "sender" | "text" | "hop" | "auto_reply" | "to_session">;

const querySchema = z.object({ query: z.enum(QUERY_TYPES) }).strict();

/** A typed query only when the whole text is exactly `{"query": "<type>"}`. */
export function parseQuery(text: string): QueryType | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  const parsed = querySchema.safeParse(value);
  return parsed.success ? parsed.data.query : null;
}

const SAFE_LABEL = /^[\w .-]{1,40}$/;
const SAFE_NAME = /^[\w .-]{1,80}$/;
const SAFE_THREAD = /^[\w.-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The fixed wake notice. The contact alias was chosen by the peer when it was pinned, so it counts as
 * remote text: anything outside a short plain name becomes "a paired peer".
 */
export function wakeNotice(conversationId: string, label: string | null | undefined, messageId: string): string {
  if (!UUID.test(conversationId) || !UUID.test(messageId)) throw new Error("wake notice ids must be UUIDs");
  const from = label && SAFE_LABEL.test(label) ? label : "a paired peer";
  return `MAIL thread=${conversationId} from=${from} id=${messageId}`;
}

function sessionTarget(session: DispatchContext["sessions"][number], via: WakeVia): WakeTarget | null {
  const harness = session.harness ?? "";
  if (/^claude/i.test(harness) && session.display_name && SAFE_NAME.test(session.display_name)) return { harness: "claude", name: session.display_name, via };
  if (/^codex/i.test(harness) && session.harness_session_id && SAFE_THREAD.test(session.harness_session_id)) return { harness: "codex", thread: session.harness_session_id, via };
  return null;
}

/**
 * The live owner, first match wins: `to_session` (only when that session sent mail in this
 * conversation, so a sender can't pick an arbitrary local session), the lease holder, then the peer's
 * configured destination.
 */
function route(message: Inbound, peer: DispatchPeer, context: DispatchContext): WakeTarget | null {
  if (message.to_session) {
    const session = context.sessions.find((s) => s.session_id === message.to_session || s.harness_session_id === message.to_session);
    const ids = session ? [session.session_id, session.harness_session_id].filter((id): id is string => !!id) : [];
    const target = session && context.sentInConversation(ids) ? sessionTarget(session, "to_session") : null;
    if (target) return target;
  }
  if (context.leaseHolder) {
    const session = context.sessions.find((s) => s.session_id === context.leaseHolder);
    const target = session ? sessionTarget(session, "lease") : null;
    if (target) return target;
  }
  const wake = peer.wake;
  if (wake?.harness === "claude" && SAFE_NAME.test(wake.destination)) return { harness: "claude", name: wake.destination, via: "destination" };
  if (wake?.harness === "codex" && SAFE_THREAD.test(wake.destination)) return { harness: "codex", thread: wake.destination, via: "destination" };
  return null;
}

/** ADR 0004 decision 4, steps 1 to 3, as a pure function. */
export function decide(message: Inbound, peer: DispatchPeer | null, context: DispatchContext): Decision {
  if (!peer) return { action: "skip", reason: "peer_not_listed" };
  if (!context.rateOk) return { action: "skip", reason: "rate_limited" };
  if ((message.hop ?? 0) >= MAX_AUTO_HOP) return { action: "skip", reason: "hop_limit" };
  const query = message.auto_reply ? null : parseQuery(message.text);
  if (query && peer.workspace && peer.auto_answer.includes(query)) return { action: "answer", query };
  const target = route(message, peer, context);
  if (target) return { action: "wake", target };
  // An automatic message is never answered, by code or by a model.
  if (peer.responder && !message.auto_reply) return { action: "respond" };
  return { action: "skip", reason: "no_live_owner" };
}

/** Per-peer sliding one-minute window over the actions this process started. */
export class RateWindow {
  private readonly hits = new Map<string, number[]>();
  allows(peer: string, now: number, perMinute: number): boolean {
    const recent = (this.hits.get(peer) ?? []).filter((t) => now - t < 60_000);
    this.hits.set(peer, recent);
    return recent.length < perMinute;
  }
  record(peer: string, now: number) { this.hits.set(peer, [...(this.hits.get(peer) ?? []), now]); }
}

export interface WakeResult { outcome: "woken" | "no_match" | "failed" | "timeout"; cost_usd?: number }
export interface Limits { timeout_ms: number; budget_usd: number }
/** One `swarm_run` request in respond mode (synthet-agent-swarm `run --request`). */
export interface SwarmRequest { task: string; harnesses: [string]; mode: "respond"; model?: string; timeoutMs: number; budgetUsd: number }
/** `outcome` is the harness row's, not swarm's top-level ok, which is also true for permission denials. */
export interface RespondResult { outcome: string; reply?: string; cost_usd?: number }
export interface Runners {
  answer(query: QueryType, workspace: string): string;
  respond(request: SwarmRequest, swarmCommand: string, workspace: string, limits: Limits): Promise<RespondResult>;
  claudeWake(name: string, notice: string, limits: Limits): Promise<WakeResult>;
  codexWake(thread: string, notice: string, limits: Limits): Promise<WakeResult>;
  toast(notice: string): Promise<void>;
}

export interface DispatchRecord {
  message_id: string; conversation_id: string; peer: string;
  step: "skip" | "answer" | "wake" | "respond";
  detail: string;
}

interface JournalLike {
  sessionDirectory(): LiveSession[];
  conversationLease(conversationId: string): { session_id: string } | null;
  registerSession(input: { session_id: string; alias?: string; harness?: string }): unknown;
  claimConversation(sessionId: string, conversationId: string): Record<string, unknown>;
  endSession(sessionId: string): unknown;
}

/** Room left in swarm's 8000-character task for the quoted message. */
const RESPONDER_TEXT_LIMIT = 6000;

/** The responder's task: remote text only inside the untrusted tag, with closing tags inside it removed. */
export function responderTask(message: Pick<PeerMessage, "id" | "conversation_id" | "text">, label: string | null | undefined): string | null {
  if (message.text.length > RESPONDER_TEXT_LIMIT) return null;
  const from = label && SAFE_LABEL.test(label) ? label : "a paired peer";
  return "A paired agent on another PC sent the message below to this machine's agent mailbox, and no session here is available "
    + "to answer it. Write a short reply using only what you can read in this workspace. If you can't answer, say so in one sentence.\n"
    + `<${UNTRUSTED_TAG} from="${from}" thread="${message.conversation_id}" id="${message.id}">\n${stripTags(message.text)}\n</${UNTRUSTED_TAG}>`;
}

/**
 * One dispatch poll. A no-op while dispatch is off, so turning it on later starts from that moment:
 * the first enabled poll records the backlog without acting on it, unless backlog is set. Each message
 * is marked handled before acting, so a crash can drop a wake but never send a second reply.
 */
export async function dispatchOnce(deps: {
  peer: Peer; home: string; policy: Policy; runners: Runners; rate: RateWindow;
  journal?: JournalLike; now?: () => number; backlog?: boolean;
}): Promise<DispatchRecord[]> {
  const { peer, home, policy, runners, rate } = deps;
  if (!policy.dispatch.enabled) return [];
  const now = deps.now ?? Date.now;
  const seen = new SeenStore(home, "dispatch");
  let first = false;
  try { writeFileSync(seen.file, JSON.stringify({ seen: [] }), { mode: 0o600, flag: "wx" }); first = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const shown = new Set(seen.load());
  const key = (m: PeerMessage) => `peer:${m.sender}:${m.id}`;
  const fresh = peer.inbox(Number.MAX_SAFE_INTEGER).filter((m) => !shown.has(key(m)));
  if (first && !deps.backlog) { seen.mark(fresh.map(key)); return []; }

  let sessions: LiveSession[] = [];
  try { sessions = deps.journal?.sessionDirectory() ?? []; } catch { sessions = []; }
  const records: DispatchRecord[] = [];
  for (const message of fresh) {
    seen.mark([key(message)]);
    const config = dispatchPeer(policy, message.sender);
    let leaseHolder: string | null = null;
    try { leaseHolder = deps.journal?.conversationLease(message.conversation_id)?.session_id ?? null; } catch { leaseHolder = null; }
    const decision = decide(message, config, {
      rateOk: rate.allows(message.sender, now(), policy.dispatch.limits.per_peer_per_minute),
      sessions, leaseHolder,
      sentInConversation: (ids) => peer.thread(message.conversation_id)
        .some((m) => m.sender !== message.sender && typeof m.agent?.session_id === "string" && ids.includes(m.agent.session_id)),
    });
    const record = (step: DispatchRecord["step"], detail: string, extra: { harness?: string | null; cost_usd?: number } = {}) => {
      records.push({ message_id: message.id, conversation_id: message.conversation_id, peer: message.sender, step, detail });
      appendLedger(home, {
        session: null, harness: extra.harness ?? null, tool: "dispatch", peer: message.sender,
        conversation_id: message.conversation_id, message_id: message.id, decision: `${step}: ${detail}`, body: message.text,
        ...(extra.cost_usd !== undefined ? { cost_usd: extra.cost_usd } : {}),
      });
    };

    if (decision.action === "skip") { record("skip", decision.reason); continue; }
    rate.record(message.sender, now());
    if (decision.action === "respond") { await respond(message, config!, record); continue; }
    if (decision.action === "answer") {
      const workspace = config!.workspace!;
      let text: string;
      try { text = JSON.stringify({ query: decision.query, answer: runners.answer(decision.query, workspace) }); }
      catch (error) { record("answer", `${decision.query} failed: ${errorText(error)}`); continue; }
      const verdict = checkOutbound({ tool: "dispatch", recipient: message.sender, text }, policy, peer.store);
      if (verdict.decision === "deny") { record("answer", `${decision.query} blocked: ${verdict.reason}`); continue; }
      try {
        const sent = await peer.reply({ sender: message.sender, message_id: message.id, text, automatic: true });
        record("answer", `${decision.query} ${sent.status}`);
        appendLedger(home, {
          session: null, harness: null, tool: "dispatch:reply", peer: message.sender, conversation_id: message.conversation_id,
          message_id: sent.message_id, decision: sent.status, body: text,
        });
      } catch (error) { record("answer", `${decision.query} refused: ${errorText(error)}`); }
      continue;
    }

    const label = peer.store.get<Contact>("contacts", message.sender)?.identity.name;
    const notice = wakeNotice(message.conversation_id, label, message.id);
    const limits = policy.dispatch.limits;
    const { target } = decision;
    let result: WakeResult;
    try {
      result = target.harness === "claude" ? await runners.claudeWake(target.name, notice, limits) : await runners.codexWake(target.thread, notice, limits);
    } catch { result = { outcome: "failed" }; }
    let detail = `${target.harness} via ${target.via}: ${result.outcome}`;
    if (target.harness === "codex" && result.outcome !== "woken") {
      try { await runners.toast(notice); detail += ", toast shown"; } catch { detail += ", toast failed"; }
    }
    record("wake", detail, { harness: target.harness, ...(result.cost_usd !== undefined ? { cost_usd: result.cost_usd } : {}) });
  }
  return records;

  async function respond(message: PeerMessage, config: DispatchPeer, record: (step: DispatchRecord["step"], detail: string, extra?: { harness?: string | null; cost_usd?: number }) => void) {
    const responder = config.responder!;
    const task = responderTask(message, peer.store.get<Contact>("contacts", message.sender)?.identity.name);
    if (!task) { record("respond", "message too long for the responder", { harness: responder.harness }); return; }
    // Hold the conversation for this run, so an interactive session and the responder can't both answer.
    const session = `dispatch:${randomUUID()}`;
    const journal = deps.journal;
    if (journal) {
      try {
        journal.registerSession({ session_id: session, alias: "dispatch", harness: "dispatch" });
        const lease = journal.claimConversation(session, message.conversation_id);
        if (lease.status === "lease_conflict") {
          journal.endSession(session);
          record("respond", `lease held by ${String(lease.holder)}`, { harness: responder.harness });
          return;
        }
      } catch (error) { record("respond", `lease failed: ${errorText(error)}`, { harness: responder.harness }); return; }
    }
    try {
      const limits = policy.dispatch.limits;
      const request: SwarmRequest = {
        task, harnesses: [responder.harness], mode: "respond", timeoutMs: limits.timeout_ms, budgetUsd: limits.budget_usd,
        ...(responder.model ? { model: responder.model } : {}),
      };
      let result: RespondResult;
      try { result = await runners.respond(request, policy.dispatch.swarm_command!, config.workspace!, limits); }
      catch (error) { result = { outcome: `error: ${errorText(error)}` }; }
      const extra = { harness: responder.harness, ...(result.cost_usd !== undefined ? { cost_usd: result.cost_usd } : {}) };
      if (result.outcome !== "ok" || !result.reply?.trim()) {
        record("respond", `${responder.harness}: ${result.outcome === "ok" ? "empty reply" : result.outcome}`, extra);
        return;
      }
      const verdict = checkOutbound({ tool: "dispatch", recipient: message.sender, text: result.reply }, policy, peer.store);
      if (verdict.decision === "deny") { record("respond", `${responder.harness} reply blocked: ${verdict.reason}`, extra); return; }
      try {
        const sent = await peer.reply({ sender: message.sender, message_id: message.id, text: result.reply, automatic: true });
        record("respond", `${responder.harness} ${sent.status}`, extra);
        appendLedger(home, {
          session: null, harness: responder.harness, tool: "dispatch:reply", peer: message.sender, conversation_id: message.conversation_id,
          message_id: sent.message_id, decision: sent.status, body: result.reply,
        });
      } catch (error) { record("respond", `${responder.harness} refused: ${errorText(error)}`, extra); }
    } finally {
      try { journal?.endSession(session); } catch { /* the lease expires on its own */ }
    }
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0];

/** Values computed by code from the configured workspace. Tests are never run (ADR 0004 open question 1). */
export function computeAnswer(query: QueryType, workspace: string): string {
  if (query === "version") {
    try {
      const version = (JSON.parse(readFileSync(join(workspace, "package.json"), "utf8")) as { version?: unknown }).version;
      return typeof version === "string" && /^[\w.+-]{1,40}$/.test(version) ? version : "unknown";
    } catch { return "unknown"; }
  }
  if (query === "hash") {
    try {
      const head = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 10_000, windowsHide: true }).trim();
      return /^[0-9a-f]{40,64}$/.test(head) ? head : "unknown";
    } catch { return "unknown"; }
  }
  return "unknown";
}

interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

/** Runs a child with a timeout that kills its whole process tree. */
export function runWithTimeout(command: string, args: string[], options: { timeoutMs: number; env?: NodeJS.ProcessEnv; shell?: boolean; cwd?: string; input?: string }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: options.shell ?? false, windowsHide: true, env: options.env, cwd: options.cwd, detached: process.platform !== "win32",
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (options.input !== undefined) { child.stdin!.on("error", () => { /* the child exited early */ }); child.stdin!.end(options.input); }
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const finish = (code: number | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); } };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32" && child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        else if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch { /* already gone */ }
      finish(null);
    }, options.timeoutMs);
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-100_000); });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-20_000); });
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code));
  });
}

/** The parent's environment without CLAUDE* variables, so the child isn't tied to this session. */
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^CLAUDE/i.test(name)));
}

/** Arguments for the restricted wake process from the delivery-agent plan (step 3). */
export function claudeWakeArgs(name: string, notice: string, budgetUsd: number): string[] {
  const prompt = `Use ListAgents to find the session named "${name}". If exactly one session has that name, send it exactly this text with SendMessage and then stop: ${notice}\nIf no session or more than one session has that name, do nothing. Do nothing else.`;
  const tools = ["ListAgents", "SendMessage", "ToolSearch"];
  return ["-p", prompt, "--tools", ...tools, "--allowedTools", ...tools, "--strict-mcp-config", "--no-session-persistence",
    "--disable-slash-commands", "--max-budget-usd", String(budgetUsd), "--output-format", "json"];
}

/** How to start swarm_command: a .js entry runs under this Node; a .cmd shim needs a shell on Windows. */
export function swarmInvocation(command: string): { file: string; args: string[]; shell: boolean } | null {
  const args = ["run", "--request", "-"];
  if (/\.(c|m)?js$/i.test(command)) return { file: process.execPath, args: [command, ...args], shell: false };
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    if (!/^[\w :\\/.()-]+$/.test(command)) return null;
    return { file: `"${command}"`, args, shell: true };
  }
  return { file: command, args, shell: false };
}

export const defaultRunners: Runners = {
  answer: computeAnswer,
  async respond(request, swarmCommand, workspace, limits) {
    const invocation = swarmInvocation(swarmCommand);
    if (!invocation) return { outcome: "error: swarm_command path has shell-sensitive characters" };
    // The request, and with it the remote text, goes over stdin: never on argv and never in a file here.
    const result = await runWithTimeout(invocation.file, invocation.args, {
      timeoutMs: limits.timeout_ms + 5_000, shell: invocation.shell, cwd: workspace,
      env: { ...cleanEnv(), WORKSPACE_ROOT: workspace }, input: JSON.stringify(request),
    });
    if (result.timedOut) return { outcome: "timeout" };
    // One JSON object on stdout; accept it pretty-printed or as the last line after any log output.
    const parse = (text: string) => { try { return JSON.parse(text) as unknown; } catch { return null; } };
    const out = result.stdout.trim();
    const parsed = parse(out) ?? parse(out.split("\n").filter(Boolean).at(-1) ?? "");
    if (!parsed || typeof parsed !== "object") return { outcome: `error: swarm exited ${result.code} without a JSON result` };
    const response = parsed as { reply?: unknown; harnesses?: { outcome?: unknown; costUsd?: unknown }[] };
    const row = response.harnesses?.[0];
    return {
      outcome: typeof row?.outcome === "string" ? row.outcome : "error",
      ...(typeof response.reply === "string" ? { reply: response.reply } : {}),
      ...(typeof row?.costUsd === "number" ? { cost_usd: row.costUsd } : {}),
    };
  },
  async claudeWake(name, notice, limits) {
    // A missing or duplicated name costs nothing: check before spawning a model run.
    const listing = await runWithTimeout("claude", ["agents", "--json"], { timeoutMs: 20_000, env: cleanEnv() });
    let matches = 0;
    try { matches = (JSON.parse(listing.stdout) as { name?: unknown }[]).filter((s) => s?.name === name).length; } catch { matches = 0; }
    if (matches !== 1) return { outcome: "no_match" };
    const result = await runWithTimeout("claude", claudeWakeArgs(name, notice, limits.budget_usd), { timeoutMs: limits.timeout_ms, env: cleanEnv() });
    if (result.timedOut) return { outcome: "timeout" };
    let cost: number | undefined;
    let isError = true;
    try {
      const output = JSON.parse(result.stdout) as { total_cost_usd?: unknown; is_error?: unknown };
      if (typeof output.total_cost_usd === "number") cost = output.total_cost_usd;
      isError = output.is_error === true;
    } catch { isError = true; }
    return { outcome: result.code === 0 && !isError ? "woken" : "failed", ...(cost !== undefined ? { cost_usd: cost } : {}) };
  },
  async codexWake(thread, notice, limits) {
    const args = ["queue", "--thread", thread, "--message", notice, "--resume"];
    // codex is a .cmd shim on Windows, which needs a shell; every argument is a checked plain token.
    const shell = process.platform === "win32";
    if (shell && !args.every((a) => /^[\w .=:-]+$/.test(a))) return { outcome: "failed" };
    const result = await runWithTimeout("codex", shell ? args.map((a) => `"${a}"`) : args, { timeoutMs: limits.timeout_ms, shell });
    if (result.timedOut) return { outcome: "timeout" };
    // A failed resume only prints a warning (ADR 0003 decision 5), so the output decides too.
    const failed = result.code !== 0 || /warn|error|fail|unexpected/i.test(result.stdout + result.stderr);
    return { outcome: failed ? "failed" : "woken" };
  },
  async toast(notice) {
    if (process.platform !== "win32") return;
    const script = "Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; "
      + "$n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; "
      + "$n.ShowBalloonTip(10000, 'Agent mail', $env:AGENT_MAIL_TOAST, 'Info'); Start-Sleep -Seconds 8; $n.Dispose()";
    await runWithTimeout("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs: 20_000, env: { ...process.env, AGENT_MAIL_TOAST: notice } });
  },
};

/** Single instance through `<home>/dispatch.lock`; a lock left by a dead process is replaced. */
export function acquireDispatchLock(home: string): () => void {
  const path = join(home, "dispatch.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => { try { if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path); } catch { /* gone */ } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(path, "utf8"));
      if (pid && isAlive(pid)) throw new Error(`agent-mail dispatch is already running (pid ${pid})`);
      if (existsSync(path)) unlinkSync(path);
    }
  }
  throw new Error("Could not take the dispatch lock");
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
