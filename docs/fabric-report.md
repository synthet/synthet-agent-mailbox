# Fabric implementation report

Date: 2026-10-18. Node v24.5.0 on Windows.

## What changed

- `src/fabric/journal.ts` — SQLite WAL journal, sessions, scoped messages, blobs, tasks.
- `src/fabric/daemon.ts`, `sync.ts`, `box.ts` — loopback control port, sealed `agent-mail/2` sync, blob ranges.
- `src/fabric/a2a.ts` — optional v1 subset, off unless `AGENT_MAIL_A2A=1`.
- `src/fabric/harness.ts` and `.claude/skills/agent-mailbox/SKILL.md` — skill plus project-local hook templates.
- `src/cli.ts` — `daemon`, `register`, `publish`, `digest`, `sync`, `harness`. `send` uses the daemon when it is up.
- `src/peer/peer.ts` — optional HTTP handler so sync can share the peer port.
- `src/peer/mcp.ts` — additive `mailbox_*` tools. The original nine tools still use the JSON store.
- Tests: `test/fabric-local.test.mjs`, `test/fabric-sync.test.mjs`, `test/fabric-harness.test.mjs`, `test/fabric-a2a.test.mjs`.
- Docs: `docs/architecture/0001-current-peer-and-fabric.md`, `docs/fabric-contract.md`, `docs/operations.md`.

`package.json` now runs the fabric tests with the peer suite. The package name change was already committed separately.

## Tests run

- `npm test`: 16 passed, 0 failed. That is the original 7 peer tests plus 9 fabric tests.
- `npm run test:legacy`: 19 passed, 0 failed, after `npm rebuild better-sqlite3` for Node 24. The first run, before that rebuild, failed 12 tests with `NODE_MODULE_VERSION` 127 vs 137. Legacy sources were not edited.

Covered here: three sessions on one journal; direct reply and per-session ack; group and broadcast isolation; JSON import; restart; duplicate idempotency; unicode body and blob name; digest omits a malicious body; two-host offline convergence; three-host scope isolation; gap then fill; unpinned sync rejected; partitioned claims stay pending until the home host certifies one; harness install/uninstall; A2A card and `SendMessage` mapping.

## Not verified

- Official A2A conformance suite. The adapter is a documented v1 subset only. Broadcast is rejected as an unknown A2A method on purpose.
- Live Claude, Codex, Cursor, and Antigravity processes. Hook files are templates. Cursor cloud hooks were not checked.
- TLS on the peer port. Sync payloads are sealed; the HTTP listener is still cleartext.
- Import of legacy `mailbox.db`.
- Waking an idle model session. Digests do not try to.

## Rollback

Stop the daemon, delete `daemon.json`, and leave or remove `journal.db` and `blobs/`. The JSON peer store keeps working. See `docs/operations.md`.
