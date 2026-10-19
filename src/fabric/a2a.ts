import { randomUUID } from "node:crypto";
import type { Journal } from "./journal.js";

const STATES: Record<string, string> = {
  offered: "submitted", pending: "submitted", accepted: "working", working: "working",
  completed: "completed", failed: "failed", cancelled: "canceled",
};

/** A2A v1 subset: Agent Card, SendMessage, GetTask, ListTasks, CancelTask. Not a conformance claim. */
export function a2aCard(baseUrl: string): Record<string, unknown> {
  return {
    name: "synthet-agent-mailbox",
    description: "Directed mailbox messages and tasks. Broadcasts, offline replication, and project ACLs stay outside A2A.",
    capabilities: { extendedAgentCard: false, streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{ id: "mailbox", name: "Mailbox", description: "Record a directed message and a mailbox task." }],
    supportedInterfaces: [{ url: `${baseUrl}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0.0" }],
  };
}

export function handleA2A(journal: Journal, request: unknown): Record<string, unknown> {
  const body = request as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  const id = body.id ?? null;
  if (body.jsonrpc !== "2.0" || !body.method) return rpcError(id, -32600, "Invalid Request");
  try {
    if (body.method === "SendMessage") return rpc(id, sendMessage(journal, body.params ?? {}));
    if (body.method === "GetTask") return rpc(id, getTask(journal, String(body.params?.id ?? "")));
    if (body.method === "ListTasks") return rpc(id, { tasks: journal.listTasks().map((task) => toTask(journal, task.task_id)) });
    if (body.method === "CancelTask") return rpc(id, cancelTask(journal, String(body.params?.id ?? "")));
    return rpcError(id, -32601, "Method not found");
  } catch (error) {
    return rpcError(id, -32000, error instanceof Error ? error.message : "A2A request failed");
  }
}

function sendMessage(journal: Journal, params: Record<string, unknown>): Record<string, unknown> {
  const message = params.message as { messageId?: string; role?: string; parts?: { text?: string }[]; contextId?: string } | undefined;
  const text = message?.parts?.map((part) => part.text ?? "").join("") ?? "";
  if (!text.trim()) throw new Error("SendMessage requires a text part");
  journal.registerSession({ session_id: "a2a", alias: journal.identity.name, harness: "a2a" });
  const taskId = randomUUID();
  journal.offerTask("a2a", { task_id: taskId, scope_id: "a2a", title: text.slice(0, 80) });
  const published = journal.publish({
    session_id: "a2a", audience: { kind: "group", scope_id: "a2a" }, body: text, subject: text.slice(0, 80),
    correlation_id: message?.contextId ?? message?.messageId ?? taskId, semantic: "request",
  });
  journal.db.prepare("UPDATE tasks SET claim_agent = ? WHERE task_id = ?").run("a2a-message", taskId);
  return toTask(journal, taskId, published.message_id, message?.messageId);
}

function getTask(journal: Journal, taskId: string): Record<string, unknown> {
  if (!taskId) throw new Error("GetTask requires id");
  return toTask(journal, taskId);
}

function cancelTask(journal: Journal, taskId: string): Record<string, unknown> {
  journal.registerSession({ session_id: "a2a", alias: journal.identity.name, harness: "a2a" });
  journal.updateTask("a2a", taskId, "cancelled");
  return toTask(journal, taskId);
}

function toTask(journal: Journal, taskId: string, mailboxMessageId?: string, requestMessageId?: string): Record<string, unknown> {
  const task = journal.task(taskId);
  return {
    id: task.task_id,
    contextId: task.task_id,
    status: { state: STATES[task.state] ?? "submitted", timestamp: new Date().toISOString() },
    metadata: { mailboxMessageId: mailboxMessageId ?? null, mailboxState: task.state, fencing: task.fencing, requestMessageId: requestMessageId ?? null },
    history: mailboxMessageId ? [{ messageId: requestMessageId ?? mailboxMessageId, role: "user", parts: [{ text: task.title }] }] : [],
  };
}

function rpc(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
