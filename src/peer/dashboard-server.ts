import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

  const peerLog = [...inbox.map((message) => ({ message, direction: "from" })), ...sent.map((message) => ({ message, direction: "to" })), ...outbox.map((message) => ({ message, direction: "queued" }))]
    .map(({ message, direction }) => ({
      at: message.created_at,
      line: `${new Date(message.created_at).toISOString()} peer ${direction} ${nameOf(direction === "to" || direction === "queued" ? message.recipient : message.sender)} ${message.text}`,
    }));
  const joinLog = (lines: { at: number; line: string }[]) => lines.sort((a, b) => a.at - b.at).slice(-40).map((entry) => entry.line).join("\n");
  const log = joinLog(peerLog);

  const view = {
    mode: "peer" as const,
    journal: false,
    generated_at: new Date().toISOString(),
    agent: { id: self.name },
    mailbox: { url: "peer", candidates: ["peer"], connected: true, fatal: null },
    wake: { mode: "off", client: "peer" },
    agents: { agents: [{ id: self.name, source: "peer" }, ...contacts.map((contact) => ({ id: contact.identity.name, source: "peer" }))] },
    agents_error: null,
    remote: { inbox: { unread, stored: inbox.length }, tasks: { delivered: sent.length } },
    remote_error: null,
    local: { pending: outbox.length },
    recent: recent.map(({ message, status, direction }) => ({
      status,
      source: "peer",
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
  // Merge the journal (same-PC mailbox) into the peer view instead of replacing it (#16), so a stale
  // journal.db can't hide peer mail. Every row says which store it came from.
  const journalRecent = journal.messages.map((message) => ({
    status: "new",
    source: "journal",
    message: {
      created_at: new Date(message.created_at).toISOString(),
      sender: message.sender,
      type: message.kind,
      body: { text: message.text },
      conversation_id: message.thread_id,
    },
  }));
  const seenAgents = new Set(view.agents.agents.map((agent) => agent.id));
  const journalAgents = journal.agents.filter((agent) => !seenAgents.has(agent.id)).map((agent) => ({ id: agent.id, source: "journal" }));
  return {
    ...view,
    journal: true,
    agents: { agents: [...view.agents.agents, ...journalAgents] },
    remote: { ...view.remote, journal: { messages: journal.messageCount, tasks: journal.tasks } },
    recent: [...view.recent, ...journalRecent]
      .sort((a, b) => Date.parse(b.message.created_at) - Date.parse(a.message.created_at))
      .slice(0, 40),
    log: joinLog([...peerLog, ...journal.messages.map((message) => ({
      at: message.created_at,
      line: `${new Date(message.created_at).toISOString()} journal ${message.kind} ${message.sender} ${message.text}`,
    }))]),
  };
}

export interface BuildInfo {
  /** package.json version of the running build. */
  app: string;
  /** Short commit of the checkout when the server started, or null outside a git checkout. */
  commit: string | null;
  /** When this module was compiled (mtime of the running file), or null if unknown. */
  built: string | null;
}

function readCommit(root: string): string | null {
  try {
    let gitDir = join(root, ".git");
    if (statSync(gitDir).isFile()) {
      const pointer = readFileSync(gitDir, "utf8").trim().replace(/^gitdir:\s*/, "");
      gitDir = pointer.match(/^([A-Za-z]:|\/)/) ? pointer : join(root, pointer);
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    let sha = head;
    if (head.startsWith("ref: ")) {
      const ref = head.slice(5);
      const common = existsSync(join(gitDir, "commondir"))
        ? join(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()) : gitDir;
      const loose = [join(gitDir, ref), join(common, ref)].find((file) => existsSync(file));
      if (loose) sha = readFileSync(loose, "utf8").trim();
      else {
        const packed = existsSync(join(common, "packed-refs")) ? readFileSync(join(common, "packed-refs"), "utf8") : "";
        sha = packed.split(/\r?\n/).find((line) => line.endsWith(` ${ref}`))?.split(" ")[0] ?? "";
      }
    }
    return /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : null;
  } catch {
    return null;
  }
}

/** Version of the running dashboard build, read once at startup without spawning git. */
export function buildInfo(): BuildInfo {
  const self = fileURLToPath(import.meta.url);
  const root = join(dirname(self), "..", "..");
  let app = "unknown";
  try { app = String((JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "unknown"); }
  catch { /* keep "unknown" */ }
  let built: string | null = null;
  try { built = statSync(self).mtime.toISOString(); } catch { /* unknown */ }
  return { app, commit: readCommit(root), built };
}

export async function startPeerDashboard(options: PeerDashboardOptions): Promise<RunningPeerDashboard> {
  if (!isLoopback(options.bind)) {
    throw new Error("The dashboard listens on loopback only.");
  }
  const version = buildInfo();
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
      res.set("Cache-Control", "no-store").json({ ...snapshot(options.home), version });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.set("Cache-Control", "no-store").json({
        mode: "peer",
        version,
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
