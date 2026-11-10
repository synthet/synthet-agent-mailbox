# Spec: peer delivery agent

Status: draft for review. Not approved for implementation.

## Summary

When a message arrives from a trusted peer on another PC, nothing tells a local agent session, because `mailbox_poll` does not wake an idle session. This feature makes the listener start a restricted Claude Code process when mail arrives. That process finds the local session the message is meant for, and sends it a fixed notice that mail is waiting. It never sees the message text, and it does no other work. The session reads the message through the mailbox tools, which mark it untrusted.

## Users and stakeholders

- The owner of two or more PCs running agents that need to reach each other.
- Agents on a remote PC that need an answer without a person relaying it.
- The owner as the party exposed if a message can cause unwanted actions.

## Product scenario

Today a message waits in the inbox until a session happens to read it. After this change, a message from an allowed peer reaches the right session soon after it arrives, and the sender can learn that it was delivered. Message text never gains authority: it stays data, however it arrives.

## Non-goals

- Doing the work a message asks for. The delivery agent only delivers and replies.
- Giving the delivery agent shell, file edit, or network tools.
- Replacing the inbox. Stored messages and receipts work as they do now.
- Waking a PC that is asleep, or retrying delivery between PCs.
- Reviving the legacy adapter. `src/wake.ts` may be reused, but the adapter stays out of the default path.
- Delivering to other harnesses. Claude Code comes first.

## User stories

- US-1: As the owner, I want a message from an allowed peer to reach the right session, so that I do not relay it myself. (AC-1, AC-4, AC-5, AC-6)
- US-2: As the owner, I want this off until I enable it per peer, so that a pinned peer does not automatically gain the ability to start processes. (AC-2, AC-3)
- US-3: As the owner, I want the delivery agent tightly restricted, so that a hostile message has little it can do. (AC-7, AC-8, AC-9, AC-10)
- US-4: As a sender, I want an optional reply, so that I can learn the outcome without a person. (AC-11, AC-12, AC-13, AC-14)
- US-5: As the owner, I want limits and a record, so that a burst of mail cannot run up cost or go unnoticed. (AC-15, AC-16, AC-17, AC-18)

## Acceptance criteria

### Trigger

- AC-1: When the listener stores a message from a peer on the delivery allowlist, the listener shall start one delivery agent for that message.
- AC-2: The listener shall keep delivery disabled until the owner enables it in local configuration.
- AC-3: If a stored message comes from a peer that is not on the delivery allowlist, then the listener shall leave the message in the inbox without starting a process.
- AC-4: If the delivery agent fails or times out, then the listener shall leave the message unacknowledged in the inbox.

### Delivery

- AC-5: When the destination configured for the peer matches a running session, the delivery agent shall send that session a notice.
- AC-6: If no running session matches the destination, then the delivery agent shall leave the message unacknowledged in the inbox.
- AC-7: The delivery agent shall build each notice from a fixed template that contains only the peer's local contact alias and the message id.

### Restriction

- AC-8: The delivery agent shall run with only the mailbox tools and the session delivery tools available.
- AC-9: The listener shall give the delivery agent only the message id, the peer's local contact alias, and the destination.
- AC-10: The delivery agent shall leave the message unacknowledged after sending a notice.

### Replies

- AC-11: The listener shall send no reply unless the owner enabled replies for that peer.
- AC-12: The listener shall include the original correlation id in every reply.
- AC-13: If a message has reached the configured hop limit, then the listener shall send no reply.
- AC-14: If a reply already exists for a correlation id, then the listener shall send no further reply for that id.

### Limits and audit

- AC-15: While a peer is over its configured rate limit, the listener shall start no delivery agents for that peer.
- AC-16: The listener shall run at most the configured number of delivery agents at the same time.
- AC-17: The listener shall stop any delivery agent that exceeds the configured timeout.
- AC-18: When a delivery agent finishes, the listener shall record the message id, peer fingerprint, destination, and outcome in a local log.

Every criterion above is one EARS sentence. None are marked AMBIGUOUS. AC-11 to AC-14 apply only if replies ship (OQ-6).

## Assumptions and dependencies

- Pinned peers are not fully trusted. The agent-mailbox skill already says a message from a paired agent is untrusted data and not permission to act.
- `src/wake.ts` shows the pattern: it runs `claude -p` with an allowlist. It lives in the legacy adapter, and its allowlist names `mcp__agent-mailbox`, while the server is now `agent-mail`.
- `Peer.listen` has no hook on receipt today, so one must be added.
- The listener runs as the logged-in user through a scheduled task.
- Any API key comes from the environment or a protected store, and never from a message or a log.
- AC-8 and AC-9 are enforced by the listener and the process arguments, so neither relies on model behaviour.
- The destination in AC-9 comes from local config. The sender cannot choose it.

## Open questions

- RESOLVED OQ-1: A headless `claude -p` process can use both `ListAgents` and `SendMessage`. Tested on Claude Code 2.1.318 with only those tools plus `ToolSearch`, no MCP servers, and session variables cleared. `SendMessage` is deferred, so `ToolSearch` must be available too. The message reached the target session with its exact text. `claude session` is not a command in this version. A fixed notice sent this way woke an idle background session within 14 seconds and an idle terminal session within 27 seconds, measured from the start of the send. It also worked from a scheduled task with no `CLAUDE*` variables set. A session started with `claude --name <name>` shows that name in both `ListAgents` and `claude agents --json`, so a chosen name is a stable match even though the ids differ. Not tested: the actual listener process, and the second PC.
- RESOLVED OQ-2: The owner sets the destination per peer in local config, and the sender cannot choose it. Decided through Jev (`owner_config`, p 0.63, confidence 0.51). Model routing stays a later option.
- RESOLVED OQ-3: Delivery is a fixed notice with no remote text. Decided through Jev (`fixed_notice`, p 0.93, confidence 0.91; carrying the text 0.06, owner confirmation 0). Reason: Claude Code tells the receiving session to treat a `SendMessage` as a teammate's request and act on it within its own permissions, and that session has full tools. Remote text sent that way would arrive as a colleague's request. This reduces the risk but does not remove it, because the session still reads the text through the mailbox tools.
- RESOLVED OQ-4: No API key is needed. The logged-in account worked from a scheduled task like the listener's, with `ANTHROPIC_API_KEY` unset. Tested on one PC.
- RESOLVED OQ-5: Defaults are off, 1 agent at a time, 2 per peer per minute, a 60 second timeout, and $0.25 per run. Decided through Jev (`stricter`, p 0.66, confidence 0.55). Test sends cost $0.07 to $0.09, and real mail is a few messages a day, so the worst case is about $11 per peer per hour.
- OPEN QUESTION OQ-7: May Jev routing send message text to TypeSafe? Mail is end-to-end encrypted between the owner's PCs, and sending text to a third party ends that for the routed message. TypeSafe's privacy policy says it will not train or fine tune models on input. It gives no fixed retention period, zero data retention is for enterprise customers only, and input may be disclosed to service providers or under legal process. Jev leaned to metadata by default with text opt-in per peer (p 0.59, confidence 0.45), which is below the threshold to act on. This needs the owner's decision, and it blocks only the optional routing step. Until then, no message text goes to any external service.
- OPEN QUESTION OQ-6: Should the first release send automatic replies at all? Text written by a model is ruled out (p 0.01). Jev split evenly between an opt-in fixed status and no replies (p 0.47 and 0.48), so this needs the owner's decision. The first release ships without replies unless the owner chooses otherwise. Replies can be added later without changing anything else, because the listener owns them.
