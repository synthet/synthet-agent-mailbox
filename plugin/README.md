# agent-mail plugin for Claude Code

Phase 2 of [ADR 0003](../docs/architecture/0003-wake-layer.md): new agent-mail wakes an idle Claude Code
session instead of waiting for someone to poll.

| Part | What it does |
| --- | --- |
| `monitors/monitors.json` | Runs `scripts/monitor.mjs`, which runs `agent-mail watch` and prints one line per new message: sender, thread and id, never the text. It restarts `watch` if it exits. |
| `hooks/hooks.json` | `SessionStart`, `UserPromptSubmit`, `Stop`: `hook inject` adds unseen mail as `<untrusted-remote-message>` blocks. `PreToolUse` on sends: `hook gate` (`onFailure: block`). `PostToolUse` on sends: `hook ledger`. `SessionEnd`: `hook end` ends the journal session with this session id and releases its leases. |
| `.mcp.json` | The agent-mail MCP server with `--no-listen`, so the scheduled listener stays the only receiver. |
| `skills/agent-mail` | How to read, answer and lease a thread, and the loop rules. |

## Before you install

1. Build the CLI: `npm run build` in this repository.
2. **Create the send policy.** The gate denies every send until `~/.agent-mail/policy.json` exists and lists the
   peer: `node dist/cli.js policy init`, add the peer to `allowed_peers`, then `node dist/cli.js policy check`.
3. Keep a receiver running on the PC (the `AgentMailListener` task or the tray). The plugin never listens.
4. If `~/.claude.json` already defines an `agent-mail` MCP server, remove it or the session will have both
   `agent-mail` and `plugin:agent-mail:agent-mail`. The gate and ledger match both names.

## Install

- Try it from this checkout: `claude --plugin-dir ./plugin`. The scripts find `../dist/cli.js` themselves.
- Install from the local marketplace: `claude plugin marketplace add <repo>` then
  `claude plugin install agent-mail@synthet-agent-mailbox`. Claude Code copies an installed plugin to its cache,
  so set `AGENT_MAIL_CLI` to the full path of `dist/cli.js` in the environment Claude Code starts from.
- Check it: `claude plugin validate ./plugin`.

## Notes

- A monitor isn't told the session id, so each monitor run uses its own `watch` seen file
  (`claude-monitor-<uuid>`). It starts from now: mail that arrived before the session started is shown by the
  `SessionStart` inject hook instead.
- Whether every monitor line wakes an idle session isn't documented. The live check in ADR 0003 (Zephyr sends to
  an idle TridentX session) is what confirms it.
