import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildDeliveryDocument, wakePrompt } from "./prompt.js";
import type { Agent, Envelope } from "./types.js";

export type WakeMode = "off" | "cli" | "apply";

export type WakeClient = "cursor" | "claude" | "codex" | "gemini" | "antigravity";

export function parseWakeClient(value: string | undefined): WakeClient {
  if (value === undefined || value === "" || value === "cursor") return "cursor";
  const lower = value.toLowerCase();
  if (lower === "claude") return "claude";
  if (lower === "codex") return "codex";
  if (lower === "gemini") return "gemini";
  if (lower === "antigravity" || lower === "agy") return "antigravity";
  throw new Error("WAKE_CLIENT must be cursor, claude, codex, gemini, or antigravity");
}

export function parseWakeMode(value: string | undefined): WakeMode {
  if (value === undefined || value === "" || value === "off") return "off";
  if (value === "cli" || value === "apply") return value;
  throw new Error("WAKE must be off, cli, or apply");
}

export async function wakeAgent(options: {
  client?: WakeClient;
  mode: Exclude<WakeMode, "off">;
  workspace?: string;
  mcpConfigPath?: string;
  mcpUrl?: string;
  mcpToken?: string;
  deliveryPath: string;
  agent: Agent;
  messages: Envelope[];
  replyDirectory: string;
  resumeChatId?: string;
  timeoutMs: number;
}): Promise<{ ok: boolean; chatId?: string }> {
  mkdirSync(dirname(options.deliveryPath), { recursive: true });
  mkdirSync(options.replyDirectory, { recursive: true });
  const document = buildDeliveryDocument(options.agent, options.messages, options.replyDirectory);
  writeFileSync(options.deliveryPath, JSON.stringify(document, null, 2), "utf8");
  const client = options.client ?? "cursor";
  const args = wakeArgs(options);
  const cwd =
    client === "claude" || client === "codex" || client === "gemini" || client === "antigravity"
      ? options.workspace
      : undefined;

  const env = client === "codex" ? { ...process.env, AGENT_TOKEN: options.mcpToken } : undefined;
  const first = await runAgent(client, args, options.timeoutMs, cwd, env);
  const chatId = client === "codex" ? findCodexThreadId(first.prefix) : findChatId(parseJson(first.stdout));
  if (first.code === 0) return { ok: true, chatId };
  if (!options.resumeChatId) return { ok: false, chatId };
  const retryArgs = wakeArgs({ ...options, resumeChatId: undefined });
  const second = await runAgent(client, retryArgs, options.timeoutMs, cwd, env);
  const secondId = client === "codex" ? findCodexThreadId(second.prefix) : findChatId(parseJson(second.stdout));
  return { ok: second.code === 0, chatId: secondId ?? chatId };
}

type WakeOptions = Parameters<typeof wakeAgent>[0];

export function wakeArgs(options: WakeOptions): string[] {
  const client = options.client ?? "cursor";
  if (client === "claude") return claudeArgs(options);
  if (client === "codex") return codexArgs(options);
  if (client === "gemini" || client === "antigravity") return geminiArgs(options);
  return cursorArgs(options);
}

function codexArgs(options: WakeOptions): string[] {
  if (!options.workspace) throw new Error("WAKE_WORKSPACE is required for Codex wake");
  if (!options.mcpUrl) throw new Error("Codex wake requires the local adapter MCP URL");
  if (!options.mcpToken) throw new Error("Codex wake requires the local adapter token");
  const args = ["exec"];
  if (options.resumeChatId) args.push("resume");
  args.push("--json", "-c", `sandbox_mode=${JSON.stringify(options.mode === "apply" ? "workspace-write" : "read-only")}`);
  args.push("-c", `mcp_servers.agent-mailbox.url=${JSON.stringify(options.mcpUrl)}`);
  args.push("-c", 'mcp_servers.agent-mailbox.bearer_token_env_var="AGENT_TOKEN"');
  args.push("-c", "mcp_servers.agent-mailbox.required=true");
  args.push("-c", 'mcp_servers.agent-mailbox.default_tools_approval_mode="auto"');
  if (options.mode === "apply") {
    args.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify([options.replyDirectory])}`);
  }
  if (!options.resumeChatId) args.push("--cd", options.workspace);
  if (options.resumeChatId) args.push(options.resumeChatId);
  args.push(wakePrompt(options.deliveryPath));
  return args;
}

function cursorArgs(options: WakeOptions): string[] {
  const args = ["-p", "--trust", "--approve-mcps", "--output-format", "json"];
  if (options.mode === "apply") args.push("--force");
  if (options.workspace) args.push("--workspace", options.workspace);
  if (options.resumeChatId) args.push("--resume", options.resumeChatId);
  args.push(wakePrompt(options.deliveryPath));
  return args;
}

// Claude Code print mode. The prompt is passed last; it runs in WAKE_WORKSPACE (the process cwd).
// cli: only the mailbox MCP tools and Read are pre-approved, so edits and shell commands are denied.
// apply: acceptEdits also lets the agent edit files in the workspace.
function claudeArgs(options: WakeOptions): string[] {
  const args = ["-p", "--output-format", "json"];
  if (options.mcpConfigPath) args.push("--mcp-config", options.mcpConfigPath);
  args.push("--allowedTools", "mcp__agent-mailbox", "Read");
  args.push("--permission-mode", options.mode === "apply" ? "acceptEdits" : "default");
  if (options.resumeChatId) args.push("--resume", options.resumeChatId);
  args.push("--", wakePrompt(options.deliveryPath));
  return args;
}

// Antigravity (Gemini) CLI (agy) print mode.
// --dangerously-skip-permissions: auto-approves tool permission requests (e.g. MCP tools).
// --output-format json: outputs a single JSON response containing conversation_id and response text.
// apply: --mode accept-edits allows agent file edits.
// cli: read/plan mode without auto file edits.
function geminiArgs(options: WakeOptions): string[] {
  const args = ["--dangerously-skip-permissions", "--output-format", "json"];
  if (options.mode === "apply") args.push("--mode", "accept-edits");
  if (options.workspace) args.push("--add-dir", options.workspace);
  if (options.resumeChatId) args.push("--conversation", options.resumeChatId);
  args.push("--print", wakePrompt(options.deliveryPath));
  return args;
}

function runAgent(
  client: WakeClient,
  args: string[],
  timeoutMs: number,
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; prefix: string }> {
  return new Promise((resolve) => {
    const isGemini = client === "gemini" || client === "antigravity";
    const command = isGemini
      ? process.platform === "win32"
        ? "agy.exe"
        : "agy"
      : client === "claude"
      ? "claude"
      : client === "codex"
      ? "codex"
      : "agent";
    const child = spawn(command, args, {
      shell: isGemini ? false : process.platform === "win32",
      windowsHide: true,
      cwd,
      env,
    });
    let stdout = "";
    let prefix = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, prefix });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(1);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-200_000);
      if (prefix.length < 20_000) prefix = (prefix + chunk).slice(0, 20_000);
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(1);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code ?? 1);
    });
  });
}

export function findCodexThreadId(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as { type?: unknown; thread_id?: unknown };
      if (event.type === "thread.started" && typeof event.thread_id === "string") return event.thread_id;
    } catch {
      // Skip incomplete or non-JSON output.
    }
  }
  return undefined;
}

export function findChatId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findChatId(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["session_id", "sessionId", "chatId", "chat_id", "conversation_id", "conversationId"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.length > 0 && candidate.length < 200) return candidate;
  }
  for (const nested of Object.values(record)) {
    const found = findChatId(nested);
    if (found) return found;
  }
  return undefined;
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      if (!line.startsWith("{") && !line.startsWith("[")) continue;
      try {
        return JSON.parse(line);
      } catch {
        // keep scanning
      }
    }
    return undefined;
  }
}
