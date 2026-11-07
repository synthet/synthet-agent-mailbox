import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initIdentity } from "../dist/peer/identity.js";
import { startTrayHost } from "../dist/tray-host.js";

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), "agent-mail-tray-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  initIdentity(dir, "tray-test");
  return dir;
}

async function occupiedPort(t, bind = "0.0.0.0") {
  const server = createServer();
  server.listen(0, bind);
  await once(server, "listening");
  t.after(() => server.close());
  return server.address().port;
}

test("tray host receives mail when the peer port is free", async (t) => {
  const host = await startTrayHost({ home: home(t), dashboardPort: 0, peerPort: 0, discovery: false });
  t.after(() => host.close());
  assert.equal(host.receiver, "hosted");
});

test("tray host leaves an existing receiver alone and still serves the dashboard", async (t) => {
  const host = await startTrayHost({ home: home(t), dashboardPort: 0, peerPort: await occupiedPort(t), discovery: false });
  t.after(() => host.close());
  assert.equal(host.receiver, "external");
  const response = await fetch(host.url.replace("/dashboard", "/api/dashboard"), { headers: { connection: "close" } });
  assert.equal((await response.json()).agent.id, "tray-test");
});

test("tray host fails when the dashboard port is taken", async (t) => {
  const port = await occupiedPort(t, "127.0.0.1");
  await assert.rejects(startTrayHost({ home: home(t), dashboardPort: port, peerPort: 0, discovery: false }), { code: "EADDRINUSE" });
});

test("tray host exits when the tray closes its stdin", async (t) => {
  const child = spawn(process.execPath, ["dist/tray-host.js"], {
    env: { ...process.env, AGENT_MAIL_HOME: home(t), DASHBOARD_PORT: "0", PEER_PORT: String(await occupiedPort(t)) },
    stdio: ["pipe", "ignore", "pipe"],
  });
  t.after(() => child.kill());
  let stderr = "";
  await new Promise((resolve, reject) => {
    child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.includes("receiver")) resolve(); });
    child.once("exit", (code) => reject(new Error(`exited early with ${code}: ${stderr}`)));
  });
  const exited = once(child, "exit");
  child.stdin.end();
  assert.equal((await exited)[0], 0);
});
