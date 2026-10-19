# Session summary — 2026-10-04

Direct peer messaging replaced the shared mailbox. Message metadata (origin, signature, optional agent identity) is in the same commit as this note. The original WSL disk error was not delivered to Zephyr.

## Unsent message

The mailbox adapter was unreachable, so this text never left this PC:

```text
failed to move WSL disk: moving disk file: rename C:\Users\dmnsy\AppData\Local\Docker\wsl\disk\docker_data.vhdx D:\WSL\Docker\DockerDesktopWSL\disk\docker_data.vhdx: The process cannot access the file because it is being used by another process.
```

Zephyr is still not a pinned peer. Deliver it only after both machines run this build, each has run `listen` or `mcp`, and each has trusted the other's fingerprint.

## What shipped earlier (`fbba9b9`)

`agent-mail` is a standalone CLI and stdio MCP process. It does not use the central mailbox or the adapter.

- Each PC keeps an Ed25519 signing key and an X25519 encryption key under `~/.agent-mail`.
- LAN discovery is UDP multicast `239.255.77.31:47831`. Tailscale discovery reads the local `tailscale status --json` peer list and probes TCP `47832`.
- Trust is an explicit fingerprint pin. Names are aliases. An agent cannot pin a peer through a tool.
- `send` discovers the recipient, encrypts the message, and requires a signed storage receipt. Exit `0` means stored, `2` means still queued.
- Cursor, Claude Code, Codex, and Antigravity start `node dist/cli.js mcp`.
- The old mailbox and adapter remain on `npm run legacy:mailbox` and `npm run adapter`. Docker Compose publishes only the adapter.

## Message metadata added in this commit

Every message plaintext now includes:

| Field | Contents |
| --- | --- |
| `origin` | Hostname, platform, architecture, and non-loopback IP addresses. Captured once, when the message is first queued. |
| `signature` | Ed25519 signature over the canonical plaintext, using the same peer key that signs the encrypted packet. A bad signature is rejected. |
| `agent` | Optional `harness`, `name`, `model`, and `session_id`. Omitted when nothing is configured. |

Stable agent values are parameters on the MCP process, not discovered from the chat:

```json
"args": ["dist/cli.js", "mcp", "--harness", "cursor", "--agent-name", "cursor", "--model", "composer"]
```

The same flags exist as `AGENT_MAIL_HARNESS`, `AGENT_MAIL_AGENT_NAME`, `AGENT_MAIL_MODEL`, and `AGENT_MAIL_SESSION`. Each agent's user-level MCP config sets harness, agent name, and model. A chat session id is not visible to the MCP process; pass `session_id` on `send_message` when the agent knows it.

Reusing a `message_id` with different text or an explicit agent field is rejected. A retry keeps the origin and signature from the first queue.

## Checks

`npm test` (peer suite) passed, including signed delivery, same-PC discovery, MCP send with a session id, and CLI `identity` output that includes origin and agent fields and no private key. Legacy mailbox tests passed on Node 22. The default shell on this PC is Node 24; `better-sqlite3` for the legacy path is built for Node 22.

## Still open

- Pair Zephyr and send the disk-move error above.
- Rebuild (`npm run build`) and restart MCP on each PC before expecting the new metadata.
- Add `--model` to a harness config when that model name should appear on every message.
