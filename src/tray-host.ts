import { join } from "node:path";
import { isDirectRun } from "./config.js";
import { startPeerDashboard } from "./peer/dashboard-server.js";
import { loadIdentity } from "./peer/identity.js";
import { Peer } from "./peer/peer.js";

const SHUTDOWN_TIMEOUT_MS = 3000;

export interface TrayHostOptions {
  home: string;
  dashboardPort?: number;
  peerPort?: number;
  discovery?: boolean;
}

export interface RunningTrayHost {
  url: string;
  /** "external" means another process, such as a scheduled `listen`, already owns the peer port. */
  receiver: "hosted" | "external";
  close: () => Promise<void>;
}

/** Serve the dashboard, and receive mail unless something on this PC already does. */
export async function startTrayHost(options: TrayHostOptions): Promise<RunningTrayHost> {
  const dashboard = await startPeerDashboard({ home: options.home, port: options.dashboardPort ?? 8788, bind: "127.0.0.1" });
  let receiver: { close: () => Promise<void> } | undefined;
  try {
    const peer = new Peer(loadIdentity(options.home), options.home);
    receiver = await peer.listen({ port: options.peerPort ?? 47832, discovery: options.discovery });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
      await dashboard.close();
      throw error;
    }
  }
  return {
    url: dashboard.url,
    receiver: receiver ? "hosted" : "external",
    close: async () => { await Promise.all([dashboard.close(), receiver?.close()]); },
  };
}

if (isDirectRun(import.meta.url)) {
  const home = process.env.AGENT_MAIL_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(), ".agent-mail");
  startTrayHost({
    home,
    dashboardPort: process.env.DASHBOARD_PORT ? Number(process.env.DASHBOARD_PORT) : undefined,
    peerPort: process.env.PEER_PORT ? Number(process.env.PEER_PORT) : undefined,
  })
    .then((host) => {
      console.error(`dashboard ${host.url}`);
      console.error(host.receiver === "hosted" ? "receiver hosted by the tray" : "receiver already running elsewhere; leaving it alone");
      // The tray holds our stdin open, so this also fires if the tray is killed.
      process.stdin.once("close", () => {
        // A browser's keep-alive connection can hold server.close() open.
        const timeout = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS));
        void Promise.race([host.close(), timeout]).finally(() => process.exit(0));
      });
      process.stdin.resume();
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
