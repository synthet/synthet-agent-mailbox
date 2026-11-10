#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { fingerprint, initIdentity, loadIdentity, publicIdentity, validatePublic } from "./peer/identity.js";
import { agentProfile } from "./peer/metadata.js";
import { startPeerMcp } from "./peer/mcp.js";
import { Peer } from "./peer/peer.js";
import { hookInject, SeenStore, unseenMessages, type HookInput } from "./peer/seen.js";
import { watchPoll } from "./peer/watch.js";
import { gateHook, initPolicy, ledgerHook, loadPolicy, policyPath, type ToolHookInput } from "./peer/policy.js";
import type { Contact } from "./peer/store.js";
import { startDaemon } from "./fabric/daemon.js";
import { installHarness, inspectHarness, uninstallHarness } from "./fabric/harness.js";
import { Journal } from "./fabric/journal.js";
import { syncOnce } from "./fabric/sync.js";

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
       [--harness NAME] [--agent-name NAME] [--model NAME] [--session ID]
  inbox                                 Read unacknowledged messages
  ack MESSAGE_ID --sender FINGERPRINT    Mark received message read
  thread CONVERSATION_UUID               Read local conversation history
  status                                Count local queues
  flush                                 Retry queued messages
  listen                                Receive messages until stopped
  mcp                                   Stdio MCP + peer receiver
  daemon                                Host journal and peer receiver
  register --session ID                 Register this session on the journal
  publish --session ID --text TEXT      Publish a journal message
       [--audience direct|group|broadcast|topic] [--scope ID]
  digest [--session ID]                 Print a short untrusted inbox digest
  digest --session ID --unseen [--json] Unacked mail this session hasn't been shown
                                        (peer inbox, plus journal.db if present);
                                        --json includes bodies (cut at 4000 chars)
  digest --session ID --mark-seen KEY   Record shown messages (repeatable; KEY from --unseen)
  hook inject --event NAME              Hook entry point (SessionStart|UserPromptSubmit|Stop):
                                        reads the hook JSON on stdin, injects this session's
                                        unseen mail as untrusted data, marks it seen; never fails.
                                        Seen is not read: digest and inbox still list it until ack
  hook gate                             PreToolUse send gate for send_message/mailbox_publish:
                                        denies secrets, unlisted peers, oversize; fails closed
  hook ledger                           PostToolUse: append metadata + sha256 to ledger.jsonl
  policy init|check                     Write a deny-all policy.json / validate it
  session heartbeat|end|list [--session ID]
                                        Keep a journal session live (10 min TTL), end it
                                        (releases its leases), or list live sessions
  lease claim|release|show --conversation ID [--session ID]
                                        30 min conversation lease: one session answers a thread.
                                        Not a task claim (agent-flow owns those), and not an
                                        access control: any local caller can name any session
  watch --session ID [--once] [--backlog] [--interval MS]
                                        One JSON line per new message for this session: ids,
                                        thread and sender only, never bodies. Starts from now
                                        unless --backlog; keeps the journal session live.
                                        Each poll re-reads the unacked inbox; its seen file
                                        keeps the newest 5000 ids
  sync FINGERPRINT --endpoint URL       Exchange granted events with a pinned peer
  harness install|inspect|uninstall     Project-local hook templates
       --target DIR --harness claude|codex|cursor|agy

Options: --home PATH (or AGENT_MAIL_HOME), --port 47832, --bind 0.0.0.0,
  --interface IPv4 (LAN multicast interface), --timeout 1200 (discovery ms),
  --no-discovery (disable LAN advertisements), --no-tailscale,
  --no-listen (MCP with an existing receiver),
  --harness, --agent-name, --model, --session (or AGENT_MAIL_HARNESS,
  AGENT_MAIL_AGENT_NAME, AGENT_MAIL_MODEL, AGENT_MAIL_SESSION).
Each message records hostname and IPs, and is signed by this peer's Ed25519 key.
Agent fields are optional. Set the stable ones in the MCP config; pass session when known.
Pair both directions. Verify fingerprints through a separate trusted channel.
Names alone never establish trust. Queued messages need flush/retry_outbox.
Send exit codes: 0 = recipient stored message; 2 = queued; 1 = error.
`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    home: { type: "string" }, name: { type: "string" }, fingerprint: { type: "string" }, endpoint: { type: "string" },
    file: { type: "string" }, text: { type: "string" }, "message-id": { type: "string" }, conversation: { type: "string" }, sender: { type: "string" },
    harness: { type: "string" }, "agent-name": { type: "string" }, model: { type: "string" }, session: { type: "string" },
    port: { type: "string" }, bind: { type: "string" }, interface: { type: "string" }, timeout: { type: "string" },
    "no-discovery": { type: "boolean" }, "no-listen": { type: "boolean" }, "no-tailscale": { type: "boolean" }, help: { type: "boolean", short: "h" },
    scope: { type: "string" }, audience: { type: "string" }, subject: { type: "string" }, target: { type: "string" },
    unseen: { type: "boolean" }, json: { type: "boolean" }, "mark-seen": { type: "string", multiple: true }, event: { type: "string" },
    once: { type: "boolean" }, backlog: { type: "boolean" }, interval: { type: "string" },
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
  const agent = agentProfile({
    harness: values.harness ?? process.env.AGENT_MAIL_HARNESS,
    name: values["agent-name"] ?? process.env.AGENT_MAIL_AGENT_NAME,
    model: values.model ?? process.env.AGENT_MAIL_MODEL,
    session_id: values.session ?? process.env.AGENT_MAIL_SESSION,
  }) ?? {};
  const peer = new Peer(loadIdentity(home), home, { interface: values.interface, timeoutMs: values.timeout ? Number(values.timeout) : undefined, tailscale: !values["no-tailscale"], peerPort: values.port ? Number(values.port) : undefined }, agent);
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
      const payload = { recipient: required(argument, "recipient"),
        text: values.text ?? readFileSync(values.file === "-" ? 0 : values.file!, "utf8"),
        message_id: values["message-id"], conversation_id: values.conversation };
      const proxied = await daemonPost(home, "/v1/peer-send", payload);
      const result = proxied ?? await peer.send(payload);
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
    case "daemon": {
      const running = await startDaemon(loadIdentity(home), home, { port: values.port ? Number(values.port) : 0, bind: values.bind ?? "127.0.0.1", discovery: !values["no-discovery"], a2a: process.env.AGENT_MAIL_A2A === "1" });
      journalSession(home, loadIdentity(home));
      console.error(`daemon peer ${running.peerPort} control ${running.controlPort}`);
      await new Promise<void>((resolve) => {
        const stop = () => { void running.close().finally(resolve); };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      break;
    }
    case "register": {
      const journal = openJournal(home);
      try { output(journal.registerSession({ session_id: required(values.session, "--session"), alias: values["agent-name"], harness: values.harness, model: values.model })); }
      finally { journal.close(); }
      break;
    }
    case "session": {
      const journal = openJournal(home);
      try {
        if (argument === "list") output(journal.liveSessions());
        else if (argument === "heartbeat") output(journal.heartbeat(required(values.session, "--session")));
        else if (argument === "end") output(journal.endSession(required(values.session, "--session")));
        else throw new Error("Use session heartbeat|end|list");
      } finally { journal.close(); }
      break;
    }
    case "lease": {
      const journal = openJournal(home);
      try {
        const conversation = required(values.conversation, "--conversation");
        if (argument === "show") output({ lease: journal.conversationLease(conversation) });
        else if (argument === "claim") {
          const result = journal.claimConversation(required(values.session, "--session"), conversation);
          output(result);
          if (result.status === "lease_conflict") process.exitCode = 2;
        } else if (argument === "release") output(journal.releaseConversation(required(values.session, "--session"), conversation));
        else throw new Error("Use lease claim|release|show");
      } finally { journal.close(); }
      break;
    }
    case "watch": {
      const session = required(values.session ?? process.env.AGENT_MAIL_SESSION, "--session");
      const interval = Math.max(500, Number(values.interval ?? 2000) || 2000);
      // Open journal.db only once it exists: creating it would switch the dashboard to journal view (#16).
      let journal: Journal | undefined;
      let lastBeat = 0;
      const poll = () => {
        if (!journal && existsSync(join(home, "journal.db"))) journal = openJournal(home);
        for (const line of watchPoll(peer, home, session, journal, { backlog: !!values.backlog })) console.log(JSON.stringify(line));
        // Liveness goes to the journal, not stdout: under a Claude monitor every stdout line wakes the model.
        if (journal && Date.now() - lastBeat >= 5 * 60_000) {
          lastBeat = Date.now();
          try { journal.heartbeat(session); } catch { /* an unregistered session has nothing to keep alive */ }
        }
      };
      poll();
      if (values.once) { journal?.close(); break; }
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          try { poll(); } catch (error) { console.error(`[agent-mail] watch: ${error instanceof Error ? error.message : String(error)}`); }
        }, interval);
        const stop = () => { clearInterval(timer); journal?.close(); resolve(); };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      break;
    }
    case "publish": {
      const journal = openJournal(home);
      try {
        const kind = (values.audience ?? "group") as "direct" | "group" | "broadcast" | "topic";
        output(journal.publish({
          session_id: required(values.session, "--session"),
          audience: kind === "direct" ? { kind, agent_ids: [required(argument, "agent id")] } : { kind, scope_id: required(values.scope, "--scope") },
          body: required(values.text, "--text"), subject: values.subject,
        }));
      } finally { journal.close(); }
      break;
    }
    case "digest": {
      if (values.unseen || values["mark-seen"]) {
        const session = required(values.session ?? process.env.AGENT_MAIL_SESSION, "--session");
        const seen = new SeenStore(home, session);
        if (values["mark-seen"]) { output({ ok: true, marked: seen.mark(values["mark-seen"]) }); break; }
        // Only read an existing journal: creating journal.db would switch the dashboard to journal view (#16).
        const journal = existsSync(join(home, "journal.db")) ? openJournal(home) : undefined;
        try { output({ ok: true, untrusted: true, session, messages: unseenMessages(peer, seen, { journal, session, bodies: !!values.json }) }); }
        finally { journal?.close(); }
        break;
      }
      try {
        const journal = openJournal(home);
        try { output(journal.digest(values.session ?? "cli")); }
        finally { journal.close(); }
      } catch (error) { output({ ok: true, untrusted: true, messages: [], warning: error instanceof Error ? error.message : "unavailable" }); }
      break;
    }
    case "hook": {
      // A hook must never break the session: on any problem, print nothing and exit 0.
      let raw = "";
      try { raw = readFileSync(0, "utf8"); } catch { raw = ""; }
      const parsed = (): Record<string, unknown> => { try { return raw.trim() ? JSON.parse(raw) : {}; } catch { return {}; } };
      if (argument === "gate") {
        // The send gate fails closed: unreadable input for a sending tool still gets a deny.
        let response: Record<string, unknown> | null;
        try { response = gateHook(parsed() as ToolHookInput, home, peer.store, values.harness ?? null); }
        catch (error) { response = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `agent-mail send gate error: ${error instanceof Error ? error.message : String(error)}` } }; }
        if (response) console.log(JSON.stringify(response));
        break;
      }
      if (argument === "ledger") {
        try { ledgerHook(parsed() as ToolHookInput, home, values.harness ?? null); }
        catch (error) { console.error(`agent-mail hook ledger: ${error instanceof Error ? error.message : String(error)}`); }
        break;
      }
      try {
        if (argument !== "inject") throw new Error("Use: hook inject|gate|ledger");
        const input = parsed() as HookInput;
        const event = values.event ?? input.hook_event_name ?? "";
        const journal = existsSync(join(home, "journal.db")) ? openJournal(home) : undefined;
        try {
          const response = hookInject(event, input, { peer, home, fallbackSession: values.harness ?? "hook", journal });
          if (response) console.log(JSON.stringify(response));
        } finally { journal?.close(); }
      } catch (error) { console.error(`agent-mail hook: ${error instanceof Error ? error.message : String(error)}`); }
      break;
    }
    case "policy": {
      if (argument === "init") { output(initPolicy(home)); break; }
      if (argument !== "check") throw new Error("Use: policy init|check");
      const loaded = loadPolicy(home);
      output(loaded.ok ? { ok: true, path: policyPath(home), policy: loaded.policy } : { ok: false, path: policyPath(home), error: loaded.error });
      if (!loaded.ok) process.exitCode = 1;
      break;
    }
    case "sync": {
      const journal = openJournal(home);
      try {
        const contact = peer.store.contact(required(argument, "fingerprint"));
        output(await syncOnce(journal, loadIdentity(home), { endpoint: required(values.endpoint, "--endpoint"), identity: contact.identity }, (id) => peer.store.get<Contact>("contacts", id)?.identity));
      } finally { journal.close(); }
      break;
    }
    case "harness": {
      const action = required(argument, "install, inspect, or uninstall");
      const target = required(values.target, "--target");
      if (action === "install") output(installHarness(target, required(values.harness, "--harness")));
      else if (action === "inspect") output(inspectHarness(target));
      else if (action === "uninstall") output(uninstallHarness(target));
      else throw new Error("Unknown harness action");
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

function openJournal(home: string): Journal {
  return new Journal(home, loadIdentity(home));
}

function journalSession(home: string, identity: ReturnType<typeof loadIdentity>): void {
  const journal = new Journal(home, identity);
  try { journal.registerSession({ session_id: "cli", alias: identity.name }); }
  finally { journal.close(); }
}

async function daemonPost(home: string, path: string, body: unknown): Promise<{ status: string; message_id: string; conversation_id: string; error?: string } | undefined> {
  try {
    const file = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as { controlPort: number; token: string };
    const health = await fetch(`http://127.0.0.1:${file.controlPort}/health`, { headers: { authorization: `Bearer ${file.token}` }, signal: AbortSignal.timeout(300) });
    if (!health.ok) return undefined;
    const response = await fetch(`http://127.0.0.1:${file.controlPort}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${file.token}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(await response.text());
    return await response.json() as { status: string; message_id: string; conversation_id: string; error?: string };
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") return undefined;
    if (error instanceof Error && /ECONNREFUSED|fetch failed/i.test(error.message)) return undefined;
    return undefined;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
