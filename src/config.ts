import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Agent } from "./types.js";

const agentSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,63}$/, "agent id must be lowercase words separated by hyphens"),
  token: z.string().min(16, "token must be at least 16 characters"),
  capabilities: z.array(z.string().regex(/^[a-z0-9-]{1,40}$/)).default([]),
  projects: z.array(z.string().min(1).max(200)).default(["*"]),
});

export const agentsFileSchema = z.object({
  maxTurns: z.number().int().min(2).max(200).default(30),
  maxOpenTasks: z.number().int().min(1).max(100).default(10),
  maxAttempts: z.number().int().min(1).max(20).default(5),
  agents: z.array(agentSchema).min(1),
});

export type AgentsFile = z.infer<typeof agentsFileSchema>;

export class Directory {
  readonly maxTurns: number;
  readonly maxOpenTasks: number;
  readonly maxAttempts: number;
  private readonly byIdMap = new Map<string, Agent>();
  private readonly byHash = new Map<string, Agent>();

  constructor(file: AgentsFile) {
    this.maxTurns = file.maxTurns;
    this.maxOpenTasks = file.maxOpenTasks;
    this.maxAttempts = file.maxAttempts;
    const seenTokens = new Set<string>();
    for (const entry of file.agents) {
      if (entry.token.startsWith("replace-me")) {
        throw new Error(`Replace the placeholder token for ${entry.id}. Run npm run init.`);
      }
      if (this.byIdMap.has(entry.id)) throw new Error(`Duplicate agent id ${entry.id}`);
      if (seenTokens.has(entry.token)) throw new Error(`Duplicate token for ${entry.id}`);
      seenTokens.add(entry.token);
      const agent: Agent = {
        id: entry.id,
        capabilities: entry.capabilities,
        projects: entry.projects,
      };
      this.byIdMap.set(agent.id, agent);
      this.byHash.set(hashToken(entry.token), agent);
    }
  }

  byId(id: string): Agent | undefined {
    return this.byIdMap.get(id);
  }

  byToken(token: string): Agent | undefined {
    return this.byHash.get(hashToken(token));
  }

  list(): Agent[] {
    return [...this.byIdMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function directoryFrom(input: unknown): Directory {
  return new Directory(agentsFileSchema.parse(input));
}

export function loadDirectory(file: string): Directory {
  if (!existsSync(file)) {
    throw new Error(`Agents file not found: ${file}. Run npm run init.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${file}: ${message}`);
  }
  try {
    return directoryFrom(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const details = error.issues.map((issue) => `${issue.path.join(".") || "file"}: ${issue.message}`).join("; ");
      throw new Error(`Invalid ${file}: ${details}`);
    }
    throw error;
  }
}

export function loadEnvFile(file = ".env"): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function isLoopback(bind: string): boolean {
  return bind === "127.0.0.1" || bind === "localhost" || bind === "::1";
}

export function assertBindAllowed(bind: string, allowPublic: boolean): void {
  if (isLoopback(bind)) return;
  if (bind === "0.0.0.0" || bind === "::" || bind === "") {
    if (!allowPublic) {
      throw new Error(
        "Refusing to listen on every interface. Set BIND to this PC's Tailscale IP, or set ALLOW_PUBLIC_BIND=1 if a firewall already limits the port.",
      );
    }
    return;
  }
}

export function parseOrigins(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function originAllowed(origin: string | undefined, allowed: Set<string>): boolean {
  if (!origin) return true;
  if (allowed.size === 0) return true;
  return allowed.has(origin);
}

export function readPort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

export function isDirectRun(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const expected = pathToFileURL(entry).href;
  if (expected === moduleUrl) return true;
  return process.platform === "win32" && expected.toLowerCase() === moduleUrl.toLowerCase();
}

export function allowsProject(agent: Agent, project: string): boolean {
  return agent.projects.includes("*") || agent.projects.includes(project);
}
