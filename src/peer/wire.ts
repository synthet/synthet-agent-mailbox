import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { z } from "zod";
import { fingerprint, publicIdentity, publicIdentitySchema, signed, verified, type Identity, type PublicIdentity } from "./identity.js";
import { agentSchema, originSchema } from "./metadata.js";

const unsignedSchema = z.object({
  id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  sender: z.string().regex(/^[a-f0-9]{64}$/),
  recipient: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string().min(1).max(64 * 1024).refine((text) => Buffer.byteLength(text, "utf8") <= 64 * 1024, "Text exceeds 64 KiB"),
  created_at: z.number().int().nonnegative(),
  origin: originSchema,
  agent: agentSchema.optional(),
}).strict();
export const messageSchema = unsignedSchema.extend({
  signature: z.string().min(1).max(128),
}).strict().refine((message) => Buffer.byteLength(JSON.stringify(message), "utf8") <= 96 * 1024, "Encoded message exceeds 96 KiB");
export type PeerMessage = z.infer<typeof messageSchema>;
type UnsignedMessage = z.infer<typeof unsignedSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

/** Stable bytes covered by the sender's Ed25519 key. The signature field itself is excluded. */
export function canonicalUnsigned(message: UnsignedMessage): string {
  return JSON.stringify(canonicalize(unsignedSchema.parse(message)));
}

export function signMessage(identity: Identity, input: unknown): PeerMessage {
  const unsigned = unsignedSchema.parse(input);
  const message = messageSchema.parse({ ...unsigned, signature: signed(identity, canonicalUnsigned(unsigned)) });
  if (!verifyMessage(identity, message)) throw new Error("Invalid message signature");
  return message;
}

export function verifyMessage(identity: PublicIdentity, message: PeerMessage): boolean {
  const parsed = messageSchema.parse(message);
  const { signature, ...unsigned } = parsed;
  return verified(identity, canonicalUnsigned(unsigned), signature);
}
const packetSchema = z.object({ payload: z.string().max(200_000), signature: z.string().max(128) }).strict();
export type Packet = z.infer<typeof packetSchema>;
const encryptedSchema = z.object({
  protocol: z.literal("agent-mail/1"), identity: publicIdentitySchema,
  recipient: z.string().length(64), timestamp: z.number(), ephemeral: z.string().max(300),
  iv: z.string().max(32), tag: z.string().max(32), ciphertext: z.string().max(140_000),
}).strict();

function key(privateKey: string, publicKey: string, recipient: string): Buffer {
  const shared = diffieHellman({ privateKey: createPrivateKey(privateKey), publicKey: createPublicKey(publicKey) });
  return Buffer.from(hkdfSync("sha256", shared, Buffer.from(recipient), Buffer.from("agent-mail/1 encryption"), 32));
}

export function seal(identity: Identity, recipient: PublicIdentity, message: PeerMessage): Packet {
  message = messageSchema.parse(message);
  if (!verifyMessage(identity, message)) throw new Error("Invalid message signature");
  const ephemeral = generateKeyPairSync("x25519");
  const privateKey = ephemeral.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(privateKey, recipient.encryption_key, fingerprint(recipient)), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(message), "utf8"), cipher.final()]);
  const payload = JSON.stringify({
    protocol: "agent-mail/1", identity: publicIdentity(identity), recipient: fingerprint(recipient), timestamp: Date.now(),
    ephemeral: ephemeral.publicKey.export({ type: "spki", format: "pem" }).toString(),
    iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64"),
  });
  return { payload, signature: signed(identity, payload) };
}

export function unseal(identity: Identity, input: unknown, trusted: (id: string) => PublicIdentity | undefined): PeerMessage {
  const packet = packetSchema.parse(input);
  const wire = encryptedSchema.parse(JSON.parse(packet.payload));
  const sender = fingerprint(wire.identity);
  const contact = trusted(sender);
  if (!contact || !verified(contact, packet.payload, packet.signature)) throw new Error("Untrusted sender or invalid signature");
  if (wire.recipient !== fingerprint(identity) || Math.abs(Date.now() - wire.timestamp) > 300_000) throw new Error("Wrong recipient or expired packet");
  const decipher = createDecipheriv("aes-256-gcm", key(identity.encryption_private, wire.ephemeral, wire.recipient), Buffer.from(wire.iv, "base64"));
  decipher.setAuthTag(Buffer.from(wire.tag, "base64"));
  const message = messageSchema.parse(JSON.parse(Buffer.concat([decipher.update(Buffer.from(wire.ciphertext, "base64")), decipher.final()]).toString("utf8")));
  if (message.sender !== sender || message.recipient !== wire.recipient) throw new Error("Message identity mismatch");
  if (!verifyMessage(contact, message)) throw new Error("Invalid message signature");
  return message;
}

export function receipt(identity: Identity, message: PeerMessage): Packet {
  const payload = receiptPayload(message);
  return { payload, signature: signed(identity, payload) };
}

export function verifyReceipt(contact: PublicIdentity, input: unknown, message: PeerMessage): void {
  const packet = packetSchema.parse(input);
  if (!verified(contact, packet.payload, packet.signature) || packet.payload !== receiptPayload(message)) {
    throw new Error("Invalid delivery receipt");
  }
}

function receiptPayload(message: PeerMessage): string {
  return JSON.stringify({ protocol: "agent-mail/1 receipt", digest: createHash("sha256").update(JSON.stringify(message)).digest("hex") });
}
