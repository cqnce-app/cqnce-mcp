/**
 * Thin HTTP client used by all MCP tool modules.
 *
 * Two auth modes are supported, controlled by environment variables:
 *   - CQNCE_API_KEY   — project API key  (for request submission / monitoring)
 *   - CQNCE_ADMIN_TOKEN — tenant admin JWT (for project / agent / team management)
 *
 * Both variables may be set simultaneously; the client uses the one appropriate
 * for each request.
 */

export interface ClientOptions {
  baseUrl: string;
  /** Project-level API key (for request operations). */
  apiKey?: string;
  /** Tenant admin JWT (for admin operations). */
  adminToken?: string;
  /** OAuth client credentials (alternative to apiKey). */
  clientId?: string;
  clientSecret?: string;
}

export type AuthMode = 'apiKey' | 'admin';

export class CqnceApiClient {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly adminToken?: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.adminToken = options.adminToken;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
  }

  /** Whether the client can perform request-level operations (API key or client credentials). */
  hasApiKey(): boolean {
    return !!(this.apiKey || (this.clientId && this.clientSecret));
  }

  /** Whether the client can perform admin-level operations (needs admin token). */
  hasAdminToken(): boolean {
    return !!this.adminToken;
  }

  async get<T = Record<string, unknown>>(
    path: string,
    query: Record<string, string | number | boolean | string[] | undefined> = {},
    auth: AuthMode = 'apiKey',
  ): Promise<T> {
    const url = this.buildUrl(path, query);
    const res = await fetch(url, { headers: this.headers(auth) });
    return this.parseResponse<T>(res);
  }

  async post<T = Record<string, unknown>>(
    path: string,
    body?: unknown,
    auth: AuthMode = 'apiKey',
  ): Promise<T> {
    const url = this.buildUrl(path);
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headersWithJson(auth),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return this.parseResponse<T>(res);
  }

  async put<T = Record<string, unknown>>(
    path: string,
    body?: unknown,
    auth: AuthMode = 'admin',
  ): Promise<T> {
    const url = this.buildUrl(path);
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.headersWithJson(auth),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return this.parseResponse<T>(res);
  }

  async delete<T = Record<string, unknown>>(
    path: string,
    auth: AuthMode = 'admin',
  ): Promise<T> {
    const url = this.buildUrl(path);
    const res = await fetch(url, { method: 'DELETE', headers: this.headers(auth) });
    return this.parseResponse<T>(res);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private buildUrl(path: string, query: Record<string, string | number | boolean | string[] | undefined> = {}): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, item);
      } else {
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private headers(auth: AuthMode): Headers {
    const h = new Headers();
    if (auth === 'apiKey') {
      if (this.clientId && this.clientSecret) {
        h.set('x-client-id', this.clientId);
        h.set('x-client-secret', this.clientSecret);
      } else if (this.apiKey) {
        h.set('x-api-key', this.apiKey);
      } else {
        throw new Error('CQNCE_API_KEY or client credentials are required for this operation');
      }
    } else {
      if (!this.adminToken) throw new Error('CQNCE_ADMIN_TOKEN is required for this operation');
      h.set('Authorization', 'Bearer ' + this.adminToken);
    }
    return h;
  }

  private headersWithJson(auth: AuthMode): Headers {
    const h = this.headers(auth);
    h.set('Content-Type', 'application/json');
    return h;
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = JSON.parse(text) as { error?: string; message?: string };
        message = body.error ?? body.message ?? message;
      } catch { /* ignore */ }
      throw new Error(message);
    }
    return text ? (JSON.parse(text) as T) : ({} as T);
  }
}

/** Build a client from environment variables. */
export function clientFromEnv(): CqnceApiClient {
  const baseUrl = process.env['CQNCE_BASE_URL'] ?? 'https://api.cqnce.app';
  return new CqnceApiClient({
    baseUrl,
    apiKey: process.env['CQNCE_API_KEY'],
    adminToken: process.env['CQNCE_ADMIN_TOKEN'],
  });
}
