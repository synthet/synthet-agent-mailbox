import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { assertBindAllowed, loadDirectory, originAllowed, type Directory } from "./config.js";
import { formatEnvelopeLog, Mailbox } from "./mailbox.js";
import { registerMailboxTools } from "./tools.js";

export interface MailboxServerOptions {
  port: number;
  bind: string;
  dataDir: string;
  agentsFile: string;
  allowedOrigins?: Set<string>;
  allowPublicBind?: boolean;
  clock?: () => number;
}

export interface RunningMailbox {
  url: string;
  port: number;
  logPath: string;
  agentIds: string[];
  close: () => Promise<void>;
}

export async function startMailbox(options: MailboxServerOptions): Promise<RunningMailbox> {
  assertBindAllowed(options.bind, options.allowPublicBind ?? false);
  mkdirSync(options.dataDir, { recursive: true });
  const directory = loadDirectory(options.agentsFile);
  const logPath = join(options.dataDir, "conversation.log");
  const mailbox = Mailbox.open(join(options.dataDir, "mailbox.db"), directory, {
    clock: options.clock,
    logPath,
  });
  const allowedOrigins = options.allowedOrigins ?? new Set<string>();
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "mailbox" });
  });

  app.get("/log", (req, res) => {
    const actor = directory.byToken(bearer(req));
    if (!actor) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const text = mailbox.recent(actor, 200).map((message) => formatEnvelopeLog(message)).join("");
    res.type("text/plain").send(text);
  });

  app.post("/mcp", express.json({ limit: "1mb" }), async (req, res) => {
    if (!originAllowed(headerString(req, "origin"), allowedOrigins)) {
      res.status(403).json({ error: "Forbidden origin" });
      return;
    }
    const actor = directory.byToken(bearer(req));
    if (!actor) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    await handleMcp(req, res, (server) => registerMailboxTools(server, mailbox, actor));
  });

  app.get("/mcp", (_req, res) => methodNotAllowed(res));
  app.delete("/mcp", (_req, res) => methodNotAllowed(res));

  const server = createServer(app);
  await listen(server, options.port, options.bind);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mailbox did not bind a TCP port");
  const host = options.bind === "0.0.0.0" || options.bind === "::" ? "127.0.0.1" : options.bind;
  return {
    url: `http://${host}:${address.port}/mcp`,
    port: address.port,
    logPath,
    agentIds: directory.list().map((agent) => agent.id),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      mailbox.close();
    },
  };
}

export async function handleMcp(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
  register: (server: McpServer) => void,
): Promise<void> {
  const server = new McpServer({ name: "agent-mailbox", version: "0.2.0" }, { capabilities: { tools: {} } });
  register(server);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request error:", error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
    }
  }
}

function methodNotAllowed(res: Response): void {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. POST JSON-RPC to this URL." },
    id: null,
  });
}

function bearer(req: Request): string {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? "";
}

function headerString(req: Request, name: string): string | undefined {
  const value = req.header(name);
  return value || undefined;
}

function listen(server: ReturnType<typeof createServer>, port: number, bind: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, bind);
  });
}
