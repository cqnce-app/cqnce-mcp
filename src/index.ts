#!/usr/bin/env node
/**
 * cQnce MCP Server
 *
 * Exposes cQnce human-in-the-loop authorization as Model Context Protocol tools
 * so that AI agents (Claude, GitHub Copilot, Cursor, etc.) can request human
 * approval before performing risky or irreversible actions.
 *
 * Configuration (environment variables):
 *   CQNCE_API_KEY       — Required. Project API key from https://cqnce.app.
 *   CQNCE_BASE_URL      — Optional. Defaults to https://api.cqnce.app.
 *   CQNCE_ADMIN_TOKEN   — Optional. Tenant admin JWT for project/agent/team management tools.
 *
 * Transport: stdio (compatible with Claude Desktop, Cursor, Copilot, and any MCP client).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { clientFromEnv } from './client.js';
import { registerRequestTools } from './tools/requests.js';
import { registerProjectTools } from './tools/projects.js';
import { registerAgentTools } from './tools/agents.js';
import { registerCallbackTools } from './tools/callbacks.js';

const server = new McpServer({
  name: 'cqnce',
  version: '0.1.0',
});

const client = clientFromEnv();

// ── Register all tool groups ──────────────────────────────────────────────────

// Scenario 1 & 4: Human-in-the-loop approval gate + request monitoring
registerRequestTools(server, client);

// Scenario 2: Project & routing rule management (requires admin token)
if (client.hasAdminToken()) {
  registerProjectTools(server, client);
}

// Scenario 3: Agent & team management (requires admin token)
if (client.hasAdminToken()) {
  registerAgentTools(server, client);
}

// Scenario 5: Webhook callback management (requires admin token)
if (client.hasAdminToken()) {
  registerCallbackTools(server, client);
}

// ── Resources: projects and routing rules ────────────────────────────────────
//
// Expose projects as browsable MCP resources so AI agents can discover
// available projects and their routing rules without calling a tool.

if (client.hasAdminToken()) {
  server.resource(
    'projects',
    'cqnce://projects',
    {
      description: 'All projects in the current cQnce tenant.',
      mimeType: 'application/json',
    },
    async () => {
      const result = await client.get<{ projects: unknown[] }>('/v1/projects', {}, 'admin');
      return {
        contents: [
          {
            uri: 'cqnce://projects',
            mimeType: 'application/json',
            text: JSON.stringify(result.projects ?? result, null, 2),
          },
        ],
      };
    },
  );
}

// ── Start server ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
