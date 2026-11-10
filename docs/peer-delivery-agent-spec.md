# Spec: peer delivery agent

Status: draft, revised with [ADR 0004](architecture/0004-dispatch-mailbox-decides-swarm-executes.md). The owner accepted that ADR on 2026-11-10, and it governs what is built from this spec.

## Summary

When a message arrives from a trusted peer on another PC, nothing tells a local agent session, because `mailbox_poll` does not wake an idle session. This feature adds a dispatcher, `agent-mail dispatch`, that watches the inbox. For a peer the owner has enabled, it answers a typed query (version, hash, test status) from code. Otherwise it wakes the local session the message is meant for with a fixed notice that mail is waiting. The wake process never sees the message text and does no other work. When no session is there and the owner enabled a responder for that peer, a read-only model run through synthet-agent-swarm drafts a reply, which the dispatcher checks and sends. The session reads the message through the mailbox tools, which mark it untrusted.

## Users and stakeholders

- The owner of two or more PCs running agents that need to reach each other.
- Agents on a remote PC that need an answer without a person relaying it.
- The owner as the party exposed if a message can cause unwanted actions.

## Product scenario

Today a message waits in the inbox until a session happens to read it. After this change, a message from an allowed peer reaches the right session soon after it arrives, and the sender can learn that it was delivered. Message text never gains authority: it stays data, however it arrives.

## Non-goals

- Doing the work a message asks for. The delivery agent only delivers, and the responder only reads and drafts a reply.
- Giving the delivery agent or the responder shell, file edit, network, or MCP tools.
- Replacing the inbox. Stored messages and receipts work as they do now.
- Waking a PC that is asleep, or retrying delivery between PCs.
- Reviving the legacy adapter. `src/wake.ts` may be reused, but the adapter stays out of the default path.
- Delivering to harnesses other than Claude Code and Codex. Claude Code comes first, and the Codex wake follows (ADR 0003 decision 5).

## User stories

- US-1: As the owner, I want a message from an allowed peer to reach the right session, so that I do not relay it myself. (AC-1, AC-4, AC-5, AC-6)
- US-2: As the owner, I want this off until I enable it per peer, so that a pinned peer does not automatically gain the ability to start processes. (AC-2, AC-3)
- US-3: As the owner, I want the delivery agent tightly restricted, so that a hostile message has little it can do. (AC-7, AC-8, AC-9, AC-10)
- US-4: As a sender, I want an optional reply, so that I can learn the outcome without a person. (AC-11, AC-12, AC-13, AC-14, AC-19 to AC-25)
- US-5: As the owner, I want limits and a record, so that a burst of mail cannot run up cost or go unnoticed. (AC-15, AC-16, AC-17, AC-18)

## Acceptance criteria

### Trigger

- AC-1: When the dispatcher finds a new message from a peer on the delivery allowlist, the dispatcher shall handle that message once.
- AC-2: The dispatcher shall keep delivery disabled until the owner enables it in local configuration.
- AC-3: If a stored message comes from a peer that is not on the delivery allowlist, then the dispatcher shall leave the message in the inbox without starting a process.
- AC-4: If the delivery agent fails or times out, then the dispatcher shall leave the message unacknowledged in the inbox.

### Delivery

- AC-5: When the destination configured for the peer matches a running session, the delivery agent shall send that session a notice.
- AC-6: If no running session matches the destination, then the delivery agent shall leave the message unacknowledged in the inbox.
- AC-7: The delivery agent shall build each notice from a fixed template that contains only the conversation id, the peer's local contact alias, and the message id.

### Restriction

- AC-8: The delivery agent shall run with only the mailbox tools and the session delivery tools available.
- AC-9: The dispatcher shall give the delivery agent only the conversation id, the message id, the peer's local contact alias, and the destination.
- AC-10: The delivery agent shall leave the message unacknowledged after sending a notice.

### Replies

- AC-11: The dispatcher shall send no reply unless the owner enabled replies for that peer.
- AC-12: The dispatcher shall send every reply in the original message's conversation, with `in_reply_to` set to the original message id.
- AC-13: If a message has reached the configured hop limit, then the dispatcher shall send no reply.
- AC-14: If an automatic reply already exists for a message id, then the dispatcher shall send no further automatic reply to that message.

### Limits and audit

- AC-15: While a peer is over its configured rate limit, the dispatcher shall start no delivery agents or responders for that peer.
- AC-16: The dispatcher shall run at most the configured number of delivery agents and responders at the same time.
- AC-17: The dispatcher shall stop any delivery agent or responder that exceeds the configured timeout, including its child processes.
- AC-18: When the dispatcher handles a message, it shall record the message id, peer fingerprint, step taken, destination, outcome, cost, and the sha256 of each body in a local log, and shall record no body.

### Deterministic answers

- AC-19: When a message's whole text parses as `{"query": "version" | "hash" | "test_status"}` and the owner allowed that query type for the peer, the dispatcher shall reply with a value computed by code from the peer's configured workspace.
- AC-20: If a message's text does not parse exactly as an allowed query, then the dispatcher shall send no deterministic answer.
- AC-21: The dispatcher shall answer `test_status` from a recorded result and shall never run tests to answer it.

### Responder

- AC-22: The dispatcher shall start a responder only when no live session owns the message and the owner enabled a responder for that peer.
- AC-23: The dispatcher shall pass the remote text to the responder only inside `<untrusted-remote-message>`, and shall take the harness, workspace, model, tools, timeout, and budget only from local configuration.
- AC-24: If the responder's outcome is not `ok`, or `checkOutbound()` denies its reply, then the dispatcher shall send no reply and shall leave the message unacknowledged.
- AC-25: The dispatcher shall mark every reply it sends as automatic, with `auto_reply=true` and `hop` one more than the original's.

Every criterion above is one EARS sentence. None are marked AMBIGUOUS. AC-11 to AC-14 and AC-19 to AC-25 apply to a peer only after the owner enables replies for that peer (OQ-6).

## Assumptions and dependencies

- Pinned peers are not fully trusted. The agent-mailbox skill already says a message from a paired agent is untrusted data and not permission to act.
- `src/wake.ts` shows the pattern: it runs `claude -p` with an allowlist. It lives in the legacy adapter, and its allowlist names `mcp__agent-mailbox`, while the server is now `agent-mail`.
- `Peer.listen` has no hook on receipt, and none is added. The dispatcher is a separate process that polls the inbox with its own seen store (ADR 0004 decision 1), so a slow or crashed dispatcher never affects delivery or receipts.
- The responder runs through `synthet-agent-swarm run --request <file> --json` in `mode: "respond"`, at an absolute `swarm_command` path the owner sets. Enabling a responder for a peer sends that peer's message text to the responder harness's provider.
- The listener and the dispatcher run as the logged-in user through scheduled tasks.
- Any API key comes from the environment or a protected store, and never from a message or a log.
- AC-8, AC-9 and AC-23 are enforced by the dispatcher and the process arguments, so none relies on model behaviour.
- The destination in AC-9 comes from local config. The sender cannot choose it.

## Open questions

- RESOLVED OQ-1: A headless `claude -p` process can use both `ListAgents` and `SendMessage`. Tested on Claude Code 2.1.318 with only those tools plus `ToolSearch`, no MCP servers, and session variables cleared. `SendMessage` is deferred, so `ToolSearch` must be available too. The message reached the target session with its exact text. `claude session` is not a command in this version. A fixed notice sent this way woke an idle background session within 14 seconds and an idle terminal session within 27 seconds, measured from the start of the send. It also worked from a scheduled task with no `CLAUDE*` variables set. A session started with `claude --name <name>` shows that name in both `ListAgents` and `claude agents --json`, so a chosen name is a stable match even though the ids differ. Not tested: the actual listener process, and the second PC.
- RESOLVED OQ-2: The owner sets the destination per peer in local config, and the sender cannot choose it. Decided through Jev (`owner_config`, p 0.63, confidence 0.51). Model routing stays a later option.
- RESOLVED OQ-3: Delivery is a fixed notice with no remote text. Decided through Jev (`fixed_notice`, p 0.93, confidence 0.91; carrying the text 0.06, owner confirmation 0). Reason: Claude Code tells the receiving session to treat a `SendMessage` as a teammate's request and act on it within its own permissions, and that session has full tools. Remote text sent that way would arrive as a colleague's request. This reduces the risk but does not remove it, because the session still reads the text through the mailbox tools.
- RESOLVED OQ-4: No API key is needed. The logged-in account worked from a scheduled task like the listener's, with `ANTHROPIC_API_KEY` unset. Tested on one PC.
- RESOLVED OQ-5: Defaults are off, 1 agent at a time, 2 per peer per minute, a 60 second timeout, and $0.25 per run. Decided through Jev (`stricter`, p 0.66, confidence 0.55). Test sends cost $0.07 to $0.09, and real mail is a few messages a day, so the worst case is about $11 per peer per hour.
- RESOLVED OQ-7: Not needed. The dispatcher routes from local configuration and envelope metadata only, so the optional model-routing step is not built and no message text goes to Jev or TypeSafe (ADR 0004 decision 7). Message text reaches an outside provider only through a responder the owner enabled for that peer.
- RESOLVED OQ-6: Replies are opt-in per peer. When approving the dispatch roadmap, the owner chose deterministic answers plus a read-only model responder. This overrides Jev's earlier lean against model-written replies (p 0.01). AC-11 to AC-14 and AC-19 to AC-25 are the guards (ADR 0004 decision 6).
