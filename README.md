# Agent mail

Direct encrypted messaging for Cursor, Claude Code, Codex, Grok, and Antigravity agents on two or more PCs. Each machine runs one peer. There is no shared mailbox and no adapter in the default path.

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

## Windows tray app

`run.bat` installs what is missing, builds, restarts the tray app, and exits. The app has no console or main window. It serves the dashboard at http://127.0.0.1:8788/dashboard, which reads this PC's `~/.agent-mail` store: `journal.db` when present, otherwise the JSON peer folders. It also receives mail unless something on this PC already holds TCP `47832`. In that case it leaves that receiver running, and **Quit** stops only the dashboard.

Click the tray icon to open the dashboard. Right-click it and choose **Quit** to stop. Starting the app while it is running opens the dashboard. Logs are in `%LOCALAPPDATA%\Agent Mailbox\agent-mailbox.log`.

To add a desktop shortcut and start the app at logon, run `scripts\install-shortcut.ps1` once. Turn off the logon start under **Startup apps** in Task Manager. Run `run.bat` again after changing code.

## Trust, then send

On each PC, with the other one listening:

```powershell
node dist/cli.js discover
node dist/cli.js trust PC-B --fingerprint <64-hex-chars-from-the-other-pc>
node dist/cli.js send PC-B --text "Review the auth change."
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

Build first, then add one stdio server to each agent's user config, so every project sees it. Use an absolute path to `dist/cli.js`. This checkout has no project-level MCP config. Several agents on one PC share the store, so start each with `--no-listen` and run `listen` (or the [tray app](#windows-tray-app)) once.

| Agent | User config |
| --- | --- |
| Claude Code | `claude mcp add --scope user agent-mail -- node C:/path/to/synthet-agent-mailbox/dist/cli.js mcp --no-listen --harness claude-code --agent-name claude --model claude` |
| Cursor | `~/.cursor/mcp.json` |
| Codex | `~/.codex/config.toml` |
| Grok | `~/.grok/config.toml` |
| Antigravity | `~/.gemini/antigravity/mcp_config.json`, `~/.gemini/antigravity-ide/mcp_config.json`, and `agy mcp add` for the CLI (`~/.gemini/config/mcp_config.json`) |
| Gemini CLI | `~/.gemini/settings.json` |

Cursor, Antigravity, and Gemini CLI take the same JSON. See `config/cursor-mcp.example.json`, `config/claude-code-mcp.example.json`, and `antigravity-mcp.example.json`, and change `--harness`, `--agent-name`, and `--model` to match.

Codex:

```toml
[mcp_servers.agent-mail]
command = "node"
args = ["C:/path/to/synthet-agent-mailbox/dist/cli.js", "mcp", "--no-listen", "--harness", "codex", "--agent-name", "codex", "--model", "codex"]
```

Grok uses the same table with `--harness grok --agent-name grok --model grok`.

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

## What every message carries

The message plaintext is signed with this peer's Ed25519 key, then encrypted. The same key signs the transport packet. A recipient rejects the message when either signature does not match the pinned fingerprint.

`origin` is filled when the message is first queued: hostname, platform, architecture, and the machine's non-loopback IP addresses. `agent` is optional:

| Field | How to set it |
| --- | --- |
| `harness` | `--harness` or `AGENT_MAIL_HARNESS` |
| `name` | `--agent-name` or `AGENT_MAIL_AGENT_NAME` |
| `model` | `--model` or `AGENT_MAIL_MODEL` |
| `session_id` | `--session`, `AGENT_MAIL_SESSION`, or `session_id` on `send_message` |

Put the stable values in that harness's MCP config. A chat session id is not available to the MCP process unless the agent passes `session_id` or the harness supplies it. Omit any field you do not know.

```json
{
  "mcpServers": {
    "agent-mail": {
      "command": "node",
      "args": ["${workspaceFolder}/dist/cli.js", "mcp", "--harness", "cursor", "--agent-name", "cursor", "--model", "composer"]
    }
  }
}
```

### Routing fields (agent-mail/1.1)

`send_message` also takes `to_session`, `hop` (0–16), `auto_reply` and `in_reply_to`. They are signed with the rest of the message, but only when the recipient's `GET /capabilities` lists `agent-mail/1.1`. Any other answer, or no answer, leaves them out, and the result says `envelope_downgraded: true`.

- The MCP server caches a definite answer per contact for 10 minutes and drops it when the endpoint changes. The CLI is a new process each time, so `send` probes on every call that sets these fields.
- A queued message keeps the fields it was signed with. A message downgraded once stays downgraded on retry; send a new message id to include the fields.
- The answer is advisory. It never changes trust or which endpoint is saved.

## Discovery and ports

LAN discovery is UDP multicast `239.255.77.31:47831`. Messages are HTTP on TCP `47832`, with the ciphertext and signature in the body. The URL is only a way to reach the peer; it is not the security boundary. Allow inbound TCP `47832` and UDP `47831` on the private network profile.

Tailscale discovery runs `tailscale status --json` and probes online peers at TCP `47832`. It does not scan subnets. Install the Tailscale CLI, sign in, and allow that TCP port through the host firewall on the tailnet. `--no-tailscale` skips the probe. `--no-discovery` stops LAN advertisements.

Each send tries the saved endpoint first, then discovered addresses. When a discovered address returns a receipt signed by the pinned key, it becomes the saved endpoint and the result says `endpoint_changed`. If the saved address is down, each send waits for that connection to fail before trying the next one, until a delivery moves the pin. Pin a preferred address with `trust NAME --fingerprint FP --endpoint URL`.

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

`npm run legacy:init`, `npm run legacy:mailbox`, and `npm run adapter` still run the older shared mailbox and per-PC adapter. `npm run test:legacy` covers the old path.

## Tests

```powershell
npm test
```
