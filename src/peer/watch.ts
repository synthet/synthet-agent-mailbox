import { writeFileSync } from "node:fs";
import type { Peer } from "./peer.js";
import { SeenStore, unseenMessages } from "./seen.js";

interface JournalLike { inbox(sessionId: string, limit?: number): Record<string, unknown>[] }

/** One wake line. Metadata only: remote text never reaches the watcher's output. */
export interface WakeLine {
  type: "mail";
  source: "peer" | "journal";
  id: string;
  thread: string;
  from: string | null;
  created_at: number | string;
}

/**
 * One poll for `agent-mail watch`: a line for each message this watcher hasn't reported yet.
 * The watcher keeps its own seen file (separate from the inject hooks', so a wake line doesn't stop a
 * hook from injecting the body later). A new watcher starts from now: its first poll records the
 * existing backlog without reporting it, unless backlog is set.
 */
export function watchPoll(peer: Peer, home: string, session: string, journal: JournalLike | undefined, options: { backlog?: boolean } = {}): WakeLine[] {
  const seen = new SeenStore(home, `watch:${session}`);
  let first = false;
  try { writeFileSync(seen.file, JSON.stringify({ seen: [] }), { mode: 0o600, flag: "wx" }); first = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const items = unseenMessages(peer, seen, { journal, session, limit: Number.MAX_SAFE_INTEGER });
  seen.mark(items.map((item) => item.key));
  if (first && !options.backlog) return [];
  return items.map((item) => ({
    type: "mail", source: item.source, id: item.message_id, thread: item.conversation_id,
    from: item.sender_label ?? item.sender, created_at: item.created_at,
  }));
}
