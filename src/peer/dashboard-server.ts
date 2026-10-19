import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
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
  /** Listen on 0.0.0.0 so Docker can publish the port. The host mapping stays on 127.0.0.1. */
  container?: boolean;
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

/** Read the peer store without creating directories, so a read-only mount stays read-only. */
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

  return {
    mode: "peer" as const,
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
}

export async function startPeerDashboard(options: PeerDashboardOptions): Promise<RunningPeerDashboard> {
  const containerBind = options.container === true && (options.bind === "0.0.0.0" || options.bind === "::");
  if (!isLoopback(options.bind) && !containerBind) {
    throw new Error("The dashboard listens on loopback only. In Docker, set DASHBOARD_CONTAINER=1 and DASHBOARD_BIND=0.0.0.0, and publish the host port on 127.0.0.1.");
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
