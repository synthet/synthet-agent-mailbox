import assert from "node:assert/strict";
import { test } from "node:test";
import { assertBindAllowed, directoryFrom, type Directory } from "../src/config.js";
import { Mailbox } from "../src/mailbox.js";
import type { Agent, SendInput } from "../src/types.js";

const DESKTOP_TOKEN = "desktop-token-value";
const LAPTOP_TOKEN = "laptop-token-value1";

function createMailbox(options?: {
  maxTurns?: number;
  maxOpenTasks?: number;
  maxAttempts?: number;
  projects?: { desktop?: string[]; laptop?: string[] };
  clock?: () => number;
  extraAgents?: Array<{ id: string; token: string; capabilities?: string[]; projects?: string[] }>;
}) {
  const directory = directoryFrom({
    maxTurns: options?.maxTurns ?? 30,
    maxOpenTasks: options?.maxOpenTasks ?? 10,
    maxAttempts: options?.maxAttempts ?? 5,
    agents: [
      {
        id: "desktop-builder",
        token: DESKTOP_TOKEN,
        capabilities: ["build", "edit"],
        projects: options?.projects?.desktop ?? ["*"],
      },
      {
        id: "laptop-reviewer",
        token: LAPTOP_TOKEN,
        capabilities: ["review"],
        projects: options?.projects?.laptop ?? ["*"],
      },
      ...(options?.extraAgents ?? []).map((agent) => ({
        capabilities: [],
        projects: ["*"],
        ...agent,
      })),
    ],
  });
  const mailbox = Mailbox.open(":memory:", directory, { clock: options?.clock });
  const desktop = mustAgent(directory, "desktop-builder");
  const laptop = mustAgent(directory, "laptop-reviewer");
  return { mailbox, directory, desktop, laptop };
}

function mustAgent(directory: Directory, id: string): Agent {
  const agent = directory.byId(id);
  if (!agent) throw new Error(`missing ${id}`);
  return agent;
}

function task(from: Agent, to: string, text: string, extra: Partial<SendInput> = {}) {
  return {
    recipient: to,
    type: "task" as const,
    body: text,
    ...extra,
  };
}

test("attributes the sender from the authenticated agent", () => {
  const { mailbox, desktop, laptop } = createMailbox();
  const sent = mailbox.send(desktop, task(desktop, laptop.id, "Inspect the login change"));
  assert.equal(sent.duplicate, false);
  assert.equal(sent.message.sender, desktop.id);
  assert.equal(sent.message.recipient, laptop.id);
  assert.equal(sent.message.type, "task");
  assert.equal(sent.message.delivery, "pending");
  assert.equal(sent.message.task_status, "open");
  assert.equal(sent.message.body.text, "Inspect the login change");
  const listed = JSON.stringify(mailbox.listAgents());
  assert.equal(listed.includes(DESKTOP_TOKEN), false);
  assert.equal(mailbox.whoami(desktop).agent_id, desktop.id);
  mailbox.close();
});

test("deduplicates message_id and operation_id", () => {
  const { mailbox, desktop, laptop } = createMailbox();
  const first = mailbox.send(desktop, task(desktop, laptop.id, "once", { message_id: "msg-fixed-001", operation_id: "op-fixed-001" }));
  const replay = mailbox.send(desktop, task(desktop, laptop.id, "changed text", { message_id: "msg-fixed-001" }));
  const sameOperation = mailbox.send(
    desktop,
    task(desktop, laptop.id, "again", { message_id: "msg-fixed-002", operation_id: "op-fixed-001" }),
  );
  assert.equal(replay.duplicate, true);
  assert.equal(replay.message.message_id, first.message.message_id);
  assert.equal(replay.message.body.text, "once");
  assert.equal(sameOperation.duplicate, true);
  assert.equal(sameOperation.message.message_id, first.message.message_id);
  assert.equal(mailbox.getThread(desktop, first.message.conversation_id).conversation.turn_count, 1);
  assert.throws(
    () => mailbox.send(laptop, task(laptop, desktop.id, "steal", { message_id: "msg-fixed-001" })),
    /belongs to another agent/,
  );
  mailbox.close();
});

test("leases, acknowledges, and retries with backoff until dead", () => {
  const clock = { now: 1_700_000_000_000 };
  const { mailbox, desktop, laptop } = createMailbox({ maxAttempts: 2, clock: () => clock.now });
  const sent = mailbox.send(desktop, task(desktop, laptop.id, "retry me"));
  const first = mailbox.fetchInbox(laptop, 5, 1_000);
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0]?.attempt, 1);
  assert.equal(first.messages[0]?.delivery, "leased");
  assert.equal(mailbox.fetchInbox(laptop).messages.length, 0);
  clock.now += 1_001;
  const redeivered = mailbox.fetchInbox(laptop, 5, 1_000);
  assert.equal(redeivered.messages[0]?.message_id, sent.message.message_id);
  assert.equal(redeivered.messages[0]?.attempt, 2);

  const released = mailbox.release(laptop, sent.message.message_id);
  assert.equal(released.delivery, "dead");
  assert.equal(mailbox.fetchInbox(laptop).messages.length, 0);
  assert.equal(mailbox.getThread(desktop, sent.message.conversation_id).messages[0]?.delivery, "dead");
  assert.throws(() => mailbox.release(desktop, sent.message.message_id), /not found/);
  mailbox.close();
});

test("acknowledgement is idempotent and is not task completion", () => {
  const { mailbox, desktop, laptop } = createMailbox();
  const sent = mailbox.send(desktop, task(desktop, laptop.id, "ack me"));
  mailbox.fetchInbox(laptop);
  assert.equal(mailbox.acknowledge(laptop, sent.message.message_id).delivery, "acked");
  assert.equal(mailbox.acknowledge(laptop, sent.message.message_id).delivery, "acked");
  assert.throws(() => mailbox.acknowledge(desktop, sent.message.message_id), /not found/);
  const thread = mailbox.getThread(laptop, sent.message.conversation_id);
  assert.equal(thread.messages[0]?.delivery, "acked");
  assert.equal(thread.tasks[0]?.status, "open");
  mailbox.close();
});

test("expires messages and fails tasks after the deadline", () => {
  const clock = { now: 1_700_000_000_000 };
  const { mailbox, desktop, laptop } = createMailbox({ clock: () => clock.now });
  const sent = mailbox.send(
    desktop,
    task(desktop, laptop.id, "soon", { deadline: clock.now + 500 }),
  );
  clock.now += 500;
  assert.equal(mailbox.fetchInbox(laptop).messages.length, 0);
  const thread = mailbox.getThread(desktop, sent.message.conversation_id);
  assert.equal(thread.messages[0]?.delivery, "expired");
  assert.equal(thread.tasks[0]?.status, "failed");
  assert.throws(
    () =>
      mailbox.send(laptop, {
        recipient: desktop.id,
        type: "result",
        task_id: sent.message.task_id ?? undefined,
        outcome: "success",
        body: "too late",
      }),
    /deadline has passed/,
  );
  mailbox.close();
});

test("keeps one owner and blocks circular questions", () => {
  const { mailbox, desktop, laptop } = createMailbox();
  const sent = mailbox.send(desktop, task(desktop, laptop.id, "Fix the test"));
  const taskId = sent.message.task_id ?? "";
  assert.throws(
    () =>
      mailbox.send(desktop, {
        recipient: laptop.id,
        type: "result",
        task_id: taskId,
        body: "I did it myself",
      }),
    /only the task owner/,
  );
  const question = mailbox.send(laptop, {
    recipient: desktop.id,
    type: "question",
    task_id: taskId,
    conversation_id: sent.message.conversation_id,
    body: "Which file?",
  });
  assert.equal(question.message.task_status, "waiting");
  assert.throws(
    () =>
      mailbox.send(desktop, {
        recipient: laptop.id,
        type: "question",
        conversation_id: sent.message.conversation_id,
        body: "Why do you ask?",
      }),
    /outstanding question/,
  );
  const answer = mailbox.send(desktop, {
    recipient: laptop.id,
    type: "answer",
    reply_to: question.message.message_id,
    body: "src/login.ts",
  });
  assert.equal(answer.message.task_status, "in_progress");
  assert.throws(
    () => mailbox.send(laptop, { recipient: desktop.id, type: "answer", body: "missing reply" }),
    /reply_to/,
  );
  const done = mailbox.send(laptop, {
    recipient: desktop.id,
    type: "result",
    task_id: taskId,
    conversation_id: sent.message.conversation_id,
    outcome: "success",
    repo: "example/app",
    branch: "main",
    commit: "abc1234",
    body: { text: "Fixed", evidence: "test passed" },
  });
  assert.equal(done.message.task_status, "completed");
  assert.equal(done.message.commit, "abc1234");
  assert.throws(
    () =>
      mailbox.send(laptop, {
        recipient: desktop.id,
        type: "progress",
        task_id: taskId,
        body: "still going",
      }),
    /already finished/,
  );
  mailbox.close();
});

test("stops a conversation at its turn limit but still accepts a result", () => {
  const { mailbox, desktop, laptop } = createMailbox({ maxTurns: 2 });
  const sent = mailbox.send(desktop, task(desktop, laptop.id, "short"));
  mailbox.send(laptop, {
    recipient: desktop.id,
    type: "progress",
    task_id: sent.message.task_id ?? undefined,
    conversation_id: sent.message.conversation_id,
    body: "started",
  });
  assert.throws(
    () =>
      mailbox.send(laptop, {
        recipient: desktop.id,
        type: "question",
        task_id: sent.message.task_id ?? undefined,
        conversation_id: sent.message.conversation_id,
        body: "one more thing?",
      }),
    /reached 2 turns/,
  );
  const done = mailbox.send(laptop, {
    recipient: desktop.id,
    type: "result",
    task_id: sent.message.task_id ?? undefined,
    conversation_id: sent.message.conversation_id,
    body: "finished inside the cap",
  });
  assert.equal(done.message.task_status, "completed");
  mailbox.close();
});

test("hides conversations from agents that are not in them", () => {
  const { mailbox, directory, desktop, laptop } = createMailbox({
    extraAgents: [{ id: "other-agent", token: "other-agent-token1" }],
  });
  const other = mustAgent(directory, "other-agent");
  const sent = mailbox.send(desktop, task(desktop, laptop.id, "private"));
  assert.throws(() => mailbox.getThread(other, sent.message.conversation_id), /conversation not found/);
  assert.throws(() => mailbox.send(desktop, task(desktop, desktop.id, "self")), /another agent/);
  mailbox.close();
});

test("rejects projects and commits outside the allowed contract", () => {
  const { mailbox, desktop, laptop } = createMailbox({
    projects: { desktop: ["alpha"], laptop: ["alpha"] },
  });
  assert.throws(
    () => mailbox.send(desktop, task(desktop, laptop.id, "nope", { project: "beta" })),
    /allowed projects/,
  );
  const sent = mailbox.send(desktop, task(desktop, laptop.id, "yes", { project: "alpha" }));
  assert.equal(sent.message.project, "alpha");
  assert.throws(
    () => mailbox.send(desktop, task(desktop, laptop.id, "bad sha", { commit: "main" })),
    /hex SHA/,
  );
  mailbox.close();
});

test("caps open tasks for one requester", () => {
  const { mailbox, desktop, laptop } = createMailbox({ maxOpenTasks: 1 });
  const first = mailbox.send(desktop, task(desktop, laptop.id, "one"));
  assert.throws(() => mailbox.send(desktop, task(desktop, laptop.id, "two")), /open task limit/);
  mailbox.send(laptop, {
    recipient: desktop.id,
    type: "result",
    task_id: first.message.task_id ?? undefined,
    outcome: "failure",
    body: "could not reproduce",
  });
  const third = mailbox.send(desktop, task(desktop, laptop.id, "three"));
  assert.equal(third.message.task_status, "open");
  mailbox.close();
});

test("refuses a public bind unless it is explicitly allowed", () => {
  assert.doesNotThrow(() => assertBindAllowed("127.0.0.1", false));
  assert.doesNotThrow(() => assertBindAllowed("100.64.1.2", false));
  assert.throws(() => assertBindAllowed("0.0.0.0", false), /every interface/);
  assert.doesNotThrow(() => assertBindAllowed("0.0.0.0", true));
});

test("token lookup is the identity boundary", () => {
  const { directory, mailbox } = createMailbox();
  assert.equal(directory.byToken(DESKTOP_TOKEN)?.id, "desktop-builder");
  assert.equal(directory.byToken("not-the-desktop-token"), undefined);
  assert.throws(() => directoryFrom({ agents: [{ id: "desktop-builder", token: "replace-me-token-value" }] }), /placeholder/);
  mailbox.close();
});
