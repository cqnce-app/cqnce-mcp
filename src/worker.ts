/**
 * cQnce MCP Worker — Cloudflare Workers deployment
 *
 * Exposes cQnce human-in-the-loop authorization as a remote MCP server
 * using Streamable HTTP transport (stateless, no Durable Objects).
 *
 * Authentication:
 *   1. OAuth 2.0 Client Credentials (recommended for Claude Desktop and MCP clients
 *      that support OAuth discovery). The worker advertises the backend token endpoint
 *      via /.well-known/oauth-authorization-server; Claude Desktop then obtains a
 *      short-lived JWT directly from the backend and uses it as the Bearer token.
 *   2. Raw API key — Authorization: Bearer <CQNCE_API_KEY> directly (backward compat).
 *
 * No secrets are stored or processed in this Worker — all token issuance and
 * validation happens on the cQnce backend.
 *
 * Optional env vars (set in Cloudflare Workers dashboard):
 *   CQNCE_BASE_URL  — defaults to https://api.cqnce.app
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CqnceApiClient } from './client.js';
import { registerRequestTools } from './tools/requests.js';

interface Env {
  CQNCE_BASE_URL?: string;
}

/** Returns true if the string looks like a JWT (three base64url segments). */
function isJWT(s: string): boolean {
  return s.split('.').length === 3;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const origin = `${url.protocol}//${url.host}`;
    const cqnceBase = env.CQNCE_BASE_URL ?? 'https://api.cqnce.app';

    // ── Health ────────────────────────────────────────────────────────────────
    if (pathname === '/' || pathname === '/health') {
      return Response.json({ status: 'ok', server: 'cqnce-mcp' });
    }

    // ── OAuth discovery ───────────────────────────────────────────────────────
    // Advertise the backend's token endpoint so MCP clients (e.g. Claude Desktop)
    // can obtain OAuth tokens without passing through this Worker.
    if (
      pathname === '/.well-known/oauth-authorization-server' ||
      pathname === '/.well-known/openid-configuration'
    ) {
      return Response.json({
        issuer: origin,
        token_endpoint: `${cqnceBase}/v1/oauth/token`,
        grant_types_supported: ['client_credentials'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        scopes_supported: ['mcp'],
      });
    }

    // ── MCP endpoint ──────────────────────────────────────────────────────────
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

      // OAuth JWT (issued by backend /v1/oauth/token) → send as Authorization: Bearer.
      // Raw API key (not a JWT) → send as x-api-key (backward compat).
      const clientOptions = isJWT(bearer)
        ? { baseUrl: cqnceBase, oauthToken: bearer }
        : { baseUrl: cqnceBase, apiKey: bearer };

      const server = new McpServer({ name: 'cqnce', version: '0.1.1' });
      const client = new CqnceApiClient(clientOptions);
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
