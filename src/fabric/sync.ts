import { fingerprint, type Identity, type PublicIdentity } from "../peer/identity.js";
import { openBytes, sealBytes } from "./box.js";
import type { HaveCursor, Journal, SignedEvent } from "./journal.js";

export async function syncOnce(journal: Journal, sender: Identity, remote: { endpoint: string; identity: PublicIdentity }, lookup: (id: string) => PublicIdentity | undefined): Promise<{ accepted: number; rejected: number; received: number }> {
  const peerId = fingerprint(remote.identity);
  const manifest = await postSync(sender, remote, { op: "manifest" });
  const have = Array.isArray(manifest.have) ? manifest.have as HaveCursor[] : [];
  const response = await postSync(sender, remote, { op: "push", have: journal.manifest(peerId), events: journal.eventsForPeer(peerId, have) });
  let accepted = 0;
  let rejected = 0;
  for (const event of (response.events as SignedEvent[] | undefined) ?? []) {
    const origin = event.origin === peerId ? remote.identity : lookup(event.origin);
    if (!origin) { rejected += 1; continue; }
    const result = journal.ingestRemote(event, remote.identity, origin);
    if (result.rejected) rejected += 1;
    else accepted += 1;
  }
  return { accepted, rejected, received: ((response.events as unknown[]) ?? []).length };
}

export async function syncWithBackoff(run: () => Promise<unknown>, attempts = 4): Promise<void> {
  let wait = 10;
  let error: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { await run(); return; }
    catch (caught) { error = caught; await new Promise((resolve) => setTimeout(resolve, wait)); wait *= 2; }
  }
  throw error instanceof Error ? error : new Error("Sync failed");
}

export function handleSync(journal: Journal, sender: Identity, body: Record<string, unknown>, packetSender: PublicIdentity, lookup: (id: string) => PublicIdentity | undefined): Record<string, unknown> {
  const peerId = fingerprint(packetSender);
  if (body.op === "manifest") return { have: journal.manifest(peerId) };
  if (body.op !== "push") throw new Error("Unknown sync operation");
  let accepted = 0;
  let rejected = 0;
  let duplicates = 0;
  for (const event of (body.events as SignedEvent[] | undefined) ?? []) {
    const origin = event.origin === peerId ? packetSender : lookup(event.origin);
    if (!origin) { rejected += 1; continue; }
    const result = journal.ingestRemote(event, packetSender, origin);
    if (result.rejected) rejected += 1;
    else if (result.duplicate) duplicates += 1;
    else accepted += 1;
  }
  const have = Array.isArray(body.have) ? body.have as HaveCursor[] : [];
  return { accepted, rejected, duplicates, events: journal.eventsForPeer(peerId, have) };
}

async function postSync(sender: Identity, remote: { endpoint: string; identity: PublicIdentity }, value: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(new URL("/fabric/sync", remote.endpoint), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sealBytes(sender, remote.identity, value)),
    signal: AbortSignal.timeout(5000), redirect: "error",
  });
  if (!response.ok) throw new Error(`Peer refused sync (HTTP ${response.status})`);
  const packet = await response.json() as unknown;
  return openBytes(sender, packet, (id) => id === fingerprint(remote.identity) ? remote.identity : undefined) as Record<string, unknown>;
}
