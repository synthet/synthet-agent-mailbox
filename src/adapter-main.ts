import { adapterOptionsFromEnv, startAdapter } from "./adapter.js";
import { isDirectRun, loadEnvFile } from "./config.js";

if (isDirectRun(import.meta.url)) {
  loadEnvFile();
  let options;
  try {
    options = adapterOptionsFromEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  startAdapter({
    ...options,
    onFatal: (error) => {
      console.error(error.message);
      process.exit(1);
    },
  })
    .then((adapter) => {
      console.error(`adapter for ${options.agentId}`);
      console.error(`local MCP ${adapter.url}`);
      console.error(`mailbox ${options.mailboxUrl}`);
      console.error(`wake ${options.wake} (${options.wakeClient ?? "cursor"})`);
      console.error(`conversation log ${adapter.logPath}`);
      if (options.wakeClient === "gemini" || options.wakeClient === "antigravity") {
        console.error(`Antigravity snippet ${options.dataDir}\\antigravity-mcp.json`);
        console.error(`Configure agy CLI: agy mcp add --header "Authorization: Bearer ${options.token}" agent-mailbox ${adapter.url}`);
      } else if (options.wakeClient === "claude") {
        console.error(`Claude snippet ${options.dataDir}\\claude-mcp.json`);
      } else if (options.wakeClient === "codex") {
        console.error(`Codex snippet ${options.dataDir}\\codex-mcp.toml`);
      } else {
        console.error(`Cursor snippet ${options.dataDir}\\cursor-mcp.json`);
        console.error(`Antigravity snippet ${options.dataDir}\\antigravity-mcp.json`);
      }
      console.error(`Codex snippet ${options.dataDir}\\codex-mcp.toml (set AGENT_TOKEN in Codex's environment)`);
      console.error(`Claude Code: claude mcp add --transport http agent-mailbox ${adapter.url} --header "Authorization: Bearer <AGENT_TOKEN>"`);
      console.error(`  or: claude --mcp-config ${options.dataDir}\\claude-mcp.json`);
      const shutdown = () => {
        void adapter.close().then(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
