import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initIdentity, loadIdentity, publicIdentity, fingerprint, signed } from "../dist/peer/identity.js";
import { advertisement, advertise, discover, joinMulticast, multicastInterfaces, parseAdvert, probeIdentity, tailscaleAddresses } from "../dist/peer/discovery.js";
import { Peer } from "../dist/peer/peer.js";
import { PeerStore } from "../dist/peer/store.js";
import { createPeerMcp, journalLoadError } from "../dist/peer/mcp.js";
import { seal, unseal, receipt, verifyReceipt, signMessage, verifyMessage } from "../dist/peer/wire.js";

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "agent-mail-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = initIdentity(join(dir, "a"), "Desktop");
  const b = initIdentity(join(dir, "b"), "Zephyr");
  return { dir, a, b };
}
function message(a, b, text = "private message") {
  return signMessage(a, {
    id: randomUUID(), conversation_id: randomUUID(), sender: fingerprint(a), recipient: fingerprint(b), text, created_at: Date.now(),
    origin: { hostname: "desktop", platform: "test", arch: "x64", addresses: ["192.0.2.10"] },
    agent: { harness: "test", name: "Desktop", model: "fixture", session_id: "session-1" },
  });
}
// Let the OS pick the port: a random one can land in a range Windows reserves (bind EACCES).
async function freeUdpPort() {
  const socket = createSocket("udp4");
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.bind(0, "0.0.0.0", resolve); });
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
function pair(a, b, options = {}) {
  a.store.trust(publicIdentity(b.identity), fingerprint(b.identity), options.b);
  b.store.trust(publicIdentity(a.identity), fingerprint(a.identity), options.a);
}

test("identity persistence, explicit fingerprint trust, revocation and ambiguous aliases", (t) => {
  const { dir, a, b } = setup(t);
  assert.deepEqual(loadIdentity(join(dir, "a")), a);
  assert.throws(() => initIdentity(join(dir, "a"), "Overwrite"), /already exists/);
  const store = new PeerStore(join(dir, "a"));
  assert.throws(() => store.trust(publicIdentity(b), "0".repeat(64)), /mismatch/);
  store.trust(publicIdentity(b), fingerprint(b));
  assert.equal(store.contact("zephyr").identity.signing_key, b.signing_key);
  const impostor = initIdentity(join(dir, "impostor"), "Zephyr");
  store.trust(publicIdentity(impostor), fingerprint(impostor));
  assert.throws(() => store.contact("Zephyr"), /Ambiguous/);
  store.remove("contacts", fingerprint(impostor));
  assert.equal(store.contact("Zephyr").identity.signing_key, b.signing_key);
  assert.throws(() => store.trust(publicIdentity(b), fingerprint(b), "http://user:pass@localhost/path"));
});

test("encrypted wire authenticates both identities, rejects tampering and expiry; receipts disclose no text", (t) => {
  const { a, b } = setup(t);
  const m = message(a, b);
  const packet = seal(a, b, m);
  const trust = (id) => id === fingerprint(a) ? publicIdentity(a) : undefined;
  assert.ok(!JSON.stringify(packet).includes(m.text));
  assert.equal(verifyMessage(a, m), true);
  assert.equal(verifyMessage(b, m), false);
  assert.throws(() => seal(a, b, { ...m, text: "changed" }), /signature/);
  assert.throws(() => seal(a, b, { ...m, origin: { ...m.origin, hostname: "impostor" } }), /signature/);
  assert.deepEqual(unseal(b, packet, trust), m);
  assert.throws(() => unseal(b, packet, () => undefined), /Untrusted/);
  assert.throws(() => unseal(a, packet, trust), /recipient/);
  assert.throws(() => unseal(b, { ...packet, payload: packet.payload.replace("agent-mail/1", "agent-mail/2") }, trust));
  const old = { ...JSON.parse(packet.payload), timestamp: Date.now() - 600_000 };
  const payload = JSON.stringify(old);
  assert.throws(() => unseal(b, { payload, signature: signed(a, payload) }, trust), /expired/);
  const r = receipt(b, m);
  assert.ok(!JSON.stringify(r).includes(m.text));
  verifyReceipt(b, r, m);
  assert.throws(() => verifyReceipt(a, r, m), /Invalid/);
  assert.throws(() => verifyReceipt(b, r, { ...m, text: "changed" }), /Invalid/);
});

test("direct delivery, restart-safe inbox, idempotency, signed discovery probe, offline queue and retry", async (t) => {
  const { dir, a, b } = setup(t);
  const alice = new Peer(a, join(dir, "a"), { timeoutMs: 50, tailscale: false });
  const bob = new Peer(b, join(dir, "b"), { timeoutMs: 50, tailscale: false });
  let listener = await bob.listen({ port: 0, bind: "127.0.0.1", discovery: false });
  let active = true;
  t.after(async () => { if (active) await listener.close(); });
  pair(alice, bob, { b: `http://127.0.0.1:${listener.port}` });
  const discovered = await probeIdentity("127.0.0.1", listener.port);
  assert.equal(discovered.fingerprint, fingerprint(b));
  const id = randomUUID();
  const sent = await alice.send({ recipient: "Zephyr", text: "Hello 🔐\nsecond line", message_id: id });
  assert.equal(sent.status, "delivered");
  assert.equal(bob.inbox().length, 1);
  assert.equal((await alice.send({ recipient: "Zephyr", text: "Hello 🔐\nsecond line", message_id: id })).status, "delivered");
  assert.equal(bob.inbox().length, 1);
  await assert.rejects(() => alice.send({ recipient: "Zephyr", text: "changed", message_id: id }), /different/);
  const received = bob.inbox()[0];
  assert.equal(received.origin.hostname, hostname());
  assert.equal(verifyMessage(a, received), true);
  assert.equal(received.agent, undefined);
  // Simulate lost receipt: the recipient accepts an identical encrypted retry only once.
  const retry = await fetch(`http://127.0.0.1:${listener.port}/message`, { method: "POST", body: JSON.stringify(seal(a, b, received)) });
  assert.equal(retry.status, 200);
  await retry.text();
  assert.equal(bob.inbox().length, 1);
  const { signature: ignored, ...unsigned } = received;
  const conflict = await fetch(`http://127.0.0.1:${listener.port}/message`, { method: "POST", body: JSON.stringify(seal(a, b, signMessage(a, { ...unsigned, text: "conflict" }))) });
  assert.equal(conflict.status, 409);
  await conflict.text();
  const restarted = new Peer(loadIdentity(join(dir, "b")), join(dir, "b"));
  assert.equal(restarted.inbox()[0].text, received.text);
  restarted.acknowledge(received.sender, received.id);
  assert.equal(bob.inbox().length, 0);
  assert.equal(bob.thread(received.conversation_id).length, 1);
  await listener.close(); active = false;
  const queued = await alice.send({ recipient: "Zephyr", text: "offline" });
  assert.equal(queued.status, "queued");
  assert.equal(alice.status().pending, 1);
  listener = await bob.listen({ port: 0, bind: "127.0.0.1", discovery: false }); active = true;
  alice.store.trust(publicIdentity(b), fingerprint(b), `http://127.0.0.1:${listener.port}`);
  const restartedAlice = new Peer(loadIdentity(join(dir, "a")), join(dir, "a"), { timeoutMs: 50, tailscale: false });
  assert.equal((await restartedAlice.flush())[0].status, "delivered");
  assert.equal(alice.status().pending, 0);
  assert.equal(bob.inbox()[0].text, "offline");
  bob.store.remove("contacts", fingerprint(a));
  assert.equal((await alice.send({ recipient: "Zephyr", text: "revoked" })).status, "queued");
  assert.equal(bob.inbox().length, 1);
});

test("multicast uses every external IPv4 interface unless one is selected", () => {
  const interfaces = {
    Loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    WSL: [{ address: "198.51.100.1", family: "IPv4", internal: false }],
    Ethernet: [{ address: "fe80::1", family: "IPv6", internal: false }, { address: "192.0.2.10", family: "IPv4", internal: false }],
    WiFi: [{ address: "192.0.2.20", family: "IPv4", internal: false }],
  };
  assert.deepEqual(multicastInterfaces(undefined, interfaces), ["198.51.100.1", "192.0.2.10", "192.0.2.20"]);
  assert.deepEqual(multicastInterfaces("192.0.2.20", interfaces), ["192.0.2.20"]);
  assert.deepEqual(multicastInterfaces(undefined, {}), []);
});

test("joining multicast again is safe and one bad interface does not stop the others", async (t) => {
  const seen = [];
  const fake = { addMembership(group, address) {
    seen.push(address);
    if (address === "10.0.0.1") throw Object.assign(new Error("gone"), { code: "EADDRNOTAVAIL" });
  } };
  assert.equal(joinMulticast(fake, "239.255.77.32", ["10.0.0.1", "10.0.0.2", "10.0.0.3"]), 2);
  assert.deepEqual(seen, ["10.0.0.1", "10.0.0.2", "10.0.0.3"]);

  const socket = createSocket({ type: "udp4", reuseAddr: true });
  t.after(() => socket.close());
  await new Promise((resolve) => socket.bind(0, "0.0.0.0", resolve));
  const interfaces = multicastInterfaces();
  assert.equal(joinMulticast(socket, "239.255.77.32", interfaces), interfaces.length);
  assert.equal(joinMulticast(socket, "239.255.77.32", interfaces), 0);
});

test("agent-mail/1.1 routing fields are signed, round-trip, and are advertised at /capabilities", async (t) => {
  const { dir, a, b } = setup(t);
  const base = message(a, b);
  const { signature, ...unsigned } = base;
  const routed = signMessage(a, { ...unsigned, to_session: "codex-thread-7", hop: 2, auto_reply: true, in_reply_to: randomUUID() });
  assert.equal(verifyMessage(publicIdentity(a), routed), true);
  assert.equal(verifyMessage(publicIdentity(a), { ...routed, hop: 3 }), false, "hop is covered by the signature");
  assert.equal(verifyMessage(publicIdentity(a), base), true, "messages without the fields still verify");
  assert.deepEqual(unseal(b, seal(a, publicIdentity(b), routed), () => publicIdentity(a)), routed);
  for (const bad of [{ hop: 17 }, { hop: -1 }, { to_session: "a\nb" }, { in_reply_to: "not-a-uuid" }, { auto_reply: "yes" }]) {
    assert.throws(() => signMessage(a, { ...unsigned, ...bad }));
  }
  const bob = new Peer(b, join(dir, "b"), { timeoutMs: 50, tailscale: false });
  const listener = await bob.listen({ port: 0, bind: "127.0.0.1", discovery: false });
  t.after(() => listener.close());
  const response = await fetch(`http://127.0.0.1:${listener.port}/capabilities`);
  assert.deepEqual(await response.json(), { envelope: ["agent-mail/1.1"] });
});

test("routing fields are sent only to a peer whose /capabilities accepts agent-mail/1.1", async (t) => {
  const { dir, a, b } = setup(t);
  const alice = new Peer(a, join(dir, "a"), { timeoutMs: 50, tailscale: false });
  const bob = new Peer(b, join(dir, "b"), { timeoutMs: 50, tailscale: false });
  let mode = "new";
  let probes = 0;
  const handle = (req, res) => {
    if (req.url !== "/capabilities") return false;
    probes++;
    if (mode === "new") return false; // the real listener answers
    if (mode === "old") { res.writeHead(404).end(); return true; }
    res.writeHead(200, { "content-type": "application/json" }).end(mode === "odd" ? "not json" : JSON.stringify({ envelope: ["agent-mail/9"] }));
    return true;
  };
  const listener = await bob.listen({ port: 0, bind: "127.0.0.1", discovery: false, handle });
  t.after(() => listener.close());
  pair(alice, bob, { b: `http://127.0.0.1:${listener.port}` });
  const routing = { to_session: "codex-7", hop: 1, auto_reply: true, in_reply_to: randomUUID() };
  const inbound = (id) => bob.inbox().find((m) => m.id === id);

  const sent = await alice.send({ recipient: "Zephyr", text: "routed", ...routing });
  assert.equal(sent.status, "delivered");
  assert.equal(sent.envelope_downgraded, undefined);
  const got = inbound(sent.message_id);
  for (const [key, value] of Object.entries(routing)) assert.equal(got[key], value, key);
  assert.equal(probes, 1);
  await alice.send({ recipient: "Zephyr", text: "cached", hop: 2 });
  assert.equal(probes, 1, "a definite answer is cached per contact");
  await alice.send({ recipient: "Zephyr", text: "plain" });
  assert.equal(probes, 1, "no probe without routing fields");

  for (const next of ["old", "odd", "other-version"]) {
    mode = next;
    const fresh = new Peer(a, join(dir, "a"), { timeoutMs: 50, tailscale: false });
    const result = await fresh.send({ recipient: "Zephyr", text: `to ${next}`, ...routing });
    assert.equal(result.status, "delivered", next);
    assert.equal(result.envelope_downgraded, true, next);
    for (const key of Object.keys(routing)) assert.equal(inbound(result.message_id)[key], undefined, `${next}: ${key} left out`);
  }
  assert.equal(alice.store.contact(fingerprint(b)).endpoint, `http://127.0.0.1:${listener.port}`, "capabilities never change the saved endpoint");
});

test("a changed endpoint clears the cached capabilities answer", async (t) => {
  const { dir, a, b } = setup(t);
  const alice = new Peer(a, join(dir, "a"), { timeoutMs: 50, tailscale: false });
  const bob = new Peer(b, join(dir, "b"), { timeoutMs: 50, tailscale: false });
  let probes = 0;
  const handle = (req) => { if (req.url === "/capabilities") probes++; return false; };
  const first = await bob.listen({ port: 0, bind: "127.0.0.1", discovery: false, handle });
  const second = await bob.listen({ port: 0, bind: "127.0.0.1", discovery: false, handle });
  t.after(() => second.close());
  pair(alice, bob, { b: `http://127.0.0.1:${first.port}` });
  await alice.send({ recipient: "Zephyr", text: "one", hop: 0 });
  assert.equal(probes, 1);
  alice.discover = async () => [{ fingerprint: fingerprint(b), endpoint: `http://127.0.0.1:${second.port}` }];
  await first.close(); // the saved address stops answering, so delivery moves
  const moved = await alice.send({ recipient: "Zephyr", text: "two", hop: 0 });
  assert.ok(moved.endpoint_changed, "delivery moved to the discovered address");
  await alice.send({ recipient: "Zephyr", text: "three", hop: 0 });
  assert.equal(probes, 2, "re-probed after the endpoint changed");
});

test("MCP mailbox tools never create journal.db; only mailbox_register_session does (#16)", async (t) => {
  const { dir, a } = setup(t);
  const home = join(dir, "a");
  const server = createPeerMcp(new Peer(a, home, { tailscale: false }));
  const client = new Client({ name: "test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  for (const [name, args] of [["mailbox_list", { session_id: "s" }], ["mailbox_poll", { session_id: "s" }], ["mailbox_session_heartbeat", { session_id: "s" }], ["mailbox_lease_conversation", { session_id: "s", conversation_id: randomUUID() }]]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, /No mailbox journal/, name);
  }
  assert.equal(existsSync(join(home, "journal.db")), false);
  const registered = await client.callTool({ name: "mailbox_register_session", arguments: { session_id: "s" } });
  assert.notEqual(registered.isError, true);
  assert.equal(existsSync(join(home, "journal.db")), true);
  assert.notEqual((await client.callTool({ name: "mailbox_list", arguments: { session_id: "s" } })).isError, true);
  await client.close();
  await server.close(); // releases journal.db before the temp dir is removed
});

test("LAN discovery verifies nonce/signature, resolves peers and sends without an explicit endpoint", async (t) => {
  const { dir, a, b } = setup(t);
  const options = { port: await freeUdpPort(), group: "239.255.77.32", timeoutMs: 800, tailscale: false };
  const alice = new Peer(a, join(dir, "a"), options);
  const bob = new Peer(b, join(dir, "b"), options);
  pair(alice, bob);
  const listener = await bob.listen({ port: 0, bind: "127.0.0.1" });
  t.after(() => listener.close());
  const peers = await discover(options);
  assert.equal(peers.length, 1);
  assert.equal(peers[0].fingerprint, fingerprint(b));
  assert.equal((await alice.send({ recipient: "Zephyr", text: "Found via multicast" })).status, "delivered");
  const nonce = randomUUID();
  const advert = advertisement(b, listener.port, nonce);
  assert.throws(() => parseAdvert(Buffer.from(JSON.stringify(advert)), "127.0.0.1", randomUUID()));
  assert.throws(() => parseAdvert(Buffer.from(JSON.stringify({ ...advert, signature: signed(a, advert.payload) })), "127.0.0.1", nonce));
});

test("a verified receipt from a discovered address replaces the stale pinned endpoint", async (t) => {
  const { dir, a, b } = setup(t);
  const alice = new Peer(a, join(dir, "a"), { timeoutMs: 50, tailscale: false });
  const bob = new Peer(b, join(dir, "b"), { timeoutMs: 50, tailscale: false });
  const listener = await bob.listen({ port: 0, bind: "127.0.0.1", discovery: false });
  t.after(() => listener.close());
  const stale = await bob.listen({ port: 0, bind: "127.0.0.1", discovery: false });
  const stalePort = stale.port;
  await stale.close();
  const fresh = `http://127.0.0.1:${listener.port}`;
  pair(alice, bob, { b: `http://127.0.0.1:${stalePort}` });
  alice.discover = async () => [{ fingerprint: fingerprint(b), endpoint: fresh }];
  const result = await alice.send({ recipient: "Zephyr", text: "after a move" });
  assert.equal(result.status, "delivered");
  assert.deepEqual(result.endpoint_changed, { from: `http://127.0.0.1:${stalePort}`, to: fresh });
  assert.equal(alice.store.contact(fingerprint(b)).endpoint, fresh);
  assert.equal(alice.store.contact(fingerprint(b)).identity.signing_key, publicIdentity(b).signing_key);
  const again = await alice.send({ recipient: "Zephyr", text: "same address" });
  assert.equal(again.status, "delivered");
  assert.equal(again.endpoint_changed, undefined, "no change once the address is saved");
});

test("a saved endpoint that still answers is kept even when discovery lists another address first", async (t) => {
  const { dir, a, b } = setup(t);
  const alice = new Peer(a, join(dir, "a"), { timeoutMs: 50, tailscale: false });
  const bob = new Peer(b, join(dir, "b"), { timeoutMs: 50, tailscale: false });
  const saved = await bob.listen({ port: 0, bind: "127.0.0.1", discovery: false });
  const other = await bob.listen({ port: 0, bind: "127.0.0.1", discovery: false });
  t.after(async () => { await saved.close(); await other.close(); });
  pair(alice, bob, { b: `http://127.0.0.1:${saved.port}` });
  alice.discover = async () => [{ fingerprint: fingerprint(b), endpoint: `http://127.0.0.1:${other.port}` }];
  for (const text of ["one", "two"]) {
    const result = await alice.send({ recipient: "Zephyr", text });
    assert.equal(result.status, "delivered");
    assert.equal(result.endpoint_changed, undefined, text);
  }
  assert.equal(alice.store.contact(fingerprint(b)).endpoint, `http://127.0.0.1:${saved.port}`);
});

test("an address answered by a different key never replaces the pinned endpoint", async (t) => {
  const { dir, a, b } = setup(t);
  const impostor = initIdentity(join(dir, "c"), "Zephyr");
  const alice = new Peer(a, join(dir, "a"), { timeoutMs: 50, tailscale: false });
  const fake = new Peer(impostor, join(dir, "c"), { timeoutMs: 50, tailscale: false });
  fake.store.trust(publicIdentity(a), fingerprint(a));
  const listener = await fake.listen({ port: 0, bind: "127.0.0.1", discovery: false });
  t.after(() => listener.close());
  const pinned = "http://127.0.0.1:9";
  alice.store.trust(publicIdentity(b), fingerprint(b), pinned);
  alice.discover = async () => [{ fingerprint: fingerprint(b), endpoint: `http://127.0.0.1:${listener.port}` }];
  const result = await alice.send({ recipient: fingerprint(b), text: "wrong host" });
  assert.equal(result.status, "queued");
  assert.equal(alice.store.contact(fingerprint(b)).endpoint, pinned);
});

test("Tailscale candidates include online IPv4/IPv6 peers only and never shell text", () => {
  assert.deepEqual(tailscaleAddresses({ Peer: {
    a: { Online: true, TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1", "$(bad)"] },
    b: { Online: false, TailscaleIPs: ["100.64.0.2"] },
    c: { Online: true, TailscaleIPs: ["100.64.0.1"] },
  } }), ["100.64.0.1", "fd7a:115c:a1e0::1"]);
});

test("MCP exposes the peer contract and delivers using the same transport", async (t) => {
  const { dir, a, b } = setup(t);
  const alice = new Peer(a, join(dir, "a"), { timeoutMs: 50, tailscale: false }, { harness: "cursor", name: "cursor", model: "composer" });
  const bob = new Peer(b, join(dir, "b"));
  const listener = await bob.listen({ port: 0, bind: "127.0.0.1", discovery: false });
  const server = createPeerMcp(alice);
  const client = new Client({ name: "test", version: "1" });
  t.after(async () => { await client.close(); await server.close(); await listener.close(); });
  pair(alice, bob, { b: `http://127.0.0.1:${listener.port}` });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === "discover_peers"));
  assert.ok(!tools.tools.some((t) => t.name === "trust_peer"));
  const result = await client.callTool({ name: "send_message", arguments: { recipient: "Zephyr", text: "via MCP", session_id: "sess-1" } });
  assert.equal(JSON.parse(result.content[0].text).status, "delivered");
  assert.equal(bob.inbox()[0].text, "via MCP");
  assert.equal(bob.inbox()[0].agent.harness, "cursor");
  assert.equal(bob.inbox()[0].agent.model, "composer");
  assert.equal(bob.inbox()[0].agent.session_id, "sess-1");
  assert.equal(verifyMessage(a, bob.inbox()[0]), true);
  const who = await client.callTool({ name: "whoami", arguments: {} });
  assert.ok(!JSON.stringify(who).includes("PRIVATE KEY"));
});

test("CLI exports no private keys, rejects malformed commands, and stdio MCP starts without a service", async (t) => {
  const { dir } = setup(t);
  const cli = join(process.cwd(), "dist", "cli.js");
  const run = (...args) => spawnSync(process.execPath, [cli, "--home", join(dir, "a"), ...args], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  const identity = run("identity", "--harness", "cursor", "--agent-name", "cursor", "--model", "composer", "--session", "sess-1");
  assert.equal(identity.status, 0, identity.stderr);
  assert.ok(!identity.stdout.includes("PRIVATE KEY"));
  const exported = JSON.parse(identity.stdout);
  assert.equal(exported.name, "Desktop");
  assert.equal(exported.origin.hostname, hostname());
  assert.deepEqual(exported.agent, { harness: "cursor", name: "cursor", model: "composer", session_id: "sess-1" });
  assert.equal(run("send", "Zephyr", "--text", "a", "--file", "b").status, 1);
  const client = new Client({ name: "stdio-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "--home", join(dir, "a"), "mcp", "--no-listen", "--no-tailscale"], stderr: "pipe" });
  t.after(() => client.close());
  await client.connect(transport);
  const who = await client.callTool({ name: "whoami", arguments: {} });
  assert.equal(JSON.parse(who.content[0].text).name, "Desktop");
});

test("MCP lets same-PC sessions message and broadcast through the host journal", async (t) => {
  const { dir, a } = setup(t);
  const home = join(dir, "a");
  // Two harness processes on one PC share the identity and store directory.
  const claude = createPeerMcp(new Peer(a, home, { tailscale: false }, { harness: "claude-code", name: "claude", model: "claude" }));
  const codex = createPeerMcp(new Peer(a, home, { tailscale: false }, { harness: "codex", name: "codex", model: "codex" }));
  // Closed in the test body: setup's t.after removes the folder first, and Windows cannot delete an open journal.db.
  const closers = [];
  const connect = async (server) => {
    const client = new Client({ name: "test", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(left);
    await client.connect(right);
    closers.push(async () => { await client.close(); await server.close(); });
    return async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      return { error: result.isError === true, data: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
    };
  };
  try {
    const callA = await connect(claude);
    const callB = await connect(codex);
    await callA("mailbox_register_session", { session_id: "s-claude", alias: "Builder" });
    const reviewer = (await callB("mailbox_register_session", { session_id: "s-codex", alias: "Reviewer" })).data;

    await callA("mailbox_publish", { session_id: "s-claude", agent_id: reviewer.agent_id, subject: "direct", body: "hi codex" });
    assert.deepEqual((await callB("mailbox_list", { session_id: "s-codex" })).data.map((m) => m.subject), ["direct"]);

    await callA("mailbox_subscribe", { session_id: "s-claude", scope_id: "local" });
    await callB("mailbox_subscribe", { session_id: "s-codex", scope_id: "local" });
    await callA("mailbox_publish", { session_id: "s-claude", audience: "broadcast", scope_id: "local", subject: "all", body: "hello all" });
    assert.ok((await callB("mailbox_list", { session_id: "s-codex" })).data.some((m) => m.subject === "all"));

    const misrouted = await callA("send_message", { recipient: "codex", text: "meant for a local agent" });
    assert.equal(misrouted.error, true);
    assert.match(misrouted.data, /mailbox_publish/);
  } finally {
    for (const close of closers) await close();
  }
});

test("a native-module mismatch becomes an actionable local-mailbox error", () => {
  const mismatch = Object.assign(new Error("compiled against a different Node.js version"), { code: "ERR_DLOPEN_FAILED" });
  assert.match(journalLoadError(mismatch).message, /npm rebuild better-sqlite3/);
  assert.match(journalLoadError(mismatch).message, /send_message to other machines still works/);
  const other = new Error("disk full");
  assert.equal(journalLoadError(other), other);
});
