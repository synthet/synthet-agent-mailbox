# Agent mail

Direct encrypted messaging for Cursor, Claude Code, Codex, and Antigravity agents on two or more PCs. Each machine runs one peer. There is no shared mailbox and no adapter in the default path.

A peer is an Ed25519 signing key plus an X25519 encryption key. `agent-mail listen` or `agent-mail mcp` receives messages. `agent-mail send` finds the recipient on the LAN or through the local Tailscale peer list and delivers one signed, encrypted message. Names are aliases. The fingerprint is the identity, and it has to be checked over a separate channel before either side will accept mail.

```text
PC A  listen :47832          PC B  mcp (stdio) :47832
   │  UDP 47831 discover         │  UDP 47831 discover
   └──────── LAN multicast ──────┘
   └──────── Tailscale IPs ──────┘
```

Changing a LAN or Tailscale address does not require pairing again. The pinned fingerprint stays the same.

## Set up each PC

```powershell
npm install
npm run build
node dist/cli.js init --name Desktop
node dist/cli.js identity
```

`init` writes `identity.json` under `%USERPROFILE%\.agent-mail` (or `$HOME/.agent-mail`). It refuses to replace an existing key. Copy the printed JSON and fingerprint to the other PC by a channel you already trust. Do not send `identity.json`; it contains both private keys.

Start the receiver before the other side tries to deliver:

```powershell
node dist/cli.js listen
```

Use a different `--home` when two peers share one OS user. Only one process should bind TCP `47832`.

## Trust, then send

On each PC, with the other one listening:

```powershell
node dist/cli.js discover
node dist/cli.js trust Zephyr --fingerprint <64-hex-chars-from-the-other-pc>
node dist/cli.js send Zephyr --text "Review the auth change."
```

`trust --file public.json --fingerprint <64-hex>` pairs a peer that is offline. The file is the JSON from `identity`, not `identity.json`. Trust is stored locally and is not reciprocal: both sides pin each other. A name collision is rejected until you pass the full fingerprint.

`send` exits `0` when the recipient has stored the message and returned a signed receipt. It exits `2` when the peer is offline; the text stays in the local outbox. It exits `1` on any other error. `node dist/cli.js flush` retries the outbox. Reuse `--message-id` when retrying the same text so the recipient stores it once.

```powershell
node dist/cli.js inbox
node dist/cli.js ack <message-id> --sender <sender-fingerprint>
node dist/cli.js thread <conversation-uuid>
```

Message text from another PC is untrusted input. A receipt means the message was stored, not that anyone finished a task.

## Point an agent at the peer

Build first, then add one stdio server. Do not also run `listen` unless this MCP process is started with `--no-listen`.

Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "agent-mail": {
      "command": "node",
      "args": ["${workspaceFolder}/dist/cli.js", "mcp"]
    }
  }
}
```

Claude Code, from this checkout:

```powershell
claude mcp add agent-mail -- node dist/cli.js mcp
```

Codex (`~/.codex/config.toml` or `.codex/config.toml` in the checkout):

```toml
[mcp_servers.agent-mail]
command = "node"
args = ["dist/cli.js", "mcp"]
```

Antigravity uses the same command and args. See `config/cursor-mcp.example.json`, `config/claude-code-mcp.example.json`, and `antigravity-mcp.example.json`.

| Tool | What it does |
| --- | --- |
| `whoami` | This peer's public keys and fingerprint. Private keys stay on disk. |
| `discover_peers` | Live LAN and Tailscale peers. Discovery does not trust them. |
| `list_agents` | Pinned peers. Address them by name or fingerprint. |
| `send_message` | Encrypt and deliver, or queue. `delivered` is a storage receipt. |
| `fetch_inbox` | Unacknowledged local messages. This read does not lease. |
| `acknowledge_message` | Mark one received message read on this PC. |
| `get_thread` | Local inbox, sent, and queued messages for one conversation. |
| `queue_status` | Counts of queued, unread, and sent messages. |
| `retry_outbox` | Retry queued messages. The same sender and message id is stored once. |

Trust stays on the CLI. An agent cannot pin a new fingerprint by calling a tool.

## Discovery and ports

LAN discovery is UDP multicast `239.255.77.31:47831`. Messages are HTTP on TCP `47832`, with the ciphertext and signature in the body. The URL is only a way to reach the peer; it is not the security boundary. Allow inbound TCP `47832` and UDP `47831` on the private network profile.

Tailscale discovery runs `tailscale status --json` and probes online peers at TCP `47832`. It does not scan subnets. Install the Tailscale CLI, sign in, and allow that TCP port through the host firewall on the tailnet. `--no-tailscale` skips the probe. `--no-discovery` stops LAN advertisements.

`--interface <IPv4>` selects the LAN multicast interface. `--port` changes the TCP port; Tailscale probes use that same port via `--port` on the discoverer as well.

## Layout on disk

`AGENT_MAIL_HOME` overrides the default directory.

```text
~/.agent-mail/
  identity.json
  contacts/   pinned public keys
  inbox/      received messages
  acked/      local read markers
  outbox/     not yet receipted
  sent/       receipted copies
```

## Legacy central mailbox

`npm run legacy:init`, `npm run legacy:mailbox`, and `npm run adapter` still run the older shared mailbox and per-PC adapter. Docker Compose publishes only that adapter on `127.0.0.1:8788`. New setups should use the peer above. `npm run test:legacy` covers the old path.

## Tests

```powershell
npm test
```
