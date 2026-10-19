import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { z } from "zod";
import { fingerprint, publicIdentity, publicIdentitySchema, signed, verified, type Identity, type PublicIdentity } from "../peer/identity.js";
import { canonical } from "./canonical.js";

const packetSchema = z.object({ payload: z.string().max(1_200_000), signature: z.string().max(128) }).strict();
const sealedSchema = z.object({
  protocol: z.literal("agent-mail/2"),
  identity: publicIdentitySchema,
  recipient: z.string().length(64),
  timestamp: z.number(),
  ephemeral: z.string().max(300),
  iv: z.string().max(32),
  tag: z.string().max(32),
  ciphertext: z.string().max(1_000_000),
}).strict();

function key(privateKey: string, publicKey: string, recipient: string): Buffer {
  const shared = diffieHellman({ privateKey: createPrivateKey(privateKey), publicKey: createPublicKey(publicKey) });
  return Buffer.from(hkdfSync("sha256", shared, Buffer.from(recipient), Buffer.from("agent-mail/2 encryption"), 32));
}

/** Encrypt a JSON value to one pinned peer. This is not an agent-mail/1 message. */
export function sealBytes(identity: Identity, recipient: PublicIdentity, value: unknown): { payload: string; signature: string } {
  const ephemeral = generateKeyPairSync("x25519");
  const privateKey = ephemeral.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(privateKey, recipient.encryption_key, fingerprint(recipient)), iv);
  const ciphertext = Buffer.concat([cipher.update(canonical(value), "utf8"), cipher.final()]);
  const payload = JSON.stringify({
    protocol: "agent-mail/2", identity: publicIdentity(identity), recipient: fingerprint(recipient), timestamp: Date.now(),
    ephemeral: ephemeral.publicKey.export({ type: "spki", format: "pem" }).toString(),
    iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64"),
  });
  return { payload, signature: signed(identity, payload) };
}

export function openBytes(identity: Identity, input: unknown, trusted: (id: string) => PublicIdentity | undefined): unknown {
  const packet = packetSchema.parse(input);
  const wire = sealedSchema.parse(JSON.parse(packet.payload));
  const senderId = fingerprint(wire.identity);
  const contact = trusted(senderId);
  if (!contact || !verified(contact, packet.payload, packet.signature)) throw new Error("Untrusted sender or invalid signature");
  if (wire.recipient !== fingerprint(identity) || Math.abs(Date.now() - wire.timestamp) > 300_000) throw new Error("Wrong recipient or expired packet");
  const decipher = createDecipheriv("aes-256-gcm", key(identity.encryption_private, wire.ephemeral, wire.recipient), Buffer.from(wire.iv, "base64"));
  decipher.setAuthTag(Buffer.from(wire.tag, "base64"));
  const text = Buffer.concat([decipher.update(Buffer.from(wire.ciphertext, "base64")), decipher.final()]).toString("utf8");
  return JSON.parse(text) as unknown;
}

export function digestHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
