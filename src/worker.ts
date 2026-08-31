/**
 * cQnce MCP Worker — Cloudflare Workers deployment
 *
 * Supports three authentication flows:
 *
 * ── Flow A: Legacy (Claude.ai) ─────────────────────────────────────────────
 *   User configures Claude.ai manually:
 *     - Remote MCP server URL: https://mcp.cqnce.app/mcp
 *     - OAuth Client ID:       <cQnce project client_id>
 *     - OAuth Client Secret:   <cQnce project client_secret>
 *   Claude runs PKCE Authorization Code; client_secret is passed at token
 *   exchange and forwarded to the cQnce backend. Fully backward-compatible.
 *
 * ── Flow B: DCR — Dynamic Client Registration (RFC 7591) ──────────────────
 *   Used by Codex "Automatic" / "Dynamic client registration" modes:
 *     1. POST /register       → ephemeral client_id (public client, no secret)
 *     2. GET  /authorize      → serves HTML form asking for cQnce API key
 *     3. POST /authorize/bind → verifies API key, completes OAuth redirect
 *     4. POST /oauth/token    → uses stored API key to obtain JWT
 *
 * ── Flow C: CIMD — Client ID Metadata Document ────────────────────────────
 *   client_id is a URL (https://…/.well-known/oauth-client-metadata).
 *   Worker fetches the document to get redirect_uris, then follows Flow B.
 *
 * Required KV namespace binding (Cloudflare dashboard → Settings → Bindings):
 *   OAUTH_CODES  — auth codes, DCR clients, refresh tokens (TTL-based)
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

/** Stored under key `<code>` (TTL 10 min). */
interface StoredCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  /** Flow B/C (DCR/CIMD): cQnce API key bound during /authorize/bind. */
  apiKey?: string;
}

/** Stored under key `dcr:<client_id>` (TTL 24 h). */
interface StoredDcrClient {
  redirectUris: string[];
  clientName?: string;
}

/** Stored under key `rt:<token>` (TTL 30 d). */
interface StoredRefreshToken {
  clientId: string;
  /** Flow A: cQnce OAuth client secret. */
  clientSecret?: string;
  /** Flow B/C: cQnce API key. */
  apiKey?: string;
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
    if (pathname === '/health') {
      return Response.json({ status: 'ok', server: 'cqnce-mcp' });
    }
    if (pathname === '/') {
      const hasMcpMethod = request.method === 'POST' || request.method === 'DELETE';
      const hasBearer = (request.headers.get('Authorization') ?? '').startsWith('Bearer ');
      if (!hasMcpMethod && !hasBearer) {
        return Response.json({ status: 'ok', server: 'cqnce-mcp' });
      }
      // Fall through to MCP handler below
    }

    // ── Authorization server metadata (RFC 8414) ────────────────────────────
    if (pathname === '/.well-known/oauth-authorization-server' ||
        pathname === '/.well-known/openid-configuration') {
      return Response.json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/register`,
        grant_types_supported: ['authorization_code', 'client_credentials', 'refresh_token'],
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
        scopes_supported: ['mcp'],
      });
    }

    // ── Protected resource metadata (RFC 9728) ──────────────────────────────
    if (pathname === '/.well-known/oauth-protected-resource') {
      return Response.json({
        resource: origin,
        authorization_servers: [origin],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp'],
      });
    }

    // ── DCR: Dynamic Client Registration (RFC 7591) ─────────────────────────
    // Codex "Automatic" / "DCR" modes POST here to obtain a client_id.
    // Returns a public client (no client_secret) — credentials are collected
    // later via the binding form served by /authorize.
    if (pathname === '/register') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

      let body: Record<string, unknown>;
      try {
        body = await request.json() as Record<string, unknown>;
      } catch {
        return Response.json({ error: 'invalid_request', error_description: 'Expected JSON body' }, { status: 400 });
      }

      const redirectUris = body['redirect_uris'];
      if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
        return Response.json(
          { error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' },
          { status: 400 },
        );
      }

      // Validate all redirect URIs: must be HTTPS or localhost
      for (const uri of redirectUris as string[]) {
        try {
          const u = new URL(uri);
          const isLocalhost = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
          if (u.protocol !== 'https:' && !isLocalhost) {
            return Response.json(
              { error: 'invalid_redirect_uri', error_description: `Redirect URI must be HTTPS or localhost: ${uri}` },
              { status: 400 },
            );
          }
        } catch {
          return Response.json(
            { error: 'invalid_redirect_uri', error_description: `Invalid redirect URI: ${uri}` },
            { status: 400 },
          );
        }
      }

      const clientId = crypto.randomUUID();
      const stored: StoredDcrClient = {
        redirectUris: redirectUris as string[],
        clientName: typeof body['client_name'] === 'string' ? body['client_name'] : undefined,
      };
      await env.OAUTH_CODES.put(`dcr:${clientId}`, JSON.stringify(stored), { expirationTtl: 24 * 3600 });

      return Response.json({
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: 'none',
        redirect_uris: redirectUris,
        grant_types: ['authorization_code'],
        response_types: ['code'],
      }, { status: 201 });
    }

    // ── Authorization endpoint ──────────────────────────────────────────────
    // Three sub-cases:
    //   A. Legacy (Claude.ai): client_id is a real cQnce client_id → immediate redirect
    //   B. DCR: client_id is a UUID previously registered via POST /register → show form
    //   C. CIMD: client_id is an HTTPS URL → fetch metadata → validate redirect_uri → show form
    if (pathname === '/authorize') {
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

      const p = url.searchParams;
      const clientId      = p.get('client_id') ?? '';
      const redirectUri   = p.get('redirect_uri') ?? '';
      const codeChallenge = p.get('code_challenge') ?? '';
      const state         = p.get('state') ?? '';

      if (!clientId || !redirectUri || !codeChallenge) {
        return Response.json(
          { error: 'invalid_request', error_description: 'client_id, redirect_uri and code_challenge required' },
          { status: 400 },
        );
      }

      // ── Case C: CIMD — client_id is a metadata URL ──────────────────────
      if (clientId.startsWith('https://')) {
        let allowedUris: string[];
        try {
          const metaRes = await fetch(clientId, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(5000),
          });
          if (!metaRes.ok) throw new Error(`HTTP ${metaRes.status}`);
          const meta = await metaRes.json() as Record<string, unknown>;
          const uris = meta['redirect_uris'];
          if (!Array.isArray(uris) || uris.length === 0) throw new Error('No redirect_uris in metadata');
          allowedUris = uris as string[];
        } catch (err) {
          return Response.json(
            { error: 'invalid_client', error_description: `Could not fetch client metadata: ${err}` },
            { status: 400 },
          );
        }

        if (!allowedUris.includes(redirectUri)) {
          return Response.json(
            { error: 'invalid_redirect_uri', error_description: 'redirect_uri not in client metadata' },
            { status: 400 },
          );
        }

        const code = crypto.randomUUID();
        const stored: StoredCode = { clientId, codeChallenge, redirectUri };
        await env.OAUTH_CODES.put(code, JSON.stringify(stored), { expirationTtl: 600 });
        return bindingFormResponse(code, state, origin, undefined);
      }

      // ── Case B: DCR — client_id was registered via POST /register ─────────
      const dcrRaw = await env.OAUTH_CODES.get(`dcr:${clientId}`);
      if (dcrRaw) {
        const dcrClient = JSON.parse(dcrRaw) as StoredDcrClient;

        if (!dcrClient.redirectUris.includes(redirectUri)) {
          return Response.json(
            { error: 'invalid_redirect_uri', error_description: 'redirect_uri not registered for this client' },
            { status: 400 },
          );
        }

        const code = crypto.randomUUID();
        const stored: StoredCode = { clientId, codeChallenge, redirectUri };
        await env.OAUTH_CODES.put(code, JSON.stringify(stored), { expirationTtl: 600 });
        return bindingFormResponse(code, state, origin, dcrClient.clientName);
      }

      // ── Case A: Legacy — immediate redirect (unchanged behaviour) ──────────
      const code = crypto.randomUUID();
      const stored: StoredCode = { clientId, codeChallenge, redirectUri };
      await env.OAUTH_CODES.put(code, JSON.stringify(stored), { expirationTtl: 600 });

      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set('code', code);
      if (state) callbackUrl.searchParams.set('state', state);
      return Response.redirect(callbackUrl.toString(), 302);
    }

    // ── Binding form submission (Flow B / C) ─────────────────────────────────
    // User submits their cQnce API key; worker verifies it and completes the redirect.
    if (pathname === '/authorize/bind') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

      const contentType = request.headers.get('Content-Type') ?? '';
      let params: URLSearchParams;
      if (contentType.includes('application/x-www-form-urlencoded')) {
        params = new URLSearchParams(await request.text());
      } else {
        return new Response('Unsupported Media Type', { status: 415 });
      }

      const code   = params.get('code') ?? '';
      const apiKey = params.get('api_key')?.trim() ?? '';
      const state  = params.get('state') ?? '';

      if (!code || !apiKey) {
        return bindingFormResponse('', state, origin, undefined, 'API key and authorization code are required.');
      }

      const raw = await env.OAUTH_CODES.get(code);
      if (!raw) {
        return bindingFormResponse('', state, origin, undefined, 'Authorization session expired. Please restart the connection.');
      }
      const stored = JSON.parse(raw) as StoredCode;

      // Verify the API key against the cQnce backend.
      // The project API key is validated via x-api-key header, not the OAuth token endpoint.
      // GET /v1/requests returns 401 for invalid keys, 200 (empty list) for valid ones.
      const verifyRes = await fetch(`${cqnceBase}/v1/requests?limit=1`, {
        headers: { 'x-api-key': apiKey },
      });

      if (!verifyRes.ok) {
        return bindingFormResponse(code, state, origin, undefined, 'Invalid API key. Please check and try again.');
      }

      // Bind the API key to the auth code
      const updated: StoredCode = { ...stored, apiKey };
      await env.OAUTH_CODES.put(code, JSON.stringify(updated), { expirationTtl: 600 });

      const callbackUrl = new URL(stored.redirectUri);
      callbackUrl.searchParams.set('code', code);
      if (state) callbackUrl.searchParams.set('state', state);
      return Response.redirect(callbackUrl.toString(), 302);
    }

    // ── Token endpoint ──────────────────────────────────────────────────────
    if (pathname === '/oauth/token') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

      const params = new URLSearchParams(await request.text());
      const grantType = params.get('grant_type');

      // Authorization Code exchange
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

        // ── Flow B/C: API key was bound during /authorize/bind ──────────────
        // The API key is used directly as access_token — the MCP endpoint already
        // handles raw API keys by forwarding them as x-api-key to the backend.
        // No JWT exchange needed.
        if (stored.apiKey) {
          const refreshToken = crypto.randomUUID();
          await env.OAUTH_CODES.put(
            `rt:${refreshToken}`,
            JSON.stringify({ clientId: stored.clientId, apiKey: stored.apiKey } satisfies StoredRefreshToken),
            { expirationTtl: 30 * 24 * 3600 },
          );

          return Response.json({
            access_token: stored.apiKey,
            token_type: 'bearer',
            refresh_token: refreshToken,
          });
        }

        // ── Flow A: client_secret sent by client (Claude.ai) ───────────────
        if (!clientSecret) {
          return Response.json({ error: 'invalid_client', error_description: 'client_secret required' }, { status: 401 });
        }

        const tokenRes = await fetch(`${cqnceBase}/v1/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=client_credentials&client_id=${encodeURIComponent(stored.clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
        });

        if (!tokenRes.ok) {
          return Response.json({ error: 'invalid_client', error_description: 'Invalid client credentials' }, { status: 401 });
        }

        const refreshToken = crypto.randomUUID();
        await env.OAUTH_CODES.put(
          `rt:${refreshToken}`,
          JSON.stringify({ clientId: stored.clientId, clientSecret } satisfies StoredRefreshToken),
          { expirationTtl: 30 * 24 * 3600 },
        );

        const tokenBody = await tokenRes.json() as Record<string, unknown>;
        return Response.json({ ...tokenBody, refresh_token: refreshToken });
      }

      // Refresh Token
      if (grantType === 'refresh_token') {
        const refreshToken = params.get('refresh_token');
        if (!refreshToken) {
          return Response.json({ error: 'invalid_request', error_description: 'refresh_token required' }, { status: 400 });
        }

        const raw = await env.OAUTH_CODES.get(`rt:${refreshToken}`);
        if (!raw) {
          return Response.json({ error: 'invalid_grant', error_description: 'Refresh token not found or expired' }, { status: 400 });
        }
        const rt = JSON.parse(raw) as StoredRefreshToken;

        // Flow B/C: re-issue the same API key as access_token (no expiry)
        if (rt.apiKey) {
          return Response.json({
            access_token: rt.apiKey,
            token_type: 'bearer',
            refresh_token: refreshToken,
          });
        }

        // Flow A: re-exchange client credentials for a fresh JWT
        const tokenRes = await fetch(`${cqnceBase}/v1/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=client_credentials&client_id=${encodeURIComponent(rt.clientId)}&client_secret=${encodeURIComponent(rt.clientSecret ?? '')}`,
        });

        if (!tokenRes.ok) {
          await env.OAUTH_CODES.delete(`rt:${refreshToken}`);
          return Response.json({ error: 'invalid_grant', error_description: 'Credentials are no longer valid' }, { status: 400 });
        }

        const tokenBody = await tokenRes.json() as Record<string, unknown>;
        return Response.json({ ...tokenBody, refresh_token: refreshToken });
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
    if (pathname.startsWith('/mcp') || pathname === '/') {
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

      // Normalise Accept header — some clients omit text/event-stream which
      // causes the transport to return 406.
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

    if (pathname === '/favicon.ico' || pathname === '/favicon.png') {
      return Response.redirect('https://cqnce.app/favicon.ico', 301);
    }

    if (pathname === '/.well-known/mcp.json') {
      return new Response(JSON.stringify({
        name: 'cQnce',
        description: 'Human-in-the-loop authorization for AI agents',
        icon_url: 'https://cqnce.app/favicon.ico',
        url: 'https://mcp.cqnce.app/mcp',
      }), { headers: { 'Content-Type': 'application/json' } });
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

/**
 * Returns the HTML binding form that asks the user for their cQnce API key.
 * Used by both DCR (Flow B) and CIMD (Flow C).
 */
function bindingFormResponse(
  code: string,
  state: string,
  origin: string,
  clientName: string | undefined,
  errorMessage?: string,
): Response {
  const clientLabel = clientName ? `<strong>${escapeHtml(clientName)}</strong>` : 'an application';
  const errorHtml = errorMessage
    ? `<div class="error">${escapeHtml(errorMessage)}</div>`
    : '';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect to cQnce</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 16px rgba(0,0,0,.10); padding: 40px; max-width: 440px; width: 100%; }
    .logo { font-size: 1.5rem; font-weight: 700; color: #111; margin-bottom: 8px; }
    h1 { font-size: 1.2rem; font-weight: 600; margin: 0 0 8px; }
    p { color: #555; font-size: .9rem; margin: 0 0 20px; }
    label { display: block; font-size: .85rem; font-weight: 500; margin-bottom: 6px; }
    input[type=text] { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: .95rem; outline: none; transition: border .15s; }
    input[type=text]:focus { border-color: #0066ff; }
    .hint { font-size: .8rem; color: #888; margin-top: 6px; }
    .hint a { color: #0066ff; }
    button { margin-top: 20px; width: 100%; padding: 12px; background: #0066ff; color: #fff; border: none; border-radius: 8px; font-size: 1rem; font-weight: 500; cursor: pointer; transition: background .15s; }
    button:hover { background: #0050cc; }
    .error { background: #fff0f0; border: 1px solid #ffcccc; color: #c00; border-radius: 8px; padding: 10px 14px; font-size: .875rem; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">cQnce</div>
    <h1>Authorize ${clientLabel}</h1>
    <p>Enter your cQnce API key to grant access. The key is stored securely and never shared with the requesting application.</p>
    ${errorHtml}
    <form method="POST" action="${escapeHtml(origin)}/authorize/bind">
      <input type="hidden" name="code" value="${escapeHtml(code)}">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <label for="api_key">cQnce API Key</label>
      <input type="text" id="api_key" name="api_key" placeholder="cqnce_…" autocomplete="off" spellcheck="false" required>
      <p class="hint">Find your API key at <a href="https://app.cqnce.com" target="_blank" rel="noopener">app.cqnce.com</a> → Project → Settings.</p>
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
