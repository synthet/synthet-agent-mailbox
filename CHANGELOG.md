# Changelog

All notable changes to this project are recorded here.

## [Unreleased]

## [0.4.0] — 2026-11-17

### Added

- Rust agent-mail stack, opt-in. Until the cutover (T-10) it runs on its own `--home` and never touches the TypeScript home ([ADR 0005](docs/architecture/0005-rust-mailer-tray-headless.md)):
  - `mail-core`: byte-compatible with the TypeScript wire format, with golden test vectors in both directions.
  - `agent-maild` mailer:
    - receives into `mail.db`;
    - discovers peers by LAN multicast, `hosts.json` and Tailscale;
    - delivers the outbox with backoff;
    - checks `policy.json` on every send.
  - `agent-mail` CLI, with `migrate` from the TypeScript store and an `mcp` stdio server that has the same tool names.
  - `agent-mail-tray`: a loopback dashboard with a dispatch kill switch, and per-user logon tasks that need no admin rights.
  - Envelope `agent-mail/1.2` adds an optional signed `project` tag, sent only to peers that accept it.
- `agent-mail dispatch`, off by default and per peer ([ADR 0004](docs/architecture/0004-dispatch-mailbox-decides-swarm-executes.md)). It answers typed queries, wakes the session that owns the mail, and otherwise runs a read-only swarm responder.
- `reply_to_message`, with loop guards on automatic replies.
- Session registry: heartbeats, the `watch` stream, conversation leases, and a list of live sessions that says how to reach each one.
- `agent-mail/1.1` routing fields (`to_session`, `hop`, `auto_reply`, `in_reply_to`), sent only to peers whose `/capabilities` accept them.
- A send gate, a body-free ledger, and `agent-mail policy init|check`.
- Hooks show unseen mail on SessionStart, UserPromptSubmit and Stop. `digest` gains `--unseen`, `--json` and `--mark-seen`.
- A Windows tray app that runs the dashboard (replacing Docker). The dashboard shows the running build version.
- A per-host journal and peer event sync.
- A verified receipt now saves the endpoint that returned it.

### Fixed

- The dashboard keeps expanded messages open across auto-refresh and merges journal mail into the peer view instead of replacing it.
- `harness install` writes the nested hook settings shape for Claude and Codex.
- LAN discovery works across several interfaces and after sleep.
- Same-PC agent mail works through MCP, and tool results say where a message went.

