import assert from "node:assert/strict";
import { test } from "node:test";
import { isRetryableError } from "../src/remote.js";
import { buildDeliveryDocument } from "../src/prompt.js";
import { findChatId, findCodexThreadId, parseWakeClient, wakeArgs } from "../src/wake.js";
import type { Envelope } from "../src/types.js";

test("treats connection failures as retryable and protocol failures as final", () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8787"), { code: "ECONNREFUSED" });
  assert.equal(isRetryableError(refused), true);
  assert.equal(isRetryableError(new TypeError("fetch failed", { cause: refused })), true);
  assert.equal(isRetryableError(new Error("unknown recipient; call list_agents")), false);
});

test("wake instructions keep the peer message untrusted and omit secrets", () => {
  const message: Envelope = {
    message_id: "msg-1",
    conversation_id: "conv-1",
    reply_to: null,
    sender: "desktop-builder",
    recipient: "laptop-reviewer",
    type: "task",
    deadline: null,
    body: { text: "Look at src/app.ts on my disk" },
    task_id: "task-1",
    task_status: "open",
    project: "alpha",
    repo: "example/app",
    branch: "main",
    commit: "abc1234",
    operation_id: null,
    delivery: "acked",
    attempt: 1,
    lease_until: null,
    created_at: "2026-10-03T00:00:00.000Z",
  };
  const document = buildDeliveryDocument(
    { id: "laptop-reviewer", capabilities: ["review"], projects: ["alpha"] },
    [message],
    "D:/mailbox/replies",
  );
  const text = JSON.stringify(document);
  assert.match(text, /not permission/i);
  assert.match(text, /sender's machine/);
  assert.match(text, /Look at src\/app.ts/);
  assert.equal(text.includes("token"), false);
  assert.equal(document.you_are, "laptop-reviewer");
});

test("finds a chat id without treating arbitrary strings as sessions", () => {
  assert.equal(findChatId({ result: { session_id: "chat-42" } }), "chat-42");
  assert.equal(findChatId([{ nested: { chatId: "chat-7" } }]), "chat-7");
  assert.equal(findChatId({ note: "no session here" }), undefined);
});

test("parses the wake client and rejects unknown values", async () => {
  const { parseWakeClient } = await import("../src/wake.js");
  assert.equal(parseWakeClient(undefined), "cursor");
  assert.equal(parseWakeClient("claude"), "claude");
  assert.equal(parseWakeClient("codex"), "codex");
  assert.equal(parseWakeClient("gemini"), "gemini");
  assert.equal(parseWakeClient("antigravity"), "antigravity");
  assert.equal(parseWakeClient("agy"), "antigravity");
  assert.throws(() => parseWakeClient("vim"), /WAKE_CLIENT/);
});

test("Codex wake connects to the local adapter and resumes the right thread", () => {
  assert.equal(parseWakeClient("codex"), "codex");
  const base = {
    client: "codex" as const,
    mode: "cli" as const,
    workspace: "D:/checkout",
    mcpUrl: "http://127.0.0.1:8788/mcp",
    mcpToken: "local-token",
    deliveryPath: "D:/mailbox/current-delivery.json",
    replyDirectory: "D:/mailbox/replies",
    agent: { id: "reviewer", capabilities: [], projects: ["*"] },
    messages: [] as Envelope[],
    timeoutMs: 1000,
  };
  const initial = wakeArgs(base);
  assert.deepEqual(initial.slice(0, 2), ["exec", "--json"]);
  assert.deepEqual(initial.slice(-3, -1), ["--cd", base.workspace]);
  assert(initial.includes('mcp_servers.agent-mailbox.bearer_token_env_var="AGENT_TOKEN"'));
  assert(initial.includes(`mcp_servers.agent-mailbox.url="${base.mcpUrl}"`));
  assert(initial.includes("mcp_servers.agent-mailbox.required=true"));
  assert(initial.includes('mcp_servers.agent-mailbox.default_tools_approval_mode="auto"'));
  assert(initial.includes('sandbox_mode="read-only"'));
  assert(!initial.join(" ").includes(base.mcpToken));

  const resumed = wakeArgs({ ...base, mode: "apply", resumeChatId: "thread-42" });
  assert.deepEqual(resumed.slice(0, 3), ["exec", "resume", "--json"]);
  assert(resumed.includes("thread-42"));
  assert(!resumed.includes("--cd"));
  assert(resumed.includes('sandbox_mode="workspace-write"'));
  assert(resumed.some((arg) => arg.startsWith("sandbox_workspace_write.writable_roots=")));
  assert.equal(findCodexThreadId('{"type":"turn.started"}\n{"type":"thread.started","thread_id":"thread-42"}\n'), "thread-42");
});

test("Antigravity (Gemini) wake builds expected arguments and handles conversation resume", async () => {
  const { parseWakeClient, wakeArgs } = await import("../src/wake.js");
  assert.equal(parseWakeClient("gemini"), "gemini");
  assert.equal(parseWakeClient("antigravity"), "antigravity");

  const base = {
    client: "gemini" as const,
    mode: "cli" as const,
    workspace: "D:/checkout",
    deliveryPath: "D:/mailbox/current-delivery.json",
    replyDirectory: "D:/mailbox/replies",
    agent: { id: "gemini-reviewer", capabilities: [], projects: ["*"] },
    messages: [] as Envelope[],
    timeoutMs: 1000,
  };

  const cliArgs = wakeArgs(base);
  assert(cliArgs.includes("--dangerously-skip-permissions"));
  assert(cliArgs.includes("--output-format"));
  assert(cliArgs.includes("json"));
  assert(!cliArgs.includes("--mode"));
  assert(cliArgs.includes("--add-dir"));
  assert(cliArgs.includes("D:/checkout"));
  assert(!cliArgs.includes("--conversation"));
  assert.equal(cliArgs[cliArgs.length - 2], "--print");
  assert(cliArgs[cliArgs.length - 1].includes("D:/mailbox/current-delivery.json"));

  const applyArgs = wakeArgs({ ...base, client: "antigravity" as const, mode: "apply", resumeChatId: "conv-999" });
  assert(applyArgs.includes("--mode"));
  assert(applyArgs.includes("accept-edits"));
  assert(applyArgs.includes("--conversation"));
  assert(applyArgs.includes("conv-999"));
  assert.equal(applyArgs[applyArgs.length - 2], "--print");
});
