import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { dispatchPeer, loadPolicy, POLICY_TEMPLATE, policySchema } from "../dist/peer/policy.js";

const FP = "a".repeat(64);
const OTHER = "b".repeat(64);
const WORKSPACE = resolve(tmpdir(), "workspace");
const SWARM = resolve(tmpdir(), "swarm", "synthet-agent-swarm.cmd");

const base = { allowed_peers: [FP], max_bytes: 16384 };
const withDispatch = (dispatch, extra = {}) => ({ ...base, ...extra, dispatch });
const fullPeer = {
  workspace: WORKSPACE,
  wake: { destination: "mailbox-dev", harness: "claude" },
  auto_answer: ["version", "hash"],
  responder: { enabled: true, harness: "codex", model: "gpt-5.5" },
};

test("a policy without a dispatch section still loads, with dispatch off", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-mail-dispatch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "policy.json"), JSON.stringify({ ...base, auto_answer_types: ["version"] }));
  const loaded = loadPolicy(dir);
  assert.equal(loaded.ok, true, loaded.error);
  assert.equal(loaded.policy.dispatch.enabled, false);
  assert.deepEqual(loaded.policy.dispatch.limits, { concurrency: 1, per_peer_per_minute: 2, timeout_ms: 60000, budget_usd: 0.25 });
  assert.deepEqual(loaded.policy.dispatch.peers, {});
  assert.equal(dispatchPeer(loaded.policy, FP), null);
});

test("the policy template ships with dispatch off", () => {
  assert.equal(POLICY_TEMPLATE.dispatch.enabled, false);
  assert.deepEqual(POLICY_TEMPLATE.dispatch.peers, {});
  assert.equal(policySchema.safeParse(POLICY_TEMPLATE).success, true);
});

test("dispatchPeer returns the listed peer's settings only while dispatch is enabled", () => {
  const on = policySchema.parse(withDispatch({ enabled: true, swarm_command: SWARM, peers: { [FP]: fullPeer } }));
  const peer = dispatchPeer(on, FP.toUpperCase());
  assert.equal(peer.fingerprint, FP, "the lookup ignores case");
  assert.equal(peer.workspace, WORKSPACE);
  assert.deepEqual(peer.wake, { destination: "mailbox-dev", harness: "claude" });
  assert.deepEqual(peer.auto_answer, ["version", "hash"]);
  assert.deepEqual(peer.responder, { enabled: true, harness: "codex", model: "gpt-5.5" });
  assert.equal(dispatchPeer(on, OTHER), null, "an unlisted peer gets nothing");

  const off = policySchema.parse(withDispatch({ enabled: false, swarm_command: SWARM, peers: { [FP]: fullPeer } }));
  assert.equal(dispatchPeer(off, FP), null, "enabled=false is the kill switch");
});

test("a disabled responder is dropped from the effective settings", () => {
  const policy = policySchema.parse(withDispatch({
    enabled: true, peers: { [FP]: { ...fullPeer, responder: { enabled: false, harness: "claude" } } },
  }));
  assert.equal(dispatchPeer(policy, FP).responder, undefined);
});

test("auto_answer_types is a legacy alias that adds known query types for listed peers", () => {
  const policy = policySchema.parse(withDispatch(
    { enabled: true, peers: { [FP]: { workspace: WORKSPACE, auto_answer: ["hash"] }, [OTHER]: { wake: { destination: "x", harness: "codex" } } } },
    { auto_answer_types: ["version", "hash", "weather"] },
  ));
  assert.deepEqual(dispatchPeer(policy, FP).auto_answer, ["hash", "version"], "merged, unknown types ignored");
  assert.deepEqual(dispatchPeer(policy, OTHER).auto_answer, [], "the alias never answers for a peer with no workspace");
});

test("the dispatch section rejects unsafe or malformed settings", () => {
  const rejects = (dispatch, why) => assert.equal(policySchema.safeParse(withDispatch(dispatch)).success, false, why);
  rejects({ enabled: true, swarm_command: "synthet-agent-swarm", peers: {} }, "swarm_command must be an absolute path");
  rejects({ enabled: true, peers: { [FP]: { ...fullPeer, responder: { enabled: true, harness: "claude" } } } }, "an enabled responder needs swarm_command");
  rejects({ enabled: true, swarm_command: SWARM, peers: { [FP]: { ...fullPeer, responder: { enabled: true, harness: "agy" } } } }, "agy is not a responder harness (#76)");
  rejects({ enabled: true, peers: { [FP]: { auto_answer: ["version"] } } }, "auto_answer needs a workspace");
  rejects({ enabled: true, peers: { [FP]: { workspace: "relative/dir", auto_answer: ["version"] } } }, "workspace must be absolute");
  rejects({ enabled: true, peers: { [FP]: { workspace: WORKSPACE, auto_answer: ["run_tests"] } } }, "only the three query types");
  rejects({ enabled: true, peers: { Beta: { wake: { destination: "x", harness: "claude" } } } }, "peers are keyed by full fingerprint");
  rejects({ enabled: true, peers: { [FP]: { wake: { destination: "x", harness: "cursor" } } } }, "wake supports claude and codex");
  rejects({ enabled: true, peers: { [FP]: { ...fullPeer, tools: ["Bash"] } } }, "unknown peer keys are rejected");
  rejects({ enabled: true, peers: {}, extra: 1 }, "unknown dispatch keys are rejected");
  for (const limits of [{ concurrency: 0 }, { per_peer_per_minute: 0 }, { timeout_ms: 100 }, { budget_usd: 0 }, { budget_usd: 50 }]) {
    rejects({ enabled: true, peers: {}, limits }, `limits out of range: ${JSON.stringify(limits)}`);
  }
});
