/**
 * cQnce MCP Worker — Cloudflare Workers deployment
 *
 * Exposes cQnce human-in-the-loop authorization as a remote MCP server
 * using Streamable HTTP transport (stateless, no Durable Objects).
 *
 * Authentication: Authorization: Bearer <CQNCE_API_KEY> on every request.
 * Configuration: set CQNCE_BASE_URL in the Cloudflare Workers environment
 *                (defaults to https://api.cqnce.app).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CqnceApiClient } from './client.js';
import { registerRequestTools } from './tools/requests.js';

interface Env {
  CQNCE_BASE_URL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === '/' || pathname === '/health') {
      return Response.json({ status: 'ok', server: 'cqnce-mcp' });
    }

    if (!pathname.startsWith('/mcp')) {
      return new Response('Not found', { status: 404 });
    }

    const authHeader = request.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return Response.json(
        { error: 'Authorization: Bearer <api-key> header required' },
        { status: 401 },
      );
    }
    const apiKey = authHeader.slice(7).trim();
    if (!apiKey) {
      return Response.json({ error: 'API key must not be empty' }, { status: 401 });
    }

    const server = new McpServer({ name: 'cqnce', version: '0.1.1' });
    const client = new CqnceApiClient({
      baseUrl: env.CQNCE_BASE_URL ?? 'https://api.cqnce.app',
      apiKey,
    });
    registerRequestTools(server, client);

    // Stateless mode: no session management, each request is independent.
    // Perfect for cloud agents where each caller has its own API key.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
