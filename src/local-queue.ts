import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Envelope, SendInput } from "./types.js";

interface OutboxRow {
  message_id: string;
  payload: string;
  attempts: number;
}

export interface SpoolCounts {
  outbox: number;
  rejected: number;
  spool_new: number;
  spool_handed: number;
  needs_attention: number;
}

export class LocalQueue {
  private constructor(private readonly db: Database.Database) {}

  static open(dbPath: string): LocalQueue {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        message_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS spool (
        message_id TEXT PRIMARY KEY,
        message_json TEXT NOT NULL,
        status TEXT NOT NULL,
        wake_attempts INTEGER NOT NULL DEFAULT 0,
        auto_wake INTEGER NOT NULL DEFAULT 1,
        lease_until INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        conversation_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL
      );
    `);
    return new LocalQueue(db);
  }

  close(): void {
    this.db.close();
  }

  enqueue(messageId: string, payload: SendInput, now: number): void {
    this.db
      .prepare(
        `INSERT INTO outbox (message_id, payload, attempts, next_attempt_at, status, created_at)
         VALUES (?, ?, 0, ?, 'pending', ?)
         ON CONFLICT(message_id) DO NOTHING`,
      )
      .run(messageId, JSON.stringify(payload), now, now);
  }

  due(now: number): Array<{ message_id: string; payload: SendInput; attempts: number }> {
    const rows = this.db
      .prepare(
        `SELECT message_id, payload, attempts FROM outbox
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY created_at ASC`,
      )
      .all(now) as OutboxRow[];
    return rows.map((row) => ({
      message_id: row.message_id,
      payload: JSON.parse(row.payload) as SendInput,
      attempts: row.attempts,
    }));
  }

  markSent(messageId: string): void {
    this.db.prepare(`DELETE FROM outbox WHERE message_id = ?`).run(messageId);
  }

  markFailed(messageId: string, error: string, now: number): void {
    const row = this.db.prepare(`SELECT attempts FROM outbox WHERE message_id = ?`).get(messageId) as
      | { attempts: number }
      | undefined;
    const attempts = (row?.attempts ?? 0) + 1;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6));
    this.db
      .prepare(
        `UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ?, status = 'pending' WHERE message_id = ?`,
      )
      .run(attempts, now + delay, error.slice(0, 500), messageId);
  }

  markRejected(messageId: string, error: string): void {
    this.db
      .prepare(`UPDATE outbox SET status = 'rejected', last_error = ? WHERE message_id = ?`)
      .run(error.slice(0, 500), messageId);
  }

  spool(message: Envelope, now: number): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO spool (message_id, message_json, status, created_at, updated_at)
         VALUES (?, ?, 'new', ?, ?)
         ON CONFLICT(message_id) DO NOTHING`,
      )
      .run(message.message_id, JSON.stringify(message), now, now);
    return result.changes > 0;
  }

  leaseLocal(limit: number, leaseMs: number, now: number): Envelope[] {
    const rows = this.db
      .prepare(
        `SELECT message_id, message_json FROM spool
         WHERE status = 'new'
            OR status = 'needs_attention'
            OR (status = 'handed' AND lease_until < ?)
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(now, limit) as Array<{ message_id: string; message_json: string }>;
    const update = this.db.prepare(
      `UPDATE spool SET status = 'handed', lease_until = ?, updated_at = ? WHERE message_id = ? AND status != 'done'`,
    );
    const messages: Envelope[] = [];
    for (const row of rows) {
      update.run(now + leaseMs, now, row.message_id);
      const message = JSON.parse(row.message_json) as Envelope;
      messages.push({ ...message, delivery: "leased", spooled: true });
    }
    return messages;
  }

  ackLocal(messageId: string, now: number): boolean {
    const row = this.db.prepare(`SELECT status FROM spool WHERE message_id = ?`).get(messageId) as
      | { status: string }
      | undefined;
    if (!row) return false;
    if (row.status === "done") return true;
    this.db
      .prepare(`UPDATE spool SET status = 'done', lease_until = 0, auto_wake = 0, updated_at = ? WHERE message_id = ?`)
      .run(now, messageId);
    return true;
  }

  releaseLocal(messageId: string, now: number): boolean {
    const row = this.db.prepare(`SELECT status FROM spool WHERE message_id = ?`).get(messageId) as
      | { status: string }
      | undefined;
    if (!row || row.status === "done") return false;
    this.db
      .prepare(
        `UPDATE spool
         SET status = 'new', auto_wake = 1, wake_attempts = 0, lease_until = 0, updated_at = ?
         WHERE message_id = ?`,
      )
      .run(now, messageId);
    return true;
  }

  pendingWake(limit: number): Envelope[] {
    const rows = this.db
      .prepare(
        `SELECT message_json FROM spool
         WHERE status = 'new' AND auto_wake = 1 AND wake_attempts < 3
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit) as Array<{ message_json: string }>;
    return rows.map((row) => JSON.parse(row.message_json) as Envelope);
  }

  markHanded(ids: string[], now: number, leaseMs: number): void {
    const update = this.db.prepare(
      `UPDATE spool
       SET status = 'handed', auto_wake = 0, lease_until = ?, updated_at = ?
       WHERE message_id = ? AND status != 'done'`,
    );
    for (const id of ids) update.run(now + leaseMs, now, id);
  }

  markWakeFailed(ids: string[], now: number): void {
    const update = this.db.prepare(
      `UPDATE spool
       SET wake_attempts = wake_attempts + 1,
           status = CASE WHEN wake_attempts + 1 >= 3 THEN 'needs_attention' ELSE 'new' END,
           auto_wake = CASE WHEN wake_attempts + 1 >= 3 THEN 0 ELSE 1 END,
           updated_at = ?
       WHERE message_id = ? AND status != 'done'`,
    );
    for (const id of ids) update.run(now, id);
  }

  session(conversationId: string): string | undefined {
    const row = this.db.prepare(`SELECT chat_id FROM sessions WHERE conversation_id = ?`).get(conversationId) as
      | { chat_id: string }
      | undefined;
    return row?.chat_id;
  }

  saveSession(conversationId: string, chatId: string): void {
    this.db
      .prepare(
        `INSERT INTO sessions (conversation_id, chat_id) VALUES (?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET chat_id = excluded.chat_id`,
      )
      .run(conversationId, chatId);
  }

  messagesIn(conversationId: string): Envelope[] {
    const rows = this.db.prepare(`SELECT message_json FROM spool ORDER BY created_at ASC`).all() as Array<{
      message_json: string;
    }>;
    return rows
      .map((row) => JSON.parse(row.message_json) as Envelope)
      .filter((message) => message.conversation_id === conversationId);
  }

  queuedFor(conversationId: string): Envelope[] {
    const rows = this.db
      .prepare(`SELECT payload, created_at FROM outbox WHERE status = 'pending' ORDER BY created_at ASC`)
      .all() as Array<{ payload: string; created_at: number }>;
    const messages: Envelope[] = [];
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as SendInput & { message_id: string; conversation_id: string };
      if (payload.conversation_id !== conversationId) continue;
      const text = typeof payload.body === "string" ? payload.body : payload.body.text;
      messages.push({
        message_id: payload.message_id,
        conversation_id: payload.conversation_id,
        reply_to: payload.reply_to ?? null,
        sender: "local-outbox",
        recipient: payload.recipient,
        type: payload.type,
        deadline: null,
        body: typeof payload.body === "string" ? { text } : payload.body,
        task_id: payload.task_id ?? null,
        task_status: null,
        project: payload.project ?? null,
        repo: payload.repo ?? null,
        branch: payload.branch ?? null,
        commit: payload.commit ?? null,
        operation_id: payload.operation_id ?? null,
        delivery: "pending",
        attempt: 0,
        lease_until: null,
        created_at: new Date(row.created_at).toISOString(),
        spooled: true,
      });
    }
    return messages;
  }

  counts(): SpoolCounts {
    const count = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      outbox: count(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`),
      rejected: count(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'rejected'`),
      spool_new: count(`SELECT COUNT(*) AS n FROM spool WHERE status = 'new'`),
      spool_handed: count(`SELECT COUNT(*) AS n FROM spool WHERE status = 'handed'`),
      needs_attention: count(`SELECT COUNT(*) AS n FROM spool WHERE status = 'needs_attention'`),
    };
  }
}
