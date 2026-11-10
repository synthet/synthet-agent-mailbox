import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import Database from "better-sqlite3";
import { initIdentity, publicIdentity, fingerprint } from "../dist/peer/identity.js";
import { Peer } from "../dist/peer/peer.js";
import { signMessage } from "../dist/peer/wire.js";
import { Journal, LEASE_TTL_MS, SESSION_TTL_MS } from "../dist/fabric/journal.js";
import { watchPoll } from "../dist/peer/watch.js";
import { SeenStore, unseenMessages } from "../dist/peer/seen.js";

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "agent-mail-p1-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "me");
  const me = initIdentity(home, "Alpha");
  const them = initIdentity(join(dir, "them"), "Beta");
  const peer = new Peer(me, home);
  peer.store.trust(publicIdentity(them), fingerprint(them));
  const deliver = (text = "hello") => {
    const m = signMessage(them, {
      id: randomUUID(), conversation_id: randomUUID(), sender: fingerprint(them), recipient: fingerprint(me), text, created_at: Date.now(),
      origin: { hostname: "beta", platform: "test", arch: "x64", addresses: ["192.0.2.20"] },
    });
    peer.store.put("inbox", m.sender + ":" + m.id, m);
    return m;
  };
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  return { dir, home, me, them, peer, deliver, clock };
}

test("sessions stay live for the TTL after a heartbeat, and end makes them not live", (t) => {
  const { home, me, clock } = setup(t);
  const journal = new Journal(home, me, clock.now);
  journal.registerSession({ session_id: "claude-1", alias: "claude" });
  journal.registerSession({ session_id: "codex-1", alias: "codex" });
  assert.deepEqual(journal.liveSessions().map((s) => s.session_id).sort(), ["claude-1", "codex-1"]);
  clock.advance(SESSION_TTL_MS - 1000);
  journal.heartbeat("claude-1");
  clock.advance(2000);
  assert.deepEqual(journal.liveSessions().map((s) => s.session_id), ["claude-1"], "codex-1 expired without a heartbeat");
  assert.throws(() => journal.heartbeat("nobody"), /Unknown session/);
  journal.endSession("claude-1");
  assert.deepEqual(journal.liveSessions(), []);
  journal.heartbeat("claude-1");
  assert.deepEqual(journal.liveSessions().map((s) => s.session_id), ["claude-1"], "a heartbeat revives an ended session");
  journal.close();
});

test("conversation leases: one holder, conflict, renew, expiry, release, and release on session end", (t) => {
  const { home, me, clock } = setup(t);
  const journal = new Journal(home, me, clock.now);
  journal.registerSession({ session_id: "a", alias: "claude" });
  journal.registerSession({ session_id: "b", alias: "codex" });
  const conv = randomUUID();
  assert.equal(journal.claimConversation("a", conv).status, "leased");
  const conflict = journal.claimConversation("b", conv);
  assert.equal(conflict.status, "lease_conflict");
  assert.equal(conflict.holder, "a");
  clock.advance(60_000);
  const renewed = journal.claimConversation("a", conv);
  assert.equal(renewed.status, "renewed");
  assert.equal(renewed.lease_until, clock.now() + LEASE_TTL_MS);
  assert.equal(journal.conversationLease(conv).session_id, "a");
  clock.advance(LEASE_TTL_MS - 1000);
  assert.equal(journal.heartbeat("a").leases_renewed, 1, "a heartbeat renews the session's leases");
  clock.advance(2000);
  assert.equal(journal.conversationLease(conv).session_id, "a", "still held past the original expiry");
  clock.advance(LEASE_TTL_MS + 1);
  assert.equal(journal.conversationLease(conv), null, "an expired lease has no holder");
  assert.equal(journal.claimConversation("b", conv).status, "leased", "an expired lease can be taken");
  assert.equal(journal.releaseConversation("a", conv).released, false, "a non-holder can't release");
  assert.equal(journal.releaseConversation("b", conv).released, true);
  assert.equal(journal.conversationLease(conv), null);
  journal.claimConversation("a", conv);
  journal.claimConversation("a", randomUUID());
  assert.equal(journal.endSession("a").released, 2);
  assert.equal(journal.conversationLease(conv), null);
  assert.throws(() => journal.claimConversation("a", "bad id with spaces"), /Invalid conversation_id/);
  assert.throws(() => journal.claimConversation("ghost", conv), /Unknown session/);
  journal.close();
});

test("leases survive reopening journal.db, which gains the table on an existing store", (t) => {
  const { home, me } = setup(t);
  const first = new Journal(home, me);
  first.registerSession({ session_id: "a" });
  const conv = randomUUID();
  first.claimConversation("a", conv);
  first.close();
  const again = new Journal(home, me);
  assert.equal(again.conversationLease(conv).session_id, "a");
  assert.deepEqual(again.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version), [1, 2, 3]);
  again.close();
});

test("watch starts from now, reports each new message once with metadata only, and leaves inject hooks alone", (t) => {
  const { home, peer, deliver } = setup(t);
  deliver("old backlog");
  assert.deepEqual(watchPoll(peer, home, "s1", undefined), [], "first poll records the backlog");
  const m = deliver("secret body text");
  const lines = watchPoll(peer, home, "s1", undefined);
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(lines[0]).sort(), ["created_at", "from", "id", "source", "thread", "type"]);
  assert.deepEqual(lines[0], { type: "mail", source: "peer", id: m.id, thread: m.conversation_id, from: "Beta", created_at: m.created_at });
  assert.equal(JSON.stringify(lines).includes("secret"), false, "no body in wake lines");
  assert.deepEqual(watchPoll(peer, home, "s1", undefined), [], "reported once");
  assert.equal(unseenMessages(peer, new SeenStore(home, "s1"), { session: "s1" }).length, 2, "inject hooks still see both");
  assert.equal(watchPoll(peer, home, "s2", undefined, { backlog: true }).length, 2, "--backlog reports existing mail");
});

test("watch CLI --once prints JSONL, and never creates journal.db", (t) => {
  const { home, deliver } = setup(t);
  const run = (...args) => spawnSync(process.execPath, ["dist/cli.js", "watch", "--home", home, "--session", "cli-1", "--once", ...args], { encoding: "utf8" });
  assert.equal(run().stdout, "");
  const m = deliver("x");
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  const lines = second.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, m.id);
  assert.equal(existsSync(join(home, "journal.db")), false);
});

test("session and lease CLI: lease_conflict exits 2", (t) => {
  const { home } = setup(t);
  const run = (...args) => spawnSync(process.execPath, ["dist/cli.js", ...args, "--home", home], { encoding: "utf8" });
  assert.equal(run("register", "--session", "a", "--agent-name", "claude").status, 0);
  assert.equal(run("register", "--session", "b", "--agent-name", "codex").status, 0);
  const conv = randomUUID();
  const claim = run("lease", "claim", "--session", "a", "--conversation", conv);
  assert.equal(claim.status, 0, claim.stderr);
  assert.equal(JSON.parse(claim.stdout).status, "leased");
  const clash = run("lease", "claim", "--session", "b", "--conversation", conv);
  assert.equal(clash.status, 2);
  assert.equal(JSON.parse(clash.stdout).holder, "a");
  assert.equal(JSON.parse(run("session", "list").stdout).length, 2);
  assert.equal(JSON.parse(run("session", "end", "--session", "a").stdout).released, 1);
  assert.equal(JSON.parse(run("lease", "show", "--conversation", conv).stdout).lease, null);
});

test("sessions record how to reach them, and the directory lists live sessions with their leases", (t) => {
  const { home, me, clock } = setup(t);
  const journal = new Journal(home, me, clock.now);
  journal.registerSession({
    session_id: "claude-1", alias: "claude", harness: "claude",
    harness_session_id: "89e4e4be-1815-4d65-ae07-66c2f91a37bb", display_name: "mailbox-dev", workspace: "D:/Projects/x",
  });
  journal.registerSession({ session_id: "codex-1", alias: "codex", harness: "codex" });
  const conv = randomUUID();
  journal.claimConversation("claude-1", conv);
  const directory = journal.sessionDirectory();
  const claude = directory.find((s) => s.session_id === "claude-1");
  assert.equal(claude.alias, "claude");
  assert.equal(claude.harness_session_id, "89e4e4be-1815-4d65-ae07-66c2f91a37bb");
  assert.equal(claude.display_name, "mailbox-dev");
  assert.equal(claude.workspace, "D:/Projects/x");
  assert.deepEqual(claude.leases.map((l) => l.conversation_id), [conv]);
  const codex = directory.find((s) => s.session_id === "codex-1");
  assert.equal(codex.harness_session_id, null);
  assert.deepEqual(codex.leases, []);
  assert.throws(() => journal.registerSession({ session_id: "x", display_name: "bad\nname" }), /Invalid display_name/);
  journal.endSession("claude-1");
  assert.deepEqual(journal.sessionDirectory().map((s) => s.session_id), ["codex-1"]);
  journal.close();
});

test("a journal created before v3 gains the session columns on open", (t) => {
  const { home, me } = setup(t);
  const legacy = new Database(join(home, "journal.db"));
  legacy.exec("CREATE TABLE sessions (session_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, harness TEXT, model TEXT, last_seen INTEGER NOT NULL)");
  legacy.prepare("INSERT INTO sessions VALUES ('old', 'agent', 'codex', NULL, 1)").run();
  legacy.close();
  const journal = new Journal(home, me);
  const columns = journal.db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
  for (const column of ["harness_session_id", "display_name", "workspace"]) assert.ok(columns.includes(column), column);
  journal.registerSession({ session_id: "new", harness_session_id: "t-1" });
  assert.equal(journal.liveSessions().find((s) => s.session_id === "new").harness_session_id, "t-1");
  journal.close();
});

test("reads never create journal.db: CLI digest, session list, lease show (#16)", (t) => {
  const { home } = setup(t);
  const run = (...args) => spawnSync(process.execPath, ["dist/cli.js", ...args, "--home", home], { encoding: "utf8" });
  const digest = run("digest", "--session", "x");
  assert.equal(digest.status, 0, digest.stderr);
  assert.match(JSON.parse(digest.stdout).warning, /No journal\.db yet/);
  assert.notEqual(run("session", "list").status, 0);
  assert.notEqual(run("lease", "show", "--conversation", randomUUID()).status, 0);
  assert.notEqual(run("publish", "--session", "x", "--text", "hi").status, 0);
  assert.equal(existsSync(join(home, "journal.db")), false);
  assert.equal(run("register", "--session", "x").status, 0, "register still creates it");
  assert.equal(existsSync(join(home, "journal.db")), true);
});
