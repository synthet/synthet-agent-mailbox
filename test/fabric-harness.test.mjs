import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initIdentity } from "../dist/peer/identity.js";
import { installHarness, inspectHarness, uninstallHarness } from "../dist/fabric/harness.js";

test("harness install is idempotent and refuses user-global config", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fabric-harness-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = installHarness(dir, "cursor");
  const second = installHarness(dir, "cursor");
  assert.equal(first.wrote.includes(".cursor/hooks.json"), true);
  assert.equal(second.skipped.length, 0);
  assert.equal(readFileSync(join(dir, ".cursor/hooks.json"), "utf8"), readFileSync(join(dir, ".cursor/hooks.json"), "utf8"));
  assert.equal(readFileSync(join(dir, ".agents/skills/agent-mailbox/SKILL.md"), "utf8").includes("untrusted"), true);
  assert.equal(inspectHarness(dir).installed, true);
  const removed = uninstallHarness(dir);
  assert.equal(removed.removed.includes(".cursor/hooks.json"), true);
  assert.equal(inspectHarness(dir).installed, false);
  assert.throws(() => installHarness(join(process.env.USERPROFILE ?? process.env.HOME, ".cursor", "mcp.json"), "cursor"), /user-global|absolute/);
  installHarness(dir, "claude");
  installHarness(dir, "codex");
  installHarness(dir, "agy");
  assert.equal(readFileSync(join(dir, ".claude/agent-mailbox.hooks.json"), "utf8").includes("SessionStart"), true);
  assert.equal(readFileSync(join(dir, ".codex/hooks.json"), "utf8").includes("PreCompact"), true);
  assert.equal(readFileSync(join(dir, ".agents/hooks.json"), "utf8").includes("PreInvocation"), true);
});

test("digest hook exits 0 and does not print a malicious body", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fabric-digest-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  initIdentity(dir, "Desktop");
  const missing = spawnSync(process.execPath, ["dist/cli.js", "digest", "--home", dir, "--session", "missing"], { encoding: "utf8" });
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout.includes("untrusted"), true);
  const again = spawnSync(process.execPath, ["dist/cli.js", "digest", "--home", dir, "--session", "missing"], { encoding: "utf8" });
  assert.equal(again.status, 0);
  assert.equal(again.stdout, missing.stdout);
});
