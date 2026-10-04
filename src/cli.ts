#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { fingerprint, initIdentity, loadIdentity, publicIdentity, validatePublic } from "./peer/identity.js";
import { startPeerMcp } from "./peer/mcp.js";
import { Peer } from "./peer/peer.js";
import type { Contact } from "./peer/store.js";

const help = `agent-mail — direct encrypted peer messaging (no mailbox or adapter)

  init --name NAME                      Create local Ed25519/X25519 keys
  identity                              Export public identity as JSON
  discover                              Discover LAN and online Tailscale peers
  trust NAME --fingerprint SHA256       Pin a discovered peer after verification
  trust --file public.json --fingerprint SHA256 [--endpoint http://host:47832]
  peers                                 List trusted peers
  untrust FINGERPRINT                    Revoke a pinned peer
  send RECIPIENT --text TEXT             Send directly; auto-discover address
  send RECIPIENT --file PATH             Read exact UTF-8 text (use - for stdin)
       [--message-id UUID] [--conversation UUID]
  inbox                                 Read unacknowledged messages
  ack MESSAGE_ID --sender FINGERPRINT    Mark received message read
  thread CONVERSATION_UUID               Read local conversation history
  status                                Count local queues
  flush                                 Retry queued messages
  listen                                Receive messages until stopped
  mcp                                   Stdio MCP + peer receiver

Options: --home PATH (or AGENT_MAIL_HOME), --port 47832, --bind 0.0.0.0,
  --interface IPv4 (LAN multicast interface), --timeout 1200 (discovery ms),
  --no-discovery (disable LAN advertisements), --no-tailscale,
  --no-listen (MCP with an existing receiver).
Pair both directions. Verify fingerprints through a separate trusted channel.
Names alone never establish trust. Queued messages need flush/retry_outbox.
Send exit codes: 0 = recipient stored message; 2 = queued; 1 = error.
`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    home: { type: "string" }, name: { type: "string" }, fingerprint: { type: "string" }, endpoint: { type: "string" },
    file: { type: "string" }, text: { type: "string" }, "message-id": { type: "string" }, conversation: { type: "string" }, sender: { type: "string" },
    port: { type: "string" }, bind: { type: "string" }, interface: { type: "string" }, timeout: { type: "string" },
    "no-discovery": { type: "boolean" }, "no-listen": { type: "boolean" }, "no-tailscale": { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  const [command, argument] = positionals;
  if (values.help || !command) { console.log(help); return; }
  const home = values.home ?? process.env.AGENT_MAIL_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(), ".agent-mail");
  const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const required = (value: string | undefined, label: string): string => { if (!value) throw new Error(`Missing ${label}`); return value; };
  if (command === "init") {
    const identity = initIdentity(home, values.name ?? hostname());
    output({ ...publicIdentity(identity), fingerprint: fingerprint(identity) });
    return;
  }
  const peer = new Peer(loadIdentity(home), home, { interface: values.interface, timeoutMs: values.timeout ? Number(values.timeout) : undefined, tailscale: !values["no-tailscale"], peerPort: values.port ? Number(values.port) : undefined });
  switch (command) {
    case "identity": output(peer.whoami()); break;
    case "discover": output(await peer.discover()); break;
    case "peers": output(peer.store.list<Contact>("contacts").map((c) => ({ ...c, fingerprint: fingerprint(c.identity) }))); break;
    case "trust": {
      const expected = required(values.fingerprint, "--fingerprint").toLowerCase();
      let identity;
      let endpoint = values.endpoint;
      if (values.file) {
        const { fingerprint: ignored, ...publicData } = JSON.parse(readFileSync(values.file, "utf8"));
        identity = validatePublic(publicData);
      } else {
        const found = (await peer.discover()).filter((p) => p.fingerprint === expected && (!argument || p.identity.name.toLowerCase() === argument.toLowerCase()));
        if (!found.length) throw new Error("No discovered peer matches that name and fingerprint; use --file for offline pairing");
        identity = found[0].identity;
        endpoint ??= found[0].endpoint;
      }
      output(peer.store.trust(identity, expected, endpoint));
      break;
    }
    case "untrust": {
      const id = required(argument, "fingerprint").toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Use the full fingerprint");
      peer.store.remove("contacts", id); output({ revoked: id }); break;
    }
    case "send": {
      if ((values.text === undefined) === (values.file === undefined)) throw new Error("Provide exactly one of --text or --file");
      const result = await peer.send({ recipient: required(argument, "recipient"),
        text: values.text ?? readFileSync(values.file === "-" ? 0 : values.file!, "utf8"),
        message_id: values["message-id"], conversation_id: values.conversation });
      output(result);
      if (result.status === "queued") process.exitCode = 2;
      break;
    }
    case "inbox": output(peer.inbox()); break;
    case "ack": output(peer.acknowledge(required(values.sender, "--sender"), required(argument, "message id"))); break;
    case "thread": output(peer.thread(required(argument, "conversation id"))); break;
    case "status": output(peer.status()); break;
    case "flush": {
      const results = await peer.flush(); output(results);
      if (results.some((r) => r.status === "queued")) process.exitCode = 2;
      break;
    }
    case "listen":
    case "mcp": {
      const port = values.port ? Number(values.port) : 47832;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be 1–65535");
      const options = { port, bind: values.bind, discovery: !values["no-discovery"], listen: !values["no-listen"] };
      const running = command === "mcp" ? await startPeerMcp(peer, options) : await peer.listen(options);
      console.error(`${peer.identity.name} (${fingerprint(peer.identity)}) ${options.listen ? `receiving on TCP ${port}` : "MCP client only"}`);
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        void running.close().catch((error) => { console.error(error.message); process.exitCode = 1; });
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      break;
    }
    default: throw new Error(`Unknown command: ${command}\n${help}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
