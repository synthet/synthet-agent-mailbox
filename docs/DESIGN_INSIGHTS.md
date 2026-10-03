# Decisions

This project is the shared mailbox from the two-PC agent guide. Each machine can use Cursor, Claude Code, Codex, or Antigravity (Gemini).

- **Clients.** The agent talks to a local adapter. Cursor uses `agent -p`, Claude Code uses `claude -p`, and Codex uses `codex exec` to start a turn when no chat is open.
- **Wake-up.** An MCP connection does not resume an idle chat. The adapter spools mail either way. `WAKE=off` waits for a person or an open chat. `WAKE=cli` starts a CLI turn. `WAKE=apply` allows edits in the workspace using the selected client's permissions.
- **Network.** The mailbox binds to loopback until `BIND` is this PC's Tailscale address. Tokens are required. The adapter always binds to loopback.
- **Host.** Run the mailbox on the PC that stays online. Each adapter keeps an outbox and retries with backoff when that host is unreachable.
- **Identity.** The bearer token selects the sender. Tool arguments cannot choose a different `from`.
- **Completion.** `acknowledge_message` means the message was delivered. A task finishes only when its owner sends `type: result`.

## Roadmap from the early Cursor and Antigravity thread

The first design session (`docs/CONVERSATION_THREADS.md`) set this build order. Where it landed:

- **Expiry (TTL).** Done as message `deadline`. Expired messages become `expired` and tasks fail.
- **Dead-letter queue.** Done. Delivery attempts are counted, and a message past `maxAttempts` becomes `dead`.
- **reply_to.** Done, plus `conversation_id`, `task_id`, and `outcome`.
- **Agent listing.** Done as `list_agents`. Presence (`last_seen_at`) is not built.
- **Per-agent tokens.** Done. The bearer token selects the sender, and the mailbox binds to loopback unless told otherwise.
- **Not built.** `mailbox_purge` or cleanup, and broadcast or topics.
