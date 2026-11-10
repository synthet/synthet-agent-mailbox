# Plan: peer delivery agent

Status: draft. Not approved for implementation. Spec: [peer-delivery-agent-spec.md](./peer-delivery-agent-spec.md).

## Goal

When a message from an allowed peer is stored, the listener wakes the configured local session with a fixed notice, and may send the sender a fixed status. Done means every `AC-n` has a passing test, the feature is off by default, and one real message between two PCs wakes an idle session.

## Decisions

The owner delegated these to Jev. The spec already reflects the settled ones.

| Item | Outcome | Jev |
| --- | --- | --- |
| OQ-2: who picks the destination | The owner, per peer in local config. The sender cannot choose | `owner_config`, p 0.63, confidence 0.51 |
| OQ-5: defaults | Off; 1 agent at a time; 2 per peer per minute; 60 second timeout; $0.25 budget | `stricter`, p 0.66, confidence 0.55 |
| Who sends replies, if any | The listener, in code, after the agent exits | `listener_code`, p 1.0 |
| OQ-6: replies in the first release | **Open.** Ships without replies unless the owner decides otherwise | Split: 0.47 fixed status, 0.48 none |
| OQ-7: message text to the routing vendor | **Open.** Blocks Step 7 only | Leaned to opt-in, confidence 0.45, below threshold |

## Files and areas

| Path | Change |
| --- | --- |
| `src/peer/delivery.ts` | New. Config, the pure decision function, notice template, session lookup, process runner, audit log |
| `src/peer/peer.ts` | `listen()` gains an `onStored` callback, called only for a newly stored message, after the receipt is sent |
| `src/cli.ts` | The `listen` command wires delivery in when config enables it |
| `test/peer-delivery.test.mjs` | New. See Tests |
| `package.json` | Add the new test file to `test` |
| `README.md`, `config/delivery.example.json` | Document the feature and its config |

`src/wake.ts` stays as it is. It belongs to the legacy adapter, its allowlist names the old server, and it uses `shell: true` on Windows, which this feature must not copy.

Config lives at `<home>/delivery.json`, outside the repo. It holds no credentials.

```json
{
  "enabled": false,
  "peers": { "<fingerprint>": { "destination": { "name": "<session name>" }, "replies": false } },
  "maxConcurrent": 1,
  "perPeerPerMinute": 2,
  "timeoutMs": 60000,
  "maxBudgetUsd": 0.25
}
```

## Approach

### Step 0: spikes (done)

All three passed on one PC, so the design stands.

1. **Interactive idle wake.** An idle terminal session woke and acted on a fixed notice, 27 seconds after the send started.
2. **Listener-started process.** `claude -p` from a scheduled task reached the session messaging layer with no `CLAUDE*` variables and no API key, for about $0.08.
3. **Session identity.** Ids differ between `ListAgents` and `claude agents --json`, but a name set with `claude --name <name>` appears in both. Destinations therefore use that name, and the owner starts the target session with it. Before spawning an agent, code checks `claude agents --json` for the name, so a missing session costs nothing. If two sessions share a name, treat it as no match.

### Step 1: decision logic (AC-1 to AC-3, AC-15, AC-16)

Write `decideDelivery(message, config, state)` as a pure function that returns start or a skip reason. No I/O, so every rule is testable without a process.

### Step 2: notice template (AC-7, AC-9)

Build the notice in code. The alias comes from the local contact store, but that name was chosen by the peer when it was pinned, so it counts as remote text. Allow only `^[\w .-]{1,40}$` and fall back to `a paired peer`. Allow only a UUID as the message id.

### Step 3: runner (AC-4, AC-8, AC-10, AC-17)

Spawn `claude` with `shell: false` and `windowsHide: true`, using the tested arguments:

```text
-p <notice prompt> --tools ListAgents SendMessage ToolSearch
--allowedTools ListAgents SendMessage ToolSearch --strict-mcp-config
--no-session-persistence --disable-slash-commands
--max-budget-usd <n> --output-format json
```

Remove `CLAUDE*` variables from the child environment. Kill the process at the timeout. Never acknowledge the message.

### Step 4: hook and audit (AC-1, AC-18)

Call `onStored` after the receipt, and never await it, so a slow or failed agent cannot delay or fail delivery of the message itself. A duplicate message must not fire it. Append one JSON line per run to `<home>/delivery.log`: message id, peer fingerprint, destination, outcome, cost. No message text.

### Step 5: status reply (AC-11 to AC-14), only if the owner chooses replies in OQ-6

After a successful run, if the peer has `replies: true`, the listener sends one fixed status in the same conversation. Status messages use a reserved prefix and never start a delivery, which ends any loop after one hop. Record answered ids in `<home>/delivery-replied.json` so a restart cannot reply twice. Check `src/peer/wire.ts` first: if a signed `kind` field is cheap to add, prefer it to a prefix.

### Step 6: end to end

Enable delivery for one peer on one PC. Send a real message from the other PC. Confirm the idle session wakes, reads the message with `fetch_inbox`, and the log has one line.

### Step 7: optional Jev routing, after Step 6 works

Configured destinations ship first. Jev routing then becomes an opt-in per peer: `"destination": { "route": "jev" }`.

- Use `@typesafe-ai/sdk` (Node 22 or newer, which both PCs run). The key comes from `TYPESAFE_API_KEY` in the environment, never from `delivery.json`.
- Code builds the candidates from running sessions, using the project folder name and session name only, never a full path. It adds a `none` option.
- Ask one Choice question. The answer can only be one of those candidates, so a message cannot invent a target.
- Send metadata only. Whether message text may ever go to Jev is OQ-7, which is the owner's decision.
- Below a confidence threshold, or on any Jev error or timeout, fall back to the configured destination, or leave the message in the inbox. Delivery never depends on Jev being up.
- Set the threshold from real mail. Do not reuse a guessed value.
- Metadata routing needs a topic or project field that the envelope does not carry today. It is sender-supplied, so it stays untrusted and may only influence a choice among candidates.
- Check the SDK source for timeout and retry defaults, which the docs do not state.

A small test with invented sessions gave four correct answers out of four, one sample each: a clear match, `none` for unrelated mail, a hijack attempt ignored, and routing from metadata alone. This shows the idea works. It does not measure accuracy.

Jev only picks the destination. The `claude -p` step is still needed to send the notice, so this adds a call and saves none.

## Risks

- **Residual injection.** The destination session still reads remote text through the mailbox tools. This feature makes that happen sooner and without a person present. The fixed notice reduces the risk and does not remove it.
- **Harness dependence.** `ListAgents`, `SendMessage` and `claude agents --json` are not a stable public contract, so a Claude Code update could break delivery. Failure leaves the message in the inbox, which is today's behaviour.
- **Sleeping PCs.** A sleeping PC receives nothing, and the sender's outbox is not retried automatically.
- **Cost.** Every notice runs a model. The rate limit and budget flag bound it.

## Constitution check

- **Safety:** received text is never placed in a prompt, a shell or a log. Arguments are passed without a shell. The feature is off by default and the allowlist is explicit.
- **Secrets:** no credentials in config or logs. If an API key proves necessary, it comes from the environment.
- **Harness config:** user-global MCP and harness config stay untouched, which matches `safeTarget` in `src/fabric/harness.ts`.
- **Minimal diffs:** one new module and a small hook in `peer.ts`. No refactor of `src/wake.ts`.
- **SDLC:** needs a backlog issue so the PR can use `Closes #<N>`. Branch from `main`.

## Tests

Write these failing first, in `test/peer-delivery.test.mjs`. The runner is injected, so tests never start a real `claude`.

| AC | Assertion |
| --- | --- |
| AC-1 | `starts one agent for a stored message from an allowed peer` |
| AC-1 | `does not start an agent for a duplicate message` |
| AC-2 | `starts nothing when delivery is disabled or config is missing` |
| AC-3 | `leaves mail from a peer off the allowlist in the inbox` |
| AC-4 | `leaves the message unacknowledged when the agent fails` |
| AC-5 | `targets the configured destination` |
| AC-6 | `leaves the message in the inbox when no session matches` |
| AC-7 | `builds a notice from the template with no message text` |
| AC-7 | `replaces an unsafe contact alias` |
| AC-8 | `passes only the allowed tools and no shell` |
| AC-9 | `gives the runner no message text` |
| AC-10 | `leaves the message unacknowledged after a notice` |
| AC-11 | `sends no status unless replies are enabled for the peer` |
| AC-12 | `sends the status in the original conversation` |
| AC-13 | `never starts a delivery for a status message` |
| AC-14 | `sends one status per message, including across a restart` |
| AC-15 | `starts nothing for a peer over its rate limit` |
| AC-16 | `never exceeds the concurrency limit` |
| AC-17 | `kills an agent that exceeds the timeout` |
| AC-18 | `logs id, peer, destination and outcome, with no message text` |

Also: a `peer.listen` test that a throwing `onStored` still returns a signed receipt.

Jev routing, with an injected client: `sends no message text unless enabled for the peer`, `only accepts a listed candidate`, `falls back when confidence is low`, `falls back when Jev fails`, `sends no full paths`.

## Task breakdown

`/tasks` is required. There are eight ordered steps, Step 0 can change the design, and Step 7 can ship separately.

## Rollback

`enabled` defaults to false, and a missing config means off. Setting it to false, or removing `delivery.json`, restores today's behaviour without touching stored mail. There is no migration. Listeners read config at startup, so they need a restart to pick up a change.
