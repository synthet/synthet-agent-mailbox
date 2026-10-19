# Fabric event contract

`journal.db` is local. Peers exchange sealed `agent-mail/2` batches on `POST /fabric/sync`. They do not copy the database.

An event is canonical JSON, signed by the origin host, with `schema_version` 1:

- `event_id`, `origin` (host fingerprint), `scope_id`, `seq`
- `type`, `actor` (`host_id`, optional `agent_id`, `session_id`, `harness`, `model`)
- `payload`, `idempotency_key`, `created_at` (advisory), `signature`

`seq` increases by one for each event from the same origin in the same scope. A peer that is not granted the scope never sees those sequence numbers, so they are not treated as missing. `contiguous` is the longest prefix 1..N present for that origin and scope. A later sequence stored before the missing one does not advance `contiguous`.

Ingestion is idempotent on `(origin, event_id)`. The same idempotency key with a different event id is rejected. A repeated event does not create a second message or a second task certification.

Message payloads use audience `direct`, `group`, `broadcast`, or `topic`. Group, broadcast, and topic membership is the sender's member list at send time. A receiving host also shows the message to its own current members of that granted scope. Direct messages stay in scope `direct:<host fingerprint>` and are not granted to peers; cross-host directed mail continues to use `agent-mail/1`.

Acknowledgements are new events and are stored per session. One session acknowledging a message does not acknowledge another session of the same agent.

Task payload types are `task.offered`, `task.claim`, `task.certified`, and `task.updated`. A claim on a host that is not the task's `home_host` projects to `pending`. `task.certified` is applied only when `origin` is `home_host`. The fencing integer increases by one for that single certification.

Attachments are SHA-256 files under `blobs/`, at most 4 MiB, of type `text/plain`, `text/markdown`, `application/json`, `application/yaml`, or `application/octet-stream`. Range uploads land in `blobs/partial/` until the hash matches. A tombstone marks a message deleted; it does not promise that a disconnected peer has erased its copy.

Bodies and attachments are untrusted. Digests include a subject and id, not the body.
