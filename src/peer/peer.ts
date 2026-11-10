import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { z } from "zod";
import { advertisement, advertise, discover, discoverTailscale, type DiscoveryOptions } from "./discovery.js";
import { fingerprint, publicIdentity, type Identity } from "./identity.js";
import { agentProfile, localOrigin, type AgentDefaults, type AgentMeta } from "./metadata.js";
import { PeerStore, validateEndpoint, type Contact } from "./store.js";
import { ENVELOPE_VERSION, messageSchema, receipt, seal, signMessage, unseal, verifyReceipt, type PeerMessage } from "./wire.js";

export const peerSendShape = {
  recipient: z.string().min(1).describe("Trusted name or full public-key fingerprint"),
  text: z.string().min(1).max(64 * 1024),
  message_id: z.string().uuid().optional().describe("Reuse on retry to avoid duplicate delivery"),
  conversation_id: z.string().uuid().optional(),
  harness: z.string().min(1).max(80).optional().describe("Override the harness name configured on this MCP server."),
  agent_name: z.string().min(1).max(120).optional().describe("Override the agent name configured on this MCP server."),
  model: z.string().min(1).max(120).optional().describe("Override the model name configured on this MCP server."),
  session_id: z.string().min(1).max(200).optional().describe("Chat or agent session id, when this harness knows it."),
  // agent-mail/1.1 routing fields. Sent only when the recipient's /capabilities says it accepts them;
  // otherwise they are left out and the result says envelope_downgraded.
  to_session: z.string().trim().min(1).max(200).refine((value) => !/[\r\n]/.test(value), "to_session cannot contain line breaks").optional()
    .describe("Recipient session that should handle this message (agent-mail/1.1)."),
  hop: z.number().int().min(0).max(16).optional().describe("Reply depth in an automated exchange (agent-mail/1.1)."),
  auto_reply: z.boolean().optional().describe("True when no human wrote this message; receivers never auto-reply to it (agent-mail/1.1)."),
  in_reply_to: z.string().uuid().optional().describe("Message id this one answers (agent-mail/1.1)."),
};
const ROUTING_FIELDS = ["to_session", "hop", "auto_reply", "in_reply_to"] as const;
/** ADR 0003 loop guard: an automatic reply is refused once the exchange reaches this depth. */
export const MAX_AUTO_HOP = 6;
const MAX_HOP = 16;

export const peerReplyShape = {
  sender: z.string().regex(/^[a-f0-9]{64}$/).describe("Fingerprint of the peer that sent the message being answered"),
  message_id: z.string().uuid().describe("Id of the received message being answered"),
  text: z.string().min(1).max(64 * 1024),
  automatic: z.boolean().default(false)
    .describe("True when no human wrote or approved this reply. Sent as auto_reply, which receivers never answer automatically."),
  reply_id: z.string().uuid().optional().describe("Reuse on retry to avoid a duplicate reply"),
};
export type ReplyOptions = z.input<z.ZodObject<typeof peerReplyShape>>;
/** How long a definite /capabilities answer is reused before the next probe. */
const CAPABILITY_TTL_MS = 10 * 60_000;
export type SendOptions = z.infer<z.ZodObject<typeof peerSendShape>>;

async function readLimited(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > limit) throw new Error("Oversized response");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString();
}

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
  /** Per-contact /capabilities answers. Advisory only: never used for trust or for saving an endpoint. */
  private readonly capabilities = new Map<string, { at: number; accepts: boolean }>();
  constructor(readonly identity: Identity, dir: string, readonly discoveryOptions: DiscoveryOptions = {}, readonly agent: AgentDefaults = {}) { this.store = new PeerStore(dir); }
  whoami() {
    return { ...publicIdentity(this.identity), fingerprint: fingerprint(this.identity), origin: localOrigin(), agent: agentProfile(this.agent) ?? null };
  }
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
    if (existing && this.conflicts(existing, args, fingerprint(contact.identity))) throw new Error("Message id already used with different content");
    const agent = this.profileFor(args);
    // The fields are signed, so decide before signing. A retry reuses the stored message as it was signed.
    const routing = Object.fromEntries(ROUTING_FIELDS.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
    let endpoints: string[] | undefined;
    let downgraded = false;
    if (!existing && Object.keys(routing).length) {
      endpoints = await this.endpointsFor(contact);
      if (!await this.acceptsEnvelope(contact, endpoints)) downgraded = true;
    }
    const created = existing ?? signMessage(this.identity, {
      id, conversation_id: args.conversation_id ?? randomUUID(), sender: fingerprint(this.identity),
      recipient: fingerprint(contact.identity), text: args.text, created_at: Date.now(), origin: localOrigin(),
      ...(agent ? { agent } : {}), ...(downgraded ? {} : routing),
    });
    let message = messageSchema.parse(created);
    const candidate = message.signature;
    if (this.store.get("sent", id)) return { status: "delivered", message_id: id, conversation_id: message.conversation_id };
    this.store.put("outbox", id, message, true);
    message = this.store.get<PeerMessage>("outbox", id)!;
    if (this.conflicts(message, args, fingerprint(contact.identity)) || (!existing && message.signature !== candidate)) throw new Error("Concurrent message id conflict");
    const result = await this.deliver(message, endpoints);
    return downgraded ? { ...result, envelope_downgraded: true } : result;
  }
  /**
   * Whether this contact accepts the agent-mail/1.1 fields, from GET /capabilities. A missing, failed
   * or odd answer means no, and leaving the fields out is harmless. Only a definite answer is cached;
   * the cache is cleared when the contact's endpoint changes.
   */
  async acceptsEnvelope(contact: Contact, endpoints?: string[]): Promise<boolean> {
    const key = fingerprint(contact.identity);
    const cached = this.capabilities.get(key);
    if (cached && Date.now() - cached.at < CAPABILITY_TTL_MS) return cached.accepts;
    for (const endpoint of endpoints ?? await this.endpointsFor(contact)) {
      try {
        const response = await fetch(new URL("/capabilities", validateEndpoint(endpoint)), { signal: AbortSignal.timeout(1500), redirect: "error" });
        if (response.status === 404) { await response.body?.cancel(); this.capabilities.set(key, { at: Date.now(), accepts: false }); return false; }
        if (!response.ok) { await response.body?.cancel(); continue; }
        const text = await readLimited(response, 4096);
        const body = JSON.parse(text) as { envelope?: unknown };
        const accepts = Array.isArray(body?.envelope) && body.envelope.includes(ENVELOPE_VERSION);
        this.capabilities.set(key, { at: Date.now(), accepts });
        return accepts;
      } catch { /* try the next address; no answer at all means no */ }
    }
    return false;
  }
  /**
   * The saved endpoint first, then discovered ones. A peer with several addresses (LAN and Tailscale,
   * or two NICs) then keeps its saved address while it answers, instead of switching to whichever
   * address discovery lists first on each send.
   */
  private async endpointsFor(contact: Contact): Promise<string[]> {
    const recipient = fingerprint(contact.identity);
    let discovered: string[] = [];
    try { discovered = (await this.discover()).filter((p) => p.fingerprint === recipient).map((p) => p.endpoint); }
    catch { /* Explicit endpoints work even when multicast is unavailable. */ }
    return preferLocalLoopback([...(contact.endpoint ? [contact.endpoint] : []), ...discovered.filter((endpoint) => endpoint !== contact.endpoint)]);
  }
  private profileFor(args: SendOptions): AgentMeta | undefined {
    return agentProfile({
      harness: args.harness ?? this.agent.harness,
      name: args.agent_name ?? this.agent.name,
      model: args.model ?? this.agent.model,
      session_id: args.session_id ?? this.agent.session_id,
    });
  }
  private conflicts(existing: PeerMessage, args: SendOptions, recipient: string): boolean {
    if (existing.text !== args.text || existing.recipient !== recipient) return true;
    if (args.conversation_id && existing.conversation_id !== args.conversation_id) return true;
    const explicit: Array<[keyof AgentMeta, string | undefined]> = [
      ["harness", args.harness], ["name", args.agent_name], ["model", args.model], ["session_id", args.session_id],
    ];
    return explicit.some(([key, value]) => value !== undefined && existing.agent?.[key] !== value);
  }
  private async deliver(message: PeerMessage, known?: string[]) {
    try {
      const contact = this.store.contact(message.recipient);
      const endpoints = known?.length ? known : await this.endpointsFor(contact);
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
          const delivered = { status: "delivered", message_id: message.id, conversation_id: message.conversation_id };
          // The receipt is signed by the already-pinned key, so this address now verifiably reaches that
          // peer. Save it so later sends and retries work when discovery doesn't find the peer.
          if (endpoint !== contact.endpoint) {
            this.store.trust(contact.identity, fingerprint(contact.identity), endpoint);
            this.capabilities.delete(fingerprint(contact.identity));
            return { ...delivered, endpoint_changed: { from: contact.endpoint ?? null, to: endpoint } };
          }
          return delivered;
        } catch (error) { failure = error; }
      }
      throw failure;
    } catch (error) {
      return { status: "queued", message_id: message.id, conversation_id: message.conversation_id, error: error instanceof Error ? error.message : String(error) };
    }
  }
  /**
   * Answer a received message. The conversation, in_reply_to, hop and to_session (the sender's own
   * session) come from the stored message, never from the caller. Automatic replies are refused when
   * the message was itself automatic, when the exchange is MAX_AUTO_HOP deep, when this message already
   * has an automatic reply, or when the peer would not receive the auto_reply flag.
   */
  async reply(input: ReplyOptions) {
    const args = z.object(peerReplyShape).strict().parse(input);
    const original = this.store.get<PeerMessage>("inbox", args.sender + ":" + args.message_id);
    if (!original) throw new Error("Unknown inbox message");
    const hop = Math.min((original.hop ?? 0) + 1, MAX_HOP);
    if (args.automatic) {
      if (original.auto_reply) throw new Error("reply_refused: the message is itself an automatic reply");
      if ((original.hop ?? 0) >= MAX_AUTO_HOP) throw new Error(`reply_refused: hop limit ${MAX_AUTO_HOP} reached`);
      const answered = [...this.store.list<PeerMessage>("sent"), ...this.store.list<PeerMessage>("outbox")]
        .some((m) => m.in_reply_to === original.id && m.auto_reply === true && m.id !== args.reply_id);
      if (answered) throw new Error("reply_refused: this message already has an automatic reply");
      if (!await this.acceptsEnvelope(this.store.contact(original.sender))) {
        throw new Error("reply_refused: the peer does not accept agent-mail/1.1, so it would not see auto_reply");
      }
    }
    const result = await this.send({
      recipient: original.sender, text: args.text, conversation_id: original.conversation_id,
      message_id: args.reply_id, in_reply_to: original.id, hop,
      ...(args.automatic ? { auto_reply: true } : {}),
      ...(original.agent?.session_id ? { to_session: original.agent.session_id } : {}),
    });
    return { ...result, in_reply_to: original.id, hop, auto_reply: args.automatic };
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

  async listen(options: { port?: number; bind?: string; discovery?: boolean; handle?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean } = {}) {
    const server = createServer(async (req, res) => {
      if (options.handle) {
        try { if (await options.handle(req, res)) return; }
        catch { if (!res.headersSent) res.writeHead(400).end(); return; }
      }
      if (req.method === "GET" && req.url?.startsWith("/identity?")) {
        try {
          const url = new URL(req.url, "http://localhost");
          const nonce = z.string().uuid().parse(url.searchParams.get("nonce"));
          const port = (server.address() as { port: number }).port;
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(advertisement(this.identity, port, nonce)));
        } catch { res.writeHead(400).end(); }
        return;
      }
      if (req.method === "GET" && req.url === "/capabilities") {
        // Unsigned on purpose: a forged answer can only make a sender include fields this receiver
        // then rejects, which leaves the message queued. Older builds answer 404.
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ envelope: [ENVELOPE_VERSION] }));
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
