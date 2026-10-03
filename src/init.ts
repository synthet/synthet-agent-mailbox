import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "./config.js";

loadEnvFile();
const file = process.env.AGENTS_FILE ?? "agents.json";
if (existsSync(file)) {
  console.error(`${file} already exists. Refusing to overwrite it.`);
  process.exit(1);
}

const desktop = randomBytes(24).toString("base64url");
const laptop = randomBytes(24).toString("base64url");
const config = {
  maxTurns: 30,
  maxOpenTasks: 10,
  maxAttempts: 5,
  agents: [
    {
      id: "desktop-builder",
      token: desktop,
      capabilities: ["build", "edit", "test"],
      projects: ["*"],
    },
    {
      id: "laptop-reviewer",
      token: laptop,
      capabilities: ["review", "read"],
      projects: ["*"],
    },
  ],
};
writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.error(`Wrote ${file}.`);
console.error("Keep this file on the mailbox host only. Copy each token into that PC's adapter .env.");
console.error("");
console.error("desktop-builder");
console.error(desktop);
console.error("");
console.error("laptop-reviewer");
console.error(laptop);
