import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { z } from "zod";
import { advertisement, advertise, discover, discoverTailscale, type DiscoveryOptions } from "./discovery.js";
import { fingerprint, publicIdentity, type Identity } from "./identity.js";
import { PeerStore, validateEndpoint, type Contact } from "./store.js";
import { messageSchema, receipt, seal, unseal, verifyReceipt, type PeerMessage } from "./wire.js";

export const peerSendShape = {
  recipient: z.string().min(1).describe("Trusted name or full public-key fingerprint"),
  text: z.string().min(1).max(64 * 1024),
  message_id: z.string().uuid().optional().describe("Reuse on retry to avoid duplicate delivery"),
  conversation_id: z.string().uuid().optional(),
};
export type SendOptions = z.infer<z.ZodObject<typeof peerSendShape>>;

/** A same-PC advertiser is reached through its LAN address. Try loopback first so a listener on 127.0.0.1 still receives. */
function preferLocalLoopback(endpoints: string[]): string[] {
  const local = new Set(["127.0.0.1"]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === "IPv4") local.add(entry.address);
  }
  const ordered: string[] = [];
  for (const endpoint of endpoints) {
    try {
      const url = new URL(endpoint);
      if (url.port && local.has(url.hostname)) ordered.push(`http://127.0.0.1:${url.port}`);
    } catch { /* Delivery validates each endpoint before using it. */ }
    ordered.push(endpoint);
  }
  return [...new Set(ordered)];
}

export class Peer {
  readonly store: PeerStore;
  constructor(readonly identity: Identity, dir: string, readonly discoveryOptions: DiscoveryOptions = {}) { this.store = new PeerStore(dir); }
  whoami() { return { ...publicIdentity(this.identity), fingerprint: fingerprint(this.identity) }; }
  async discover() {
    const results = await Promise.allSettled([discover(this.discoveryOptions), discoverTailscale(this.discoveryOptions)]);
    const peers = new Map<string, Awaited<ReturnType<typeof discover>>[number]>();
    for (const result of results) {
      if (result.status === "rejected") { console.error(`Discovery: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`); continue; }
      for (const peer of result.value) if (peer.fingerprint !== fingerprint(this.identity)) peers.set(peer.fingerprint + "@" + peer.endpoint, peer);
    }
    return [...peers.values()].map((p) => ({ ...p, trusted: !!this.store.get<Contact>("contacts", p.fingerprint) }));
  }
  async send(input: SendOptions) {
    const args = z.object(peerSendShape).strict().parse(input);
    const contact = this.store.contact(args.recipient);
    const id = args.message_id ?? randomUUID();
    const existing = this.store.get<PeerMessage>("sent", id) ?? this.store.get<PeerMessage>("outbox", id);
    if (existing && (existing.text !== args.text || existing.recipient !== fingerprint(contact.identity) || (args.conversation_id && existing.conversation_id !== args.conversation_id))) throw new Error("Message id already used with different content");
    let message: PeerMessage = existing ?? {
      id, conversation_id: args.conversation_id ?? randomUUID(), sender: fingerprint(this.identity),
      recipient: fingerprint(contact.identity), text: args.text, created_at: Date.now(),
    };
    message = messageSchema.parse(message);
    if (this.store.get("sent", id)) return { status: "delivered", message_id: id, conversation_id: message.conversation_id };
    this.store.put("outbox", id, message, true);
    message = this.store.get<PeerMessage>("outbox", id)!;
    if (message.text !== args.text || message.recipient !== fingerprint(contact.identity) || (args.conversation_id && message.conversation_id !== args.conversation_id)) throw new Error("Concurrent message id conflict");
    return this.deliver(message);
  }
  private async deliver(message: PeerMessage) {
    try {
      const contact = this.store.contact(message.recipient);
      let endpoints: string[] = [];
      try { endpoints = (await this.discover()).filter((p) => p.fingerprint === message.recipient).map((p) => p.endpoint); }
      catch { /* Explicit endpoints work even when multicast is unavailable. */ }
      if (contact.endpoint && !endpoints.includes(contact.endpoint)) endpoints.push(contact.endpoint);
      endpoints = preferLocalLoopback(endpoints);
      if (!endpoints.length) throw new Error("Peer offline or undiscoverable; message remains queued");
      let failure: unknown;
      for (const endpoint of endpoints) {
        try {
          const response = await fetch(new URL("/message", validateEndpoint(endpoint)), {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(seal(this.identity, contact.identity, message)),
            signal: AbortSignal.timeout(5000), redirect: "error",
          });
          if (!response.ok) { await response.body?.cancel(); throw new Error(`Peer refused message (HTTP ${response.status})`); }
          // Receipts contain only a digest, never plaintext message content.
          const reader = response.body?.getReader();
          if (!reader) throw new Error("Missing receipt");
          let bytes = 0;
          const chunks: Uint8Array[] = [];
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.length;
              if (bytes > 4096) throw new Error("Oversized receipt");
              chunks.push(chunk.value);
            }
          } finally { await reader.cancel(); }
          verifyReceipt(contact.identity, JSON.parse(Buffer.concat(chunks).toString()), message);
          this.store.put("sent", message.id, message, true);
          this.store.remove("outbox", message.id);
          return { status: "delivered", message_id: message.id, conversation_id: message.conversation_id };
        } catch (error) { failure = error; }
      }
      throw failure;
    } catch (error) {
      return { status: "queued", message_id: message.id, conversation_id: message.conversation_id, error: error instanceof Error ? error.message : String(error) };
    }
  }
  async flush() {
    const results = [];
    for (const message of this.store.list<PeerMessage>("outbox")) results.push(await this.deliver(messageSchema.parse(message)));
    return results;
  }
  inbox(limit = 50) {
    return this.store.list<PeerMessage>("inbox").filter((m) => !this.store.get("acked", m.sender + ":" + m.id)).sort((a, b) => a.created_at - b.created_at).slice(0, limit);
  }
  acknowledge(sender: string, id: string) {
    const key = sender + ":" + id;
    if (!this.store.get("inbox", key)) throw new Error("Unknown inbox message");
    this.store.put("acked", key, { sender, id });
    return { acknowledged: true };
  }
  thread(id: string) {
    return [...this.store.list<PeerMessage>("inbox"), ...this.store.list<PeerMessage>("sent"), ...this.store.list<PeerMessage>("outbox")]
      .filter((m) => m.conversation_id === id).sort((a, b) => a.created_at - b.created_at);
  }
  status() { return { pending: this.store.list("outbox").length, unread: this.inbox(Number.MAX_SAFE_INTEGER).length, sent: this.store.list("sent").length }; }

  async listen(options: { port?: number; bind?: string; discovery?: boolean } = {}) {
    const server = createServer(async (req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/identity?")) {
        try {
          const url = new URL(req.url, "http://localhost");
          const nonce = z.string().uuid().parse(url.searchParams.get("nonce"));
          const port = (server.address() as { port: number }).port;
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(advertisement(this.identity, port, nonce)));
        } catch { res.writeHead(400).end(); }
        return;
      }
      if (req.method !== "POST" || req.url !== "/message") { res.writeHead(404).end(); return; }
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 220_000) { res.writeHead(413).end(); req.destroy(); return; }
          chunks.push(chunk);
        }
        const message = unseal(this.identity, JSON.parse(Buffer.concat(chunks).toString()), (id) => this.store.get<Contact>("contacts", id)?.identity);
        const key = message.sender + ":" + message.id;
        if (!this.store.put("inbox", key, message, true)) {
          if (JSON.stringify(this.store.get("inbox", key)) !== JSON.stringify(message)) { res.writeHead(409).end(); return; }
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(receipt(this.identity, message)));
      } catch { res.writeHead(400).end(JSON.stringify({ error: "Message rejected" })); }
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.timeout = 10_000;
    server.maxConnections = 64;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 47832, options.bind ?? "0.0.0.0", () => { server.off("error", reject); resolve(); });
    });
    const port = (server.address() as { port: number }).port;
    let stopDiscovery: (() => Promise<void>) | undefined;
    try { if (options.discovery !== false) stopDiscovery = await advertise(this.identity, port, this.discoveryOptions); }
    catch (error) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); throw error; }
    return {
      port,
      close: async () => {
        await stopDiscovery?.();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      },
    };
  }
}
