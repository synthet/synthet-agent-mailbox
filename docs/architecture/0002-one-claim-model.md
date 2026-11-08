# ADR 0002 — One claim model: agent-flow owns claims, the fabric carries them between hosts

Date: 2026-11-07
Status: Proposed

## Context

Two claim models exist side by side.

- **agent-flow** (`synthet-agent-flow`) owns tickets. A claim is atomic in the repo's SQLite tracker,
  leased (default 30 minutes, renewable by heartbeat), gated by WIP limits and dependencies, counted as
  an attempt when it expires, and recorded in a hash-chained audit log.
- **The fabric task authority** (`src/fabric/journal.ts`) has its own lifecycle: `task.offered` →
  `task.claim` → `task.certified` → `task.updated`. A claim on a host other than the task's
  `home_host` projects to `pending`; only the home host certifies, once, with a fencing integer.

agent-flow's mailbox integration already decided that the mailbox only carries notifications and that
the fabric's `task.*` events are not used, "so there is never a second source of truth"
(`synthet-agent-flow/docs/integrations.md`). A search of `D:\Projects` on 2026-11-07 found no other
user of `mailbox_offer_task` or `mailbox_claim_task`; the only outside mention is the Jev permission
policy, which lists `mailbox_claim_task` as a tool to gate.

agent-flow has a real gap the fabric model was built for. Each PC has its own `flow.db`, rebuilt from
the committed `tickets.jsonl`, and `agent-flow import` merges a teammate's snapshot with "newer
`updated_at` wins". Two PCs can therefore claim the same ready ticket while offline, and the merge
silently keeps one of them. Leases protect agents on one PC, not across PCs.

The fabric authority cannot replace agent-flow's claims as it stands:

- No leases or expiry: `maybeCertify` returns once a task is `accepted`, and its idempotency key is
  `task-certified:<task_id>`, so a released or abandoned task can never be certified again.
  (Ingestion already accepts a later certification with a higher fencing value.)
- No dependencies, WIP limits, acceptance criteria or review gates.
- Any host can `offer` a task with itself as home.

## Decision

Keep **agent-flow's leased claim as the only claim model**. Reuse the fabric task authority as
agent-flow's **transport for claims across hosts**, and stop offering it as a general-purpose task
tracker.

1. **Home host.** Each agent-flow repo names one claim home: the host whose `flow.db` is
   authoritative for claims (agent-flow config `claims.home`, a mailbox host fingerprint or contact
   name). Without it, agent-flow behaves exactly as today.
2. **Task ids.** A fabric task id is `<repo>/<ticket-id>`, in a scope the repo's agents subscribe to.
   Only the home host offers, when a ticket becomes ready.
3. **Remote claim.** `agent-flow claim` on a non-home host appends `task.claim` and shows the ticket as
   pending locally. It is not owned until certification arrives.
4. **Certification.** The home host's agent-flow (its `serve` daemon or tray app) ingests the claim and
   runs the real atomic claim in its SQLite, with lease, WIP and dependency checks. On success it
   appends `task.certified` with `fencing + 1` and `lease_until`; on failure, `task.updated` with
   `state: rejected` and the reason.
5. **Lease life.** Heartbeats from the claimant are `task.updated {state: working, lease_until}`. On
   release, expiry or approval the home host appends `task.updated {state: released | completed}`;
   the next claim is certified with a higher fencing value.
6. **Fencing.** The certified fencing value travels with the claim (branch metadata and commit trailer
   `Flow-Fence: <n>`). The home host refuses submits and heartbeats that carry a stale value.
7. **Ticket content** keeps syncing through `tickets.jsonl` and git. Only the claim decision moves to
   the fabric.

## Required changes

Mailbox (this repo):

- Allow re-certification after `task.updated {state: released}` from the home host: reset to
  `offered`, and include the fencing value in the certification idempotency key.
- Carry `lease_until` in `task.certified` and `task.updated` payloads.
- Reject `task.offered` from a host that is not the scope's declared home for that task prefix.
- Document `mailbox_offer_task` / `mailbox_claim_task` as the agent-flow claim transport, not a tracker.

agent-flow:

- Config `claims.home` and `claims.transport: local | mailbox` (default `local`).
- A home-side certifier in `serve` and the tray app, using the MCP client the mailbox integration
  already has.
- Remote `claim`, `heartbeat`, `release` and `submit` paths that wait for, renew or check certification.

## Alternatives considered

- **Drop the fabric task events.** Smallest change and removes the duplicate model, but leaves the
  cross-PC double-claim race in agent-flow unsolved.
- **Share one `flow.db` over the network.** SQLite over SMB or a synced folder is not safe for
  concurrent writers.
- **Make agent-flow a network server for all hosts.** Works, but adds an always-on service, auth and
  port exposure that the signed peer fabric already solves.

## Rollout

1. agent-flow: `claims.home` guard. A claim on a non-home host refuses with a clear message. No
   mailbox needed; this already closes the race for teams that accept claiming on one PC.
2. Mailbox: re-certification after release, `lease_until`, home-only offers.
3. agent-flow: remote claim through the fabric plus the home-side certifier.
4. agent-flow: heartbeats, expiry and fencing checks on submit.
5. Mailbox: document the task tools as agent-flow transport; consider hiding them unless enabled.

## Consequences

- One owner for claim decisions; the fabric stays a transport with signed, idempotent events.
- Agents on a remote PC wait for the home host to be reachable before a claim is final. While it is
  offline, claims stay pending rather than racing.
- The Jev policy entry for `mailbox_claim_task` stays valid: it is still a tool that changes claim state.
