import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { fingerprint } from "./identity.js";
import type { PeerStore, Contact } from "./store.js";

/**
 * Owner-written send policy at `<home>/policy.json` (ADR 0003, decision 6). There is no permissive
 * default: a missing or invalid policy makes the send gate deny every outbound message.
 */
export const policySchema = z.object({
  allowed_peers: z.array(z.string().min(1)).describe("Peer names or full fingerprints that may receive mail"),
  max_bytes: z.number().int().min(1).max(64 * 1024),
  forbid_action_requests: z.boolean().default(false).describe("Opt-in: deny messages that ask a peer to push, delete or trust"),
  auto_answer_types: z.array(z.string().min(1)).default([]),
}).strict();
export type Policy = z.infer<typeof policySchema>;

/** A starting policy that allows nobody. The owner adds peers by hand. */
export const POLICY_TEMPLATE: Policy = { allowed_peers: [], max_bytes: 16384, forbid_action_requests: false, auto_answer_types: [] };

export const policyPath = (home: string) => join(home, "policy.json");
export const ledgerPath = (home: string) => join(home, "ledger.jsonl");

export function loadPolicy(home: string): { ok: true; policy: Policy } | { ok: false; error: string } {
  const path = policyPath(home);
  if (!existsSync(path)) return { ok: false, error: "No policy.json; run `agent-mail policy init`, then add allowed_peers" };
  try {
    return { ok: true, policy: policySchema.parse(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (error) {
    return { ok: false, error: `Invalid policy.json: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` };
  }
}

/** Writes the deny-everyone template. Never overwrites an existing policy. */
export function initPolicy(home: string): { created: boolean; path: string } {
  const path = policyPath(home);
  if (existsSync(path)) return { created: false, path };
  writeFileSync(path, JSON.stringify(POLICY_TEMPLATE, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return { created: true, path };
}

// Patterns are built from parts so this file itself never looks like a leaked credential.
const SECRET_PATTERNS: RegExp[] = [
  new RegExp("-----BEGIN [A-Z ]*PRIVATE KEY-----"),
  new RegExp("\\b(?:sk|rk)-[A-Za-z0-9_-]{20,}"),
  new RegExp("\\bgh[pousr]_[A-Za-z0-9]{36,}"),
  new RegExp("\\bA" + "KIA[0-9A-Z]{16}\\b"),
  new RegExp("\\bxox[baprs]-[A-Za-z0-9-]{10,}"),
  new RegExp("\\b(?:password|passwd|secret|api[_-]?key|token)\\s*[:=]\\s*\\S{8,}", "i"),
];
const ACTION_REQUEST = /\b(?:git\s+push|force[- ]push|push\s+--force|rm\s+-rf|agent-mail\s+(?:un)?trust)\b/i;

export interface OutboundMessage { tool: string; recipient?: string; text: string }

/** The gate's verdict. `deny` carries a reason; `allow` means "no objection", not permission. */
export function checkOutbound(message: OutboundMessage, policy: Policy, store?: PeerStore): { decision: "allow" } | { decision: "deny"; reason: string } {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(message.text))) return { decision: "deny", reason: "Outbound agent-mail looks like it contains a secret. Send a hash or a summary instead." };
  const bytes = Buffer.byteLength(message.text, "utf8");
  if (bytes > policy.max_bytes) return { decision: "deny", reason: `Message is ${bytes} bytes, over policy max_bytes ${policy.max_bytes}. Send hashes or a summary.` };
  if (message.recipient !== undefined && !peerAllowed(message.recipient, policy, store)) {
    return { decision: "deny", reason: `Peer "${message.recipient}" is not in policy allowed_peers.` };
  }
  if (policy.forbid_action_requests && ACTION_REQUEST.test(message.text)) {
    return { decision: "deny", reason: "Asking a peer for a side-effectful action (push, delete, trust) needs the owner's approval first." };
  }
  return { decision: "allow" };
}

/** A recipient matches by exact entry, or through its contact's fingerprint or name. */
function peerAllowed(recipient: string, policy: Policy, store?: PeerStore): boolean {
  const allowed = new Set(policy.allowed_peers.map((p) => p.toLowerCase()));
  if (allowed.has(recipient.toLowerCase())) return true;
  let contact: Contact | undefined;
  try { contact = store?.contact(recipient); } catch { contact = undefined; }
  if (!contact) return false;
  return allowed.has(fingerprint(contact.identity)) || allowed.has(contact.identity.name.toLowerCase());
}

export interface ToolHookInput { session_id?: string; tool_name?: string; tool_input?: Record<string, unknown>; tool_response?: unknown }

/** Agent-mail tools that send text off this PC (`mcp__<server>__send_message` and the plugin-scoped forms). */
const SENDING_TOOL = /(?:^|__)(send_message|mailbox_publish)$/;

const outbound = (input: ToolHookInput): OutboundMessage & { body: string } => {
  const args = input.tool_input ?? {};
  const text = typeof args.text === "string" ? args.text : typeof args.body === "string" ? args.body : "";
  const recipient = typeof args.recipient === "string" ? args.recipient : undefined;
  return { tool: input.tool_name ?? "", recipient, text, body: text };
};

const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

/**
 * PreToolUse send gate. Returns a deny response, or null for "no objection" (the normal permission flow
 * still decides). Fails closed: a missing or invalid policy, or any error, denies a sending tool.
 */
export function gateHook(input: ToolHookInput, home: string, store?: PeerStore, harness: string | null = null): Record<string, unknown> | null {
  const tool = input.tool_name ?? "";
  if (!SENDING_TOOL.test(tool)) return null;
  let reason: string | null = null;
  const message = outbound(input);
  try {
    const loaded = loadPolicy(home);
    if (!loaded.ok) reason = `agent-mail send gate: ${loaded.error}`;
    else {
      const verdict = checkOutbound(message, loaded.policy, store);
      if (verdict.decision === "deny") reason = verdict.reason;
    }
  } catch (error) {
    reason = `agent-mail send gate error: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (reason === null) return null;
  try {
    appendLedger(home, { session: input.session_id ?? null, harness, tool, peer: message.recipient ?? null, conversation_id: null, message_id: null, decision: `denied: ${reason}`, body: message.body });
  } catch { /* a ledger failure must not turn a deny into an allow */ }
  return deny(reason);
}

/** PostToolUse ledger: one metadata line per agent-mail tool call, ids taken from the tool result. */
export function ledgerHook(input: ToolHookInput, home: string, harness: string | null = null): LedgerEntry | null {
  const tool = input.tool_name ?? "";
  if (!tool) return null;
  const result = parseToolResult(input.tool_response);
  const message = outbound(input);
  const str = (value: unknown) => (typeof value === "string" ? value : null);
  return appendLedger(home, {
    session: input.session_id ?? null, harness, tool, peer: message.recipient ?? null,
    conversation_id: str(result.conversation_id) ?? str(input.tool_input?.conversation_id),
    message_id: str(result.message_id) ?? str(input.tool_input?.message_id),
    decision: str(result.status) ?? "ok",
    ...(SENDING_TOOL.test(tool) ? { body: message.body } : {}),
  });
}

/** MCP results arrive as `{content: [{type: "text", text: "<json>"}]}`, a JSON string, or an object. */
function parseToolResult(response: unknown): Record<string, unknown> {
  const tryJson = (text: string): Record<string, unknown> => { try { const v = JSON.parse(text); return v && typeof v === "object" ? v : {}; } catch { return {}; } };
  if (typeof response === "string") return tryJson(response);
  if (Array.isArray(response)) return parseToolResult({ content: response });
  if (response && typeof response === "object") {
    const content = (response as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const first = content.find((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text") as { text?: unknown } | undefined;
      if (first && typeof first.text === "string") return tryJson(first.text);
    }
    return response as Record<string, unknown>;
  }
  return {};
}

export interface LedgerEntry {
  ts: string; session: string | null; harness: string | null; tool: string; peer: string | null;
  conversation_id: string | null; message_id: string | null; sha256: string | null; decision: string;
}

/** Append one metadata line. The body is stored only as its sha256, never as text. */
export function appendLedger(home: string, entry: Omit<LedgerEntry, "ts" | "sha256"> & { body?: string }): LedgerEntry {
  const { body, ...rest } = entry;
  const line: LedgerEntry = { ts: new Date().toISOString(), ...rest, sha256: body === undefined ? null : createHash("sha256").update(body).digest("hex") };
  appendFileSync(ledgerPath(home), JSON.stringify(line) + "\n", { mode: 0o600 });
  return line;
}
