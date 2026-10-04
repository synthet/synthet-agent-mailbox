import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fingerprint, type PublicIdentity, validatePublic } from "./identity.js";

export interface Contact { identity: PublicIdentity; endpoint?: string }

/** Individual atomic files allow CLI and MCP processes to share one identity without lost updates. */
export class PeerStore {
  constructor(readonly dir: string) {
    for (const area of ["contacts", "inbox", "acked", "outbox", "sent"]) mkdirSync(join(dir, area), { recursive: true, mode: 0o700 });
  }
  private path(area: string, id: string): string {
    return join(this.dir, area, createHash("sha256").update(id).digest("hex") + ".json");
  }
  get<T>(area: string, id: string): T | undefined {
    try { return JSON.parse(readFileSync(this.path(area, id), "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  list<T>(area: string): T[] {
    return readdirSync(join(this.dir, area)).filter((name) => name.endsWith(".json")).flatMap((name) => {
      try { return [JSON.parse(readFileSync(join(this.dir, area, name), "utf8")) as T]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    });
  }
  put(area: string, id: string, value: unknown, exclusive = false): boolean {
    const target = this.path(area, id);
    const temp = target + "." + randomUUID() + ".tmp";
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx", flush: true });
    try {
      if (exclusive) linkSync(temp, target);
      else renameSync(temp, target);
      return true;
    } catch (error) {
      if (exclusive && (error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  remove(area: string, id: string): void {
    try { unlinkSync(this.path(area, id)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  trust(identity: PublicIdentity, expected: string, endpoint?: string): Contact {
    validatePublic(identity);
    if (fingerprint(identity) !== expected.toLowerCase()) throw new Error("Fingerprint mismatch; peer was not trusted");
    if (endpoint) validateEndpoint(endpoint);
    const contact = { identity, endpoint };
    this.put("contacts", expected.toLowerCase(), contact);
    return contact;
  }
  contact(recipient: string): Contact {
    const matches = this.list<Contact>("contacts").filter((c) => fingerprint(c.identity) === recipient.toLowerCase() || c.identity.name.toLowerCase() === recipient.toLowerCase());
    if (matches.length !== 1) throw new Error(matches.length ? "Ambiguous peer name; use full fingerprint" : "Unknown peer; discover and trust its verified fingerprint first");
    return matches[0];
  }
}

export function validateEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("Endpoint must be http://host:port without credentials, path, query, or fragment");
  }
  return url;
}
