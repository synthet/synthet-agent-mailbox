import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createSocket, type Socket } from "node:dgram";
import { isIP } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { fingerprint, publicIdentity, publicIdentitySchema, signed, verified, type Identity, type PublicIdentity } from "./identity.js";

export const DISCOVERY_PORT = 47831;
export const DISCOVERY_GROUP = "239.255.77.31";
export interface DiscoveredPeer { identity: PublicIdentity; fingerprint: string; endpoint: string }
export interface DiscoveryOptions { port?: number; group?: string; interface?: string; timeoutMs?: number; tailscale?: boolean; peerPort?: number }
const querySchema = z.object({ protocol: z.literal("agent-mail/1 discover"), nonce: z.string().uuid() }).strict();
const advertSchema = z.object({ protocol: z.literal("agent-mail/1 advert"), nonce: z.string().uuid(), identity: publicIdentitySchema, port: z.number().int().min(1).max(65535) }).strict();

export function parseAdvert(data: Buffer, address: string, nonce: string): DiscoveredPeer {
  if (data.length > 4096 || !isIP(address)) throw new Error("Invalid discovery packet");
  const packet = z.object({ payload: z.string().max(3000), signature: z.string().max(128) }).strict().parse(JSON.parse(data.toString()));
  const advert = advertSchema.parse(JSON.parse(packet.payload));
  if (advert.nonce !== nonce || !verified(advert.identity, packet.payload, packet.signature)) throw new Error("Invalid discovery signature or nonce");
  return { identity: advert.identity, fingerprint: fingerprint(advert.identity), endpoint: `http://${isIP(address) === 6 ? `[${address}]` : address}:${advert.port}` };
}

export function advertisement(identity: Identity, port: number, nonce: string): { payload: string; signature: string } {
  const payload = JSON.stringify(advertSchema.parse({ protocol: "agent-mail/1 advert", nonce, identity: publicIdentity(identity), port }));
  return { payload, signature: signed(identity, payload) };
}

export async function advertise(identity: Identity, tcpPort: number, options: DiscoveryOptions = {}): Promise<() => Promise<void>> {
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  await bind(socket, options.port ?? DISCOVERY_PORT, "0.0.0.0");
  try {
    socket.setMulticastLoopback(true);
    socket.addMembership(options.group ?? DISCOVERY_GROUP, options.interface);
  } catch (error) { socket.close(); throw error; }
  // A bounded reply budget prevents multicast traffic from becoming an amplification service.
  let window = Date.now();
  let replies = 0;
  socket.on("message", (data, remote) => {
    if (data.length > 256) return;
    if (Date.now() - window > 1000) { window = Date.now(); replies = 0; }
    if (replies >= 20) return;
    try {
      const query = querySchema.parse(JSON.parse(data.toString()));
      replies++;
      socket.send(JSON.stringify(advertisement(identity, tcpPort, query.nonce)), remote.port, remote.address, () => {});
    } catch { /* Ignore unrelated or malformed LAN traffic. */ }
  });
  socket.on("error", (error) => console.error(`Discovery: ${error.message}`));
  return () => closeSocket(socket);
}

export async function discover(options: DiscoveryOptions = {}): Promise<DiscoveredPeer[]> {
  const timeout = options.timeoutMs ?? 1200;
  if (!Number.isFinite(timeout) || timeout < 50 || timeout > 30_000) throw new Error("Discovery timeout must be 50–30000ms");
  const socket = createSocket("udp4");
  await bind(socket, 0, "0.0.0.0");
  const nonce = randomUUID();
  const peers = new Map<string, DiscoveredPeer>();
  try {
    socket.setMulticastLoopback(true);
    socket.setMulticastTTL(1);
    if (options.interface) socket.setMulticastInterface(options.interface);
    return await new Promise<DiscoveredPeer[]>((resolve, reject) => {
      const timer = setTimeout(() => resolve([...peers.values()]), timeout);
      socket.on("error", (error) => { clearTimeout(timer); reject(error); });
      socket.on("message", (data, remote) => {
        try { const peer = parseAdvert(data, remote.address, nonce); peers.set(peer.fingerprint, peer); }
        catch { /* Discovery data is untrusted until signature and nonce verification. */ }
      });
      const query = JSON.stringify({ protocol: "agent-mail/1 discover", nonce });
      socket.send(query, options.port ?? DISCOVERY_PORT, options.group ?? DISCOVERY_GROUP, (error) => {
        if (error) { clearTimeout(timer); reject(error); }
      });
    });
  } finally { await closeSocket(socket); }
}

function bind(socket: Socket, port: number, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { socket.close(); reject(error); };
    socket.once("error", onError);
    socket.bind(port, address, () => { socket.off("error", onError); resolve(); });
  });
}
function closeSocket(socket: Socket): Promise<void> { return new Promise((resolve) => socket.close(() => resolve())); }

/** Only addresses reported by the local Tailscale CLI are probed; no subnet sweep or central mailbox. */
export function tailscaleAddresses(status: unknown): string[] {
  const parsed = z.object({ Peer: z.record(z.object({ Online: z.boolean().optional(), TailscaleIPs: z.array(z.string()).optional() })).optional() }).parse(status);
  return [...new Set(Object.values(parsed.Peer ?? {}).filter((p) => p.Online !== false).flatMap((p) => p.TailscaleIPs ?? []).filter((ip) => isIP(ip)))].slice(0, 256);
}

export async function probeIdentity(address: string, port: number, timeoutMs = 1200): Promise<DiscoveredPeer> {
  if (!isIP(address)) throw new Error("Identity probe requires an IP address");
  const nonce = randomUUID();
  const host = isIP(address) === 6 ? `[${address}]` : address;
  const response = await fetch(`http://${host}:${port}/identity?nonce=${nonce}`, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Identity probe failed: HTTP ${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty identity response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 4096) throw new Error("Oversized identity response");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  return parseAdvert(Buffer.concat(chunks), address, nonce);
}

export async function discoverTailscale(options: DiscoveryOptions = {}): Promise<DiscoveredPeer[]> {
  if (options.tailscale === false) return [];
  const execute = promisify(execFile);
  const executable = process.platform === "win32" ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Tailscale", "tailscale.exe") : "tailscale";
  let addresses: string[];
  try {
    const { stdout } = await execute(executable, ["status", "--json"], { timeout: 2000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    addresses = tailscaleAddresses(JSON.parse(stdout));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Tailscale status unavailable; check that Tailscale is running and signed in");
  }
  const peers: DiscoveredPeer[] = [];
  // Bound concurrency and total probe time, even in a large tailnet.
  const deadline = Date.now() + 4000;
  await Promise.all(Array.from({ length: Math.min(16, addresses.length) }, async () => {
    while (addresses.length && Date.now() < deadline) {
      const address = addresses.shift()!;
      try { peers.push(await probeIdentity(address, options.peerPort ?? 47832, options.timeoutMs ?? 1200)); }
      catch { /* An online Tailscale device need not run agent-mail. */ }
    }
  }));
  return peers;
}
