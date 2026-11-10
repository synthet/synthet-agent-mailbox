import assert from "node:assert/strict";
import { request } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Journal } from "../dist/fabric/journal.js";
import { fingerprint, initIdentity, publicIdentity } from "../dist/peer/identity.js";
import { startPeerDashboard } from "../dist/peer/dashboard-server.js";
import { PeerStore } from "../dist/peer/store.js";
import { signMessage } from "../dist/peer/wire.js";

/** Put one signed peer message from Zephyr into dir's inbox, and pin Zephyr as a contact. */
function peerMail(dir, identity, text) {
  const zephyrDir = mkdtempSync(join(tmpdir(), "peer-dashboard-zephyr-"));
  const zephyr = initIdentity(zephyrDir, "Zephyr");
  rmSync(zephyrDir, { recursive: true, force: true });
  const store = new PeerStore(dir);
  store.trust(publicIdentity(zephyr), fingerprint(zephyr));
  const message = signMessage(zephyr, {
    id: randomUUID(), conversation_id: randomUUID(), sender: fingerprint(zephyr), recipient: fingerprint(identity), text, created_at: Date.now() - 60_000,
    origin: { hostname: "zephyr", platform: "test", arch: "x64", addresses: ["192.0.2.20"] },
  });
  store.put("inbox", message.sender + ":" + message.id, message);
  return message;
}

async function api(dir, t) {
  const dashboard = await startPeerDashboard({ home: dir, port: 0, bind: "127.0.0.1" });
  t.after(async () => {
    await dashboard.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const response = await get(dashboard.url.replace(/\/dashboard$/, "/api/dashboard"));
  assert.equal(response.status, 200);
  return { dashboard, body: JSON.parse(response.body) };
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        type: String(res.headers["content-type"] ?? ""),
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("dashboard serves journal mail at /dashboard", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "peer-dashboard-"));
  const identity = initIdentity(dir, "Desktop");
  const journal = new Journal(dir, identity);
  const session = journal.registerSession({ session_id: "dash", alias: "Builder", harness: "cursor" });
  journal.publish({
    session_id: "dash",
    audience: { kind: "direct", agent_ids: [session.agent_id] },
    body: "review the schema",
    subject: "schema review",
  });
  journal.offerTask("dash", { title: "write the migration", scope_id: "team" });
  journal.close();

  const dashboard = await startPeerDashboard({ home: dir, port: 0, bind: "127.0.0.1" });
  t.after(async () => {
    await dashboard.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const page = await get(dashboard.url);
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.body, /Mailbox dashboard/);

  const api = await get(dashboard.url.replace(/\/dashboard$/, "/api/dashboard"));
  assert.equal(api.status, 200);
  const body = JSON.parse(api.body);
  assert.equal(body.journal, true);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(body.version.app, pkg.version);
  assert.ok(body.version.commit === null || /^[0-9a-f]{7}$/.test(body.version.commit));
  assert.match(page.body, /id="version"/);
  assert.equal(body.recent.some((row) => row.message.body.text === "review the schema"), true);
  assert.equal(body.remote.journal.tasks.offered, 1);
  assert.equal(body.remote.journal.messages, 1);
  assert.ok(body.recent.every((row) => row.source === "journal"));
  assert.equal(body.agents.agents.some((agent) => agent.id.includes("Builder")), true);

  const forbidden = await get(dashboard.url, { host: "evil.example" });
  assert.equal(forbidden.status, 403);
});

test("dashboard without a journal shows peer mail, tagged peer", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "peer-dashboard-"));
  const identity = initIdentity(dir, "Desktop");
  peerMail(dir, identity, "hello from zephyr");
  const { body } = await api(dir, t);
  assert.equal(body.journal, false);
  assert.deepEqual(body.remote, { inbox: { unread: 1, stored: 1 }, tasks: { delivered: 0 } });
  assert.equal(body.recent.length, 1);
  assert.equal(body.recent[0].source, "peer");
  assert.equal(body.recent[0].message.body.text, "hello from zephyr");
  assert.deepEqual(body.agents.agents.map((a) => [a.id, a.source]), [["Desktop", "peer"], ["Zephyr", "peer"]]);
  assert.equal(existsSync(join(dir, "journal.db")), false, "reading the dashboard never creates journal.db");
});

test("a journal adds to peer mail instead of hiding it (#16)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "peer-dashboard-"));
  const identity = initIdentity(dir, "Desktop");
  peerMail(dir, identity, "peer message");
  const journal = new Journal(dir, identity);
  const session = journal.registerSession({ session_id: "dash", alias: "Builder", harness: "cursor" });
  journal.publish({ session_id: "dash", audience: { kind: "direct", agent_ids: [session.agent_id] }, body: "journal message" });
  journal.close();
  const { body } = await api(dir, t);
  assert.equal(body.journal, true);
  assert.deepEqual(body.remote.inbox, { unread: 1, stored: 1 }, "peer counts stay");
  assert.equal(body.remote.journal.messages, 1);
  const texts = Object.fromEntries(body.recent.map((row) => [row.message.body.text, row.source]));
  assert.deepEqual(texts, { "peer message": "peer", "journal message": "journal" });
  assert.equal(body.recent[0].source, "journal", "newest first across both stores");
  assert.ok(body.agents.agents.some((a) => a.id === "Zephyr" && a.source === "peer"));
  assert.ok(body.agents.agents.some((a) => a.id.includes("Builder") && a.source === "journal"));
  assert.match(body.log, / peer from Zephyr peer message/);
  assert.match(body.log, / journal direct /);
});
