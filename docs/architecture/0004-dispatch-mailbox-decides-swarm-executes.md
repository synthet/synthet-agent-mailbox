# ADR 0004 — Dispatch: the mailbox decides, swarm executes

Date: 2026-11-10
Status: Accepted (2026-11-10, owner).

## Context

ADR 0003 added the signed routing fields, session heartbeats, conversation leases and
`agent-mail watch`. It left two things for later: the Claude wake path (decision 4, to be picked by a
two-PC trial) and Phase 3, headless read-only responders. Mail is still stored and then left alone.
`Peer.listen` has no on-receive hook, and `policy.json` `auto_answer_types` is parsed but never read.

The November 2026 research note on headless spawning and ACP (Claude Code, Codex, Cursor CLI,
Antigravity) was checked against this repo and `synthet-agent-swarm`. The owner then approved a
roadmap ("Mailbox × Swarm: headless dispatch") with three decisions:

- the full roadmap, not only the wake layer;
- target autonomy: wake the owning session, answer typed queries deterministically, and, when no
  session is there, let a read-only model responder draft a reply;
- **the mailbox decides, swarm executes.** Swarm is the only place that starts a headless harness.

Already built for it, on local branches:

- **Mailbox.** Sessions record `harness_session_id`, `display_name` and `workspace`, and
  `mailbox_list_sessions` lists live sessions with their leases. `reply_to_message` derives the
  conversation, `in_reply_to`, `hop + 1` and `to_session` from the stored message, never from the
  caller. Automatic replies are refused when the message is itself automatic, at `MAX_AUTO_HOP` (6),
  when the message already has an automatic reply, and when the peer does not accept
  `agent-mail/1.1`, because it would not see `auto_reply`.
- **Swarm.**
  - Structured headless output with an `outcome` per run: `ok`, `permission_denied`, `soft_denied`,
    `auth_required`, `rate_limited`, `timeout`, `empty_output` or `error`.
  - The whole process tree is killed on timeout, with a per-harness concurrency cap.
  - Session resume and `swarm_sessions`.
  - `mode: "respond"`: one of claude, codex or cursor, read-only. Claude gets
    `--tools Read,Grep,Glob` with the prompt on stdin, Cursor gets `--mode=ask`, and Codex keeps its
    read-only sandbox.
  - `synthet-agent-swarm run --request <file|-> --json`: no prompt text on argv, one JSON line on
    stdout. Exit 0 means ok, 1 a failed run, 2 an invalid request.
  - An ACP permission policy that allows only read and search for responders.

## Decision

1. **A separate dispatcher, not a listener hook.** `agent-mail dispatch` is its own process. It
   polls the inbox with its own `SeenStore("dispatch")`, the same way `watch` does, and runs as a
   single instance through `~/.agent-mail/dispatch.lock`. `Peer.listen` stays unchanged: it stores
   the message and returns a receipt. A crashed or slow dispatcher can never cost a delivery or a
   receipt.
2. **Off by default, per peer.** A new `dispatch` section in `policy.json`:
   - `enabled` (default `false`) is the kill switch.
   - `swarm_command` is an absolute path the owner sets. It is never found on `PATH`.
   - `limits` default to `concurrency: 1`, `per_peer_per_minute: 2`, `timeout_ms: 60000` and
     `budget_usd: 0.25` (spec OQ-5).
   - `peers[<fingerprint>]` holds `workspace` (an absolute path, used by both the deterministic
     answers and the responder), `wake: {destination, harness}`, `auto_answer: [...]` and
     `responder: {enabled, harness, model}`. A peer that isn't listed gets nothing.
   - The existing `auto_answer_types` is read as a legacy alias for `auto_answer`. It applies to
     every listed peer that has a `workspace`.
3. **Remote text never configures anything.** The destination, the tool list, the workspace, the
   harness and the model come only from `policy.json`. Message text is data for the deterministic
   parser or for the responder prompt, and nothing else.
4. **Order for each message.** The first step that applies wins:
   1. **Gate.** The peer is listed, it is under its rate limit, and `hop < 6`. A message with
      `auto_reply=true` may wake a session but never gets a reply.
   2. **Deterministic answer.** Only when the whole text parses under a zod `.strict()` schema as
      `{"query": "version" | "hash" | "test_status"}` and that type is in the peer's `auto_answer`.
      Code computes the answer from the peer's configured workspace: the package version,
      `git rev-parse HEAD`, and the last recorded test result. The dispatcher never runs tests. The
      reply goes out through `reply_to_message` with `automatic: true`.
   3. **Wake the live owner.** The owner is the first live session that matches: the `to_session`
      field, then the conversation-lease holder, then the peer's configured `wake.destination`.
      `to_session` counts only when that session has itself sent mail in this conversation, so a
      sender can return a reply to the session that asked, but cannot pick an arbitrary local
      session. The wake carries metadata only: `MAIL thread=<id> from=<label> id=<message id>`.
      - Claude: the restricted `claude -p` from the delivery-agent spec (only ListAgents,
        SendMessage and ToolSearch; `--strict-mcp-config`).
      - Codex: `codex queue --thread <harness_session_id> --message <metadata> --resume`. If the
        output shows the resume failed, show a toast.
   4. **Responder.** Only when there is no live owner and `responder.enabled` is set for the peer:
      - Lease the conversation as `dispatch:<runId>`.
      - Write a request file in `mode: "respond"`, with the remote text inside
        `<untrusted-remote-message>` (`wrapUntrusted`), and run `swarm_command run --request <file>
        --json` with the configured harness, workspace, timeout and budget.
      - Require the row's `outcome == "ok"`. Swarm's top-level `ok` is also true for
        `permission_denied` and `soft_denied`, so `ok` alone is not enough.
      - Run `checkOutbound()` on the reply. It fails closed.
      - Send through `reply_to_message` with `automatic: true`.
   5. **Audit.** Append one line to `ledger.jsonl` for every decision, including skips: the sha256
      of the inbound and reply bodies, the step taken, the outcome and the cost. Bodies are never
      written. The message stays unacknowledged, so the owner and the owning session still see it
      (spec AC-10).
5. **The responder can't act.** It runs with no MCP servers, only read and search tools, and no way
   to send anything. The mailbox sends the reply after its own checks. agy is excluded until its
   Windows empty-stdout bug (#76) is fixed.
6. **Delivery-agent spec OQ-6 is resolved: opt-in replies per peer.** Deterministic answers and a
   model-written responder reply are both allowed, each off until the owner enables it for a peer.
   This overrides the spec's earlier lean against model-written replies (Jev p 0.01). The owner made
   this call when approving the roadmap, and the guards in decisions 3 to 5 are the condition for
   it.
7. **No message text goes to Jev or TypeSafe.** Dispatch routes from local configuration and
   envelope metadata only, so the spec's optional model-routing step isn't built and OQ-7 blocks
   nothing. The responder is a separate matter: enabling it for a peer sends that peer's message text
   to the responder harness's provider (Anthropic, OpenAI or Cursor). That is part of what the owner
   opts into per peer, and the operator skill and `docs/operations.md` must say so.
8. **ADR 0003 decision 4 still stands.** The dispatcher's wake action is path (b). Path (a) is
   `agent-mail watch`. The two-PC trial (B5) measures both and picks the primary path. Nothing here
   changes that.

## Not doing (now)

- **A hook in `Peer.listen`.** See decision 1.
- **Resuming a live interactive session from the dispatcher.** ADR 0003 forbids two writers on one
  transcript. A responder run starts a fresh session. Swarm's `resume` always uses `--fork-session`
  for Claude.
- **Running tests to answer `test_status`.** The answer is a recorded result or "unknown".
- **Responders that edit files, run commands or call MCP tools.**
- **Model-based routing.** See decision 7.

## Open questions

1. **Where the last test result is recorded for `test_status`.** Options: a file the owner's test
   command writes (for example `~/.agent-mail/test-status/<workspace-hash>.json`), or the latest run
   in agent-flow's evidence when the workspace is tracked. Until this is settled, `test_status`
   answers `unknown`.
2. **Ledger growth.** One line per inbound message, skips included. Rotation is left to the
   operations docs.

## Consequences

- An enabled peer gets an answer to a typed query without a person, and free text gets either a
  woken session or a bounded read-only reply.
- The trust boundary stays where ADR 0003 put it: the agent-mail process and `policy.json`. Keep
  `policy.json` writable by the owner only, and deny agent edits to it. It now also names an
  executable (`swarm_command`) that the dispatcher runs.
- Every automatic reply carries `auto_reply=true` and `hop + 1`, and the receiver never answers it
  automatically. Two dispatchers can't loop.
- The worst-case cost per enabled peer follows from the limits: 2 runs a minute at $0.25 is about
  $30 an hour. Real mail is a few messages a day.
- The spec's ACs move from "the listener" to "the dispatcher" (decision 1). The spec changes with
  this ADR.

## Sequencing after acceptance

B3 (the policy schema), then B4 without the responder (deterministic answers and wake), then the
responder, then the `mail-dispatch` operator skill and the operations docs, then the B5 two-PC
trial.
