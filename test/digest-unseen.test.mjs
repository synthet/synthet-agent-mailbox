import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { initIdentity, publicIdentity, fingerprint } from "../dist/peer/identity.js";
import { Peer } from "../dist/peer/peer.js";
import { SeenStore, SEEN_BODY_LIMIT, unseenMessages } from "../dist/peer/seen.js";
import { signMessage } from "../dist/peer/wire.js";

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "agent-mail-unseen-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "me");
  const me = initIdentity(home, "TridentX");
  const them = initIdentity(join(dir, "them"), "Zephyr");
  const peer = new Peer(me, home);
  peer.store.trust(publicIdentity(them), fingerprint(them));
  const deliver = (text = "hello") => {
    const m = signMessage(them, {
      id: randomUUID(), conversation_id: randomUUID(), sender: fingerprint(them), recipient: fingerprint(me), text, created_at: Date.now(),
      origin: { hostname: "zephyr", platform: "test", arch: "x64", addresses: ["192.0.2.20"] },
    });
    peer.store.put("inbox", m.sender + ":" + m.id, m);
    return m;
  };
  return { dir, home, me, them, peer, deliver };
}

const cli = (home, ...args) => {
  const run = spawnSync(process.execPath, ["dist/cli.js", "digest", "--home", home, ...args], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
};

test("unseen lists unacked peer mail once, then nothing after mark-seen", (t) => {
  const { home, peer, deliver } = setup(t);
  const m = deliver("first");
  const seen = new SeenStore(home, "s1");
  const first = unseenMessages(peer, seen, { session: "s1" });
  assert.equal(first.length, 1);
  assert.equal(first[0].key, `peer:${m.sender}:${m.id}`);
  assert.equal(first[0].sender_label, "Zephyr");
  assert.equal(first[0].body, undefined, "no body without bodies:true");
  assert.equal(seen.mark([first[0].key]), 1);
  assert.equal(seen.mark([first[0].key]), 0, "marking twice is idempotent");
  assert.deepEqual(unseenMessages(peer, seen, { session: "s1" }), []);
  const second = deliver("second");
  const next = unseenMessages(peer, seen, { session: "s1" });
  assert.deepEqual(next.map((x) => x.message_id), [second.id], "a new message appears exactly once");
});

test("seen state is per session and separate from acknowledgement", (t) => {
  const { home, peer, deliver } = setup(t);
  const m = deliver();
  const a = new SeenStore(home, "a");
  a.mark([`peer:${m.sender}:${m.id}`]);
  assert.equal(unseenMessages(peer, a, { session: "a" }).length, 0);
  assert.equal(unseenMessages(peer, new SeenStore(home, "b"), { session: "b" }).length, 1, "another session still sees it");
  assert.equal(peer.inbox().length, 1, "seen is not acknowledged");
  peer.acknowledge(m.sender, m.id);
  assert.equal(unseenMessages(peer, new SeenStore(home, "b"), { session: "b" }).length, 0, "acked mail is not pending");
});

test("bodies are included only on request and cut at the limit", (t) => {
  const { home, peer, deliver } = setup(t);
  deliver("x".repeat(SEEN_BODY_LIMIT + 10));
  const [m] = unseenMessages(peer, new SeenStore(home, "s"), { session: "s", bodies: true });
  assert.equal(m.body.length, SEEN_BODY_LIMIT);
  assert.equal(m.truncated, true);
});

test("CLI --unseen/--json/--mark-seen round trip, and never creates journal.db", (t) => {
  const { home, deliver } = setup(t);
  const m = deliver("via cli");
  const out = cli(home, "--session", "cli-s", "--unseen", "--json");
  assert.equal(out.untrusted, true);
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].body, "via cli");
  assert.equal(cli(home, "--session", "cli-s", "--mark-seen", out.messages[0].key).marked, 1);
  assert.deepEqual(cli(home, "--session", "cli-s", "--unseen").messages, []);
  assert.equal(existsSync(join(home, "journal.db")), false, "unseen must not create journal.db");
  assert.ok(m.id);
});

test("CLI --unseen requires a session", (t) => {
  const { home } = setup(t);
  const run = spawnSync(process.execPath, ["dist/cli.js", "digest", "--home", home, "--unseen"], { encoding: "utf8", env: { ...process.env, AGENT_MAIL_SESSION: "" } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr + run.stdout, /--session/);
});
