/**
 * cQnce MCP Worker — Cloudflare Workers deployment
 *
 * OAuth 2.0 Authorization Code + PKCE flow:
 *   1. Claude.ai fetches /.well-known and discovers authorization + token endpoints here
 *   2. Claude.ai redirects user to /authorize → Worker shows a form asking for
 *      the project client_id and client_secret (created in cQnce project settings)
 *   3. Worker validates credentials against cQnce, stores them in KV with the auth code
 *   4. Claude.ai exchanges the code at /oauth/token → Worker calls the cQnce backend
 *      token endpoint and returns a short-lived backend JWT as the access_token
 *   5. Claude.ai uses the JWT as Bearer on /mcp → Worker passes it to cQnce as-is
 *
 * No secrets are generated or stored in this Worker beyond the temporary auth code
 * (kept in KV for 10 minutes). All token signing happens on the cQnce backend.
 *
 * Required KV namespace binding (set in Cloudflare dashboard → Settings → Bindings):
 *   OAUTH_CODES  — temporary auth code storage
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
  clientSecret: string;
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

// ── Validate client credentials (lightweight check before storing in KV) ─────

async function validateClientCredentials(
  clientId: string, clientSecret: string, cqnceBase: string,
): Promise<boolean> {
  const res = await fetch(`${cqnceBase}/v1/requests?limit=1`, {
    headers: { 'x-client-id': clientId, 'x-client-secret': clientSecret },
  });
  return res.status !== 401 && res.status !== 403;
}

// ── Authorize page HTML ───────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function authorizePage(params: {
  oauthClientId: string; state: string; redirectUri: string;
  codeChallenge: string; codeChallengeMethod: string; error?: string;
}): Response {
  const { oauthClientId, state, redirectUri, codeChallenge, codeChallengeMethod, error } = params;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Authorize — cQnce</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
    body { font-family: system-ui, sans-serif; background: #f5f5f7; min-height: 100vh;
           display: flex; align-items: center; justify-content: center; padding: 1rem }
    .card { background: #fff; border-radius: 16px; padding: 2.5rem 2rem; width: 100%;
            max-width: 420px; box-shadow: 0 4px 24px rgba(0,0,0,.1) }
    .logo { font-size: 1.5rem; font-weight: 700; color: #4f46e5; margin-bottom: .25rem }
    h1 { font-size: 1.1rem; font-weight: 600; margin-bottom: .4rem }
    .sub { font-size: .875rem; color: #6b7280; margin-bottom: 1.5rem }
    label { display: block; font-size: .8rem; font-weight: 500; color: #374151;
            margin-bottom: .35rem; margin-top: 1rem }
    input { width: 100%; padding: .65rem .85rem; border: 1px solid #d1d5db;
            border-radius: 8px; font-size: .9rem; font-family: monospace;
            outline: none; transition: border .15s }
    input:focus { border-color: #4f46e5 }
    button { margin-top: 1.4rem; width: 100%; padding: .7rem; background: #4f46e5;
             color: #fff; border: none; border-radius: 8px; font-size: .95rem;
             font-weight: 600; cursor: pointer; transition: background .15s }
    button:hover { background: #4338ca }
    .error { margin-top: 1rem; padding: .65rem .85rem; background: #fef2f2;
             border: 1px solid #fecaca; border-radius: 8px; font-size: .85rem; color: #dc2626 }
    .hint { margin-top: 1rem; font-size: .78rem; color: #9ca3af; text-align: center }
  </style>
</head>
<body>
<div class="card">
  <div class="logo">cQnce</div>
  <h1>Connect your project</h1>
  <p class="sub"><code>${escHtml(oauthClientId)}</code> is requesting access to a cQnce project.</p>
  <form method="POST" action="/authorize">
    <input type="hidden" name="state" value="${escHtml(state)}">
    <input type="hidden" name="redirect_uri" value="${escHtml(redirectUri)}">
    <input type="hidden" name="code_challenge" value="${escHtml(codeChallenge)}">
    <input type="hidden" name="code_challenge_method" value="${escHtml(codeChallengeMethod)}">
    <input type="hidden" name="oauth_client_id" value="${escHtml(oauthClientId)}">
    <label for="client_id">Project Client ID</label>
    <input type="text" id="client_id" name="client_id"
           placeholder="cid_xxxxxxxxxxxxxxxx" autofocus autocomplete="off">
    <label for="client_secret">Client Secret</label>
    <input type="password" id="client_secret" name="client_secret"
           placeholder="Your client secret" autocomplete="off">
    ${error ? `<div class="error">${escHtml(error)}</div>` : ''}
    <button type="submit">Authorize</button>
  </form>
  <p class="hint">Create project client credentials at <strong>cqnce.app → Project → Clients</strong></p>
</div>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
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

    // ── OAuth discovery ─────────────────────────────────────────────────────
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

    // ── Authorization endpoint ──────────────────────────────────────────────
    if (pathname === '/authorize') {

      if (request.method === 'GET') {
        const p = url.searchParams;
        const oauthClientId     = p.get('client_id') ?? '';
        const state             = p.get('state') ?? '';
        const redirectUri       = p.get('redirect_uri') ?? '';
        const codeChallenge     = p.get('code_challenge') ?? '';
        const codeChallengeMethod = p.get('code_challenge_method') ?? 'S256';
        if (!oauthClientId || !redirectUri || !codeChallenge) {
          return new Response('Missing required OAuth parameters', { status: 400 });
        }
        return authorizePage({ oauthClientId, state, redirectUri, codeChallenge, codeChallengeMethod });
      }

      if (request.method === 'POST') {
        const form = new URLSearchParams(await request.text());
        const clientId          = form.get('client_id')?.trim() ?? '';
        const clientSecret      = form.get('client_secret')?.trim() ?? '';
        const state             = form.get('state') ?? '';
        const redirectUri       = form.get('redirect_uri') ?? '';
        const codeChallenge     = form.get('code_challenge') ?? '';
        const codeChallengeMethod = form.get('code_challenge_method') ?? 'S256';
        const oauthClientId     = form.get('oauth_client_id') ?? '';

        const pageParams = { oauthClientId, state, redirectUri, codeChallenge, codeChallengeMethod };

        if (!clientId || !clientSecret) {
          return authorizePage({ ...pageParams, error: 'Please enter both Client ID and Client Secret.' });
        }

        const valid = await validateClientCredentials(clientId, clientSecret, cqnceBase);
        if (!valid) {
          return authorizePage({ ...pageParams, error: 'Invalid credentials. Check your Client ID and Secret.' });
        }

        const code = crypto.randomUUID();
        const stored: StoredCode = { clientId, clientSecret, codeChallenge, redirectUri };
        await env.OAUTH_CODES.put(code, JSON.stringify(stored), { expirationTtl: 600 });

        const callbackUrl = new URL(redirectUri);
        callbackUrl.searchParams.set('code', code);
        if (state) callbackUrl.searchParams.set('state', state);
        return Response.redirect(callbackUrl.toString(), 302);
      }

      return new Response('Method Not Allowed', { status: 405 });
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

        // Exchange client credentials for a backend JWT
        const tokenRes = await fetch(`${cqnceBase}/v1/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=client_credentials&client_id=${encodeURIComponent(stored.clientId)}&client_secret=${encodeURIComponent(stored.clientSecret)}`,
        });

        if (!tokenRes.ok) {
          return Response.json({ error: 'invalid_grant', error_description: 'Failed to issue token' }, { status: 400 });
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

      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      return transport.handleRequest(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
