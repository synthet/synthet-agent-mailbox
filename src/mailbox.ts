import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { allowsProject, type Directory } from "./config.js";
import { MailboxError } from "./errors.js";
import type {
  Agent,
  ConversationRecord,
  DeliveryStatus,
  Envelope,
  MessageBody,
  MessageType,
  SendInput,
  TaskRecord,
  TaskStatus,
} from "./types.js";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const COMMIT_RE = /^[0-9a-f]{7,64}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_TASK = "('open','waiting','in_progress')";

interface MessageRow {
  id: string;
  conversation_id: string;
  reply_to: string | null;
  sender: string;
  recipient: string;
  type: MessageType;
  deadline: number | null;
  body: string;
  task_id: string | null;
  project: string | null;
  repo: string | null;
  branch: string | null;
  commit_sha: string | null;
  operation_id: string | null;
  delivery: DeliveryStatus;
  lease_until: number;
  attempt: number;
  created_at: number;
  task_status: TaskStatus | null;
}

interface TaskRow {
  id: string;
  conversation_id: string;
  owner: string;
  requester: string;
  status: TaskStatus;
  deadline: number | null;
  created_at: number;
  updated_at: number;
}

interface ConversationRow {
  id: string;
  created_by: string;
  turn_count: number;
  max_turns: number;
  created_at: number;
  updated_at: number;
}

export interface SendResult {
  ok: true;
  duplicate: boolean;
  message: Envelope;
}

export interface ThreadResult {
  ok: true;
  conversation: ConversationRecord;
  tasks: TaskRecord[];
  messages: Envelope[];
  truncated: boolean;
}

function assertId(value: string, label: string): void {
  if (!ID_RE.test(value)) {
    throw new MailboxError(`${label} must be 1-80 letters, numbers, or . _ : -`);
  }
}

function iso(ms: number | null): string | null {
  if (ms === null) return null;
  return new Date(ms).toISOString();
}

function cleanLine(value: string, label: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\u0000-\u001f]/.test(trimmed) || trimmed.includes("..")) {
    throw new MailboxError(`${label} is empty, too long, or contains control characters`);
  }
  return trimmed;
}

export function formatEnvelopeLog(message: Envelope): string {
  const header = [
    message.created_at,
    `${message.sender} -> ${message.recipient}`,
    message.type,
    `conversation=${message.conversation_id}`,
    `message=${message.message_id}`,
    message.task_id ? `task=${message.task_id}` : "",
    message.task_status ? `task_status=${message.task_status}` : "",
    message.repo ? `repo=${message.repo}` : "",
    message.branch ? `branch=${message.branch}` : "",
    message.commit ? `commit=${message.commit}` : "",
    `delivery=${message.delivery}`,
  ]
    .filter(Boolean)
    .join(" ");
  const lines = [header, message.body.text];
  if (message.body.evidence) lines.push(`evidence: ${message.body.evidence}`);
  if (message.body.constraints) lines.push(`constraints: ${message.body.constraints}`);
  if (message.body.expected) lines.push(`expected: ${message.body.expected}`);
  return `${lines.join("\n")}\n\n`;
}

export class Mailbox {
  private constructor(
    private readonly db: Database.Database,
    private readonly directory: Directory,
    private readonly clock: () => number,
    private readonly logPath?: string,
  ) {}

  static open(
    dbPath: string,
    directory: Directory,
    options?: { clock?: () => number; logPath?: string },
  ): Mailbox {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        created_by TEXT NOT NULL,
        turn_count INTEGER NOT NULL DEFAULT 0,
        max_turns INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        owner TEXT NOT NULL,
        requester TEXT NOT NULL,
        status TEXT NOT NULL,
        deadline INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        reply_to TEXT REFERENCES messages(id),
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        type TEXT NOT NULL,
        deadline INTEGER,
        body TEXT NOT NULL,
        task_id TEXT REFERENCES tasks(id),
        project TEXT,
        repo TEXT,
        branch TEXT,
        commit_sha TEXT,
        operation_id TEXT,
        delivery TEXT NOT NULL DEFAULT 'pending',
        lease_owner TEXT,
        lease_until INTEGER NOT NULL DEFAULT 0,
        not_before INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_inbox
        ON messages(recipient, delivery, not_before, lease_until, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_thread
        ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_reply
        ON messages(reply_to);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_operation
        ON messages(sender, operation_id) WHERE operation_id IS NOT NULL;
    `);
    return new Mailbox(db, directory, options?.clock ?? Date.now, options?.logPath);
  }

  close(): void {
    this.db.close();
  }

  whoami(actor: Agent): { ok: true; agent_id: string; capabilities: string[]; projects: string[] } {
    return {
      ok: true,
      agent_id: actor.id,
      capabilities: actor.capabilities,
      projects: actor.projects,
    };
  }

  listAgents(): { ok: true; agents: Agent[] } {
    return { ok: true, agents: this.directory.list() };
  }

  send(actor: Agent, input: SendInput): SendResult {
    this.expireDue();
    let result: SendResult;
    try {
      result = this.db.transaction(() => this.performSend(actor, input))();
    } catch (error) {
      if (!isSqliteConstraint(error)) throw error;
      const duplicate = this.findDuplicate(actor.id, input.message_id ?? "missing-message", input.operation_id);
      if (!duplicate) throw error;
      return { ok: true, duplicate: true, message: duplicate };
    }
    if (!result.duplicate && this.logPath) {
      try {
        appendFileSync(this.logPath, formatEnvelopeLog(result.message));
      } catch (error) {
        console.error("failed to append conversation log", error);
      }
    }
    return result;
  }

  fetchInbox(actor: Agent, limit = 5, leaseMs = 60_000): { ok: true; messages: Envelope[] } {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new MailboxError("limit must be an integer from 1 to 50");
    }
    if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 600_000) {
      throw new MailboxError("lease_ms must be an integer from 1000 to 600000");
    }
    this.expireDue();
    const now = this.clock();
    const messages = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE messages
           SET delivery = 'dead', lease_owner = NULL, lease_until = 0, updated_at = ?
           WHERE recipient = ?
             AND delivery IN ('pending', 'leased')
             AND attempt >= ?
             AND (delivery = 'pending' OR lease_until < ?)`,
        )
        .run(now, actor.id, this.directory.maxAttempts, now);

      const rows = this.db
        .prepare(
          `SELECT id FROM messages
           WHERE recipient = ?
             AND attempt < ?
             AND (deadline IS NULL OR deadline > ?)
             AND (
               (delivery = 'pending' AND not_before <= ?)
               OR (delivery = 'leased' AND lease_until < ?)
             )
           ORDER BY created_at ASC
           LIMIT ?`,
        )
        .all(actor.id, this.directory.maxAttempts, now, now, now, limit) as Array<{ id: string }>;

      const lease = this.db.prepare(
        `UPDATE messages
         SET delivery = 'leased', lease_owner = ?, lease_until = ?, attempt = attempt + 1, updated_at = ?
         WHERE id = ?`,
      );
      const leased: Envelope[] = [];
      for (const row of rows) {
        lease.run(actor.id, now + leaseMs, now, row.id);
        const message = this.loadMessage(row.id);
        if (message) leased.push(message);
      }
      return leased;
    })();
    return { ok: true, messages };
  }

  acknowledge(actor: Agent, messageId: string): { ok: true; message_id: string; delivery: "acked" } {
    assertId(messageId, "message_id");
    const now = this.clock();
    const row = this.messageBasics(messageId);
    if (!row || row.recipient !== actor.id) throw new MailboxError("message not found");
    if (row.delivery === "expired") throw new MailboxError("message is expired");
    if (row.delivery === "dead") throw new MailboxError("message is dead and will not be retried");
    this.db
      .prepare(
        `UPDATE messages
         SET delivery = 'acked', lease_owner = NULL, lease_until = 0, updated_at = ?
         WHERE id = ? AND recipient = ?`,
      )
      .run(now, messageId, actor.id);
    return { ok: true, message_id: messageId, delivery: "acked" };
  }

  release(actor: Agent, messageId: string): { ok: true; message_id: string; delivery: "pending" | "dead" } {
    assertId(messageId, "message_id");
    const now = this.clock();
    const row = this.messageBasics(messageId);
    if (!row || row.recipient !== actor.id) throw new MailboxError("message not found");
    if (row.delivery !== "leased") throw new MailboxError("message is not leased");
    const dead = row.attempt >= this.directory.maxAttempts;
    const backoff = Math.min(60_000, 1000 * 2 ** Math.max(0, row.attempt - 1));
    this.db
      .prepare(
        `UPDATE messages
         SET delivery = ?, lease_owner = NULL, lease_until = 0, not_before = ?, updated_at = ?
         WHERE id = ? AND recipient = ?`,
      )
      .run(dead ? "dead" : "pending", dead ? 0 : now + backoff, now, messageId, actor.id);
    return { ok: true, message_id: messageId, delivery: dead ? "dead" : "pending" };
  }

  getThread(actor: Agent, conversationId: string, limit = 200): ThreadResult {
    assertId(conversationId, "conversation_id");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new MailboxError("limit must be an integer from 1 to 500");
    }
    this.expireDue();
    const conversation = this.conversation(conversationId);
    if (!conversation || !this.isParticipant(conversationId, actor.id)) {
      throw new MailboxError("conversation not found");
    }
    const total = this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?`)
      .get(conversationId) as { n: number };
    const messages = (
      this.db
        .prepare(
          `SELECT * FROM (
             SELECT ${MESSAGE_COLUMNS}
             FROM messages m
             LEFT JOIN tasks t ON t.id = m.task_id
             WHERE m.conversation_id = ?
             ORDER BY m.created_at DESC
             LIMIT ?
           )
           ORDER BY created_at ASC`,
        )
        .all(conversationId, limit) as MessageRow[]
    ).map((row) => this.toEnvelope(row));
    const tasks = (
      this.db.prepare(`SELECT * FROM tasks WHERE conversation_id = ? ORDER BY created_at ASC`).all(conversationId) as TaskRow[]
    ).map((row) => this.toTask(row));
    return {
      ok: true,
      conversation: this.toConversation(conversation),
      tasks,
      messages,
      truncated: total.n > messages.length,
    };
  }

  queueStatus(actor: Agent): {
    ok: true;
    inbox: Record<DeliveryStatus, number>;
    tasks: Record<TaskStatus, number>;
  } {
    const inbox: Record<DeliveryStatus, number> = {
      pending: 0,
      leased: 0,
      acked: 0,
      expired: 0,
      dead: 0,
    };
    const tasks: Record<TaskStatus, number> = {
      open: 0,
      waiting: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
    };
    const deliveryRows = this.db
      .prepare(`SELECT delivery, COUNT(*) AS n FROM messages WHERE recipient = ? GROUP BY delivery`)
      .all(actor.id) as Array<{ delivery: DeliveryStatus; n: number }>;
    for (const row of deliveryRows) inbox[row.delivery] = row.n;
    const taskRows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM tasks
         WHERE owner = ? OR requester = ?
         GROUP BY status`,
      )
      .all(actor.id, actor.id) as Array<{ status: TaskStatus; n: number }>;
    for (const row of taskRows) tasks[row.status] = row.n;
    return { ok: true, inbox, tasks };
  }

  recent(actor: Agent, limit: number): Envelope[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM (
             SELECT ${MESSAGE_COLUMNS}
             FROM messages m
             LEFT JOIN tasks t ON t.id = m.task_id
             WHERE m.sender = ? OR m.recipient = ?
             ORDER BY m.created_at DESC
             LIMIT ?
           )
           ORDER BY created_at ASC`,
        )
        .all(actor.id, actor.id, limit) as MessageRow[]
    ).map((row) => this.toEnvelope(row));
  }

  private expireDue(): void {
    const now = this.clock();
    this.db
      .prepare(
        `UPDATE messages
         SET delivery = 'expired', lease_owner = NULL, lease_until = 0, updated_at = ?
         WHERE delivery IN ('pending', 'leased') AND deadline IS NOT NULL AND deadline <= ?`,
      )
      .run(now, now);
    this.db
      .prepare(
        `UPDATE tasks
         SET status = 'failed', updated_at = ?
         WHERE deadline IS NOT NULL AND deadline <= ? AND status IN ${OPEN_TASK}`,
      )
      .run(now, now);
  }

  private performSend(actor: Agent, input: SendInput): SendResult {
    const recipient = this.directory.byId(input.recipient);
    if (!recipient) throw new MailboxError("unknown recipient; call list_agents");
    if (recipient.id === actor.id) throw new MailboxError("choose another agent; list_agents shows the peers");

    const messageId = input.message_id ?? randomUUID();
    assertId(messageId, "message_id");
    if (input.operation_id) assertId(input.operation_id, "operation_id");

    const existing = this.findDuplicate(actor.id, messageId, input.operation_id);
    if (existing) return { ok: true, duplicate: true, message: existing };

    const body = normalizeBody(input.body);
    const project = input.project === undefined ? null : cleanLine(input.project, "project", 200);
    if (project && (!allowsProject(actor, project) || !allowsProject(recipient, project))) {
      throw new MailboxError("project is outside the allowed projects for this sender or recipient");
    }
    const repo = input.repo === undefined ? null : cleanLine(input.repo, "repo", 200);
    const branch = input.branch === undefined ? null : cleanLine(input.branch, "branch", 200);
    const commit = input.commit === undefined ? null : input.commit.trim().toLowerCase();
    if (commit && !COMMIT_RE.test(commit)) throw new MailboxError("commit must be a hex SHA");

    const reply = input.reply_to ? this.requireReply(input.reply_to) : null;
    const taskEarly = input.task_id ? this.requireTask(input.task_id) : null;
    let conversationId = input.conversation_id;
    if (conversationId) assertId(conversationId, "conversation_id");
    if (!conversationId && reply) conversationId = reply.conversation_id;
    if (!conversationId && taskEarly) conversationId = taskEarly.conversation_id;
    if (!conversationId) conversationId = randomUUID();
    if (reply && reply.conversation_id !== conversationId) {
      throw new MailboxError("reply_to is in a different conversation");
    }
    if (taskEarly && taskEarly.conversation_id !== conversationId) {
      throw new MailboxError("task_id is in a different conversation");
    }

    const now = this.clock();
    const deadline = parseDeadline(input.deadline, now);
    let conversation = this.conversation(conversationId);
    if (conversation) {
      if (!this.isParticipant(conversationId, actor.id)) throw new MailboxError("conversation not found");
    } else {
      const maxTurns = Math.min(this.directory.maxTurns, Math.max(2, input.max_turns ?? this.directory.maxTurns));
      this.db
        .prepare(
          `INSERT INTO conversations (id, created_by, turn_count, max_turns, created_at, updated_at)
           VALUES (?, ?, 0, ?, ?, ?)`,
        )
        .run(conversationId, actor.id, maxTurns, now, now);
      conversation = this.conversation(conversationId);
    }
    if (!conversation) throw new MailboxError("conversation not found");
    if (conversation.turn_count >= conversation.max_turns && input.type !== "result") {
      throw new MailboxError(
        `conversation reached ${conversation.max_turns} turns; send a result to finish, or start a new conversation`,
      );
    }

    if (input.type === "question") this.assertNoCircularQuestion(actor.id, recipient.id);

    const task = this.applyTask(actor, recipient, input, conversationId, deadline, now);
    this.db
      .prepare(
        `INSERT INTO messages (
           id, conversation_id, reply_to, sender, recipient, type, deadline, body, task_id,
           project, repo, branch, commit_sha, operation_id, delivery, lease_owner, lease_until,
           not_before, attempt, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 0, 0, 0, ?, ?)`,
      )
      .run(
        messageId,
        conversationId,
        reply?.id ?? null,
        actor.id,
        recipient.id,
        input.type,
        deadline,
        JSON.stringify(body),
        task?.id ?? null,
        project,
        repo,
        branch,
        commit,
        input.operation_id ?? null,
        now,
        now,
      );
    this.db
      .prepare(`UPDATE conversations SET turn_count = turn_count + 1, updated_at = ? WHERE id = ?`)
      .run(now, conversationId);

    const message = this.loadMessage(messageId);
    if (!message) throw new MailboxError("internal error");
    return { ok: true, duplicate: false, message };
  }

  private applyTask(
    actor: Agent,
    recipient: Agent,
    input: SendInput,
    conversationId: string,
    deadline: number | null,
    now: number,
  ): TaskRow | null {
    if (input.type === "task") {
      if (input.task_id) {
        const task = this.requireTask(input.task_id);
        this.assertTaskOpen(task, now);
        if (task.requester !== actor.id || task.owner !== recipient.id) {
          throw new MailboxError("only the requester can send another task message, and only to the owner");
        }
        return task;
      }
      const open = this.db
        .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE requester = ? AND status IN ${OPEN_TASK}`)
        .get(actor.id) as { n: number };
      if (open.n >= this.directory.maxOpenTasks) {
        throw new MailboxError(`open task limit reached (${this.directory.maxOpenTasks})`);
      }
      const taskId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO tasks (id, conversation_id, owner, requester, status, deadline, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
        )
        .run(taskId, conversationId, recipient.id, actor.id, deadline, now, now);
      return this.requireTask(taskId);
    }

    if (input.type === "progress" || input.type === "result" || (input.type === "question" && input.task_id)) {
      if (!input.task_id) throw new MailboxError(`${input.type} requires task_id`);
      const task = this.requireTask(input.task_id);
      this.assertTaskOpen(task, now);
      if (task.conversation_id !== conversationId) throw new MailboxError("task_id is in a different conversation");
      if (input.type === "progress" || input.type === "result") {
        if (actor.id !== task.owner) throw new MailboxError("only the task owner can send progress or a result");
        if (recipient.id !== task.requester) {
          throw new MailboxError("progress and results go to the agent that requested the task");
        }
        const status: TaskStatus =
          input.type === "progress" ? "in_progress" : input.outcome === "failure" ? "failed" : "completed";
        this.db.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`).run(status, now, task.id);
        return this.requireTask(task.id);
      }
      if (actor.id !== task.owner && actor.id !== task.requester) {
        throw new MailboxError("you are not part of this task");
      }
      const other = actor.id === task.owner ? task.requester : task.owner;
      if (recipient.id !== other) throw new MailboxError("questions about a task go to the other party on that task");
      this.db.prepare(`UPDATE tasks SET status = 'waiting', updated_at = ? WHERE id = ?`).run(now, task.id);
      return this.requireTask(task.id);
    }

    if (input.type === "answer") {
      if (!input.reply_to) throw new MailboxError("answer requires reply_to");
      const reply = this.requireReply(input.reply_to);
      if (recipient.id !== reply.sender) {
        throw new MailboxError("answer must go to the sender of the message you are answering");
      }
      if (reply.task_id) {
        const task = this.requireTask(reply.task_id);
        if (task.status === "waiting") {
          this.db.prepare(`UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?`).run(now, task.id);
        }
        return this.requireTask(task.id);
      }
    }
    return input.task_id ? this.requireTask(input.task_id) : null;
  }

  private assertTaskOpen(task: TaskRow, now: number): void {
    if (task.status === "completed" || task.status === "failed") {
      throw new MailboxError(task.status === "failed" && task.deadline && task.deadline <= now
        ? "task deadline has passed"
        : "task is already finished");
    }
    if (task.deadline && task.deadline <= now) throw new MailboxError("task deadline has passed");
  }

  private assertNoCircularQuestion(sender: string, recipient: string): void {
    const waitingOnMe = this.outstandingQuestion(recipient, sender);
    if (waitingOnMe) {
      throw new MailboxError(
        `answer outstanding question ${waitingOnMe.id} in conversation ${waitingOnMe.conversation_id} before asking a new one`,
      );
    }
    const waitingOnThem = this.outstandingQuestion(sender, recipient);
    if (waitingOnThem) {
      throw new MailboxError(
        `question ${waitingOnThem.id} in conversation ${waitingOnThem.conversation_id} is still unanswered`,
      );
    }
  }

  private outstandingQuestion(sender: string, recipient: string): { id: string; conversation_id: string } | undefined {
    return this.db
      .prepare(
        `SELECT id, conversation_id FROM messages q
         WHERE q.sender = ? AND q.recipient = ? AND q.type = 'question'
           AND q.delivery NOT IN ('expired', 'dead')
           AND NOT EXISTS (SELECT 1 FROM messages later WHERE later.reply_to = q.id)
         ORDER BY q.created_at ASC
         LIMIT 1`,
      )
      .get(sender, recipient) as { id: string; conversation_id: string } | undefined;
  }

  private findDuplicate(sender: string, messageId: string, operationId: string | undefined): Envelope | undefined {
    const byId = this.messageBasics(messageId);
    if (byId) {
      if (byId.sender !== sender) throw new MailboxError("message_id belongs to another agent");
      const message = this.loadMessage(messageId);
      if (!message) throw new MailboxError("message not found");
      return message;
    }
    if (!operationId) return undefined;
    const byOperation = this.db
      .prepare(`SELECT id, sender FROM messages WHERE sender = ? AND operation_id = ?`)
      .get(sender, operationId) as { id: string; sender: string } | undefined;
    if (!byOperation) return undefined;
    const message = this.loadMessage(byOperation.id);
    if (!message) throw new MailboxError("message not found");
    return message;
  }

  private requireReply(messageId: string): MessageRow {
    assertId(messageId, "reply_to");
    const message = this.loadMessage(messageId);
    if (!message) throw new MailboxError("reply_to was not found");
    return this.mustRow(messageId);
  }

  private requireTask(taskId: string): TaskRow {
    assertId(taskId, "task_id");
    const task = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as TaskRow | undefined;
    if (!task) throw new MailboxError("unknown task_id");
    return task;
  }

  private conversation(id: string): ConversationRow | undefined {
    return this.db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as ConversationRow | undefined;
  }

  private isParticipant(conversationId: string, agentId: string): boolean {
    const conversation = this.conversation(conversationId);
    if (!conversation) return false;
    if (conversation.created_by === agentId) return true;
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM messages
         WHERE conversation_id = ? AND (sender = ? OR recipient = ?) LIMIT 1`,
      )
      .get(conversationId, agentId, agentId) as { ok: number } | undefined;
    return Boolean(row);
  }

  private messageBasics(id: string): { sender: string; recipient: string; delivery: DeliveryStatus; attempt: number } | undefined {
    return this.db
      .prepare(`SELECT sender, recipient, delivery, attempt FROM messages WHERE id = ?`)
      .get(id) as { sender: string; recipient: string; delivery: DeliveryStatus; attempt: number } | undefined;
  }

  private mustRow(id: string): MessageRow {
    const row = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS}
         FROM messages m LEFT JOIN tasks t ON t.id = m.task_id
         WHERE m.id = ?`,
      )
      .get(id) as MessageRow | undefined;
    if (!row) throw new MailboxError("message not found");
    return row;
  }

  private loadMessage(id: string): Envelope | undefined {
    const row = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS}
         FROM messages m LEFT JOIN tasks t ON t.id = m.task_id
         WHERE m.id = ?`,
      )
      .get(id) as MessageRow | undefined;
    return row ? this.toEnvelope(row) : undefined;
  }

  private toEnvelope(row: MessageRow): Envelope {
    return {
      message_id: row.id,
      conversation_id: row.conversation_id,
      reply_to: row.reply_to,
      sender: row.sender,
      recipient: row.recipient,
      type: row.type,
      deadline: iso(row.deadline),
      body: parseBody(row.body),
      task_id: row.task_id,
      task_status: row.task_status,
      project: row.project,
      repo: row.repo,
      branch: row.branch,
      commit: row.commit_sha,
      operation_id: row.operation_id,
      delivery: row.delivery,
      attempt: row.attempt,
      lease_until: row.delivery === "leased" ? iso(row.lease_until) : null,
      created_at: iso(row.created_at) ?? new Date(0).toISOString(),
    };
  }

  private toTask(row: TaskRow): TaskRecord {
    return {
      id: row.id,
      conversation_id: row.conversation_id,
      owner: row.owner,
      requester: row.requester,
      status: row.status,
      deadline: iso(row.deadline),
      created_at: iso(row.created_at) ?? new Date(0).toISOString(),
      updated_at: iso(row.updated_at) ?? new Date(0).toISOString(),
    };
  }

  private toConversation(row: ConversationRow): ConversationRecord {
    return {
      id: row.id,
      created_by: row.created_by,
      turn_count: row.turn_count,
      max_turns: row.max_turns,
      created_at: iso(row.created_at) ?? new Date(0).toISOString(),
      updated_at: iso(row.updated_at) ?? new Date(0).toISOString(),
    };
  }
}

const MESSAGE_COLUMNS = `
  m.id, m.conversation_id, m.reply_to, m.sender, m.recipient, m.type, m.deadline, m.body,
  m.task_id, m.project, m.repo, m.branch, m.commit_sha, m.operation_id, m.delivery,
  m.lease_until, m.attempt, m.created_at, t.status AS task_status
`;

function normalizeBody(body: string | MessageBody): MessageBody {
  if (typeof body === "string") return { text: requireText(body, "body") };
  return {
    text: requireText(body.text, "body.text"),
    evidence: optionalText(body.evidence, "evidence", 64_000),
    constraints: optionalText(body.constraints, "constraints", 8_000),
    expected: optionalText(body.expected, "expected", 8_000),
  };
}

function requireText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new MailboxError(`${label} is required`);
  if (text.length > 64_000) throw new MailboxError(`${label} is longer than 64000 characters`);
  return text;
}

function optionalText(value: string | undefined, label: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > max) throw new MailboxError(`${label} is longer than ${max} characters`);
  return text;
}

function parseDeadline(value: string | number | undefined, now: number): number | null {
  if (value === undefined) return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new MailboxError("deadline must be an ISO-8601 time or epoch milliseconds");
  if (ms <= now) throw new MailboxError("deadline is already in the past");
  if (ms > now + 30 * DAY_MS) throw new MailboxError("deadline cannot be more than 30 days out");
  return ms;
}

function isSqliteConstraint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String((error as { code: unknown }).code).startsWith("SQLITE_CONSTRAINT")
  );
}

function parseBody(raw: string): MessageBody {
  try {
    const parsed = JSON.parse(raw) as MessageBody;
    if (parsed && typeof parsed.text === "string") return parsed;
  } catch {
    // stored text was not JSON
  }
  return { text: raw };
}
