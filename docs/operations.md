# Mailbox operations

## One daemon per computer

```powershell
node dist/cli.js init --name Desktop
node dist/cli.js daemon
```

The daemon binds the peer receiver and a loopback control port. It writes `daemon.json` (mode 0600) with the control token. While that file answers `/health`, `agent-mail send` posts through the daemon and the daemon still uses `agent-mail/1` for delivery.

Register a session before publishing journal mail:

```powershell
node dist/cli.js register --session chat-1 --agent-name Builder --harness cursor
node dist/cli.js publish --session chat-1 --audience group --scope team --text "blocker: waiting on the schema"
node dist/cli.js digest --session chat-1
```

Pin a peer the same way as before (`trust --fingerprint`), then grant a scope and sync:

```powershell
node dist/cli.js sync <fingerprint> --endpoint http://192.0.2.20:47832
```

Only granted scopes are offered. An unpinned caller gets HTTP 403 and nothing is stored.

## Harness templates

From a project directory, not from the user profile:

```powershell
node dist/cli.js harness install --target D:\Projects\example --harness cursor
node dist/cli.js harness inspect --target D:\Projects\example
node dist/cli.js harness uninstall --target D:\Projects\example
```

`claude`, `codex`, `cursor`, and `agy` are accepted. Install refuses the user profile root and user-global MCP files (`~\.cursor\mcp.json`, `~\.claude.json`, `~\.codex\config.toml`, `~\.gemini`). Existing hook files that this installer did not create are left in place. Hook commands run `digest`, which prints a short untrusted summary and exits 0 when the journal is unavailable.

These templates were not executed inside Claude, Codex, Cursor, or Antigravity during this change. Cursor cloud agents were not checked.

## Backup

Copy, while the daemon is stopped:

- `identity.json` (private keys; keep it private)
- `journal.db`, `journal.db-wal`, `journal.db-shm`
- `blobs/`
- the JSON directories `contacts`, `inbox`, `acked`, `outbox`, `sent`

`node dist/cli.js` repair is not a separate command. Opening a `Journal` and calling `repair()` checks blob hashes.

## Rollback

1. Stop the daemon.
2. Delete `daemon.json` so `send` stops proxying.
3. Leave or delete `journal.db*` and `blobs/`. The JSON store is still the `agent-mail/1` mailbox.
4. Do not delete `identity.json` unless you intend to create a new host id.
5. Legacy `mailbox.db` is untouched and is not migrated.

Deleting a journal does not delete messages that a peer already stored. A later sync can deliver them again if the events are still on the peer; idempotent event ids keep them from applying twice on a journal that still has them.
