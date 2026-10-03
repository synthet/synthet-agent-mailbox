export const MESSAGE_TYPES = ["question", "answer", "task", "progress", "result"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const TASK_STATUSES = ["open", "waiting", "in_progress", "completed", "failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const DELIVERY_STATUSES = ["pending", "leased", "acked", "expired", "dead"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface MessageBody {
  text: string;
  evidence?: string;
  constraints?: string;
  expected?: string;
}

/** Wire envelope stored by the mailbox and returned by the tools. */
export interface Envelope {
  message_id: string;
  conversation_id: string;
  reply_to: string | null;
  sender: string;
  recipient: string;
  type: MessageType;
  deadline: string | null;
  body: MessageBody;
  task_id: string | null;
  task_status: TaskStatus | null;
  project: string | null;
  repo: string | null;
  branch: string | null;
  commit: string | null;
  operation_id: string | null;
  delivery: DeliveryStatus;
  attempt: number;
  lease_until: string | null;
  created_at: string;
  spooled?: boolean;
}

export interface TaskRecord {
  id: string;
  conversation_id: string;
  owner: string;
  requester: string;
  status: TaskStatus;
  deadline: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationRecord {
  id: string;
  created_by: string;
  turn_count: number;
  max_turns: number;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: string;
  capabilities: string[];
  projects: string[];
}

export interface SendInput {
  recipient: string;
  type: MessageType;
  body: string | MessageBody;
  conversation_id?: string;
  reply_to?: string;
  message_id?: string;
  deadline?: string | number;
  task_id?: string;
  project?: string;
  repo?: string;
  branch?: string;
  commit?: string;
  operation_id?: string;
  outcome?: "success" | "failure";
  max_turns?: number;
}
