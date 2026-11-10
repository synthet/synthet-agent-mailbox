import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { initIdentity, publicIdentity, fingerprint } from "../dist/peer/identity.js";
import { Peer } from "../dist/peer/peer.js";
import { checkOutbound, gateHook, initPolicy, ledgerHook, loadPolicy, POLICY_TEMPLATE } from "../dist/peer/policy.js";

// Fake credentials are assembled at runtime so this file never looks like a real leak to a scanner.
const FAKE_GH = "gh" + "p_" + "A".repeat(36);
const FAKE_PEM = "-----BEGIN " + "PRIVATE KEY-----\nAAAA";

function setup(t, policy) {
  const dir = mkdtempSync(join(tmpdir(), "agent-mail-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "me");
  const me = initIdentity(home, "TridentX");
  const zephyr = initIdentity(join(dir, "z"), "Zephyr");
  const other = initIdentity(join(dir, "o"), "Stranger");
  const peer = new Peer(me, home);
  peer.store.trust(publicIdentity(zephyr), fingerprint(zephyr));
  peer.store.trust(publicIdentity(other), fingerprint(other));
  if (policy) writeFileSync(join(home, "policy.json"), JSON.stringify(policy));
  return { home, peer, zephyr, other };
}
const send = (recipient, text) => ({ session_id: "s1", tool_name: "mcp__agent-mail__send_message", tool_input: { recipient, text } });
const ledger = (home) => existsSync(join(home, "ledger.jsonl")) ? readFileSync(join(home, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];

test("checkOutbound denies secrets, oversize, unlisted peers; allows a listed peer", (t) => {
  const { peer, zephyr } = setup(t);
  const policy = { ...POLICY_TEMPLATE, allowed_peers: ["Zephyr"], max_bytes: 100 };
  assert.equal(checkOutbound({ tool: "x", recipient: "Zephyr", text: "status: 17 files match" }, policy, peer.store).decision, "allow");
  assert.equal(checkOutbound({ tool: "x", recipient: fingerprint(zephyr), text: "by fingerprint" }, policy, peer.store).decision, "allow", "fingerprint resolves to a listed name");
  for (const text of [`token here ${FAKE_GH}`, FAKE_PEM, "password = hunter2hunter2"]) {
    assert.match(checkOutbound({ tool: "x", recipient: "Zephyr", text }, policy, peer.store).reason, /secret/);
  }
  assert.match(checkOutbound({ tool: "x", recipient: "Zephyr", text: "y".repeat(101) }, policy, peer.store).reason, /max_bytes/);
  assert.match(checkOutbound({ tool: "x", recipient: "Stranger", text: "hi" }, policy, peer.store).reason, /allowed_peers/);
  assert.equal(checkOutbound({ tool: "x", recipient: "Zephyr", text: "please git push" }, policy, peer.store).decision, "allow", "action check is opt-in");
  assert.match(checkOutbound({ tool: "x", recipient: "Zephyr", text: "please git push" }, { ...policy, forbid_action_requests: true }, peer.store).reason, /owner's approval/);
});

test("gate fails closed without a valid policy, ignores non-sending tools, and logs denials without bodies", (t) => {
  const { home, peer } = setup(t);
  const missing = gateHook(send("Zephyr", "hello"), home, peer.store);
  assert.equal(missing.hookSpecificOutput.permissionDecision, "deny");
  assert.match(missing.hookSpecificOutput.permissionDecisionReason, /policy/);
  writeFileSync(join(home, "policy.json"), "{ not json");
  assert.equal(gateHook(send("Zephyr", "hello"), home, peer.store).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(gateHook({ tool_name: "mcp__agent-mail__fetch_inbox", tool_input: {} }, home, peer.store), null, "reads are not gated");
  writeFileSync(join(home, "policy.json"), JSON.stringify({ ...POLICY_TEMPLATE, allowed_peers: ["Zephyr"] }));
  assert.equal(gateHook(send("Zephyr", "hello"), home, peer.store), null, "allowed: no output, normal permission flow");
  assert.equal(gateHook({ tool_name: "mcp__plugin_agent-mail_agent-mail__send_message", tool_input: { recipient: "Stranger", text: "x" } }, home, peer.store).hookSpecificOutput.permissionDecision, "deny", "plugin-scoped names are gated too");
  const secret = `here is ${FAKE_GH}`;
  gateHook(send("Zephyr", secret), home, peer.store);
  const lines = readFileSync(join(home, "ledger.jsonl"), "utf8");
  assert.doesNotMatch(lines, /here is|AAAAAAAA|hello/, "ledger never stores bodies");
  const last = ledger(home).at(-1);
  assert.match(last.decision, /^denied: /);
  assert.match(last.sha256, /^[0-9a-f]{64}$/);
});

test("ledger records ids from the MCP result and only the body hash", (t) => {
  const { home } = setup(t);
  const entry = ledgerHook({
    session_id: "s1", tool_name: "mcp__agent-mail__send_message", tool_input: { recipient: "Zephyr", text: "secret-free body" },
    tool_response: { content: [{ type: "text", text: JSON.stringify({ status: "delivered", message_id: "m-1", conversation_id: "c-1" }) }] },
  }, home, "claude-code");
  assert.deepEqual([entry.peer, entry.message_id, entry.conversation_id, entry.decision, entry.harness], ["Zephyr", "m-1", "c-1", "delivered", "claude-code"]);
  const raw = readFileSync(join(home, "ledger.jsonl"), "utf8");
  assert.doesNotMatch(raw, /secret-free body/);
  assert.deepEqual(Object.keys(JSON.parse(raw.trim())).sort(), ["conversation_id", "decision", "harness", "message_id", "peer", "session", "sha256", "tool", "ts"]);
  assert.equal(ledgerHook({ tool_name: "mcp__agent-mail__fetch_inbox", tool_input: {} }, home).sha256, null, "reads log no hash");
});

test("policy init writes a deny-all template once; policy check validates", (t) => {
  const { home } = setup(t);
  const cli = (...args) => spawnSync(process.execPath, ["dist/cli.js", "policy", "--home", home, ...args], { encoding: "utf8" });
  assert.equal(cli("check").status, 1, "missing policy fails the check");
  assert.equal(JSON.parse(cli("init").stdout).created, true);
  assert.equal(JSON.parse(cli("init").stdout).created, false, "never overwrites");
  const check = cli("check");
  assert.equal(check.status, 0);
  assert.deepEqual(JSON.parse(check.stdout).policy.allowed_peers, [], "template allows nobody");
  assert.equal(loadPolicy(home).ok, true);
  assert.equal(initPolicy(home).created, false);
});

test("CLI hook gate denies on bad stdin for nothing, and on a sending tool without policy", (t) => {
  const { home } = setup(t);
  const gate = (input) => spawnSync(process.execPath, ["dist/cli.js", "hook", "gate", "--home", home], { input, encoding: "utf8" });
  const noPolicy = gate(JSON.stringify(send("Zephyr", "hi")));
  assert.equal(noPolicy.status, 0);
  assert.equal(JSON.parse(noPolicy.stdout).hookSpecificOutput.permissionDecision, "deny");
  const garbage = gate("{nope");
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, "", "unparseable input names no tool, so there's nothing to gate");
  const led = spawnSync(process.execPath, ["dist/cli.js", "hook", "ledger", "--home", home], { input: "{nope", encoding: "utf8" });
  assert.equal(led.status, 0, "ledger never fails the session");
});
