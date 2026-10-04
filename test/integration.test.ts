import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startAdapter } from "../src/adapter.js";
import { parseMailboxUrls, RemoteMailbox } from "../src/remote.js";
import { startMailbox, type RunningMailbox } from "../src/server.js";
import type { Envelope } from "../src/types.js";

const DESKTOP_TOKEN = "desktop-token-value";
const LAPTOP_TOKEN = "laptop-token-value1";

function agentsFile(dir: string): string {
  const file = join(dir, "agents.json");
  writeFileSync(
    file,
    JSON.stringify({
      maxTurns: 30,
      agents: [
        { id: "desktop-builder", token: DESKTOP_TOKEN, capabilities: ["build"], projects: ["*"] },
        { id: "laptop-reviewer", token: LAPTOP_TOKEN, capabilities: ["review"], projects: ["*"] },
      ],
    }),
  );
  return file;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function waitFor<T>(run: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await run();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out${last instanceof Error ? `: ${last.message}` : ""}`);
}

test("adapter delivers mail to the other PC and queues while the host is down", { timeout: 40_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mailbox-"));
  const port = await freePort();
  const mailboxUrl = `http://127.0.0.1:${port}/mcp`;
  let mailbox: RunningMailbox | undefined;
  const adapter = await startAdapter({
    mailboxUrl,
    token: LAPTOP_TOKEN,
    agentId: "laptop-reviewer",
    port: 0,
    bind: "0.0.0.0",
    container: true,
    dataDir: join(dir, "adapter"),
    pollMs: 200,
    wake: "off",
    wakeTimeoutMs: 1_000,
    requestTimeoutMs: 2_000,
  });
  const laptop = new RemoteMailbox(adapter.url, LAPTOP_TOKEN, 5_000);
  let desktop: RemoteMailbox | undefined;
  try {
    const codexSnippet = readFileSync(join(dir, "adapter", "codex-mcp.toml"), "utf8");
    assert.match(codexSnippet, /\[mcp_servers\.agent-mailbox\]/);
    assert.match(codexSnippet, /bearer_token_env_var = "AGENT_TOKEN"/);
    assert.match(codexSnippet, /url = "http:\/\/127\.0\.0\.1:\d+\/mcp"/);
    assert(!codexSnippet.includes(LAPTOP_TOKEN));

    const queued = await laptop.call<{ queued: boolean; message_id: string }>("send_message", {
      recipient: "desktop-builder",
      type: "question",
      body: "Are you there?",
    });
    assert.equal(queued.queued, true);

    mailbox = await startMailbox({
      port,
      bind: "127.0.0.1",
      dataDir: join(dir, "mailbox"),
      agentsFile: agentsFile(dir),
    });
    desktop = new RemoteMailbox(mailbox.url, DESKTOP_TOKEN, 5_000);
    const delivered = await waitFor(async () => {
      const inbox = await desktop.call<{ messages: Envelope[] }>("fetch_inbox", { limit: 5 });
      return inbox.messages.find((message) => message.body.text === "Are you there?");
    });
    assert.equal(delivered.sender, "laptop-reviewer");
    await desktop.call("acknowledge_message", { message_id: delivered.message_id });

    const task = await desktop.call<{ message: Envelope }>("send_message", {
      recipient: "laptop-reviewer",
      type: "task",
      conversation_id: delivered.conversation_id,
      body: { text: "Review commit abc1234", expected: "A short review" },
      repo: "example/app",
      branch: "main",
      commit: "abc1234",
    });
    const spooled = await waitFor(async () => {
      const inbox = await laptop.call<{ messages: Array<Envelope & { spooled?: boolean }> }>("fetch_inbox", {});
      return inbox.messages.find((message) => message.message_id === task.message.message_id);
    });
    assert.equal(spooled.spooled, true);
    assert.equal(spooled.commit, "abc1234");
    await laptop.call("acknowledge_message", { message_id: spooled.message_id });

    const result = await laptop.call<{ queued: boolean; message: Envelope }>("send_message", {
      recipient: "desktop-builder",
      type: "result",
      conversation_id: task.message.conversation_id,
      task_id: task.message.task_id,
      outcome: "success",
      body: "Looks consistent.",
    });
    assert.equal(result.queued, false);
    assert.equal(result.message.task_status, "completed");

    const thread = await desktop.call<{ tasks: Array<{ status: string }> }>("get_thread", {
      conversation_id: task.message.conversation_id,
    });
    assert.equal(thread.tasks[0]?.status, "completed");

    const health = await fetch(`http://127.0.0.1:${mailbox.port}/health`);
    assert.equal(health.status, 200);
    const healthBody = (await health.json()) as { messages?: number };
    assert.equal(healthBody.messages, undefined);

    const base = adapter.url.replace(/\/mcp$/, "");
    const page = await fetch(`${base}/dashboard`);
    const root = await fetch(base, { redirect: "manual" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/dashboard");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Mailbox dashboard/);
    const api = await fetch(`${base}/api/dashboard`);
    assert.equal(api.status, 200);
    const apiText = await api.text();
    assert(!apiText.includes(LAPTOP_TOKEN));
    const snapshot = JSON.parse(apiText) as {
      agent: { id: string };
      mailbox: { connected: boolean };
      recent: Array<{ message: Envelope }>;
    };
    assert.equal(snapshot.agent.id, "laptop-reviewer");
    assert.equal(snapshot.mailbox.connected, true);
    assert(snapshot.recent.some((entry) => entry.message.message_id === task.message.message_id));
    const rebound = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${base}/api/dashboard`, { headers: { host: "evil.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(rebound, 403);

    const denied = await fetch(`${mailbox.url}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(denied.status, 401);
    const log = await fetch(`http://127.0.0.1:${mailbox.port}/log`, {
      headers: { Authorization: `Bearer ${DESKTOP_TOKEN}` },
    });
    assert.match(await log.text(), /Are you there\?/);
  } finally {
    await laptop.close();
    await desktop?.close();
    await adapter.close();
    await mailbox?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails over to the next MAILBOX_URL route and keeps using it", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mailbox-"));
  const deadPort = await freePort();
  const mailbox = await startMailbox({
    port: 0,
    bind: "127.0.0.1",
    dataDir: join(dir, "mailbox"),
    agentsFile: agentsFile(dir),
  });
  try {
    const dead = `http://127.0.0.1:${deadPort}/mcp`;
    const remote = new RemoteMailbox(`${dead}, ${mailbox.url}`, DESKTOP_TOKEN, 2_000);
    assert.deepEqual(remote.candidateUrls, [dead, mailbox.url]);
    const me = await remote.call<{ agent_id: string }>("whoami");
    assert.equal(me.agent_id, "desktop-builder");
    assert.equal(remote.currentUrl, mailbox.url);

    const wrongToken = new RemoteMailbox([dead, mailbox.url], "not-a-real-token-value", 2_000);
    await assert.rejects(wrongToken.call("whoami"));
    assert.throws(() => parseMailboxUrls(" , "), /empty/);
    assert.throws(() => parseMailboxUrls("ftp://host/mcp"), /http or https/);
    await remote.close();
    await wrongToken.close();
  } finally {
    await mailbox.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
