# Agent mailbox

A shared mailbox for **Cursor, Antigravity (Gemini), Claude Code, and Codex agents on two PCs**. One PC hosts the mailbox. Each PC runs a local adapter that its agent connects to. The adapter sends through the mailbox, keeps an outbox while the host is offline, and spools incoming mail on this machine.

An open agent chat can call the tools itself. An idle chat does not wake up just because MCP is connected. Set `WAKE=cli` or `WAKE=apply` when a message should start a CLI turn.

## Layout

```text
PC that stays online                Other PC
┌─────────────────────┐             ┌─────────────────────┐
│ mailbox  :8787      │◀── tailnet ─│ adapter  :8788      │
│ adapter  :8788      │             │ agent → adapter     │
│ agent → adapter     │             └─────────────────────┘
└─────────────────────┘
```

Each agent talks to `127.0.0.1:8788` on its own PC. Only the adapters open the mailbox port.

## Tools

| Tool | What it does |
| --- | --- |
| `whoami` | Authenticated agent id, capabilities, and projects. |
| `list_agents` | Peers you can address. |
| `send_message` | Store a message. The token picks the sender. |
| `fetch_inbox` | Lease messages waiting on this PC. |
| `acknowledge_message` | Mark a message delivered. This does not finish a task. |
| `release_message` | Put a leased message back for retry. |
| `get_thread` | Read one conversation, including task status. |
| `queue_status` | Local outbox plus mailbox counts. |

`send_message` accepts `message_id` or `operation_id`. Sending the same id again returns the original message instead of writing a second one.

Message `type` is `question`, `answer`, `task`, `progress`, or `result`. A task has one owner: the recipient. Only that owner can send progress or a result. `outcome` is `success` or `failure`.

Also send `repo`, `branch`, and `commit` when the work is code. Each PC uses its own checkout. A path from the other machine is not a path on this one.

The mailbox caps conversation turns, open tasks, delivery attempts, and deadlines. A question is rejected while either side still owes an answer, so the two agents cannot wait on each other.

## Set up the host

On the PC that stays online:

```powershell
npm install
npm run init
```

`npm run init` writes `agents.json` and prints two tokens. Leave that file on the host. Copy each token into that PC's `.env` only.

```powershell
copy .env.example .env
```

Host `.env`:

```text
BIND=127.0.0.1
PORT=8787
MAILBOX_URL=http://127.0.0.1:8787/mcp
AGENT_ID=desktop-builder
AGENT_TOKEN=<desktop token from npm run init>
```

`BIND=127.0.0.1` is enough to try both roles on one computer. For a second PC, install Tailscale on both, run `tailscale ip -4` on the host, and set `BIND` and `MAILBOX_URL` to `http://<that-ip>:8787/mcp`. The mailbox refuses `0.0.0.0` unless you set `ALLOW_PUBLIC_BIND=1`.

Start the host:

```powershell
npm run dev
npm run adapter
```

Use two terminals. `run.bat` and `run-adapter.bat` do the same.

## Run the mailbox host in Docker

```powershell
npm run init                 # once, writes agents.json
docker compose up -d --build
```

The container listens on `8787` inside and is published on host port `MAILBOX_PORT` (default `8797`), on every adapter unless `LAN_BIND` names one LAN IP. `agents.json` is mounted read-only and the database lives in the `mailbox-data` volume. Other PCs set `MAILBOX_URL=http://<this-PC-LAN-IP>:8797/mcp` with their own agent token. Allow inbound TCP `8797` for the Private profile in Windows Firewall. The traffic is plain HTTP, so use it only on a network you trust, or put Tailscale underneath. Stop any host started with `npm run dev` first, since both would want the same port.

## Set up the other PC

Copy this project there and install it. Do not copy `agents.json`. Its `.env` only needs the adapter:

```text
MAILBOX_URL=http://<host-tailscale-ip>:8787/mcp
AGENT_ID=laptop-reviewer
AGENT_TOKEN=<laptop token>
WAKE=off
WAKE_WORKSPACE=D:\Projects\your-checkout
```

Then `npm run adapter`. Allow inbound TCP `8787` on the host from the tailnet.

## Point Cursor at the adapter

Each adapter writes `data/adapter/cursor-mcp.json`. Merge that entry into the checkout's `.cursor/mcp.json` or into your user MCP config. The URL is `http://127.0.0.1:8788/mcp` and the bearer token is **this** PC's token. Do not point Cursor at the mailbox port, or the adapter and the IDE will take each other's messages.

Give each checkout the same remote, branch, and commit. Do not assume a disk path exists on both PCs.

## Point Antigravity (Gemini) at the adapter

Each adapter writes `data/adapter/antigravity-mcp.json` and `data/adapter/mcp_config.json`.

### Antigravity IDE / Desktop (Antigravity 2.0)
In Antigravity: **Settings → MCP Servers → View raw config** (or edit `~/.gemini/config/mcp_config.json`):

```json
{
  "mcpServers": {
    "agent-mailbox": {
      "url": "http://127.0.0.1:8788/mcp",
      "headers": {
        "Authorization": "Bearer <this PC's token>"
      }
    }
  }
}
```

### Antigravity CLI (`agy`)
Configure the MCP server using the CLI:

```powershell
agy mcp add --header "Authorization: Bearer <this PC's token>" agent-mailbox http://127.0.0.1:8788/mcp
```

Verify with `agy mcp list`. The agent will now have access to `whoami`, `list_agents`, `send_message`, `fetch_inbox`, `acknowledge_message`, `release_message`, `get_thread`, and `queue_status`.

### Automatic Wake-Up
To wake an idle Antigravity / Gemini agent when mail arrives, set:

```text
WAKE=cli   # or WAKE=apply to allow file edits in WAKE_WORKSPACE
WAKE_CLIENT=gemini   # or antigravity
WAKE_WORKSPACE=D:\Projects\your-checkout
```

The adapter executes `agy --dangerously-skip-permissions --output-format json --print <wake-prompt>`, auto-approving MCP tools and resuming subsequent messages in the conversation via `--conversation <conversation_id>`.

## Point Claude Code at the adapter

Claude Code needs `"type": "http"` on remote servers. Each adapter also writes `data/adapter/claude-mcp.json` in that form. Either pass it with `claude --mcp-config data/adapter/claude-mcp.json`, or register the adapter once:

```powershell
claude mcp add --transport http agent-mailbox http://127.0.0.1:8788/mcp --header "Authorization: Bearer <this PC's token>"
```

A project `.mcp.json` works too; see `config/claude-code-mcp.example.json`. As with Cursor, use the adapter port, not the mailbox port.

To wake an idle Claude Code agent, set `WAKE_CLIENT=claude` along with `WAKE=cli` or `WAKE=apply` and `WAKE_WORKSPACE`. The adapter runs `claude -p` in that workspace and resumes the conversation's session on later mail.

## Point Codex at the adapter

Each adapter writes `data/adapter/codex-mcp.toml`. Copy its table into your user `~/.codex/config.toml` or the trusted checkout's `.codex/config.toml`. The generated file contains the local URL and the name of the token environment variable, not the token itself:

```toml
[mcp_servers.agent-mailbox]
url = "http://127.0.0.1:8788/mcp"
bearer_token_env_var = "AGENT_TOKEN"
```

Start Codex with `AGENT_TOKEN` set to **this** PC's token. For example, set `$env:AGENT_TOKEN` in the PowerShell session that launches Codex from the same value used by this PC's adapter. Run `codex mcp list` to verify the entry, then ask Codex to call `whoami`. Codex CLI and the IDE extension share this configuration. Use the local adapter URL, not the host mailbox URL. See the [official OpenAI MCP documentation](https://developers.openai.com/codex/mcp) for the supported configuration fields.

For automatic wake-up, install and sign in to the Codex CLI, then set `WAKE_CLIENT=codex`, `WAKE=cli` or `WAKE=apply`, and `WAKE_WORKSPACE` to this PC's Git checkout. The adapter passes its token to the spawned Codex process and supplies the local MCP connection for that turn; a separate user config entry is only needed for interactive Codex use. `cli` uses a read-only sandbox; `apply` uses workspace-write and also permits reply files in the adapter's reply directory. The adapter resumes the Codex session for later messages in the same conversation.

## Receiving mail

With `WAKE=off`, the adapter writes `data/adapter/conversation.log` and holds the messages until a chat calls `fetch_inbox`. That is the safe default.

| `WAKE` | Behavior |
| --- | --- |
| `off` | Spool and log only. |
| `cli` | Start the selected client's CLI for new messages. Antigravity runs with MCP auto-approved; Codex uses a read-only sandbox; Claude Code is pre-approved for `agent-mailbox` and `Read` only. |
| `apply` | Start the selected client's CLI with edits allowed in `WAKE_WORKSPACE`. Antigravity runs in `accept-edits` mode; Codex uses workspace-write. |

The text from the other PC is input, not permission. The woken agent is told to stay inside the existing task. `WAKE=apply` uses the local agent's own permissions; it does not grant the peer a new one.

If the CLI cannot see the mailbox tools, it can write a reply JSON file into `data/adapter/replies/`. The adapter sends that file and then moves it to `replies/sent/`.

## Handshake

Desktop asks the laptop to review a commit:

```json
{
  "recipient": "laptop-reviewer",
  "type": "task",
  "repo": "example/app",
  "branch": "main",
  "commit": "abc1234def",
  "body": {
    "text": "Review the auth change.",
    "expected": "Approve or list the defects."
  }
}
```

The laptop fetches the message, does the review in its own checkout, then:

```json
{
  "recipient": "desktop-builder",
  "type": "result",
  "conversation_id": "<from the task>",
  "task_id": "<from the task>",
  "outcome": "success",
  "body": "Approved. The token check now uses the bearer identity."
}
```

Then it calls `acknowledge_message` with the task's `message_id`. The result is what finishes the task.

## Host down

`send_message` on the adapter returns `queued: true` and a stable `message_id` when the host cannot be reached. The adapter retries with backoff. `queue_status` shows the local outbox. A queued send is not delivered until that retry succeeds.

## Logs

The host appends `data/mailbox/conversation.log`. `GET /log` with the agent token returns the same agent's messages. `GET /health` returns `{ "ok": true }` and no message bodies.

## Tests

```powershell
npm test
```

## Environment

| Variable | Role |
| --- | --- |
| `BIND`, `PORT` | Mailbox listen address. Default `127.0.0.1:8787`. |
| `AGENTS_FILE` | Host identity file. Default `agents.json`. |
| `DATA_DIR` | Mailbox database and log. Default `data/mailbox`. |
| `MAILBOX_URL` | Adapter's mailbox endpoint. |
| `AGENT_ID`, `AGENT_TOKEN` | This PC's identity. Must match `agents.json` on the host. |
| `ADAPTER_PORT` | Local MCP port. Default `8788`. |
| `WAKE`, `WAKE_WORKSPACE` | How to start an agent turn for new mail. |
| `WAKE_CLIENT` | `cursor` (default), `gemini` (or `antigravity`), `claude`, or `codex`. Which CLI the wake-up runs. |
