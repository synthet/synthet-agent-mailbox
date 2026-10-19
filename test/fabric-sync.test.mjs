import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fingerprint, initIdentity, publicIdentity } from "../dist/peer/identity.js";
import { PeerStore } from "../dist/peer/store.js";
import { sealBytes } from "../dist/fabric/box.js";
import { Journal } from "../dist/fabric/journal.js";
import { startDaemon } from "../dist/fabric/daemon.js";
import { syncOnce, syncWithBackoff } from "../dist/fabric/sync.js";

async function daemon(t, name) {
  const dir = mkdtempSync(join(tmpdir(), "fabric-sync-"));
  const identity = initIdentity(dir, name);
  const running = await startDaemon(identity, dir, { bind: "127.0.0.1", discovery: false });
  t.after(async () => { await running.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, identity, running };
}

function lookup(identity, dir) {
  const store = new PeerStore(dir);
  return (id) => id === fingerprint(identity) ? publicIdentity(identity) : store.get("contacts", id)?.identity;
}

function trust(dir, identity) {
  new PeerStore(dir).trust(publicIdentity(identity), fingerprint(identity));
}

test("two hosts converge offline writes once, and a third host never receives an ungranted scope", async (t) => {
  const a = await daemon(t, "Alpha");
  const b = await daemon(t, "Beta");
  const c = await daemon(t, "Gamma");
  for (const [left, right] of [[a, b], [b, a], [b, c], [c, b]]) {
    trust(left.dir, right.identity);
    left.running.journal.grant(fingerprint(right.identity), "shared");
  }
  trust(c.dir, a.identity);
  a.running.journal.registerSession({ session_id: "a", alias: "Alpha" });
  b.running.journal.registerSession({ session_id: "b", alias: "Beta" });
  c.running.journal.registerSession({ session_id: "c", alias: "Gamma" });
  a.running.journal.subscribe("a", "shared");
  b.running.journal.subscribe("b", "shared");
  c.running.journal.subscribe("c", "shared");
  a.running.journal.subscribe("a", "secret");
  a.running.journal.publish({ session_id: "a", audience: { kind: "group", scope_id: "shared" }, body: "from-a", subject: "shared" });
  b.running.journal.publish({ session_id: "b", audience: { kind: "group", scope_id: "shared" }, body: "from-b", subject: "shared" });
  a.running.journal.publish({ session_id: "a", audience: { kind: "group", scope_id: "secret" }, body: "classified", subject: "secret" });
  await syncOnce(a.running.journal, a.identity, { endpoint: `http://127.0.0.1:${b.running.peerPort}`, identity: publicIdentity(b.identity) }, lookup(a.identity, a.dir));
  await syncOnce(b.running.journal, b.identity, { endpoint: `http://127.0.0.1:${c.running.peerPort}`, identity: publicIdentity(c.identity) }, lookup(b.identity, b.dir));
  assert.equal(b.running.journal.inbox("b").filter((message) => message.subject === "shared").length, 2);
  assert.equal(a.running.journal.inbox("a").some((message) => message.body === "from-b"), true);
  assert.equal(c.running.journal.inbox("c").some((message) => message.body === "from-a"), true);
  assert.equal(c.running.journal.inbox("c").some((message) => message.body === "classified"), false);
  assert.equal(b.running.journal.inbox("b").some((message) => message.body === "classified"), false);
  const before = b.running.journal.countMessages();
  await syncOnce(a.running.journal, a.identity, { endpoint: `http://127.0.0.1:${b.running.peerPort}`, identity: publicIdentity(b.identity) }, lookup(a.identity, a.dir));
  assert.equal(b.running.journal.countMessages(), before);
});

test("out-of-order events fill gaps without duplicates, and an unpinned peer is rejected", async (t) => {
  const a = await daemon(t, "Alpha");
  const b = await daemon(t, "Beta");
  trust(a.dir, b.identity);
  trust(b.dir, a.identity);
  a.running.journal.grant(fingerprint(b.identity), "shared");
  b.running.journal.grant(fingerprint(a.identity), "shared");
  a.running.journal.registerSession({ session_id: "a", alias: "Alpha" });
  a.running.journal.subscribe("a", "shared");
  a.running.journal.publish({ session_id: "a", audience: { kind: "group", scope_id: "shared" }, body: "one", subject: "one" });
  a.running.journal.publish({ session_id: "a", audience: { kind: "group", scope_id: "shared" }, body: "two", subject: "two" });
  const events = a.running.journal.eventsForPeer(fingerprint(b.identity), []);
  assert.equal(events.length, 2);
  const second = events.find((event) => event.seq === 2);
  const first = events.find((event) => event.seq === 1);
  b.running.journal.ingestRemote(second, publicIdentity(a.identity), publicIdentity(a.identity));
  assert.deepEqual(b.running.journal.missing(fingerprint(a.identity), "shared"), [1]);
  assert.equal(b.running.journal.contiguous(fingerprint(a.identity), "shared"), 0);
  b.running.journal.ingestRemote(first, publicIdentity(a.identity), publicIdentity(a.identity));
  b.running.journal.ingestRemote(second, publicIdentity(a.identity), publicIdentity(a.identity));
  assert.equal(b.running.journal.contiguous(fingerprint(a.identity), "shared"), 2);
  assert.equal(b.running.journal.countMessages(), 2);
  const strangerDir = mkdtempSync(join(tmpdir(), "fabric-stranger-"));
  t.after(() => rmSync(strangerDir, { recursive: true, force: true }));
  const stranger = initIdentity(strangerDir, "Stranger");
  const response = await fetch(`http://127.0.0.1:${a.running.peerPort}/fabric/sync`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(sealBytes(stranger, publicIdentity(a.identity), { op: "manifest" })),
  });
  assert.equal(response.status, 403);
  let attempts = 0;
  await syncWithBackoff(async () => { attempts += 1; if (attempts < 3) throw new Error("down"); }, 4);
  assert.equal(attempts, 3);
});

test("partitioned task claims stay pending until the home host certifies one", async (t) => {
  const a = await daemon(t, "Alpha");
  const b = await daemon(t, "Beta");
  const c = await daemon(t, "Gamma");
  a.running.journal.registerSession({ session_id: "a", alias: "Alpha" });
  b.running.journal.registerSession({ session_id: "b", alias: "Beta" });
  c.running.journal.registerSession({ session_id: "c", alias: "Gamma" });
  const scope = "work";
  for (const peer of [b, c]) {
    a.running.journal.grant(fingerprint(peer.identity), scope);
    peer.running.journal.grant(fingerprint(a.identity), scope);
    trust(peer.dir, a.identity);
  }
  a.running.journal.subscribe("a", scope);
  const offered = a.running.journal.offerTask("a", { scope_id: scope, title: "edit the file" });
  const offer = a.running.journal.eventsForPeer(fingerprint(b.identity), []).find((event) => event.type === "task.offered");
  b.running.journal.ingestRemote(offer, publicIdentity(a.identity), publicIdentity(a.identity));
  c.running.journal.ingestRemote(offer, publicIdentity(a.identity), publicIdentity(a.identity));
  assert.equal(b.running.journal.claimTask("b", offered.task_id).state, "pending");
  assert.equal(c.running.journal.claimTask("c", offered.task_id).state, "pending");
  const claims = [b, c].map((peer) => peer.running.journal.eventsForPeer(fingerprint(a.identity), []).find((event) => event.type === "task.claim"));
  for (const [peer, claim] of [[b, claims[0]], [c, claims[1]]]) {
    a.running.journal.grant(fingerprint(peer.identity), scope);
    a.running.journal.ingestRemote(claim, publicIdentity(peer.identity), publicIdentity(peer.identity));
  }
  const certified = a.running.journal.task(offered.task_id);
  assert.equal(certified.state, "accepted");
  assert.equal(certified.fencing > 0, true);
  const winner = certified.claim_agent;
  assert.equal([b.running.journal.registerSession({ session_id: "b" }).agent_id, c.running.journal.registerSession({ session_id: "c" }).agent_id].includes(winner), true);
  assert.notEqual(b.running.journal.task(offered.task_id).state, "accepted");
  assert.notEqual(c.running.journal.task(offered.task_id).state, "accepted");
});
