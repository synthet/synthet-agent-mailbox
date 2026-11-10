#!/usr/bin/env node
// Run the agent-mail CLI with this process's stdio, so hooks get their JSON on stdin and MCP talks over stdio.
// A hook must never break the session: when the CLI is missing, hooks print nothing and exit 0, except the
// send gate, which denies (fail closed). The MCP server exits 1 with a hint.
import { spawn } from "node:child_process";
import { MISSING_CLI, resolveCli } from "./resolve.mjs";

const args = process.argv.slice(2);
const cli = resolveCli();
if (!cli) {
  if (args[0] === "hook" && args[1] === "gate") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: MISSING_CLI } }));
    process.exit(0);
  }
  process.stderr.write(MISSING_CLI + "\n");
  process.exit(args[0] === "hook" ? 0 : 1);
}
const child = spawn(process.execPath, [cli, ...args], { stdio: "inherit", windowsHide: true });
child.on("error", (error) => { process.stderr.write(`agent-mail plugin: ${error.message}\n`); process.exit(args[0] === "hook" ? 0 : 1); });
child.on("close", (code) => process.exit(code ?? 0));
