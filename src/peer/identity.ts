import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const publicIdentitySchema = z.object({
  name: z.string().min(1).max(80),
  signing_key: z.string().max(300),
  encryption_key: z.string().max(300),
}).strict();
export type PublicIdentity = z.infer<typeof publicIdentitySchema>;
export interface Identity extends PublicIdentity { signing_private: string; encryption_private: string }

export function fingerprint(identity: PublicIdentity): string {
  // Callers may hold the local key file, which also contains private keys.
  // Hash only the public fields so a strict public schema can still reject those keys on import.
  const pub = validatePublic({
    name: identity.name,
    signing_key: identity.signing_key,
    encryption_key: identity.encryption_key,
  });
  return createHash("sha256").update(pub.signing_key + "\n" + pub.encryption_key).digest("hex");
}

export function validatePublic(value: unknown): PublicIdentity {
  const identity = publicIdentitySchema.parse(value);
  if (createPublicKey(identity.signing_key).asymmetricKeyType !== "ed25519" ||
      createPublicKey(identity.encryption_key).asymmetricKeyType !== "x25519") throw new Error("Unsupported identity keys");
  return identity;
}

export function publicIdentity(identity: Identity): PublicIdentity {
  return { name: identity.name, signing_key: identity.signing_key, encryption_key: identity.encryption_key };
}

export function loadIdentity(dir: string): Identity {
  const value = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8")) as Identity;
  validatePublic(publicIdentity(value));
  for (const [privateKey, publicKey] of [[value.signing_private, value.signing_key], [value.encryption_private, value.encryption_key]]) {
    if (createPublicKey(privateKey).export({ type: "spki", format: "pem" }) !== publicKey) throw new Error("Identity key mismatch");
  }
  return value;
}

export function initIdentity(dir: string, name: string): Identity {
  if (existsSync(join(dir, "identity.json"))) throw new Error("Identity already exists; refusing to replace private keys");
  if (!name.trim() || name.length > 80) throw new Error("Name must contain 1–80 characters");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  const identity: Identity = {
    name,
    signing_key: signing.publicKey.export({ type: "spki", format: "pem" }).toString(),
    encryption_key: encryption.publicKey.export({ type: "spki", format: "pem" }).toString(),
    signing_private: signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    encryption_private: encryption.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  writeFileSync(join(dir, "identity.json"), JSON.stringify(identity, null, 2), { flag: "wx", mode: 0o600 });
  return identity;
}

export function signed(identity: Identity, payload: string): string {
  return sign(null, Buffer.from(payload), identity.signing_private).toString("base64");
}

export function verified(identity: PublicIdentity, payload: string, signature: string): boolean {
  try { return verify(null, Buffer.from(payload), identity.signing_key, Buffer.from(signature, "base64")); }
  catch { return false; }
}
