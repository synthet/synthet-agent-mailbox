import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isLoopback, originAllowed, tokensEqual } from "./config.js";
import { MailboxError, RemoteError } from "./errors.js";
import { formatEnvelopeLog } from "./mailbox.js";
import { LocalQueue } from "./local-queue.js";
import { RemoteMailbox } from "./remote.js";
import { bodySchema, fetchShape, messageIdShape, sendShape, threadShape } from "./schemas.js";
import { handleMcp } from "./server.js";
import { dashboardHtml } from "./dashboard.js";
import { faviconIco, faviconSvg } from "./favicon.js";
import type { Agent, Envelope, SendInput } from "./types.js";
import { MESSAGE_TYPES } from "./types.js";
import { parseWakeClient, parseWakeMode, wakeAgent, type WakeClient, type WakeMode } from "./wake.js";

const replySchema = z.object({
  message_id: z.string().optional(),
  conversation_id: z.string(),
  reply_to: z.string().optional(),
  recipient: z.string(),
  type: z.enum(MESSAGE_TYPES),
  body: bodySchema,
  task_id: z.string().optional(),
  outcome: z.enum(["success", "failure"]).optional(),
  project: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  commit: z.string().optional(),
  operation_id: z.string().optional(),
  acknowledge: z.array(z.string()).default([]),
});

export interface AdapterServerOptions {
  mailboxUrl: string;
  token: string;
  agentId: string;
  port: number;
  bind: string;
  dataDir: string;
  pollMs: number;
  wake: WakeMode;
  wakeClient?: WakeClient;
  workspace?: string;
  wakeTimeoutMs: number;
  requestTimeoutMs: number;
  /** Listen on 0.0.0.0 so Docker can publish the port. The host mapping stays on 127.0.0.1. */
  container?: boolean;
  allowedOrigins?: Set<string>;
  onFatal?: (error: Error) => void;
}

export interface RunningAdapter {
  url: string;
  port: number;
  logPath: string;
  close: () => Promise<void>;
}

interface WhoamiResult {
  agent_id: string;
  capabilities: string[];
  projects: string[];
}

interface SendToolResult {
  duplicate: boolean;
  message: Envelope;
}

export async function startAdapter(options: AdapterServerOptions): Promise<RunningAdapter> {
  const containerBind = options.container === true && (options.bind === "0.0.0.0" || options.bind === "::");
  if (!isLoopback(options.bind) && !containerBind) {
    throw new Error(
      "The adapter listens on loopback only. Point your local MCP client at http://127.0.0.1:<port>/mcp on this PC. In Docker, set ADAPTER_CONTAINER=1 and ADAPTER_BIND=0.0.0.0, and publish the host port on 127.0.0.1.",
    );
  }
  mkdirSync(options.dataDir, { recursive: true });
  const replyDir = join(options.dataDir, "replies");
  mkdirSync(replyDir, { recursive: true });
  mkdirSync(join(replyDir, "sent"), { recursive: true });
  mkdirSync(join(replyDir, "rejected"), { recursive: true });
  const logPath = join(options.dataDir, "conversation.log");
  const queue = LocalQueue.open(join(options.dataDir, "adapter.db"));
  const remote = new RemoteMailbox(options.mailboxUrl, options.token, options.requestTimeoutMs);
  const allowedOrigins = options.allowedOrigins ?? new Set<string>();
  let profile: Agent = { id: options.agentId, capabilities: [], projects: ["*"] };
  let identityOk = false;
  let stopped: Error | null = null;
  let polling = false;
  let waking = false;
  let actualPort = options.port;

  function note(line: string): void {
    try {
      appendFileSync(logPath, line.endsWith("\n") ? line : `${line}\n`);
    } catch (error) {
      console.error("failed to append adapter log", error);
    }
  }

  function stop(error: Error): void {
    if (stopped) return;
    stopped = error;
    console.error(error.message);
    options.onFatal?.(error);
  }

  function currentStop(): Error | null {
    return stopped;
  }

  async function ensureIdentity(): Promise<boolean> {
    if (stopped) return false;
    if (identityOk) return true;
    try {
      const me = await remote.call<WhoamiResult>("whoami");
      if (me.agent_id !== options.agentId) {
        stop(new Error(`AGENT_ID ${options.agentId} does not match the token, which belongs to ${me.agent_id}`));
        return false;
      }
      profile = { id: me.agent_id, capabilities: me.capabilities, projects: me.projects };
      identityOk = true;
      return true;
    } catch (error) {
      if (error instanceof RemoteError && error.retryable) return false;
      stop(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  async function flushOutbox(): Promise<void> {
    for (const row of queue.due(Date.now())) {
      try {
        const result = await remote.call<SendToolResult>("send_message", defined(row.payload));
        queue.markSent(row.message_id);
        note(formatEnvelopeLog(result.message));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof RemoteError && !error.retryable) queue.markRejected(row.message_id, message);
        else queue.markFailed(row.message_id, message, Date.now());
      }
    }
  }

  async function pullInbox(): Promise<void> {
    const result = await remote.call<{ messages: Envelope[] }>("fetch_inbox", { limit: 10, lease_ms: 60_000 });
    for (const message of result.messages ?? []) {
      const added = queue.spool(message, Date.now());
      if (added) note(formatEnvelopeLog({ ...message, spooled: true }));
      try {
        await remote.call("acknowledge_message", { message_id: message.message_id });
      } catch (error) {
        console.error(`could not acknowledge ${message.message_id} on the mailbox`, error);
      }
    }
  }

  async function ingestReplies(): Promise<void> {
    let names: string[] = [];
    try {
      names = readdirSync(replyDir).filter((name) => name.endsWith(".json"));
    } catch {
      return;
    }
    for (const name of names) {
      const source = join(replyDir, name);
      try {
        const parsed = replySchema.parse(JSON.parse(readFileSync(source, "utf8")));
        const sent = await sendMessage({
          message_id: parsed.message_id,
          conversation_id: parsed.conversation_id,
          reply_to: parsed.reply_to,
          recipient: parsed.recipient,
          type: parsed.type,
          body: parsed.body,
          task_id: parsed.task_id,
          outcome: parsed.outcome,
          project: parsed.project,
          repo: parsed.repo,
          branch: parsed.branch,
          commit: parsed.commit,
          operation_id: parsed.operation_id,
        });
        const ackIds = new Set(parsed.acknowledge);
        if (parsed.reply_to) ackIds.add(parsed.reply_to);
        for (const id of ackIds) queue.ackLocal(id, Date.now());
        renameSync(source, join(replyDir, "sent", `${sent.message_id}.json`));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        note(`${new Date().toISOString()} rejected reply file ${name}: ${message}\n`);
        const target = join(replyDir, "rejected", name);
        try {
          renameSync(source, target);
        } catch {
          // already moved
        }
      }
    }
  }

  async function sendMessage(args: SendInput): Promise<{ queued: boolean; duplicate: boolean; message_id: string; conversation_id: string; message: Envelope | null }> {
    if (stopped) throw new MailboxError(stopped.message);
    const payload: SendInput = {
      ...args,
      message_id: args.message_id ?? randomUUID(),
      conversation_id: args.conversation_id ?? randomUUID(),
    };
    const ready = await ensureIdentity();
    const fatal = currentStop();
    if (fatal) throw new MailboxError(fatal.message);
    if (!ready) {
      queue.enqueue(payload.message_id!, payload, Date.now());
      note(`${new Date().toISOString()} queued ${payload.message_id} to ${payload.recipient} (mailbox unreachable)\n\n`);
      return {
        queued: true,
        duplicate: false,
        message_id: payload.message_id!,
        conversation_id: payload.conversation_id!,
        message: null,
      };
    }
    try {
      const result = await remote.call<SendToolResult>("send_message", defined(payload));
      queue.markSent(payload.message_id!);
      note(formatEnvelopeLog(result.message));
      return {
        queued: false,
        duplicate: result.duplicate,
        message_id: result.message.message_id,
        conversation_id: result.message.conversation_id,
        message: result.message,
      };
    } catch (error) {
      if (error instanceof RemoteError && error.retryable) {
        queue.enqueue(payload.message_id!, payload, Date.now());
        note(`${new Date().toISOString()} queued ${payload.message_id} to ${payload.recipient} (mailbox unreachable)\n\n`);
        return {
          queued: true,
          duplicate: false,
          message_id: payload.message_id!,
          conversation_id: payload.conversation_id!,
          message: null,
        };
      }
      throw error;
    }
  }

  async function pollOnce(): Promise<void> {
    if (polling || stopped) return;
    polling = true;
    try {
      const ready = await ensureIdentity();
      if (!ready || stopped) return;
      await flushOutbox();
      await pullInbox();
      await ingestReplies();
    } catch (error) {
      console.error("adapter poll failed", error);
    } finally {
      polling = false;
    }
  }

  async function maybeWake(): Promise<void> {
    if (waking || options.wake === "off" || stopped) return;
    const batch = queue.pendingWake(5);
    if (batch.length === 0) return;
    waking = true;
    const ids = batch.map((message) => message.message_id);
    const conversationIds = [...new Set(batch.map((message) => message.conversation_id))];
    const resumeChatId = conversationIds.length === 1 ? queue.session(conversationIds[0]) : undefined;
    try {
      const result = await wakeAgent({
        client: options.wakeClient,
        mode: options.wake,
        workspace: options.workspace,
        mcpConfigPath: resolve(options.dataDir, "claude-mcp.json"),
        mcpUrl: url,
        mcpToken: options.token,
        deliveryPath: resolve(options.dataDir, "current-delivery.json"),
        agent: profile,
        messages: batch,
        replyDirectory: resolve(replyDir),
        resumeChatId,
        timeoutMs: options.wakeTimeoutMs,
      });
      if (result.ok) queue.markHanded(ids, Date.now(), 10 * 60 * 1000);
      else queue.markWakeFailed(ids, Date.now());
      if (result.chatId && conversationIds.length === 1) queue.saveSession(conversationIds[0], result.chatId);
      note(`${new Date().toISOString()} wake ${result.ok ? "handed" : "failed"} ${ids.join(",")}\n\n`);
    } catch (error) {
      console.error("wake failed", error);
      queue.markWakeFailed(ids, Date.now());
    } finally {
      waking = false;
    }
  }

  const app = express();
  app.disable("x-powered-by");
  app.get("/", (_req, res) => res.redirect("/dashboard"));
  app.get("/favicon.svg", (_req, res) => {
    res.set("Cache-Control", "public, max-age=86400").type("image/svg+xml").send(faviconSvg);
  });
  app.get("/favicon.ico", (_req, res) => {
    res.set("Cache-Control", "public, max-age=86400").type("image/x-icon").send(faviconIco());
  });
  // Read-only local dashboard. No token: the Host header must be loopback so a hostile page cannot read it through DNS rebinding.
  function loopbackHost(req: Request): boolean {
    const host = (req.header("host") ?? "").toLowerCase();
    return host === `127.0.0.1:${actualPort}` || host === `localhost:${actualPort}` || host === `[::1]:${actualPort}`;
  }
  app.get("/dashboard", (req, res) => {
    if (!loopbackHost(req)) {
      res.status(403).type("text/plain").send("Forbidden host");
      return;
    }
    res
      .set("Cache-Control", "no-store")
      .set("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'")
      .set("X-Content-Type-Options", "nosniff")
      .type("html")
      .send(dashboardHtml);
  });
  app.get("/api/dashboard", async (req, res) => {
    if (!loopbackHost(req)) {
      res.status(403).json({ error: "Forbidden host" });
      return;
    }
    const attempt = async <T,>(call: () => Promise<T>): Promise<{ value: T | null; error: string | null }> => {
      try {
        return { value: await call(), error: null };
      } catch (error) {
        return { value: null, error: error instanceof Error ? error.message : String(error) };
      }
    };
    const [agents, remoteStatus] = identityOk
      ? await Promise.all([attempt(() => remote.call("list_agents")), attempt(() => remote.call("queue_status"))])
      : [{ value: null, error: "mailbox unreachable" }, { value: null, error: "mailbox unreachable" }];
    let log = "";
    try {
      log = readFileSync(logPath, "utf8").slice(-6000);
    } catch {
      log = "";
    }
    res.set("Cache-Control", "no-store").json({
      generated_at: new Date().toISOString(),
      agent: profile,
      mailbox: {
        url: options.mailboxUrl,
        candidates: [options.mailboxUrl],
        connected: identityOk,
        fatal: stopped ? stopped.message : null,
      },
      wake: { mode: options.wake, client: options.wakeClient ?? "cursor" },
      agents: agents.value,
      agents_error: agents.error,
      remote: remoteStatus.value,
      remote_error: remoteStatus.error,
      local: queue.counts(),
      outbox: queue.outboxRows(20),
      recent: queue.recent(25),
      log,
    });
  });
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "adapter", agent_id: options.agentId, mailbox: identityOk ? "connected" : "unreachable" });
  });
  app.get("/log", (req, res) => {
    if (!authorized(req, options.token)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      res.type("text/plain").send(readFileSync(logPath, "utf8"));
    } catch {
      res.type("text/plain").send("");
    }
  });
  app.post("/mcp", express.json({ limit: "1mb" }), async (req, res) => {
    if (!originAllowed(req.header("origin") || undefined, allowedOrigins)) {
      res.status(403).json({ error: "Forbidden origin" });
      return;
    }
    // Cursor's HTTP client sends no static bearer. Loopback is the same trust boundary as the dashboard.
    if (!authorized(req, options.token) && !loopbackHost(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    await handleMcp(req, res, (server) => registerAdapterTools(server));
  });
  app.get("/mcp", (_req, res) => methodNotAllowed(res));
  app.delete("/mcp", (_req, res) => methodNotAllowed(res));

  function registerAdapterTools(server: McpServer): void {
    server.tool(
      "whoami",
      "Return this PC's agent id. The mailbox token, not the tool arguments, decides who the sender is.",
      {},
      async () => {
        try {
          await ensureIdentity();
          if (stopped) throw new MailboxError(stopped.message);
          return ok({
            ok: true,
            agent_id: profile.id,
            capabilities: profile.capabilities,
            projects: profile.projects,
            mailbox: identityOk ? "connected" : "unreachable",
          });
        } catch (error) {
          return toolError(error);
        }
      },
    );

    server.tool(
      "list_agents",
      "List agents registered on the shared mailbox.",
      {},
      async () => {
        try {
          if (stopped) throw new MailboxError(stopped.message);
          return ok(await remote.call("list_agents"));
        } catch (error) {
          return toolError(error);
        }
      },
    );

    server.tool(
      "send_message",
      "Send a message through the shared mailbox. If the mailbox host is offline, the message is stored on this PC and retried. Sender is the authenticated agent.",
      sendShape,
      async (args) => {
        try {
          return ok({ ok: true, ...(await sendMessage(args)) });
        } catch (error) {
          return toolError(error);
        }
      },
    );

    server.tool(
      "fetch_inbox",
      "Return messages this PC has received for its agent. The adapter stores them locally, so an acknowledgement here confirms local handling and does not by itself finish a task.",
      fetchShape,
      async (args) => {
        try {
          if (!stopped) {
            const ready = await ensureIdentity();
            if (ready) await pullInbox();
          }
          const messages = queue.leaseLocal(args.limit ?? 5, args.lease_ms ?? 60_000, Date.now());
          return ok({ ok: true, messages });
        } catch (error) {
          return toolError(error);
        }
      },
    );

    server.tool(
      "acknowledge_message",
      "Confirm this PC has handled a spooled message. This does not mark a task complete.",
      messageIdShape,
      async (args) => {
        try {
          if (!queue.ackLocal(args.message_id, Date.now())) throw new MailboxError("message not found");
          return ok({ ok: true, message_id: args.message_id, delivery: "acked" });
        } catch (error) {
          return toolError(error);
        }
      },
    );

    server.tool(
      "release_message",
      "Put a spooled message back in this PC's local inbox so it can be fetched or woken again.",
      messageIdShape,
      async (args) => {
        try {
          if (!queue.releaseLocal(args.message_id, Date.now())) {
            throw new MailboxError("message is not waiting locally");
          }
          return ok({ ok: true, message_id: args.message_id, delivery: "pending" });
        } catch (error) {
          return toolError(error);
        }
      },
    );

    server.tool(
      "get_thread",
      "Read a conversation from the shared mailbox. If the host is offline, return the messages already spooled on this PC.",
      threadShape,
      async (args) => {
        try {
          if (stopped) throw new MailboxError(stopped.message);
          try {
            return ok(await remote.call("get_thread", defined({ conversation_id: args.conversation_id, limit: args.limit })));
          } catch (error) {
            if (!(error instanceof RemoteError) || !error.retryable) throw error;
            const messages = [
              ...queue.messagesIn(args.conversation_id),
              ...queue.queuedFor(args.conversation_id),
            ];
            if (messages.length === 0) {
              throw new MailboxError("mailbox unreachable and this conversation is not in the local spool");
            }
            return ok({ ok: true, partial: true, conversation_id: args.conversation_id, messages });
          }
        } catch (error) {
          return toolError(error);
        }
      },
    );

    server.tool(
      "queue_status",
      "Show the local outbox and spool, plus the shared mailbox counts when the host is reachable.",
      {},
      async () => {
        try {
          let remoteStatus: unknown = null;
          let remoteError: string | null = null;
          try {
            remoteStatus = await remote.call("queue_status");
          } catch (error) {
            remoteError = error instanceof Error ? error.message : String(error);
          }
          return ok({ ok: true, local: queue.counts(), remote: remoteStatus, remote_error: remoteError });
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  const server = createServer(app);
  await listen(server, options.port, options.bind);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("adapter did not bind a TCP port");
  actualPort = address.port;
  const url = `http://127.0.0.1:${address.port}/mcp`;
  writeFileSync(
    join(options.dataDir, "cursor-mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          "agent-mailbox": {
            url,
            headers: { Authorization: `Bearer ${options.token}` },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  writeFileSync(
    join(options.dataDir, "claude-mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          "agent-mailbox": {
            type: "http",
            url,
            headers: { Authorization: `Bearer ${options.token}` },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const antigravityHeaders = { Authorization: `Bearer ${options.token}` };
  writeFileSync(
    join(options.dataDir, "antigravity-mcp.json"),
    JSON.stringify({ mcpServers: { "agent-mailbox": { url, headers: antigravityHeaders } } }, null, 2),
    "utf8",
  );
  writeFileSync(
    join(options.dataDir, "mcp_config.json"),
    JSON.stringify(
      { mcpServers: { "agent-mailbox": { serverUrl: url, headers: antigravityHeaders } } },
      null,
      2,
    ),
    "utf8",
  );

  writeFileSync(
    join(options.dataDir, "codex-mcp.toml"),
    `[mcp_servers.agent-mailbox]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "AGENT_TOKEN"\n`,
    "utf8",
  );

  const pollMs = Math.max(200, options.pollMs);
  const timer = setInterval(() => {
    void pollOnce().finally(() => {
      void maybeWake();
    });
  }, pollMs);
  void pollOnce().finally(() => {
    void maybeWake();
  });

  return {
    url,
    port: address.port,
    logPath,
    close: async () => {
      clearInterval(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await remote.close();
      queue.close();
    },
  };
}

export function adapterOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): AdapterServerOptions {
  const token = env.AGENT_TOKEN ?? "";
  const agentId = env.AGENT_ID ?? "";
  const mailboxUrl = env.MAILBOX_URL ?? "";
  if (!mailboxUrl || !token || !agentId) {
    throw new Error("The adapter requires MAILBOX_URL, AGENT_ID, and AGENT_TOKEN.");
  }

  const wake = parseWakeMode(env.WAKE);
  const wakeClient = parseWakeClient(env.WAKE_CLIENT);
  if (
    wake !== "off" &&
    (wakeClient === "codex" || wakeClient === "gemini" || wakeClient === "antigravity") &&
    !env.WAKE_WORKSPACE
  ) {
    throw new Error(`WAKE_WORKSPACE is required when WAKE_CLIENT=${wakeClient} and WAKE is enabled.`);
  }
  return {
    mailboxUrl,
    token,
    agentId,
    port: Number(env.ADAPTER_PORT ?? 8788),
    bind: env.ADAPTER_BIND ?? "127.0.0.1",
    container: env.ADAPTER_CONTAINER === "1",
    dataDir: env.ADAPTER_DATA_DIR ?? "data/adapter",
    pollMs: Number(env.POLL_MS ?? 5000),
    wake,
    wakeClient,
    workspace: env.WAKE_WORKSPACE || undefined,
    wakeTimeoutMs: Number(env.WAKE_TIMEOUT_MS ?? 600_000),
    requestTimeoutMs: Number(env.MAILBOX_TIMEOUT_MS ?? 20_000),
    allowedOrigins: new Set(
      (env.MAILBOX_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  };
}

function defined(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }],
  };
}

function toolError(error: unknown) {
  if (error instanceof MailboxError || error instanceof RemoteError) return fail(error.message);
  console.error(error);
  return fail("internal error");
}

function authorized(req: Request, token: string): boolean {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return Boolean(match?.[1] && tokensEqual(match[1].trim(), token));
}

function methodNotAllowed(res: Response): void {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. POST JSON-RPC to this URL." },
    id: null,
  });
}

function listen(server: ReturnType<typeof createServer>, port: number, bind: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => resolve());
  });
}
