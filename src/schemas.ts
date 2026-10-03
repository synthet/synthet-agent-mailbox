import { z } from "zod";
import { MESSAGE_TYPES } from "./types.js";

const bodyObject = z
  .object({
    text: z.string().min(1).describe("The request or response itself"),
    evidence: z.string().optional().describe("Logs, diffs, or other evidence the recipient needs"),
    constraints: z.string().optional().describe("Limits the recipient must respect"),
    expected: z.string().optional().describe("What a finished reply should contain"),
  })
  .strict();

export const bodySchema = z.union([
  z.string().min(1).describe("Message text"),
  bodyObject,
]);

export const sendShape = {
  recipient: z.string().min(1).describe("Recipient agent id from list_agents"),
  type: z.enum(MESSAGE_TYPES).describe("question, answer, task, progress, or result"),
  body: bodySchema.describe("Request or response content"),
  conversation_id: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe("Existing conversation, or a new id to reuse across retries"),
  reply_to: z.string().min(1).max(80).optional().describe("message_id this message answers"),
  message_id: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe("Client id for deduplication. Replays return the original message"),
  deadline: z
    .union([z.string(), z.number()])
    .optional()
    .describe("ISO-8601 time or epoch milliseconds after which the message is no longer actionable"),
  task_id: z.string().min(1).max(80).optional().describe("Task this message belongs to"),
  project: z.string().min(1).max(200).optional().describe("Project id both agents are allowed to use"),
  repo: z.string().min(1).max(200).optional().describe("Repository name or URL. Paths are not shared across PCs"),
  branch: z.string().min(1).max(200).optional().describe("Git branch"),
  commit: z.string().min(1).max(80).optional().describe("Commit SHA"),
  operation_id: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe("Idempotency key for this sender. Reuse it when retrying the same send"),
  outcome: z
    .enum(["success", "failure"])
    .optional()
    .describe("For result messages: success completes the task, failure marks it failed"),
  max_turns: z
    .number()
    .int()
    .min(2)
    .max(200)
    .optional()
    .describe("Turn cap when creating a conversation. Cannot exceed the server cap"),
};

export const fetchShape = {
  limit: z.number().int().min(1).max(50).optional().describe("Maximum messages to lease"),
  lease_ms: z
    .number()
    .int()
    .min(1000)
    .max(600_000)
    .optional()
    .describe("How long this worker holds the messages before they can be retried"),
};

export const messageIdShape = {
  message_id: z.string().min(1).describe("Message id to update"),
};

export const threadShape = {
  conversation_id: z.string().min(1).describe("Conversation to read"),
  limit: z.number().int().min(1).max(500).optional().describe("Maximum messages to return"),
};
