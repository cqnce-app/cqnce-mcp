/**
 * cQnce MCP Worker — Cloudflare Workers deployment
 *
 * OAuth 2.0 Authorization Code + PKCE (no user-facing form):
 *
 *   User configures in Claude.ai → Add connector:
 *     - Remote MCP server URL: https://mcp.cqnce.app/mcp
 *     - OAuth Client ID:       <cQnce project client_id>
 *     - OAuth Client Secret:   <cQnce project client_secret>
 *
 *   Claude then runs the full Authorization Code + PKCE flow automatically:
 *     1. GET  /authorize?client_id=<cid>&code_challenge=... → immediate redirect
 *     2. POST /oauth/token  (code + code_verifier + client_secret)
 *            → Worker verifies PKCE, calls api.cqnce.app/v1/oauth/token, returns JWT
 *     3. POST /mcp  Authorization: Bearer <JWT>
 *            → Worker passes JWT as Bearer to cQnce backend
 *
 * Required KV namespace binding (Cloudflare dashboard → Settings → Bindings):
 *   OAUTH_CODES  — temporary auth code storage (TTL 10 min)
 *
 * Optional env var:
 *   CQNCE_BASE_URL  — defaults to https://api.cqnce.app
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CqnceApiClient } from './client.js';
import { registerRequestTools } from './tools/requests.js';

interface Env {
  CQNCE_BASE_URL?: string;
  OAUTH_CODES: KVNamespace;
}

interface StoredCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
}

// ── PKCE ─────────────────────────────────────────────────────────────────────

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function verifyPKCE(verifier: string, challenge: string): Promise<boolean> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(hash) === challenge;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const origin = `${url.protocol}//${url.host}`;
    const cqnceBase = env.CQNCE_BASE_URL ?? 'https://api.cqnce.app';

    // ── Health ──────────────────────────────────────────────────────────────
    if (pathname === '/' || pathname === '/health') {
      return Response.json({ status: 'ok', server: 'cqnce-mcp' });
    }

    // ── Authorization server metadata (RFC 8414) ────────────────────────────
    if (pathname === '/.well-known/oauth-authorization-server' ||
        pathname === '/.well-known/openid-configuration') {
      return Response.json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        grant_types_supported: ['authorization_code', 'client_credentials'],
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
        scopes_supported: ['mcp'],
      });
    }

    // ── Protected resource metadata (RFC 9728) ──────────────────────────────
    // Claude validates the token against this endpoint after OAuth completes.
    if (pathname === '/.well-known/oauth-protected-resource') {
      return Response.json({
        resource: origin,
        authorization_servers: [origin],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp'],
      });
    }

    // ── Authorization endpoint ──────────────────────────────────────────────
    // Claude sends the project client_id (from the connector's "OAuth Client ID"
    // field) as the client_id parameter. No user-facing form is needed.
    if (pathname === '/authorize') {
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

      const p = url.searchParams;
      const clientId    = p.get('client_id') ?? '';
      const redirectUri = p.get('redirect_uri') ?? '';
      const codeChallenge = p.get('code_challenge') ?? '';
      const state       = p.get('state') ?? '';

      if (!clientId || !redirectUri || !codeChallenge) {
        return Response.json(
          { error: 'invalid_request', error_description: 'client_id, redirect_uri and code_challenge required' },
          { status: 400 },
        );
      }

      const code = crypto.randomUUID();
      const stored: StoredCode = { clientId, codeChallenge, redirectUri };
      await env.OAUTH_CODES.put(code, JSON.stringify(stored), { expirationTtl: 600 });

      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set('code', code);
      if (state) callbackUrl.searchParams.set('state', state);
      return Response.redirect(callbackUrl.toString(), 302);
    }

    // ── Token endpoint ──────────────────────────────────────────────────────
    if (pathname === '/oauth/token') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

      const params = new URLSearchParams(await request.text());
      const grantType = params.get('grant_type');

      // Authorization Code exchange — Claude sends client_secret here
      if (grantType === 'authorization_code') {
        const code         = params.get('code');
        const codeVerifier = params.get('code_verifier');
        const redirectUri  = params.get('redirect_uri');
        const clientSecret = params.get('client_secret') ?? extractBasicSecret(request.headers.get('Authorization'));

        if (!code || !codeVerifier) {
          return Response.json({ error: 'invalid_request', error_description: 'code and code_verifier required' }, { status: 400 });
        }

        const raw = await env.OAUTH_CODES.get(code);
        if (!raw) {
          return Response.json({ error: 'invalid_grant', error_description: 'Code not found or expired' }, { status: 400 });
        }
        const stored = JSON.parse(raw) as StoredCode;

        if (!await verifyPKCE(codeVerifier, stored.codeChallenge)) {
          return Response.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, { status: 400 });
        }
        if (redirectUri && redirectUri !== stored.redirectUri) {
          return Response.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, { status: 400 });
        }

        await env.OAUTH_CODES.delete(code); // one-time use

        if (!clientSecret) {
          return Response.json({ error: 'invalid_client', error_description: 'client_secret required' }, { status: 401 });
        }

        // Exchange credentials for a backend JWT
        const tokenRes = await fetch(`${cqnceBase}/v1/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=client_credentials&client_id=${encodeURIComponent(stored.clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
        });

        if (!tokenRes.ok) {
          return Response.json({ error: 'invalid_client', error_description: 'Invalid client credentials' }, { status: 401 });
        }

        return new Response(await tokenRes.text(), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Client Credentials — proxied directly to backend (for API/testing)
      if (grantType === 'client_credentials') {
        const backendRes = await fetch(`${cqnceBase}/v1/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });
        return new Response(await backendRes.text(), {
          status: backendRes.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
    }

    // ── MCP endpoint ────────────────────────────────────────────────────────
    if (pathname.startsWith('/mcp')) {
      const authHeader = request.headers.get('Authorization') ?? '';
      if (!authHeader.startsWith('Bearer ')) {
        return Response.json(
          { error: 'Authorization: Bearer <token> required' },
          { status: 401, headers: { 'WWW-Authenticate': `Bearer realm="cqnce-mcp", resource="${origin}"` } },
        );
      }
      const bearer = authHeader.slice(7).trim();

      // Backend JWT (3 dot-separated parts) → pass as Authorization: Bearer
      // Raw API key → pass as x-api-key (backward compat)
      const clientOptions = bearer.split('.').length === 3
        ? { baseUrl: cqnceBase, oauthToken: bearer }
        : { baseUrl: cqnceBase, apiKey: bearer };

      const server = new McpServer({ name: 'cqnce', version: '0.1.1' });
      const client = new CqnceApiClient(clientOptions);
      registerRequestTools(server, client);

      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);

      // The MCP transport requires both application/json and text/event-stream in
      // the Accept header. Some MCP clients (including Claude's servers) may omit
      // text/event-stream, causing the transport to return 406. We normalise the
      // header here so the transport always sees the full required value.
      const accept = request.headers.get('accept') ?? '';
      const mcpRequest = accept.includes('text/event-stream')
        ? request
        : new Request(request.url, {
            method: request.method,
            headers: (() => { const h = new Headers(request.headers); h.set('accept', 'application/json, text/event-stream'); return h; })(),
            body: request.body,
          });

      return transport.handleRequest(mcpRequest);
    }

    return new Response('Not found', { status: 404 });
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractBasicSecret(authHeader: string | null): string | null {
  if (!authHeader?.startsWith('Basic ')) return null;
  try {
    const decoded = atob(authHeader.slice(6));
    const colon = decoded.indexOf(':');
    return colon >= 0 ? decoded.slice(colon + 1) : null;
  } catch {
    return null;
  }
}
