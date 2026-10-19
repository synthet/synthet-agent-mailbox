import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { fingerprint, signed, verified, type Identity, type PublicIdentity } from "../peer/identity.js";
import { PeerStore } from "../peer/store.js";
import { canonical } from "./canonical.js";

const MAX_BODY = 64 * 1024;
const MAX_BLOB = 4 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["text/plain", "text/markdown", "application/json", "application/yaml", "application/octet-stream"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SESSION_RE = /^[^\r\n]{1,200}$/;

export interface Actor { host_id: string; agent_id?: string; session_id?: string; harness?: string; model?: string }
export interface SignedEvent {
  schema_version: 1;
  event_id: string;
  origin: string;
  scope_id: string;
  seq: number;
  type: string;
  actor: Actor;
  payload: Record<string, unknown>;
  idempotency_key: string | null;
  created_at: number;
  signature: string;
}
export interface HaveCursor { origin: string; scope_id: string; contiguous: number }
export interface Audience {
  kind: "direct" | "group" | "broadcast" | "topic";
  agent_ids?: string[];
  scope_id?: string;
}

interface EventRow {
  origin: string;
  scope_id: string;
  seq: number;
  event_id: string;
  type: string;
  actor_json: string;
  payload_json: string;
  payload_hash: string;
  signature: string;
  idempotency_key: string | null;
  created_at: number;
}

/**
 * Local SQLite journal. Sequence numbers are per origin and per scope so a
 * scope that a peer is not allowed to see does not look like a missing event.
 */
export class Journal {
  readonly db: Database.Database;
  readonly hostId: string;
  private readonly rates = new Map<string, { start: number; count: number }>();

  constructor(readonly dir: string, readonly identity: Identity, private readonly clock: () => number = Date.now) {
    mkdirSync(join(dir, "blobs", "partial"), { recursive: true, mode: 0o700 });
    this.db = new Database(join(dir, "journal.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.hostId = fingerprint(identity);
    this.migrate();
    this.ensureAgent(this.hostId, identity.name);
  }

  close(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        origin TEXT NOT NULL, scope_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL, type TEXT NOT NULL, actor_json TEXT NOT NULL, payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL, signature TEXT NOT NULL, idempotency_key TEXT, created_at INTEGER NOT NULL,
        PRIMARY KEY (origin, event_id), UNIQUE (origin, scope_id, seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS events_idem ON events(origin, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS agents (agent_id TEXT PRIMARY KEY, alias TEXT NOT NULL, host_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS agents_alias ON agents(host_id, alias);
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, harness TEXT, model TEXT, last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scope_members (scope_id TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY (scope_id, agent_id));
      CREATE TABLE IF NOT EXISTS peer_grants (fingerprint TEXT NOT NULL, scope_id TEXT NOT NULL, PRIMARY KEY (fingerprint, scope_id));
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, thread_id TEXT NOT NULL, scope_id TEXT NOT NULL,
        sender_host TEXT NOT NULL, sender_agent TEXT, audience_kind TEXT NOT NULL, subject TEXT NOT NULL,
        tags_json TEXT NOT NULL, semantic TEXT NOT NULL, body TEXT NOT NULL, reply_to TEXT, correlation_id TEXT,
        created_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS message_audience (message_id TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY (message_id, agent_id));
      CREATE TABLE IF NOT EXISTS session_cursors (session_id TEXT NOT NULL, message_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (session_id, message_id));
      CREATE TABLE IF NOT EXISTS blobs (sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, media_type TEXT NOT NULL, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY, home_host TEXT NOT NULL, scope_id TEXT NOT NULL, title TEXT NOT NULL,
        state TEXT NOT NULL, claim_agent TEXT, fencing INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ${Date.now()});
    `);
  }

  registerSession(input: { session_id: string; alias?: string; harness?: string; model?: string }): { agent_id: string; session_id: string } {
    const sessionId = requiredId(input.session_id, SESSION_RE, "session_id");
    const alias = (input.alias?.trim() || this.identity.name).slice(0, 80);
    if (!alias) throw new Error("Agent alias is empty");
    const existingAlias = this.db.prepare("SELECT agent_id FROM agents WHERE host_id = ? AND alias = ?").get(this.hostId, alias) as { agent_id: string } | undefined;
    const agentId = existingAlias?.agent_id ?? (alias === this.identity.name ? this.hostId : randomUUID());
    this.ensureAgent(agentId, alias);
    const prior = this.db.prepare("SELECT agent_id FROM sessions WHERE session_id = ?").get(sessionId) as { agent_id: string } | undefined;
    if (prior && prior.agent_id !== agentId) throw new Error("Session is already registered to another agent");
    this.db.prepare(`INSERT INTO sessions (session_id, agent_id, harness, model, last_seen) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET last_seen = excluded.last_seen, harness = excluded.harness, model = excluded.model`)
      .run(sessionId, agentId, input.harness ?? null, input.model ?? null, this.clock());
    return { agent_id: agentId, session_id: sessionId };
  }

  subscribe(sessionId: string, scopeId: string): { scope_id: string; agent_id: string } {
    const session = this.mustSession(sessionId);
    const scope = requiredId(scopeId, ID_RE, "scope_id");
    this.db.prepare("INSERT OR IGNORE INTO scope_members (scope_id, agent_id) VALUES (?, ?)").run(scope, session.agent_id);
    return { scope_id: scope, agent_id: session.agent_id };
  }

  grant(peerFingerprint: string, scopeId: string): void {
    if (!/^[a-f0-9]{64}$/.test(peerFingerprint)) throw new Error("Grant requires a fingerprint");
    this.db.prepare("INSERT OR IGNORE INTO peer_grants (fingerprint, scope_id) VALUES (?, ?)").run(peerFingerprint, requiredId(scopeId, ID_RE, "scope_id"));
  }

  granted(peerFingerprint: string, scopeId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM peer_grants WHERE fingerprint = ? AND scope_id = ?").get(peerFingerprint, scopeId);
  }

  publish(input: {
    session_id: string;
    audience: Audience;
    body: string;
    subject?: string;
    tags?: string[];
    semantic?: string;
    thread_id?: string;
    reply_to?: string;
    correlation_id?: string;
    idempotency_key?: string;
    message_id?: string;
    attachments?: string[];
  }): { duplicate: boolean; message_id: string; thread_id: string; event_id: string } {
    this.rateLimit(input.session_id);
    const session = this.mustSession(input.session_id);
    const body = Buffer.from(input.body, "utf8");
    if (body.length < 1 || body.length > MAX_BODY) throw new Error("Body must be 1–65536 bytes");
    const audience = this.snapshot(input.audience, session.agent_id);
    const scopeId = input.audience.kind === "direct" ? `direct:${this.hostId}` : requiredId(input.audience.scope_id ?? "", ID_RE, "scope_id");
    const messageId = input.message_id ?? randomUUID();
    const stored = this.append({
      type: "message.published",
      scope_id: scopeId,
      actor: { host_id: this.hostId, agent_id: session.agent_id, session_id: session.session_id, harness: session.harness ?? undefined, model: session.model ?? undefined },
      payload: {
        message_id: messageId,
        thread_id: input.thread_id ?? messageId,
        audience_kind: input.audience.kind,
        audience,
        subject: (input.subject ?? input.semantic ?? "inform").slice(0, 200),
        tags: (input.tags ?? []).slice(0, 16).map((tag) => tag.slice(0, 40)),
        semantic: input.semantic ?? "inform",
        body: input.body,
        reply_to: input.reply_to ?? null,
        correlation_id: input.correlation_id ?? null,
        attachments: input.attachments ?? [],
      },
      idempotency_key: input.idempotency_key,
    });
    const payload = JSON.parse(stored.payload_json) as { message_id: string; thread_id: string };
    return { duplicate: stored.duplicate, message_id: payload.message_id, thread_id: payload.thread_id, event_id: stored.event_id };
  }

  inbox(sessionId: string, limit = 50): Record<string, unknown>[] {
    const session = this.mustSession(sessionId);
    return this.visible(session.agent_id, session.session_id, limit, true);
  }

  acknowledge(sessionId: string, messageId: string): { acknowledged: boolean; duplicate: boolean } {
    const session = this.mustSession(sessionId);
    const message = this.db.prepare("SELECT message_id, scope_id FROM messages WHERE message_id = ? AND deleted = 0").get(messageId) as { message_id: string; scope_id: string } | undefined;
    if (!message) throw new Error("Unknown message");
    if (!this.canSee(session.agent_id, messageId)) throw new Error("Message is outside this session's audience");
    const prior = this.db.prepare("SELECT state FROM session_cursors WHERE session_id = ? AND message_id = ?").get(sessionId, messageId) as { state: string } | undefined;
    const stored = this.append({
      type: "message.acknowledged",
      scope_id: message.scope_id,
      actor: { host_id: this.hostId, agent_id: session.agent_id, session_id: session.session_id },
      payload: { message_id: messageId, session_id: session.session_id },
      idempotency_key: `ack:${session.session_id}:${messageId}`,
    });
    return { acknowledged: true, duplicate: prior?.state === "acknowledged" || stored.duplicate };
  }

  thread(sessionId: string, threadId: string): Record<string, unknown>[] {
    const session = this.mustSession(sessionId);
    return (this.db.prepare(`SELECT message_id, thread_id, subject, semantic, body, sender_agent, sender_host, created_at, deleted
      FROM messages WHERE thread_id = ? ORDER BY created_at, message_id`).all(threadId) as Record<string, unknown>[])
      .filter((row) => row.deleted === 0 && this.canSee(session.agent_id, String(row.message_id)))
      .map((row) => this.publicMessage(row));
  }

  search(sessionId: string, query: string, limit = 20): Record<string, unknown>[] {
    const session = this.mustSession(sessionId);
    const needle = query.trim().slice(0, 80);
    if (!needle) throw new Error("Search query is empty");
    const like = `%${needle.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    return (this.db.prepare(`SELECT message_id, subject, semantic, sender_agent, created_at, deleted FROM messages
      WHERE deleted = 0 AND (subject LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\') ORDER BY created_at LIMIT 200`)
      .all(like, like) as Record<string, unknown>[])
      .filter((row) => this.canSee(session.agent_id, String(row.message_id)))
      .slice(0, limit)
      .map((row) => ({ message_id: row.message_id, subject: row.subject, semantic: row.semantic, sender_agent: row.sender_agent, created_at: row.created_at, untrusted: true }));
  }

  /** Bounded digest. The body is never included. */
  digest(sessionId: string, limit = 5): { ok: true; untrusted: true; messages: { message_id: string; subject: string; sender_agent: string | null }[] } {
    let rows: Record<string, unknown>[] = [];
    try { rows = this.inbox(sessionId, limit); }
    catch { rows = []; }
    return {
      ok: true,
      untrusted: true,
      messages: rows.map((row) => ({
        message_id: String(row.message_id),
        subject: String(row.subject).replace(/[\r\n]/g, " ").slice(0, 120),
        sender_agent: row.sender_agent == null ? null : String(row.sender_agent),
      })),
    };
  }

  importJson(): { imported: number; skipped: number } {
    const store = new PeerStore(this.dir);
    let imported = 0;
    let skipped = 0;
    for (const area of ["inbox", "sent", "outbox"]) {
      for (const value of store.list<Record<string, unknown>>(area)) {
        const id = typeof value.id === "string" ? value.id : "";
        const sender = typeof value.sender === "string" ? value.sender : "";
        const text = typeof value.text === "string" ? value.text : "";
        if (!id || !sender || !text || Buffer.byteLength(text) > MAX_BODY) { skipped += 1; continue; }
        const stored = this.append({
          type: "message.published",
          scope_id: `direct:${this.hostId}`,
          actor: { host_id: sender, agent_id: this.hostId, session_id: "import" },
          idempotency_key: `json:${area}:${sender}:${id}`,
          created_at: typeof value.created_at === "number" ? value.created_at : this.clock(),
          payload: {
            message_id: id,
            thread_id: typeof value.conversation_id === "string" ? value.conversation_id : id,
            audience_kind: "direct",
            audience: [this.hostId],
            subject: `imported ${area}`,
            tags: ["imported", area],
            semantic: "inform",
            body: text,
            reply_to: null,
            correlation_id: null,
            attachments: [],
          },
        });
        if (stored.duplicate) skipped += 1;
        else imported += 1;
      }
    }
    return { imported, skipped };
  }

  writeBlob(bytes: Buffer, name: string, mediaType: string): { sha256: string; size: number } {
    if (!ALLOWED_TYPES.has(mediaType)) throw new Error("Attachment type is not allowed");
    if (bytes.length > MAX_BLOB) throw new Error("Attachment exceeds 4 MiB");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = join(this.dir, "blobs", sha256);
    if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
    this.db.prepare("INSERT OR IGNORE INTO blobs (sha256, size, media_type, name) VALUES (?, ?, ?, ?)").run(sha256, bytes.length, mediaType, name.slice(0, 200));
    return { sha256, size: bytes.length };
  }

  readBlob(sha256: string): { bytes: Buffer; name: string; media_type: string } {
    const row = this.db.prepare("SELECT name, media_type FROM blobs WHERE sha256 = ?").get(sha256) as { name: string; media_type: string } | undefined;
    if (!row) throw new Error("Unknown attachment");
    const bytes = readFileSync(join(this.dir, "blobs", sha256));
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("Attachment hash mismatch");
    return { bytes, name: row.name, media_type: row.media_type };
  }

  writeBlobRange(sha256: string, offset: number, chunk: Buffer, total: number, name: string, mediaType: string): { complete: boolean; received: number; sha256?: string } {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Attachment id must be a sha256");
    if (!ALLOWED_TYPES.has(mediaType)) throw new Error("Attachment type is not allowed");
    if (total < 1 || total > MAX_BLOB || offset < 0 || chunk.length < 1 || offset + chunk.length > total) throw new Error("Attachment range is outside the declared size");
    const partial = join(this.dir, "blobs", "partial", sha256);
    const handle = openSync(partial, existsSync(partial) ? "r+" : "w");
    try { writeSync(handle, chunk, 0, chunk.length, offset); }
    finally { closeSync(handle); }
    const received = statSync(partial).size;
    if (received < total) return { complete: false, received };
    const data = readFileSync(partial);
    if (data.length !== total || createHash("sha256").update(data).digest("hex") !== sha256) {
      unlinkSync(partial);
      throw new Error("Attachment hash mismatch");
    }
    const stored = this.writeBlob(data, name, mediaType);
    unlinkSync(partial);
    return { complete: true, received: total, sha256: stored.sha256 };
  }

  repair(): { ok: boolean; missing: string[] } {
    const missing: string[] = [];
    const rows = this.db.prepare("SELECT sha256 FROM blobs").all() as { sha256: string }[];
    for (const row of rows) {
      const path = join(this.dir, "blobs", row.sha256);
      if (!existsSync(path) || createHash("sha256").update(readFileSync(path)).digest("hex") !== row.sha256) missing.push(row.sha256);
    }
    return { ok: missing.length === 0, missing };
  }

  offerTask(sessionId: string, input: { title: string; scope_id: string; task_id?: string }): { task_id: string; state: string } {
    const session = this.mustSession(sessionId);
    const scopeId = requiredId(input.scope_id, ID_RE, "scope_id");
    this.subscribe(sessionId, scopeId);
    const taskId = input.task_id ?? randomUUID();
    this.append({
      type: "task.offered",
      scope_id: scopeId,
      actor: { host_id: this.hostId, agent_id: session.agent_id, session_id: session.session_id },
      payload: { task_id: taskId, title: input.title.slice(0, 200), home_host: this.hostId },
      idempotency_key: `task-offer:${taskId}`,
    });
    return this.task(taskId);
  }

  claimTask(sessionId: string, taskId: string): { task_id: string; state: string; fencing: number } {
    const session = this.mustSession(sessionId);
    const task = this.mustTask(taskId);
    this.append({
      type: "task.claim",
      scope_id: task.scope_id,
      actor: { host_id: this.hostId, agent_id: session.agent_id, session_id: session.session_id },
      payload: { task_id: taskId, agent_id: session.agent_id },
      idempotency_key: `task-claim:${taskId}:${session.agent_id}`,
    });
    this.maybeCertify(taskId, session.agent_id);
    return this.task(taskId);
  }

  updateTask(sessionId: string, taskId: string, state: "working" | "completed" | "failed" | "cancelled", note = ""): { task_id: string; state: string } {
    const session = this.mustSession(sessionId);
    const task = this.mustTask(taskId);
    const home = task.home_host === this.hostId;
    const owner = task.claim_agent === session.agent_id;
    if (state === "cancelled" ? !home && !owner : !owner || task.state === "offered" || task.state === "pending") {
      throw new Error("Only the certified owner can update a task, and only the home host can cancel an uncertified one");
    }
    this.append({
      type: "task.updated",
      scope_id: task.scope_id,
      actor: { host_id: this.hostId, agent_id: session.agent_id, session_id: session.session_id },
      payload: { task_id: taskId, state, note: note.slice(0, 500) },
    });
    return this.task(taskId);
  }

  task(taskId: string): { task_id: string; state: string; fencing: number; home_host: string; claim_agent: string | null; title: string } {
    const row = this.mustTask(taskId);
    return { task_id: row.task_id, state: row.state, fencing: row.fencing, home_host: row.home_host, claim_agent: row.claim_agent, title: row.title };
  }

  listTasks(): { task_id: string; state: string; fencing: number; home_host: string; claim_agent: string | null; title: string }[] {
    return this.db.prepare("SELECT task_id, state, fencing, home_host, claim_agent, title FROM tasks ORDER BY updated_at").all() as { task_id: string; state: string; fencing: number; home_host: string; claim_agent: string | null; title: string }[];
  }

  contiguous(origin: string, scopeId: string): number {
    const rows = this.db.prepare("SELECT seq FROM events WHERE origin = ? AND scope_id = ? ORDER BY seq").all(origin, scopeId) as { seq: number }[];
    let expect = 1;
    for (const row of rows) {
      if (row.seq !== expect) break;
      expect += 1;
    }
    return expect - 1;
  }

  missing(origin: string, scopeId: string): number[] {
    const rows = this.db.prepare("SELECT seq FROM events WHERE origin = ? AND scope_id = ?").all(origin, scopeId) as { seq: number }[];
    const have = new Set(rows.map((row) => row.seq));
    const high = rows.reduce((max, row) => Math.max(max, row.seq), 0);
    const gaps: number[] = [];
    for (let seq = 1; seq <= high && gaps.length < 100; seq += 1) if (!have.has(seq)) gaps.push(seq);
    return gaps;
  }

  manifest(peerFingerprint: string): HaveCursor[] {
    const scopes = this.db.prepare("SELECT scope_id FROM peer_grants WHERE fingerprint = ?").all(peerFingerprint) as { scope_id: string }[];
    const result: HaveCursor[] = [];
    for (const scope of scopes) {
      const origins = this.db.prepare("SELECT DISTINCT origin FROM events WHERE scope_id = ?").all(scope.scope_id) as { origin: string }[];
      for (const origin of origins) result.push({ origin: origin.origin, scope_id: scope.scope_id, contiguous: this.contiguous(origin.origin, scope.scope_id) });
    }
    return result;
  }

  eventsForPeer(peerFingerprint: string, have: HaveCursor[]): SignedEvent[] {
    const scopes = this.db.prepare("SELECT scope_id FROM peer_grants WHERE fingerprint = ?").all(peerFingerprint) as { scope_id: string }[];
    const events: SignedEvent[] = [];
    for (const scope of scopes) {
      const origins = this.db.prepare("SELECT DISTINCT origin FROM events WHERE scope_id = ?").all(scope.scope_id) as { origin: string }[];
      for (const origin of origins) {
        const cursor = have.find((item) => item.origin === origin.origin && item.scope_id === scope.scope_id)?.contiguous ?? 0;
        const rows = this.db.prepare("SELECT * FROM events WHERE origin = ? AND scope_id = ? AND seq > ? ORDER BY seq LIMIT 32").all(origin.origin, scope.scope_id, cursor) as EventRow[];
        events.push(...rows.map((row) => this.toEvent(row)));
      }
    }
    return events.slice(0, 32);
  }

  ingestRemote(event: SignedEvent, packetSender: PublicIdentity, originIdentity: PublicIdentity): { duplicate: boolean; rejected?: string } {
    if (fingerprint(originIdentity) !== event.origin) return { duplicate: false, rejected: "origin key does not match" };
    if (!this.granted(fingerprint(packetSender), event.scope_id)) return { duplicate: false, rejected: "scope is not granted" };
    if (!verified(originIdentity, signable(event), event.signature)) return { duplicate: false, rejected: "bad signature" };
    const stored = this.db.transaction(() => this.insertRemote(event))();
    if (event.type === "task.claim" && !stored.duplicate) this.maybeCertify(String(event.payload.task_id), String(event.payload.agent_id));
    return { duplicate: stored.duplicate };
  }

  countMessages(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE deleted = 0").get() as { n: number }).n;
  }

  private append(input: { type: string; scope_id: string; actor: Actor; payload: Record<string, unknown>; idempotency_key?: string; created_at?: number }): EventRow & { duplicate: boolean } {
    return this.db.transaction(() => {
      if (input.idempotency_key) {
        const hit = this.db.prepare("SELECT * FROM events WHERE origin = ? AND idempotency_key = ?").get(this.hostId, input.idempotency_key) as EventRow | undefined;
        if (hit) return { ...hit, duplicate: true };
      }
      const seq = ((this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM events WHERE origin = ? AND scope_id = ?").get(this.hostId, input.scope_id) as { n: number }).n) + 1;
      const unsigned = {
        schema_version: 1 as const, event_id: randomUUID(), origin: this.hostId, scope_id: input.scope_id, seq, type: input.type,
        actor: input.actor, payload: input.payload, idempotency_key: input.idempotency_key ?? null, created_at: input.created_at ?? this.clock(),
      };
      const signature = signed(this.identity, signable(unsigned));
      const row = this.insert({ ...unsigned, signature });
      this.project(unsigned);
      return { ...row, duplicate: false };
    })();
  }

  private insertRemote(event: SignedEvent): EventRow & { duplicate: boolean } {
    const prior = this.db.prepare("SELECT * FROM events WHERE origin = ? AND event_id = ?").get(event.origin, event.event_id) as EventRow | undefined;
    const hash = createHash("sha256").update(signable(event)).digest("hex");
    if (prior) {
      if (prior.payload_hash !== hash) throw new Error("Conflicting event");
      return { ...prior, duplicate: true };
    }
    if (event.idempotency_key) {
      const keyed = this.db.prepare("SELECT event_id FROM events WHERE origin = ? AND idempotency_key = ?").get(event.origin, event.idempotency_key) as { event_id: string } | undefined;
      if (keyed && keyed.event_id !== event.event_id) throw new Error("Idempotency key reused");
      if (keyed) return { ...(this.db.prepare("SELECT * FROM events WHERE origin = ? AND event_id = ?").get(event.origin, event.event_id) as EventRow), duplicate: true };
    }
    const row = this.insert(event);
    this.project(event);
    return { ...row, duplicate: false };
  }

  private insert(event: Omit<SignedEvent, "signature"> & { signature: string }): EventRow {
    const payloadHash = createHash("sha256").update(signable(event)).digest("hex");
    this.db.prepare(`INSERT INTO events (origin, scope_id, seq, event_id, schema_version, type, actor_json, payload_json, payload_hash, signature, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      event.origin, event.scope_id, event.seq, event.event_id, event.schema_version, event.type, JSON.stringify(event.actor),
      JSON.stringify(event.payload), payloadHash, event.signature, event.idempotency_key, event.created_at,
    );
    return this.db.prepare("SELECT * FROM events WHERE origin = ? AND event_id = ?").get(event.origin, event.event_id) as EventRow;
  }

  private project(event: Omit<SignedEvent, "signature">): void {
    const payload = event.payload;
    if (event.type === "message.published") {
      this.db.prepare(`INSERT OR IGNORE INTO messages (message_id, event_id, thread_id, scope_id, sender_host, sender_agent, audience_kind, subject, tags_json, semantic, body, reply_to, correlation_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        payload.message_id, event.event_id, payload.thread_id, event.scope_id, event.actor.host_id, event.actor.agent_id ?? null,
        payload.audience_kind, payload.subject, JSON.stringify(payload.tags ?? []), payload.semantic, payload.body, payload.reply_to ?? null, payload.correlation_id ?? null, event.created_at,
      );
      for (const agentId of payload.audience as string[]) {
        this.db.prepare("INSERT OR IGNORE INTO message_audience (message_id, agent_id) VALUES (?, ?)").run(payload.message_id, agentId);
      }
      if (event.origin !== this.hostId) {
        const local = this.db.prepare("SELECT agent_id FROM scope_members WHERE scope_id = ?").all(event.scope_id) as { agent_id: string }[];
        for (const member of local) this.db.prepare("INSERT OR IGNORE INTO message_audience (message_id, agent_id) VALUES (?, ?)").run(payload.message_id, member.agent_id);
      }
    } else if (event.type === "message.acknowledged") {
      this.db.prepare("INSERT OR REPLACE INTO session_cursors (session_id, message_id, state) VALUES (?, ?, 'acknowledged')").run(payload.session_id, payload.message_id);
    } else if (event.type === "message.tombstone") {
      this.db.prepare("UPDATE messages SET deleted = 1 WHERE message_id = ?").run(payload.message_id);
    } else if (event.type === "task.offered") {
      this.db.prepare(`INSERT OR IGNORE INTO tasks (task_id, home_host, scope_id, title, state, fencing, updated_at) VALUES (?, ?, ?, ?, 'offered', 0, ?)`)
        .run(payload.task_id, payload.home_host, event.scope_id, payload.title, event.created_at);
    } else if (event.type === "task.claim") {
      this.db.prepare("UPDATE tasks SET state = 'pending', updated_at = ? WHERE task_id = ? AND state IN ('offered', 'pending')").run(event.created_at, payload.task_id);
    } else if (event.type === "task.certified") {
      const task = this.db.prepare("SELECT home_host, state, fencing FROM tasks WHERE task_id = ?").get(payload.task_id) as { home_host: string; state: string; fencing: number } | undefined;
      if (task && event.origin === task.home_host && (task.state !== "accepted" || Number(payload.fencing) > task.fencing)) {
        this.db.prepare("UPDATE tasks SET state = 'accepted', claim_agent = ?, fencing = ?, updated_at = ? WHERE task_id = ?")
          .run(payload.agent_id, payload.fencing, event.created_at, payload.task_id);
      }
    } else if (event.type === "task.updated") {
      this.db.prepare("UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ?").run(payload.state, event.created_at, payload.task_id);
    }
  }

  private maybeCertify(taskId: string, agentId: string): void {
    const task = this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as { home_host: string; state: string; scope_id: string; fencing: number } | undefined;
    if (!task || task.home_host !== this.hostId || task.state === "accepted") return;
    this.append({
      type: "task.certified",
      scope_id: task.scope_id,
      actor: { host_id: this.hostId, agent_id: agentId },
      payload: { task_id: taskId, agent_id: agentId, fencing: task.fencing + 1 },
      idempotency_key: `task-certified:${taskId}`,
    });
  }

  private snapshot(audience: Audience, senderAgent: string): string[] {
    if (audience.kind === "direct") {
      const ids = [...new Set(audience.agent_ids ?? [])];
      if (!ids.length) throw new Error("Direct audience needs an agent id");
      for (const id of ids) if (!this.db.prepare("SELECT 1 FROM agents WHERE agent_id = ?").get(id)) throw new Error("Unknown agent");
      return [...new Set([senderAgent, ...ids])];
    }
    const scopeId = requiredId(audience.scope_id ?? "", ID_RE, "scope_id");
    const members = (this.db.prepare("SELECT agent_id FROM scope_members WHERE scope_id = ?").all(scopeId) as { agent_id: string }[]).map((row) => row.agent_id);
    if (!members.includes(senderAgent)) throw new Error("Sender is not a member of that scope");
    return members;
  }

  private visible(agentId: string, sessionId: string, limit: number, unreadOnly: boolean): Record<string, unknown>[] {
    const rows = this.db.prepare(`SELECT m.message_id, m.thread_id, m.subject, m.semantic, m.body, m.sender_agent, m.sender_host, m.created_at
      FROM messages m JOIN message_audience a ON a.message_id = m.message_id
      WHERE m.deleted = 0 AND a.agent_id = ?
      AND (? = 0 OR NOT EXISTS (SELECT 1 FROM session_cursors c WHERE c.session_id = ? AND c.message_id = m.message_id AND c.state = 'acknowledged'))
      ORDER BY m.created_at, m.message_id LIMIT ?`).all(agentId, unreadOnly ? 1 : 0, sessionId, limit) as Record<string, unknown>[];
    return rows.map((row) => this.publicMessage(row));
  }

  private publicMessage(row: Record<string, unknown>): Record<string, unknown> {
    return { ...row, untrusted: true };
  }

  private canSee(agentId: string, messageId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM message_audience WHERE message_id = ? AND agent_id = ?").get(messageId, agentId);
  }

  private mustSession(sessionId: string): { session_id: string; agent_id: string; harness: string | null; model: string | null } {
    const row = this.db.prepare("SELECT session_id, agent_id, harness, model FROM sessions WHERE session_id = ?").get(sessionId) as { session_id: string; agent_id: string; harness: string | null; model: string | null } | undefined;
    if (!row) throw new Error("Unknown session; register it first");
    return row;
  }

  private mustTask(taskId: string): { task_id: string; home_host: string; scope_id: string; title: string; state: string; claim_agent: string | null; fencing: number } {
    const row = this.db.prepare("SELECT task_id, home_host, scope_id, title, state, claim_agent, fencing FROM tasks WHERE task_id = ?").get(taskId) as { task_id: string; home_host: string; scope_id: string; title: string; state: string; claim_agent: string | null; fencing: number } | undefined;
    if (!row) throw new Error("Unknown task");
    return row;
  }

  private ensureAgent(agentId: string, alias: string): void {
    this.db.prepare("INSERT OR IGNORE INTO agents (agent_id, alias, host_id, created_at) VALUES (?, ?, ?, ?)").run(agentId, alias, this.hostId, this.clock());
  }

  private rateLimit(sessionId: string): void {
    const now = this.clock();
    const slot = this.rates.get(sessionId);
    if (!slot || now - slot.start > 10_000) { this.rates.set(sessionId, { start: now, count: 1 }); return; }
    slot.count += 1;
    if (slot.count > 60) throw new Error("Publish rate exceeded");
  }

  private toEvent(row: EventRow): SignedEvent {
    return {
      schema_version: 1, event_id: row.event_id, origin: row.origin, scope_id: row.scope_id, seq: row.seq, type: row.type,
      actor: JSON.parse(row.actor_json) as Actor, payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      idempotency_key: row.idempotency_key, created_at: row.created_at, signature: row.signature,
    };
  }
}

function signable(event: Omit<SignedEvent, "signature">): string {
  return canonical({
    schema_version: event.schema_version, event_id: event.event_id, origin: event.origin, scope_id: event.scope_id,
    seq: event.seq, type: event.type, actor: event.actor, payload: event.payload, idempotency_key: event.idempotency_key, created_at: event.created_at,
  });
}

function requiredId(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
