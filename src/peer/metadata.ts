import { isIP } from "node:net";
import { arch, hostname, networkInterfaces, platform } from "node:os";
import { z } from "zod";

const label = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\r\n]/.test(value), "Metadata cannot contain line breaks");

export const originSchema = z.object({
  hostname: label(255),
  platform: label(32),
  arch: label(32),
  addresses: z.array(z.string().refine((value) => isIP(value) !== 0, "Invalid IP")).max(16),
}).strict();
export type Origin = z.infer<typeof originSchema>;

export const agentSchema = z.object({
  harness: label(80).optional(),
  name: label(120).optional(),
  model: label(120).optional(),
  session_id: label(200).optional(),
}).strict().refine((agent) => Object.values(agent).some((value) => value !== undefined), "Agent metadata is empty");
export type AgentMeta = z.infer<typeof agentSchema>;
export interface AgentDefaults { harness?: string; name?: string; model?: string; session_id?: string }

/** Non-loopback addresses on this machine, captured once when a message is first created. */
export function localOrigin(): Origin {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && isIP(entry.address) !== 0) addresses.add(entry.address);
    }
  }
  return originSchema.parse({
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    addresses: [...addresses].sort().slice(0, 16),
  });
}

export function agentProfile(input: { harness?: string; name?: string; model?: string; session_id?: string }): AgentMeta | undefined {
  const defined = Object.fromEntries(Object.entries({
    harness: input.harness,
    name: input.name,
    model: input.model,
    session_id: input.session_id,
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== ""));
  if (!Object.keys(defined).length) return undefined;
  return agentSchema.parse(defined);
}

export function agentProfileFromEnv(env: NodeJS.ProcessEnv = process.env): AgentMeta | undefined {
  return agentProfile({
    harness: env.AGENT_MAIL_HARNESS,
    name: env.AGENT_MAIL_AGENT_NAME,
    model: env.AGENT_MAIL_MODEL,
    session_id: env.AGENT_MAIL_SESSION,
  });
}
