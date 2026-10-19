import { join } from "node:path";
import { isDirectRun } from "./config.js";
import { startPeerDashboard } from "./peer/dashboard-server.js";

if (isDirectRun(import.meta.url)) {
  const home = process.env.AGENT_MAIL_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(), ".agent-mail");
  const port = Number(process.env.DASHBOARD_PORT ?? 8788);
  const bind = process.env.DASHBOARD_BIND ?? "127.0.0.1";
  startPeerDashboard({
    home,
    port,
    bind,
    container: process.env.DASHBOARD_CONTAINER === "1",
  })
    .then((dashboard) => {
      console.error(`peer dashboard ${dashboard.url}`);
      console.error(`store ${home}`);
      const shutdown = () => {
        void dashboard.close().then(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
