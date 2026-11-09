# ADR 0003 — Wake layer: deliver mail to the session that should answer it

Date: 2026-11-09
Status: Proposed. TridentX drafted it; Zephyr reviews; the owner accepts.

## Context

Peer mail is stored reliably, but nothing tells a model session that mail arrived. Three problems
showed up in daily two-PC use (TridentX and Zephyr, both Windows):

- **Replies wait until someone polls.** An answer can sit in the inbox for hours, because an idle
  Claude Code or Codex session never looks. `mailbox_poll` and `digest` are reads, not wakes.
- **Pinned endpoints go stale.** `PeerStore.trust()` is the only writer of `contacts/<fp>.endpoint`.
  `Peer.deliver()` re-discovers on every send but never saves the result, so `retry_outbox` kept
  hitting a dead address while a fresh `send` worked.
- **Several sessions share one peer identity.** The sender's `agent.session_id` is signed, but
  nothing addresses a session or says which session owns a thread.

Inputs:
- The owner's research guide on automating agent-mail across Claude Code and Codex, which proposes a
  wake layer on top of agent-mail. A second, generic report was discarded: it says Codex has no
  hooks, no MCP and no skills, all of which are wrong.
- The peer-delivery-agent drafts in #9 (`docs/peer-delivery-agent-spec.md`, `-plan.md`). Both are
  drafts, not approved. Their spike: a restricted `claude -p` sent a fixed SendMessage notice that
  woke an idle background session in 14 s and an idle terminal session in 27 s.
- The TridentX–Zephyr design thread of 2026-11-09. The owner decided Q1 and Q5. Q3, Q4 and Q6 were
  decided through Jev. The probabilities are quoted below and are advisory.

## Decision

Keep agent-mail as the signed transport. Add a wake layer and a send policy on top. No change to
trust: pinning stays human-only through `agent-mail trust`.

1. **Home (owner).** New harness code lives in this repo: a Claude Code plugin in `plugin/` and a
   Codex adapter in `adapters/codex/`, versioned with the CLI they call. The `agent-mail-handshake`
   skill stays in the vault for now. The plugin may take it over in a later PR.
2. **Envelope fields, version-gated (Jev `accept_with_versioning`, p 0.67, confidence 0.56).**
   - Add the optional signed fields `to_session`, `hop`, `auto_reply` and `in_reply_to`.
   - Roll out receiver-first: both PCs deploy a build that accepts the fields before either sends
     them. Old receivers reject unknown fields, because `unsignedSchema` and `agentSchema` are
     `.strict()`.
   - Send the fields only to a peer that has advertised it accepts them, so the sender decides before
     sending instead of learning from a failed delivery.
   - **Naming correction:** `agent-mail/2` is already the sync-box protocol (`src/fabric/box.ts`,
     ADR 0001). The message version therefore can't be "/2". Use a distinct marker such as
     `agent-mail/1.1`, or a capability flag (see open question 1).
3. **Conversation leases (Jev `separate_leases`, p 0.70, confidence 0.60).**
   - New `conversation_leases` table in `journal.db`: `conversation_id`, `session_id`,
     `lease_until`. Default TTL 30 minutes, renewed by heartbeat, released at session end.
   - On a clash the second session gets `lease_conflict` and doesn't reply.
   - **A lease is not a claim.** A lease is transient routing state: which session answers this
     thread right now. A claim (ADR 0002) is ownership of a unit of work. Losing a lease costs a
     re-route; losing a claim costs work. Leases never gate merges, submits or WIP limits, and
     agent-flow remains the only claim model.
4. **Claude wake path: undecided until measured (Jev `both_compare`, p 0.68, confidence 0.57).**
   Phase 2 opens with a two-PC trial of both paths:
   - (a) A plugin monitor running `agent-mail watch --session <sid> --jsonl`.
   - (b) The #9 design: on store, the listener starts a restricted `claude -p` (only ListAgents,
     SendMessage and ToolSearch; `--strict-mcp-config`) that sends a fixed notice to a session the
     owner configured per peer.

   Measure wake latency, cost per wake, idle versus busy sessions, and duplicate or spurious wakes.
   The guide warns that frequent monitor wakes can spam or fabricate "Human:" turns. The faster path
   with no spurious wakes and an acceptable cost becomes primary. **Both paths carry metadata only:
   a wake line is `MAIL thread=<id> from=<label> id=<message id>`, never a message body.**
5. **Codex wake.** `codex queue --thread <sid> --message <metadata> --resume` (Codex CLI 0.166+). A
   failed resume only prints a warning, so the router checks the output and falls back to a toast.
   This comes after the Claude path.
6. **Send policy.** `~/.agent-mail/policy.json` (peer allowlist, size cap, auto-answer types,
   rate limits) feeds a PreToolUse send gate that fails closed and an append-only
   `~/.agent-mail/ledger.jsonl`.
   - Remote text reaching a model is wrapped in `<untrusted-remote-message>` with nested closing tags
     stripped.
   - Confirm hook matchers against the scoped MCP tool names with a dry-run PreToolUse logger before
     relying on them.
7. **Split (owner).** TridentX implements. Zephyr reviews each PR and runs the Zephyr-side checks.
   Every merge is the owner's.

## Phases

Each phase is one or two PRs. Their issues are opened from this ADR once it is accepted.

- **Phase 0, no protocol change:**
  - `digest --json --unseen` plus mark-seen, using `session_cursors`.
  - `UserPromptSubmit` and `Stop` inject hooks in `installHarness()`; Stop stays silent when
    `stop_hook_active` is set.
  - The send gate and ledger scripts, plus `agent-mail policy check`.
- **Phase 1, protocol and state:**
  - The version-gated envelope fields (decision 2).
  - Session heartbeat and end, with a TTL on `sessions.last_seen`.
  - `watch --session <sid> --jsonl [--since <cursor>]`, with a heartbeat line.
  - `conversation_leases` (decision 3).
  - **Endpoint auto-refresh:** when a delivery to a discovered address returns a valid receipt from
    an already-pinned fingerprint, update that contact's endpoint, log `endpoint_changed` and flush
    the outbox. Never pin a new fingerprint. `retry_outbox` re-discovers before falling back to the
    pinned address.
- **Phase 2, wake:**
  - The two-PC trial (decision 4), then the chosen Claude path packaged in `plugin/`.
  - Then the Codex adapter and the `codex queue` router action (decision 5).
- **Phase 3, automation:** headless read-only responders for allowlisted question types only:
  versions, hashes, test status.
  - Claude: `claude -p --resume <sid> --permission-mode dontAsk` with an explicit `--allowedTools`
    list, never `--bare`.
  - Codex: `codex exec --sandbox read-only`.
  - Loop guards: never reply to `auto_reply=true`; stop at `hop` 6; per-thread rate and budget caps;
    escalate to the owner when a lease expires unanswered.

## Not doing (now)

- **Re-pinning peers to Tailscale MagicDNS names.** Zephyr has no Tailscale, and both PCs are on the
  LAN only. Endpoint auto-refresh is the fix for stale addresses.
- **Claude channels.** They are a research preview and need a development flag on every launch.
  Revisit when they are stable.
- **Per-session signing sub-keys.** Session tags under the host key are enough for a single owner.

## Open questions

1. **Where a receiver advertises that it accepts the new fields.** The discovery advert
   (`advertSchema` in `src/peer/discovery.ts`) is also `.strict()`. A new advert field would be
   rejected by old discoverers until they upgrade. The options are an HTTP capability probe on the
   receiver port, cached per contact, or a receiver-first advert change. To be settled in the
   Phase 1 PR.
2. **#9 OQ-6 and OQ-7** (fixed status reply or none; whether message text may go to the routing
   vendor) stay open. They matter only if path (b) wins the trial.

## Prerequisites outside this repo

- **Codex CLI 0.166 or later on both PCs** for `codex queue --resume`. TridentX runs 0.167.0;
  Zephyr runs 0.161.0.
- **Rebuild and restart:** Zephyr's running `dist/` predates `378d2e8`, so rebuild and restart its
  listener, tray and MCP servers before the Phase 1 two-PC checks.

## Consequences

- An agent no longer has to remember to poll. A routed message reaches its owning session, or
  escalates to the owner.
- The trust boundary is the agent-mail process and its policy file, not the harness sandbox. Claude
  plugin monitors run outside the sandbox, and Codex does not network-filter MCP servers. Keep
  `policy.json` writable by the owner only, and deny agent edits to it.
- A wake proves a message is waiting, not that it is safe. Remote text is still data and never
  authorizes an action.
