// Find the agent-mail CLI (dist/cli.js) for the plugin's MCP server, hooks and monitor.
// Order: $AGENT_MAIL_CLI, then the checkout this plugin sits in (<repo>/plugin -> <repo>/dist/cli.js).
// An installed plugin is copied to Claude Code's plugin cache, so outside a checkout set AGENT_MAIL_CLI.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @returns {string | null} absolute path to dist/cli.js, or null when none is found */
export function resolveCli(env = process.env, root = pluginRoot, exists = existsSync) {
  const configured = env.AGENT_MAIL_CLI?.trim();
  if (configured) return exists(configured) ? configured : null;
  const local = join(root, "..", "dist", "cli.js");
  return exists(local) ? local : null;
}

export const MISSING_CLI = "agent-mail plugin: CLI not found. Set AGENT_MAIL_CLI to the full path of synthet-agent-mailbox/dist/cli.js (run npm run build there first).";
