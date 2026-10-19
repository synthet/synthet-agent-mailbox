# ADR 0001 — Current peer mail and the host journal

Date: 2026-10-18

## Current implementation

The product path is direct peer mail, not the older shared mailbox.

- Identity: Ed25519 signing and X25519 encryption under `AGENT_MAIL_HOME` (default `~/.agent-mail`), created by `agent-mail init`. The host id is the SHA-256 fingerprint of the two public keys.
- Store: atomic JSON files in `contacts`, `inbox`, `acked`, `outbox`, and `sent` (`src/peer/store.ts`). Several processes can share one directory.
- Wire: `agent-mail/1` is one signed plaintext message inside an ephemeral X25519 + AES-GCM packet, posted to `http://host:47832/message`. Trust is an explicit fingerprint pin. Discovery (LAN multicast and Tailscale) does not grant trust.
- MCP: stdio tools `whoami`, `discover_peers`, `list_agents`, `send_message`, `fetch_inbox`, `acknowledge_message`, `get_thread`, `queue_status`, `retry_outbox`.
- CLI: `src/cli.ts`. `listen` and `mcp` can each bind the receiver. There is no shared daemon.

The legacy path remains behind `npm run legacy:*`. `src/mailbox.ts` is SQLite `mailbox.db` (conversations, tasks, messages) served by MCP Streamable HTTP in `src/server.ts`. `src/local-queue.ts` is the adapter spool. That database is not the replication log.

## What was already true

Directed, signed, encrypted messages; durable local queue; idempotent message ids; fingerprint pairing; same-PC and two-peer delivery tests.

## What was missing

One daemon per host, separate logical agents and sessions, groups, topics, an append-only event journal, sync cursors, attachments, scope grants, and a task authority. Agent metadata on a peer message is optional and is not a stable agent id. Peer HTTP is cleartext; confidentiality is the packet body.

## Baseline before this change

- Node v24.5.0.
- `npm test`: 7 passed (`test/peer.test.mjs`).
- `npm run test:legacy`: 12 failed because `better-sqlite3` was built for NODE_MODULE_VERSION 127 while this Node expects 137. After `npm rebuild better-sqlite3`, the same suite passed 19 tests. The legacy sources were not changed.

## Decision

Add `journal.db` beside the JSON store. Events are immutable and signed. Inbox rows are a projection. SQLite files are not copied between hosts.

Sequence numbers are per origin and per scope. A single origin counter would look like a gap when a peer is not allowed to see another scope.

Existing peer tool names stay on the JSON store. New `mailbox_*` tools and `register` / `publish` / `digest` use the journal. `send` uses the daemon when `daemon.json` is live, and the daemon still delivers `agent-mail/1` before importing JSON into the journal.

`agent-mail/2` sync batches are sealed to a pinned peer. A remote event is stored only when the direct sender is granted that scope and the origin signature checks. Mandatory TLS is deferred so current peers keep speaking HTTP.

Offline task claims stay `pending`. Only the task's home host appends `task.certified`, and only one certification is accepted.

The legacy `mailbox.db` is not imported. JSON inbox, sent, and outbox files are imported and left in place.

A2A is off unless the daemon is started with `AGENT_MAIL_A2A=1`. The adapter speaks a v1 subset (agent card, `SendMessage`, `GetTask`, `ListTasks`, `CancelTask`). It is not a conformance claim.

## Rollback

Stop the daemon. Ignore or delete `journal.db`, `journal.db-wal`, `journal.db-shm`, and `blobs/`. The JSON store and `agent-mail/1` tools keep working. Removing `daemon.json` makes `send` talk to the local peer process again. Do not delete `identity.json`.
