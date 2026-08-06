/**
 * cQnce MCP Worker — Cloudflare Workers deployment
 *
 * Exposes cQnce human-in-the-loop authorization as a remote MCP server
 * using Streamable HTTP transport (stateless, no Durable Objects).
 *
 * Authentication (two modes, both supported):
 *   1. OAuth 2.0 Client Credentials — Claude Desktop and other MCP clients
 *      that support OAuth. Flow: POST /oauth/token with client_id + client_secret
 *      → get a Bearer token → use it on /mcp requests.
 *   2. Raw API key — Authorization: Bearer <CQNCE_API_KEY> directly on /mcp.
 *      Backward-compatible with the previous behaviour.
 *
 * Required env vars (set in Cloudflare Workers dashboard):
 *   WORKER_JWT_SECRET   — secret used to sign/verify OAuth tokens issued by this worker
 *
 * Optional env vars:
 *   CQNCE_BASE_URL      — defaults to https://api.cqnce.app
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CqnceApiClient } from './client.js';
import { registerRequestTools } from './tools/requests.js';

interface Env {
  CQNCE_BASE_URL?: string;
  WORKER_JWT_SECRET?: string;
}

// ── Minimal JWT via Web Crypto API (no external deps) ───────────────────────

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlEncode(obj: object): string {
  return btoa(JSON.stringify(obj))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s: string): string {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

async function signJWT(
  payload: Record<string, unknown>,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlEncode({ alg: 'HS256', typ: 'JWT' });
  const claims = b64urlEncode({ ...payload, iat: now, exp: now + ttlSeconds });
  const unsigned = `${header}.${claims}`;
  const key = await hmacKey(secret, 'sign');
  const sig = b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(unsigned)));
  return `${unsigned}.${sig}`;
}

async function verifyJWT(
  token: string,
  secret: string,
): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const key = await hmacKey(secret, 'verify');
  const sigBytes = Uint8Array.from(b64urlDecode(s), (c) => c.charCodeAt(0));
  const valid = await crypto.subtle.verify(
    'HMAC', key, sigBytes, new TextEncoder().encode(`${h}.${p}`),
  );
  if (!valid) return null;
  const payload = JSON.parse(b64urlDecode(p)) as Record<string, unknown>;
  if (typeof payload['exp'] === 'number' && payload['exp'] < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

// ── OAuth helpers ────────────────────────────────────────────────────────────

function oauthDiscovery(origin: string): object {
  return {
    issuer: origin,
    token_endpoint: `${origin}/oauth/token`,
    grant_types_supported: ['client_credentials'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    scopes_supported: ['mcp'],
  };
}

/** Validate client credentials by making a real (read-only) cQnce API call. */
async function validateClientCredentials(
  clientId: string,
  clientSecret: string,
  cqnceBase: string,
): Promise<boolean> {
  const res = await fetch(`${cqnceBase}/v1/requests?limit=1`, {
    headers: { 'x-client-id': clientId, 'x-client-secret': clientSecret },
  });
  return res.status !== 401 && res.status !== 403;
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const origin = `${url.protocol}//${url.host}`;
    const cqnceBase = env.CQNCE_BASE_URL ?? 'https://api.cqnce.app';

    // ── Health ────────────────────────────────────────────────────────────
    if (pathname === '/' || pathname === '/health') {
      return Response.json({ status: 'ok', server: 'cqnce-mcp' });
    }

    // ── OAuth discovery ───────────────────────────────────────────────────
    if (
      pathname === '/.well-known/oauth-authorization-server' ||
      pathname === '/.well-known/openid-configuration'
    ) {
      return Response.json(oauthDiscovery(origin));
    }

    // ── OAuth token endpoint ──────────────────────────────────────────────
    if (pathname === '/oauth/token') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }
      if (!env.WORKER_JWT_SECRET) {
        return Response.json(
          { error: 'server_error', error_description: 'WORKER_JWT_SECRET not configured' },
          { status: 500 },
        );
      }

      const body = await request.text();
      const params = new URLSearchParams(body);

      if (params.get('grant_type') !== 'client_credentials') {
        return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
      }

      // Support client_secret_basic (Authorization: Basic) and client_secret_post (body)
      let clientId: string | null = null;
      let clientSecret: string | null = null;
      const authHeader = request.headers.get('Authorization') ?? '';
      if (authHeader.startsWith('Basic ')) {
        const decoded = b64urlDecode(authHeader.slice(6).replace(/-/g, '+').replace(/_/g, '/'));
        const colon = decoded.indexOf(':');
        if (colon >= 0) {
          clientId = decodeURIComponent(decoded.slice(0, colon));
          clientSecret = decodeURIComponent(decoded.slice(colon + 1));
        }
      }
      if (!clientId) clientId = params.get('client_id');
      if (!clientSecret) clientSecret = params.get('client_secret');

      if (!clientId || !clientSecret) {
        return Response.json(
          { error: 'invalid_client', error_description: 'client_id and client_secret required' },
          { status: 401 },
        );
      }

      const valid = await validateClientCredentials(clientId, clientSecret, cqnceBase);
      if (!valid) {
        return Response.json(
          { error: 'invalid_client', error_description: 'Invalid client credentials' },
          { status: 401 },
        );
      }

      // Issue a signed token.
      // The credentials are included in the JWT so that each MCP request
      // can be handled statelessly without a session store.
      // The token is equivalent in sensitivity to the credentials themselves
      // and is only transmitted over HTTPS.
      const token = await signJWT(
        { sub: clientId, sec: clientSecret },
        env.WORKER_JWT_SECRET,
        3600,
      );
      return Response.json({ access_token: token, token_type: 'bearer', expires_in: 3600 });
    }

    // ── MCP endpoint ──────────────────────────────────────────────────────
    if (pathname.startsWith('/mcp')) {
      const authHeader = request.headers.get('Authorization') ?? '';
      if (!authHeader.startsWith('Bearer ')) {
        return Response.json(
          { error: 'Authorization: Bearer <token> required' },
          {
            status: 401,
            headers: { 'WWW-Authenticate': `Bearer realm="cqnce-mcp", resource="${origin}"` },
          },
        );
      }
      const bearer = authHeader.slice(7).trim();

      let clientId: string | undefined;
      let clientSecret: string | undefined;
      let apiKey: string | undefined;

      // Try to verify as an OAuth JWT issued by this worker
      if (env.WORKER_JWT_SECRET) {
        const payload = await verifyJWT(bearer, env.WORKER_JWT_SECRET).catch(() => null);
        if (payload) {
          clientId = payload['sub'] as string;
          clientSecret = payload['sec'] as string;
        }
      }

      // Fallback: treat Bearer token as a raw API key
      if (!clientId) apiKey = bearer;

      const server = new McpServer({ name: 'cqnce', version: '0.1.1' });
      const client = new CqnceApiClient({ baseUrl: cqnceBase, apiKey, clientId, clientSecret });
      registerRequestTools(server, client);

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      return transport.handleRequest(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
