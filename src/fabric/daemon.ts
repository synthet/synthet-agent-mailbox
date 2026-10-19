import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fingerprint, publicIdentity, type Identity, type PublicIdentity } from "../peer/identity.js";
import { Peer } from "../peer/peer.js";
import type { Contact } from "../peer/store.js";
import { openBytes, sealBytes } from "./box.js";
import { Journal } from "./journal.js";
import { handleSync } from "./sync.js";
import { a2aCard, handleA2A } from "./a2a.js";

export interface DaemonOptions { port?: number; bind?: string; discovery?: boolean; a2a?: boolean }

export interface RunningDaemon {
  peerPort: number;
  controlPort: number;
  token: string;
  journal: Journal;
  close: () => Promise<void>;
}

export async function startDaemon(identity: Identity, home: string, options: DaemonOptions = {}): Promise<RunningDaemon> {
  const journal = new Journal(home, identity);
  journal.importJson();
  const peer = new Peer(identity, home, { tailscale: false, timeoutMs: 300 });
  const token = randomBytes(32).toString("hex");
  const lookup = (id: string): PublicIdentity | undefined => {
    if (id === fingerprint(identity)) return publicIdentity(identity);
    return peer.store.get<Contact>("contacts", id)?.identity;
  };
  const listener = await peer.listen({
    port: options.port ?? 0,
    bind: options.bind ?? "127.0.0.1",
    discovery: options.discovery ?? false,
    handle: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (options.a2a && req.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
        const port = listenerPort(req.socket);
        json(res, 200, a2aCard(`http://127.0.0.1:${port}`));
        return true;
      }
      if (options.a2a && req.method === "POST" && url.pathname === "/a2a") {
        json(res, 200, handleA2A(journal, await readJson(req)));
        return true;
      }
      if (req.method === "POST" && url.pathname === "/fabric/blobs") {
        await receiveBlob(journal, identity, lookup, req, res);
        return true;
      }
      if (req.method !== "POST" || url.pathname !== "/fabric/sync") return false;
      try {
        const packet = await readJson(req);
        const senderId = fingerprintOfPacket(packet);
        const sender = lookup(senderId);
        if (!sender) { json(res, 403, { error: "Unpinned peer" }); return true; }
        const body = openBytes(identity, packet, lookup) as Record<string, unknown>;
        json(res, 200, sealBytes(identity, sender, handleSync(journal, identity, body, sender, lookup)));
      } catch {
        if (!res.headersSent) json(res, 400, { error: "Sync rejected" });
      }
      return true;
    },
  });
  const control = createServer(async (req, res) => {
    if (!loopback(req) || req.headers.authorization !== `Bearer ${token}`) { json(res, 401, { error: "Unauthorized" }); return; }
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") { json(res, 200, { ok: true }); return; }
      if (req.method === "GET" && url.pathname === "/v1/inbox") { json(res, 200, journal.inbox(url.searchParams.get("session") ?? "cli")); return; }
      if (req.method === "GET" && url.pathname === "/v1/digest") { json(res, 200, journal.digest(url.searchParams.get("session") ?? "cli")); return; }
      const body = req.method === "POST" ? await readJson(req) as Record<string, unknown> : {};
      if (req.method === "POST" && url.pathname === "/v1/peer-send") {
        const result = await peer.send(body as Parameters<Peer["send"]>[0]);
        journal.importJson();
        json(res, 200, result);
        return;
      }
      json(res, 404, { error: "Not found" });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : "Bad request" });
    }
  });
  await listen(control, "127.0.0.1");
  const controlPort = (control.address() as { port: number }).port;
  writeFileSync(join(home, "daemon.json"), JSON.stringify({ peerPort: listener.port, controlPort, token }), { mode: 0o600 });
  return {
    peerPort: listener.port, controlPort, token, journal,
    close: async () => { await listener.close(); await closeServer(control); journal.close(); },
  };
}

async function receiveBlob(journal: Journal, identity: Identity, lookup: (id: string) => PublicIdentity | undefined, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = openBytes(identity, await readJson(req), lookup) as { sha256: string; offset: number; total: number; name: string; media_type: string; chunk: string; sender: string };
  const sender = lookup(body.sender);
  if (!sender) { json(res, 403, { error: "Unpinned peer" }); return; }
  const result = journal.writeBlobRange(body.sha256, body.offset, Buffer.from(body.chunk, "base64"), body.total, body.name, body.media_type);
  json(res, 200, sealBytes(identity, sender, result));
}

function fingerprintOfPacket(packet: unknown): string {
  const payload = JSON.parse((packet as { payload: string }).payload) as { identity: PublicIdentity };
  return fingerprint(payload.identity);
}

function listenerPort(socket: IncomingMessage["socket"]): number {
  const address = socket.localPort;
  return address ?? 0;
}

function loopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_200_000) throw new Error("Body too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function listen(server: ReturnType<typeof createServer>, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => { server.off("error", reject); resolve(); });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
