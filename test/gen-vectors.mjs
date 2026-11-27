// Golden vectors for the Rust port (ADR 0005, T-1).
//
//   node test/gen-vectors.mjs --write [file]    regenerate test/vectors/agent-mail-v1.json from the TS code
//   node test/gen-vectors.mjs --verify <file>   check output from `cargo run -p mail-core --example emit-vectors`
//
// Run `npm run build` first: this imports the compiled peer code from dist/.
// The identities are TEST ONLY. Their keys come from fixed public seeds, so they protect nothing.
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { fingerprint, validatePublic } from "../dist/peer/identity.js";
import { canonicalUnsigned, receipt, seal, signMessage, unseal, verifyMessage, verifyReceipt } from "../dist/peer/wire.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultFile = join(root, "test", "vectors", "agent-mail-v1.json");

// RFC 8410 DER prefixes. Node exports these exact encodings.
const PKCS8 = { ed25519: "302e020100300506032b657004220420", x25519: "302e020100300506032b656e04220420" };

const seed = (label) => createHash("sha256").update(`agent-mail test vector ${label}`).digest("hex");

function keyPair(type, seedHex) {
  const privateKey = createPrivateKey({ key: Buffer.from(PKCS8[type] + seedHex, "hex"), format: "der", type: "pkcs8" });
  return {
    private: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    public: createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString(),
  };
}

function testIdentity(name) {
  const signing_seed = seed(`${name} signing`);
  const encryption_seed = seed(`${name} encryption`);
  const signing = keyPair("ed25519", signing_seed);
  const encryption = keyPair("x25519", encryption_seed);
  const identity = {
    name,
    signing_key: signing.public,
    encryption_key: encryption.public,
    signing_private: signing.private,
    encryption_private: encryption.private,
  };
  return { identity, signing_seed, encryption_seed, fingerprint: fingerprint(identity) };
}

const publicOnly = ({ identity, signing_seed, encryption_seed, fingerprint: fp }) => ({
  name: identity.name, signing_seed, encryption_seed,
  signing_key: identity.signing_key, encryption_key: identity.encryption_key, fingerprint: fp,
});

function write(file) {
  const alice = testIdentity("alice");
  const bob = testIdentity("bob");
  const base = {
    sender: alice.fingerprint,
    recipient: bob.fingerprint,
    created_at: 1763337600000,
  };
  const inputs = [
    {
      label: "minimal",
      input: {
        ...base,
        id: "00000000-0000-4000-8000-000000000001",
        conversation_id: "00000000-0000-4000-8000-000000000002",
        text: "hello",
        origin: { hostname: "pc1", platform: "win32", arch: "x64", addresses: [] },
      },
    },
    {
      label: "full-1.1-escapes-and-trim",
      input: {
        ...base,
        id: "6F9619FF-8B86-D011-B42D-00C04FC964FF",
        conversation_id: "00000000-0000-4000-8000-000000000003",
        text: "Grüße \"quoted\" \\ back\nslash\t tab \u0001 ctrl \u007f del 😀   line-sep </script>",
        origin: { hostname: "  pc1.local ", platform: " win32 ", arch: "x64", addresses: ["192.168.1.20", "fe80::1", "100.64.0.3"] },
        agent: { harness: " claude-code ", name: "claude", model: "opus", session_id: "s-1" },
        to_session: "  session one  ",
        hop: 3,
        auto_reply: true,
        in_reply_to: "00000000-0000-4000-8000-000000000001",
      },
    },
    {
      label: "agent-partial",
      input: {
        ...base,
        id: "00000000-0000-4000-8000-000000000004",
        conversation_id: "00000000-0000-4000-8000-000000000002",
        text: "x".repeat(300),
        origin: { hostname: "h", platform: "linux", arch: "arm64", addresses: ["10.0.0.1"] },
        agent: { model: "gpt" },
        hop: 0,
        auto_reply: false,
      },
    },
  ];
  const messages = inputs.map(({ label, input }) => {
    const signed = signMessage(alice.identity, input);
    const { signature, ...unsigned } = signed;
    const json = JSON.stringify(signed);
    return {
      label,
      input,
      canonical: canonicalUnsigned(unsigned),
      signed,
      json,
      digest: createHash("sha256").update(json).digest("hex"),
      receipt: receipt(bob.identity, signed),
      packet: seal(alice.identity, bob.identity, signed),
    };
  });
  const valid = messages[0].signed;
  const invalid = [
    { label: "unknown-field", message: { ...valid, project: "demo" } },
    // agent-mail/1.3 (ADR 0006): TS peers reject both, so Rust sends them only to 1.3 receivers.
    { label: "unknown-field-checkout", message: { ...valid, checkout: { roots: ["a".repeat(40)], origin: "github.com/o/app" } } },
    { label: "unknown-field-intent", message: { ...valid, intent: "task" } },
    { label: "bad-uuid", message: { ...valid, id: "not-a-uuid" } },
    { label: "empty-text", message: { ...valid, text: "" } },
    { label: "empty-agent", message: { ...valid, agent: {} } },
    { label: "hop-too-high", message: { ...valid, hop: 17 } },
    { label: "label-line-break", message: { ...valid, origin: { ...valid.origin, hostname: "a\nb" } } },
    { label: "blank-label", message: { ...valid, origin: { ...valid.origin, arch: "   " } } },
    { label: "bad-ip", message: { ...valid, origin: { ...valid.origin, addresses: ["999.1.1.1"] } } },
    { label: "leading-zero-ip", message: { ...valid, origin: { ...valid.origin, addresses: ["01.2.3.4"] } } },
    { label: "sender-not-hex", message: { ...valid, sender: "Z".repeat(64) } },
    { label: "negative-created-at", message: { ...valid, created_at: -1 } },
  ];
  // Every invalid case must be rejected by the TS schema too, or it isn't a parity vector.
  for (const item of invalid) {
    let rejected = false;
    try { verifyMessage(alice.identity, item.message); } catch { rejected = true; }
    if (!rejected) throw new Error(`TS accepted invalid vector ${item.label}`);
  }
  const vectors = {
    note: "TEST ONLY. Keys derive from public seeds (sha256 of a label); they protect nothing. Regenerate with node test/gen-vectors.mjs --write.",
    identities: { alice: publicOnly(alice), bob: publicOnly(bob) },
    messages,
    invalid,
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(vectors, null, 2) + "\n");
  console.log(`wrote ${messages.length} messages and ${invalid.length} invalid cases to ${file}`);
}

function check(condition, what) {
  if (!condition) throw new Error(`verify failed: ${what}`);
  console.log(`ok - ${what}`);
}

function verify(file) {
  const out = JSON.parse(readFileSync(file, "utf8"));
  const ts = { alice: testIdentity("alice"), bob: testIdentity("bob") };
  for (const name of ["alice", "bob"]) {
    const rust = out.identities[name];
    const mine = ts[name].identity;
    for (const field of ["signing_key", "encryption_key", "signing_private", "encryption_private"]) {
      check(rust[field] === mine[field], `${name} ${field} PEM matches Node byte for byte`);
    }
    check(fingerprint(validatePublic({ name: rust.name, signing_key: rust.signing_key, encryption_key: rust.encryption_key })) === ts[name].fingerprint,
      `${name} fingerprint matches`);
  }
  const fresh = out.generated;
  validatePublic({ name: fresh.name, signing_key: fresh.signing_key, encryption_key: fresh.encryption_key });
  check(createPublicKey(fresh.signing_private).export({ type: "spki", format: "pem" }) === fresh.signing_key, "Rust-generated signing key pair is consistent for Node");
  check(createPublicKey(fresh.encryption_private).export({ type: "spki", format: "pem" }) === fresh.encryption_key, "Rust-generated encryption key pair is consistent for Node");
  check(fingerprint(fresh) === fresh.fingerprint, "Rust-generated fingerprint matches Node");

  const alicePublic = { name: ts.alice.identity.name, signing_key: ts.alice.identity.signing_key, encryption_key: ts.alice.identity.encryption_key };
  for (const item of out.messages) {
    check(verifyMessage(alicePublic, item.signed), `${item.label}: Rust signature verifies in TS`);
    const opened = unseal(ts.bob.identity, item.packet, (fp) => fp === ts.alice.fingerprint ? alicePublic : undefined);
    check(isDeepStrictEqual(opened, item.signed), `${item.label}: TS unseals the Rust packet to the same message`);
    check(JSON.stringify(opened) === item.json, `${item.label}: Rust message JSON matches JSON.stringify`);
    verifyReceipt(ts.bob.identity, item.receipt, opened);
    check(true, `${item.label}: TS accepts the Rust receipt`);
    const tsReceipt = receipt(ts.bob.identity, opened);
    check(tsReceipt.payload === item.receipt.payload && tsReceipt.signature === item.receipt.signature, `${item.label}: Rust receipt is byte-identical to TS`);
  }
}

const [mode, file] = process.argv.slice(2);
if (mode === "--write") write(file ?? defaultFile);
else if (mode === "--verify" && file) verify(file);
else {
  console.error("usage: node test/gen-vectors.mjs --write [file] | --verify <rust-output.json>");
  process.exit(2);
}
