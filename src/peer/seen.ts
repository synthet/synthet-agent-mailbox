import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Peer } from "./peer.js";
import type { Contact } from "./store.js";

/** Bodies longer than this are cut, so one message can't flood a hook's injected context. */
export const SEEN_BODY_LIMIT = 4000;
/** Oldest keys are dropped past this, so a long-lived session's file stays small. */
const SEEN_KEEP = 5000;

export interface UnseenMessage {
  key: string;
  source: "peer" | "journal";
  message_id: string;
  conversation_id: string;
  sender: string | null;
  sender_label: string | null;
  agent: Record<string, unknown> | null;
  created_at: number | string;
  body?: string;
  truncated?: boolean;
}

/**
 * Which messages a session has already been shown. A local hint for hooks, kept per session under
 * `<home>/sessions/`. It is not a read receipt: `ack` still marks a message read.
 */
export class SeenStore {
  readonly file: string;
  constructor(home: string, sessionId: string) {
    if (!sessionId) throw new Error("Missing --session");
    const folder = join(home, "sessions");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    this.file = join(folder, createHash("sha256").update(sessionId).digest("hex") + ".seen.json");
  }
  load(): string[] {
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8")) as { seen?: unknown };
      return Array.isArray(value.seen) ? value.seen.filter((key): key is string => typeof key === "string") : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  /** Returns how many keys were new. Writes atomically; concurrent writers can only re-show a message. */
  mark(keys: string[]): number {
    const seen = this.load();
    const known = new Set(seen);
    let added = 0;
    for (const key of keys) if (key && !known.has(key)) { known.add(key); seen.push(key); added++; }
    if (!added) return 0;
    const temp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ seen: seen.slice(-SEEN_KEEP) }), { mode: 0o600, flag: "wx" });
    try { renameSync(temp, this.file); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
    return added;
  }
}

interface JournalLike { inbox(sessionId: string, limit?: number): Record<string, unknown>[] }

/**
 * Unacknowledged messages this session hasn't been shown yet: the peer inbox, plus journal messages
 * when a journal is passed. Opening the journal is the caller's choice, so this never creates journal.db.
 */
export function unseenMessages(peer: Peer, seen: SeenStore, options: { journal?: JournalLike; session: string; limit?: number; bodies?: boolean }): UnseenMessage[] {
  const shown = new Set(seen.load());
  const limit = options.limit ?? 20;
  const label = (sender: string) => peer.store.get<Contact>("contacts", sender)?.identity.name ?? null;
  const items: UnseenMessage[] = peer.inbox(Number.MAX_SAFE_INTEGER).map((m) => ({
    key: `peer:${m.sender}:${m.id}`, source: "peer" as const, message_id: m.id, conversation_id: m.conversation_id,
    sender: m.sender, sender_label: label(m.sender), agent: (m.agent as Record<string, unknown> | undefined) ?? null,
    created_at: m.created_at, text: m.text,
  })).filter((m) => !shown.has(m.key)).map(({ text, ...m }) => withBody(m, text, options.bodies));
  if (options.journal) {
    let rows: Record<string, unknown>[] = [];
    try { rows = options.journal.inbox(options.session, Number.MAX_SAFE_INTEGER); }
    catch { rows = []; } // an unregistered session has no journal inbox
    for (const row of rows) {
      const key = `journal:${String(row.message_id)}`;
      if (shown.has(key)) continue;
      items.push(withBody({
        key, source: "journal", message_id: String(row.message_id), conversation_id: String(row.thread_id),
        sender: row.sender_host == null ? null : String(row.sender_host), sender_label: row.sender_agent == null ? null : String(row.sender_agent),
        agent: null, created_at: row.created_at as number | string,
      }, String(row.body ?? ""), options.bodies));
    }
  }
  return items.slice(0, limit);
}

function withBody(m: UnseenMessage, text: string, bodies?: boolean): UnseenMessage {
  if (!bodies) return m;
  return { ...m, body: text.slice(0, SEEN_BODY_LIMIT), truncated: text.length > SEEN_BODY_LIMIT };
}
