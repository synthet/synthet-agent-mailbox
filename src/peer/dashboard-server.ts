import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import Database from "better-sqlite3";
import express, { type Request } from "express";
import { dashboardHtml } from "../dashboard.js";
import { faviconIco, faviconSvg } from "../favicon.js";
import { isLoopback } from "../config.js";
import { fingerprint, validatePublic, type PublicIdentity } from "./identity.js";
import type { Contact } from "./store.js";
import type { PeerMessage } from "./wire.js";

export interface PeerDashboardOptions {
  home: string;
  port: number;
  bind: string;
}

export interface RunningPeerDashboard {
  url: string;
  port: number;
  close: () => Promise<void>;
}

function loadPublic(home: string): PublicIdentity {
  const raw = JSON.parse(readFileSync(join(home, "identity.json"), "utf8")) as Record<string, unknown>;
  return validatePublic({ name: raw.name, signing_key: raw.signing_key, encryption_key: raw.encryption_key });
}

/** Read the peer store without creating directories, so the dashboard never writes to it. */
function readArea<T>(home: string, area: string): T[] {
  let names: string[];
  try { names = readdirSync(join(home, area)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return names.filter((name) => name.endsWith(".json")).flatMap((name) => {
    try { return [JSON.parse(readFileSync(join(home, area, name), "utf8")) as T]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  });
}

function readAcked(home: string, id: string): boolean {
  const file = createHash("sha256").update(id).digest("hex") + ".json";
  try { readFileSync(join(home, "acked", file)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

interface JournalRead {
  agents: { id: string }[];
  messages: { created_at: number; sender: string; text: string; kind: string; thread_id: string }[];
  messageCount: number;
  tasks: Record<string, number>;
}

/**
 * Read journal.db without creating files next to it.
 * The journal runs in WAL mode, and even a read-only SQLite connection to a WAL database needs
 * the -shm file, so read a private copy of the database and its WAL instead.
 */
function readJournal(home: string): JournalRead | null {
  const path = join(home, "journal.db");
  if (!existsSync(path)) return null;
  const copyDir = mkdtempSync(join(tmpdir(), "agent-mail-journal-"));
  const copy = join(copyDir, "journal.db");
  copyFileSync(path, copy);
  if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`);
  let db: Database.Database;
  try { db = new Database(copy, { readonly: true, fileMustExist: true }); }
  catch (error) { rmSync(copyDir, { recursive: true, force: true }); throw error; }
  try {
    db.pragma("query_only = ON");
    const sessions = db.prepare(`SELECT a.alias AS alias, COALESCE(s.harness, '') AS harness
      FROM sessions s JOIN agents a ON a.agent_id = s.agent_id
      ORDER BY s.last_seen DESC`).all() as { alias: string; harness: string }[];
    const agents = sessions.length
      ? sessions.map((row) => ({ id: row.harness ? `${row.alias} · ${row.harness}` : row.alias }))
      : db.prepare("SELECT alias AS id FROM agents ORDER BY alias").all() as { id: string }[];
    const messages = db.prepare(`SELECT m.created_at, m.body AS text, m.audience_kind AS kind, m.thread_id,
        COALESCE(a.alias, m.sender_agent, substr(m.sender_host, 1, 12)) AS sender
      FROM messages m LEFT JOIN agents a ON a.agent_id = m.sender_agent
      WHERE m.deleted = 0 ORDER BY m.created_at DESC LIMIT 40`).all() as JournalRead["messages"];
    const messageCount = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE deleted = 0").get() as { n: number }).n;
    const tasks: Record<string, number> = {};
    for (const row of db.prepare("SELECT state, COUNT(*) AS n FROM tasks GROUP BY state").all() as { state: string; n: number }[]) {
      tasks[row.state] = row.n;
    }
    return { agents, messages, messageCount, tasks };
  } finally {
    db.close();
    rmSync(copyDir, { recursive: true, force: true });
  }
}

function snapshot(home: string) {
  const self = loadPublic(home);
  const selfFingerprint = fingerprint(self);
  const contacts = readArea<Contact>(home, "contacts");
  const names = new Map<string, string>([[selfFingerprint, self.name]]);
  for (const contact of contacts) names.set(fingerprint(contact.identity), contact.identity.name);
  const nameOf = (id: string) => names.get(id) ?? id.slice(0, 12);

  const inbox = readArea<PeerMessage>(home, "inbox").sort((a, b) => b.created_at - a.created_at);
  const sent = readArea<PeerMessage>(home, "sent").sort((a, b) => b.created_at - a.created_at);
  const outbox = readArea<PeerMessage>(home, "outbox").sort((a, b) => b.created_at - a.created_at);
  const unread = inbox.filter((message) => !readAcked(home, message.sender + ":" + message.id)).length;

  const recent = [...inbox.map((message) => ({ message, status: readAcked(home, message.sender + ":" + message.id) ? "acked" : "new", direction: "inbox" })),
    ...sent.map((message) => ({ message, status: "delivered", direction: "sent" }))]
    .sort((a, b) => b.message.created_at - a.message.created_at)
    .slice(0, 40);

  const log = [...inbox.map((message) => ({ message, direction: "from" })), ...sent.map((message) => ({ message, direction: "to" })), ...outbox.map((message) => ({ message, direction: "queued" }))]
    .sort((a, b) => a.message.created_at - b.message.created_at)
    .slice(-40)
    .map(({ message, direction }) => `${new Date(message.created_at).toISOString()} ${direction} ${nameOf(direction === "to" || direction === "queued" ? message.recipient : message.sender)} ${message.text}`)
    .join("\n");

  const view = {
    mode: "peer" as const,
    journal: false,
    generated_at: new Date().toISOString(),
    agent: { id: self.name },
    mailbox: { url: "peer", candidates: ["peer"], connected: true, fatal: null },
    wake: { mode: "off", client: "peer" },
    agents: { agents: [{ id: self.name }, ...contacts.map((contact) => ({ id: contact.identity.name }))] },
    agents_error: null,
    remote: { inbox: { unread, stored: inbox.length }, tasks: { delivered: sent.length } },
    remote_error: null,
    local: { pending: outbox.length },
    recent: recent.map(({ message, status, direction }) => ({
      status,
      message: {
        created_at: new Date(message.created_at).toISOString(),
        sender: direction === "sent" ? nameOf(message.recipient) : nameOf(message.sender),
        type: direction,
        body: { text: message.text },
        conversation_id: message.conversation_id,
      },
    })),
    outbox: outbox.slice(0, 40).map((message) => ({
      created_at: new Date(message.created_at).toISOString(),
      recipient: nameOf(message.recipient),
      type: "peer",
      status: "queued",
      attempts: 0,
      last_error: "",
    })),
    log,
  };
  const journal = readJournal(home);
  if (!journal) return view;
  const known = journal.agents.some((agent) => agent.id === self.name || agent.id.startsWith(`${self.name} ·`));
  const journalRecent = journal.messages.map((message) => ({
    status: "new",
    message: {
      created_at: new Date(message.created_at).toISOString(),
      sender: message.sender,
      type: message.kind,
      body: { text: message.text },
      conversation_id: message.thread_id,
    },
  }));
  return {
    ...view,
    journal: true,
    agents: { agents: known ? journal.agents : [{ id: self.name }, ...journal.agents] },
    remote: { inbox: { messages: journal.messageCount }, tasks: journal.tasks },
    recent: journalRecent,
    log: journal.messages.slice().reverse().map((message) => `${new Date(message.created_at).toISOString()} ${message.kind} ${message.sender} ${message.text}`).join("\n"),
  };
}

export async function startPeerDashboard(options: PeerDashboardOptions): Promise<RunningPeerDashboard> {
  if (!isLoopback(options.bind)) {
    throw new Error("The dashboard listens on loopback only.");
  }
  const app = express();
  app.disable("x-powered-by");
  app.get("/", (_req, res) => res.redirect("/dashboard"));
  app.get("/favicon.svg", (_req, res) => {
    res.set("Cache-Control", "public, max-age=86400").type("image/svg+xml").send(faviconSvg);
  });
  app.get("/favicon.ico", (_req, res) => {
    res.set("Cache-Control", "public, max-age=86400").type("image/x-icon").send(faviconIco());
  });

  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.bind, () => { server.off("error", reject); resolve(); });
  });
  const actualPort = (server.address() as { port: number }).port;
  function loopbackHost(req: Request): boolean {
    const host = (req.header("host") ?? "").toLowerCase();
    return host === `127.0.0.1:${actualPort}` || host === `localhost:${actualPort}` || host === `[::1]:${actualPort}`;
  }
  app.get("/dashboard", (req, res) => {
    if (!loopbackHost(req)) {
      res.status(403).type("text/plain").send("Forbidden host");
      return;
    }
    res
      .set("Cache-Control", "no-store")
      .set("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'")
      .set("X-Content-Type-Options", "nosniff")
      .type("html")
      .send(dashboardHtml);
  });
  app.get("/api/dashboard", (req, res) => {
    if (!loopbackHost(req)) {
      res.status(403).json({ error: "Forbidden host" });
      return;
    }
    try {
      res.set("Cache-Control", "no-store").json(snapshot(options.home));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.set("Cache-Control", "no-store").json({
        mode: "peer",
        generated_at: new Date().toISOString(),
        agent: { id: "peer" },
        mailbox: { url: "peer", candidates: ["peer"], connected: false, fatal: message },
        wake: { mode: "off", client: "peer" },
        agents: { agents: [] },
        agents_error: message,
        remote: null,
        remote_error: message,
        local: null,
        recent: [],
        outbox: [],
        log: message,
      });
    }
  });
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "peer-dashboard" });
  });

  return {
    url: `http://127.0.0.1:${actualPort}/dashboard`,
    port: actualPort,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
