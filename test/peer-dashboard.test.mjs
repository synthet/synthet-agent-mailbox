import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Journal } from "../dist/fabric/journal.js";
import { initIdentity } from "../dist/peer/identity.js";
import { startPeerDashboard } from "../dist/peer/dashboard-server.js";

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
  assert.equal(body.remote.tasks.offered, 1);
  assert.equal(body.agents.agents.some((agent) => agent.id.includes("Builder")), true);

  const forbidden = await get(dashboard.url, { host: "evil.example" });
  assert.equal(forbidden.status, 403);
});
