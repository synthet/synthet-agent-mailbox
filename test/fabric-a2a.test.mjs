import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initIdentity } from "../dist/peer/identity.js";
import { startDaemon } from "../dist/fabric/daemon.js";

test("optional A2A v1 card and SendMessage map onto a mailbox task", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fabric-a2a-"));
  const identity = initIdentity(dir, "Desktop");
  const running = await startDaemon(identity, dir, { bind: "127.0.0.1", discovery: false, a2a: true });
  t.after(async () => { await running.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${running.peerPort}`;
  const card = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
  assert.equal(card.supportedInterfaces[0].protocolVersion, "1.0.0");
  assert.equal(card.capabilities.extendedAgentCard, false);
  assert.equal("url" in card, false);
  const sent = await (await fetch(`${base}/a2a`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "SendMessage", params: { message: { messageId: "m-1", role: "user", parts: [{ text: "status please" }] } } }),
  })).json();
  assert.equal(sent.result.status.state, "submitted");
  assert.equal(typeof sent.result.metadata.mailboxMessageId, "string");
  assert.equal("text" in sent.result.history[0].parts[0], true);
  assert.equal("kind" in sent.result.history[0].parts[0], false);
  const taskId = sent.result.id;
  const got = await (await fetch(`${base}/a2a`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "2", method: "GetTask", params: { id: taskId } }),
  })).json();
  assert.equal(got.result.id, taskId);
  assert.equal(got.result.metadata.mailboxState, "offered");
  const unknown = await (await fetch(`${base}/a2a`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "3", method: "Broadcast", params: {} }),
  })).json();
  assert.equal(unknown.error.code, -32601);
  const offDir = mkdtempSync(join(tmpdir(), "fabric-a2a-off-"));
  const off = await startDaemon(initIdentity(offDir, "Other"), offDir, { bind: "127.0.0.1", discovery: false });
  t.after(async () => { await off.close(); rmSync(offDir, { recursive: true, force: true }); });
  const disabled = await fetch(`http://127.0.0.1:${off.peerPort}/a2a`, { method: "POST", body: "{}" });
  assert.equal(disabled.status, 404);
});
