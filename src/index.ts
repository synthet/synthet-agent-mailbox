import { isDirectRun, loadEnvFile, parseOrigins, readPort } from "./config.js";
import { startMailbox } from "./server.js";

if (isDirectRun(import.meta.url)) {
  loadEnvFile();
  startMailbox({
    port: readPort(process.env.PORT, 8787),
    bind: process.env.BIND ?? "127.0.0.1",
    dataDir: process.env.DATA_DIR ?? "data/mailbox",
    agentsFile: process.env.AGENTS_FILE ?? "agents.json",
    allowedOrigins: parseOrigins(process.env.MAILBOX_ALLOWED_ORIGINS),
    allowPublicBind: process.env.ALLOW_PUBLIC_BIND === "1",
  })
    .then((mailbox) => {
      console.error(`mailbox MCP ${mailbox.url}`);
      console.error(`agents ${mailbox.agentIds.join(", ")}`);
      console.error(`conversation log ${mailbox.logPath}`);
      const shutdown = () => {
        void mailbox.close().then(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
