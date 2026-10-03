import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RemoteError } from "./errors.js";

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof RemoteError) return error.retryable;
  const code =
    typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) {
    return true;
  }
  if (typeof error === "object" && error !== null && "cause" in error) {
    const cause = (error as { cause: unknown }).cause;
    if (cause && cause !== error && isRetryableError(cause)) return true;
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|socket hang up|network|other side closed|AbortError|TimeoutError/i.test(
    message,
  );
}

/**
 * Split MAILBOX_URL into candidate addresses. Every entry must reach the same mailbox host
 * (for example its Wi-Fi and Ethernet addresses); they are failover routes, not separate mailboxes.
 */
export function parseMailboxUrls(value: string | string[]): string[] {
  const items = (Array.isArray(value) ? value : value.split(","))
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length === 0) throw new Error("MAILBOX_URL is empty");
  for (const item of items) {
    let parsed: URL;
    try {
      parsed = new URL(item);
    } catch {
      throw new Error(`MAILBOX_URL entry is not a URL: ${item}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`MAILBOX_URL entry must be http or https: ${item}`);
    }
  }
  return [...new Set(items)];
}

/**
 * One MCP session per call. A shared abort signal on a long-lived session would
 * cancel later calls when the first timeout fired.
 */
export class RemoteMailbox {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly urls: string[];
  private active = 0;

  /**
   * With several URLs, a call that fails to connect is retried on the next one, and the one that
   * answers becomes the default. Retried sends are safe because the mailbox deduplicates message_id.
   */
  constructor(
    urls: string | string[],
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {
    this.urls = parseMailboxUrls(urls);
  }

  get currentUrl(): string {
    return this.urls[this.active];
  }

  get candidateUrls(): string[] {
    return [...this.urls];
  }

  call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const run = this.chain.then(() => this.callExclusive<T>(name, args));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async close(): Promise<void> {
    await this.chain.catch(() => undefined);
  }

  private async callExclusive<T>(name: string, args: Record<string, unknown>): Promise<T> {
    let lastError: RemoteError | undefined;
    for (let step = 0; step < this.urls.length; step += 1) {
      const index = (this.active + step) % this.urls.length;
      try {
        const result = await this.callOnce<T>(this.urls[index], name, args);
        this.active = index;
        return result;
      } catch (error) {
        if (!(error instanceof RemoteError) || !error.retryable) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new RemoteError("mailbox unreachable", true);
  }

  private async callOnce<T>(url: string, name: string, args: Record<string, unknown>): Promise<T> {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json, text/event-stream",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    });
    const client = new Client({ name: "mailbox-adapter", version: "0.2.0" });
    try {
      await client.connect(transport);
      const result = (await client.callTool({ name, arguments: args })) as ToolResult;
      return parseToolResult<T>(result);
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      throw new RemoteError(error instanceof Error ? error.message : String(error), isRetryableError(error));
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

function parseToolResult<T>(result: ToolResult): T {
  const text = (result.content ?? []).map((item) => item.text ?? "").join("\n");
  let parsed: { ok?: boolean; error?: string };
  try {
    parsed = JSON.parse(text) as { ok?: boolean; error?: string };
  } catch {
    throw new RemoteError(text || "mailbox returned a non-JSON tool result", false);
  }
  if (result.isError || parsed.ok === false) {
    throw new RemoteError(parsed.error || text || "mailbox tool failed", false);
  }
  return parsed as T;
}
