import { CqnceApiClient } from '../client.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerAgentTools(server: McpServer, client: CqnceApiClient): void {

  // ── Agents ───────────────────────────────────────────────────────────────

  server.tool(
    'list_agents',
    'List all agents (human approvers) who have joined the current tenant. ' +
    'Returns their ID, name, phone, online status, and whether they have push notifications enabled.',
    {},
    async () => {
      const result = await client.get('/v1/agents', {}, 'admin');
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'get_agent',
    'Get details of a specific agent by ID.',
    {
      agentId: z.string().describe('The agent ID to retrieve.'),
    },
    async ({ agentId }) => {
      const result = await client.get(
        `/v1/agents/${encodeURIComponent(agentId)}`,
        {},
        'admin',
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'invite_agent',
    'Invite an agent to join the tenant by phone number. ' +
    'The agent will receive an invitation via push notification or SMS and can accept it in the mobile app.',
    {
      phone: z
        .string()
        .describe('Agent phone number in international format (e.g. +12025551234).'),
      firstName: z.string().optional().describe('Agent first name.'),
      lastName: z.string().optional().describe('Agent last name.'),
      email: z.string().email().optional().describe('Agent email address (for email invitation).'),
    },
    async (input) => {
      const result = await client.post('/v1/agents/invite', input, 'admin');
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'list_agent_invites',
    'List all agent invitations sent by this tenant, including their status (PENDING, ACCEPTED, DECLINED).',
    {},
    async () => {
      const result = await client.get('/v1/agents/invites', {}, 'admin');
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // ── Teams ────────────────────────────────────────────────────────────────

  server.tool(
    'list_teams',
    'List all agent teams in the current tenant. ' +
    'Teams group agents together and can be assigned to routing rules.',
    {},
    async () => {
      const result = await client.get('/v1/teams', {}, 'admin');
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'create_team',
    'Create a new agent team.',
    {
      name: z.string().describe('Unique name for the team within the tenant.'),
    },
    async (input) => {
      const result = await client.post('/v1/teams', input, 'admin');
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'add_agent_to_team',
    'Add an agent to a team.',
    {
      teamId: z.string().describe('The team ID.'),
      agentId: z.string().describe('The agent ID to add.'),
      priority: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'Agent priority within the team for SERIAL routing. ' +
          'Lower value = notified first. Defaults to the current member count.',
        ),
    },
    async ({ teamId, ...body }) => {
      const result = await client.post(
        `/v1/teams/${encodeURIComponent(teamId)}/members`,
        body,
        'admin',
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'remove_agent_from_team',
    'Remove an agent from a team.',
    {
      teamId: z.string().describe('The team ID.'),
      agentId: z.string().describe('The agent ID to remove.'),
    },
    async ({ teamId, agentId }) => {
      const result = await client.delete(
        `/v1/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(agentId)}`,
        'admin',
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
