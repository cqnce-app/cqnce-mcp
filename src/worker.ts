/**
 * cQnce MCP Worker — Cloudflare Workers deployment
 *
 * Implements:
 *  - OAuth 2.0 Authorization Code + PKCE  (Claude Desktop / claude.ai)
 *  - OAuth 2.0 Client Credentials          (API / PowerShell testing)
 *  - Raw API key Bearer                    (backward compat)
 *  - MCP Streamable HTTP transport
 *
 * Required env vars (Cloudflare dashboard → Settings → Variables):
 *   WORKER_JWT_SECRET   — used to sign short-lived access tokens
 *
 * Required KV namespace binding (wrangler.jsonc):
 *   OAUTH_CODES         — stores auth codes for 10 min during the OAuth dance
 *
 * Optional:
 *   CQNCE_BASE_URL      — defaults to https://api.cqnce.app
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CqnceApiClient } from './client.js';
import { registerRequestTools } from './tools/requests.js';

interface Env {
  CQNCE_BASE_URL?: string;
  WORKER_JWT_SECRET: string;
  OAUTH_CODES: KVNamespace;
}

interface StoredCode {
  apiKey: string;
  codeChallenge: string;
  redirectUri: string;
  clientId: string;
}

// ── Minimal JWT (Web Crypto API) ─────────────────────────────────────────────

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
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}
async function signJWT(payload: Record<string, unknown>, secret: string, ttl: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const h = b64urlEncode({ alg: 'HS256', typ: 'JWT' });
  const p = b64urlEncode({ ...payload, iat: now, exp: now + ttl });
  const unsigned = `${h}.${p}`;
  const key = await hmacKey(secret, 'sign');
  const sig = b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(unsigned)));
  return `${unsigned}.${sig}`;
}
async function verifyJWT(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const key = await hmacKey(secret, 'verify');
  const sigBytes = Uint8Array.from(b64urlDecode(s), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes,
    new TextEncoder().encode(`${h}.${p}`));
  if (!valid) return null;
  const payload = JSON.parse(b64urlDecode(p)) as Record<string, unknown>;
  if (typeof payload['exp'] === 'number' && payload['exp'] < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// ── PKCE verification ────────────────────────────────────────────────────────

async function verifyPKCE(verifier: string, challenge: string): Promise<boolean> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(hash) === challenge;
}

// ── Validate API key against cQnce ───────────────────────────────────────────

async function validateApiKey(apiKey: string, cqnceBase: string): Promise<boolean> {
  const res = await fetch(`${cqnceBase}/v1/requests?limit=1`, {
    headers: { 'x-api-key': apiKey },
  });
  return res.status !== 401 && res.status !== 403;
}

// ── Authorize page HTML ──────────────────────────────────────────────────────

function authorizePage(params: {
  clientId: string; state: string; redirectUri: string;
  codeChallenge: string; codeChallengeMethod: string;
  error?: string;
}): Response {
  const { clientId, state, redirectUri, codeChallenge, codeChallengeMethod, error } = params;
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
            max-width: 400px; box-shadow: 0 4px 24px rgba(0,0,0,.1) }
    .logo { font-size: 1.5rem; font-weight: 700; color: #4f46e5; margin-bottom: .25rem }
    h1 { font-size: 1.1rem; font-weight: 600; margin-bottom: .5rem }
    p  { font-size: .875rem; color: #6b7280; margin-bottom: 1.5rem }
    label { display: block; font-size: .8rem; font-weight: 500; color: #374151; margin-bottom: .4rem }
    input[type=password] { width: 100%; padding: .65rem .85rem; border: 1px solid #d1d5db;
                           border-radius: 8px; font-size: .95rem; outline: none; transition: border .15s }
    input[type=password]:focus { border-color: #4f46e5 }
    button { margin-top: 1.2rem; width: 100%; padding: .7rem; background: #4f46e5; color: #fff;
             border: none; border-radius: 8px; font-size: .95rem; font-weight: 600;
             cursor: pointer; transition: background .15s }
    button:hover { background: #4338ca }
    .error { margin-top: 1rem; padding: .65rem .85rem; background: #fef2f2;
             border: 1px solid #fecaca; border-radius: 8px; font-size: .85rem; color: #dc2626 }
    .hint { margin-top: 1rem; font-size: .78rem; color: #9ca3af; text-align: center }
  </style>
</head>
<body>
<div class="card">
  <div class="logo">cQnce</div>
  <h1>Connect your account</h1>
  <p>An external application (<code>${escHtml(clientId)}</code>) is requesting access to your cQnce project.</p>
  <form method="POST" action="/authorize">
    <input type="hidden" name="state" value="${escHtml(state)}">
    <input type="hidden" name="redirect_uri" value="${escHtml(redirectUri)}">
    <input type="hidden" name="code_challenge" value="${escHtml(codeChallenge)}">
    <input type="hidden" name="code_challenge_method" value="${escHtml(codeChallengeMethod)}">
    <input type="hidden" name="client_id" value="${escHtml(clientId)}">
    <label for="api_key">cQnce API Key</label>
    <input type="password" id="api_key" name="api_key"
           placeholder="Paste your project API key" autofocus autocomplete="off">
    ${error ? `<div class="error">${escHtml(error)}</div>` : ''}
    <button type="submit">Authorize</button>
  </form>
  <p class="hint">Find your API key in <strong>cqnce.app → Project settings</strong></p>
</div>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

    // ── Authorization endpoint ────────────────────────────────────────────
    if (pathname === '/authorize') {

      // GET — show login form
      if (request.method === 'GET') {
        const p = url.searchParams;
        const clientId = p.get('client_id') ?? '';
        const state = p.get('state') ?? '';
        const redirectUri = p.get('redirect_uri') ?? '';
        const codeChallenge = p.get('code_challenge') ?? '';
        const codeChallengeMethod = p.get('code_challenge_method') ?? 'S256';
        if (!clientId || !redirectUri || !codeChallenge) {
          return new Response('Missing required OAuth parameters', { status: 400 });
        }
        return authorizePage({ clientId, state, redirectUri, codeChallenge, codeChallengeMethod });
      }

      // POST — validate credentials and redirect with code
      if (request.method === 'POST') {
        const body = await request.text();
        const form = new URLSearchParams(body);
        const apiKey = form.get('api_key')?.trim() ?? '';
        const state = form.get('state') ?? '';
        const redirectUri = form.get('redirect_uri') ?? '';
        const codeChallenge = form.get('code_challenge') ?? '';
        const codeChallengeMethod = form.get('code_challenge_method') ?? 'S256';
        const clientId = form.get('client_id') ?? '';

        if (!apiKey) {
          return authorizePage({ clientId, state, redirectUri, codeChallenge,
            codeChallengeMethod, error: 'Please enter your API key.' });
        }

        const valid = await validateApiKey(apiKey, cqnceBase);
        if (!valid) {
          return authorizePage({ clientId, state, redirectUri, codeChallenge,
            codeChallengeMethod, error: 'Invalid API key. Please check and try again.' });
        }

        const code = crypto.randomUUID();
        const stored: StoredCode = { apiKey, codeChallenge, redirectUri, clientId };
        await env.OAUTH_CODES.put(code, JSON.stringify(stored), { expirationTtl: 600 });

        const callbackUrl = new URL(redirectUri);
        callbackUrl.searchParams.set('code', code);
        if (state) callbackUrl.searchParams.set('state', state);
        return Response.redirect(callbackUrl.toString(), 302);
      }

      return new Response('Method Not Allowed', { status: 405 });
    }

    // ── Token endpoint ────────────────────────────────────────────────────
    if (pathname === '/oauth/token') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

      const body = await request.text();
      const params = new URLSearchParams(body);
      const grantType = params.get('grant_type');

      // Authorization Code exchange
      if (grantType === 'authorization_code') {
        const code = params.get('code');
        const codeVerifier = params.get('code_verifier');
        const redirectUri = params.get('redirect_uri');

        if (!code || !codeVerifier) {
          return Response.json({ error: 'invalid_request', error_description: 'code and code_verifier required' }, { status: 400 });
        }

        const raw = await env.OAUTH_CODES.get(code);
        if (!raw) {
          return Response.json({ error: 'invalid_grant', error_description: 'Code not found or expired' }, { status: 400 });
        }

        const stored = JSON.parse(raw) as StoredCode;

        // Verify PKCE
        const pkceOk = await verifyPKCE(codeVerifier, stored.codeChallenge);
        if (!pkceOk) {
          return Response.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, { status: 400 });
        }

        if (redirectUri && redirectUri !== stored.redirectUri) {
          return Response.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, { status: 400 });
        }

        // One-time use
        await env.OAUTH_CODES.delete(code);

        const token = await signJWT({ apiKey: stored.apiKey }, env.WORKER_JWT_SECRET, 3600);
        return Response.json({ access_token: token, token_type: 'bearer', expires_in: 3600 });
      }

      // Client Credentials (for direct API / testing — proxied to backend)
      if (grantType === 'client_credentials') {
        let clientId: string | null = null;
        let clientSecret: string | null = null;
        const authHeader = request.headers.get('Authorization') ?? '';
        if (authHeader.startsWith('Basic ')) {
          const decoded = atob(authHeader.slice(6).replace(/-/g, '+').replace(/_/g, '/'));
          const colon = decoded.indexOf(':');
          if (colon >= 0) { clientId = decoded.slice(0, colon); clientSecret = decoded.slice(colon + 1); }
        }
        if (!clientId) clientId = params.get('client_id');
        if (!clientSecret) clientSecret = params.get('client_secret');
        if (!clientId || !clientSecret) {
          return Response.json({ error: 'invalid_client', error_description: 'client_id and client_secret required' }, { status: 401 });
        }
        // Proxy to backend token endpoint
        const backendRes = await fetch(`${cqnceBase}/v1/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
        });
        const backendBody = await backendRes.text();
        return new Response(backendBody, {
          status: backendRes.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
    }

    // ── MCP endpoint ──────────────────────────────────────────────────────
    if (pathname.startsWith('/mcp')) {
      const authHeader = request.headers.get('Authorization') ?? '';
      if (!authHeader.startsWith('Bearer ')) {
        return Response.json(
          { error: 'Authorization: Bearer <token> required' },
          { status: 401, headers: { 'WWW-Authenticate': `Bearer realm="cqnce-mcp", resource="${origin}"` } },
        );
      }
      const bearer = authHeader.slice(7).trim();

      let clientOptions: ConstructorParameters<typeof CqnceApiClient>[0];

      // Try Worker JWT (Authorization Code flow — contains apiKey)
      const payload = env.WORKER_JWT_SECRET
        ? await verifyJWT(bearer, env.WORKER_JWT_SECRET).catch(() => null)
        : null;

      if (payload?.['apiKey']) {
        clientOptions = { baseUrl: cqnceBase, apiKey: payload['apiKey'] as string };
      } else if (bearer.split('.').length === 3) {
        // Backend JWT (Client Credentials flow — contains projectId)
        clientOptions = { baseUrl: cqnceBase, oauthToken: bearer };
      } else {
        // Raw API key (backward compat)
        clientOptions = { baseUrl: cqnceBase, apiKey: bearer };
      }

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
