/**
 * Thin HTTP client for the vspark REST API. The MCP tool layer talks to the
 * backend exclusively through this so the same tool code works for every
 * transport (the in-process HTTP mount, the stdio bin, and the in-memory
 * transport the assistant agent uses) — each just points it at a base URL.
 */
export interface VsparkClientOptions {
  baseUrl: string;
  /** Optional fetch override (tests). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export class VsparkApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'VsparkApiError';
  }
}

export class VsparkClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: VsparkClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Loopback API origin (e.g. http://127.0.0.1:3001) — used to resolve served
   *  `/uploads/...` asset paths into absolute URLs for headless rendering. */
  get origin(): string {
    return this.baseUrl;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<unknown> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new VsparkApiError(
        `non-JSON response (${res.status}) from ${method} ${path}`,
        res.status
      );
    }
    const env = json as { ok?: boolean; data?: unknown; error?: unknown };
    if (!res.ok || env.ok === false) {
      const msg =
        (env.error as { message?: string } | undefined)?.message ??
        `HTTP ${res.status} from ${method} ${path}`;
      throw new VsparkApiError(msg, res.status);
    }
    return env.data ?? json;
  }

  get(path: string): Promise<unknown> {
    return this.request('GET', path);
  }
  post(path: string, body?: unknown): Promise<unknown> {
    return this.request('POST', path, body ?? {});
  }
  put(path: string, body?: unknown): Promise<unknown> {
    return this.request('PUT', path, body ?? {});
  }
  del(path: string): Promise<unknown> {
    return this.request('DELETE', path);
  }
}
