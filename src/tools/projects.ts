import { CqnceApiClient } from '../client.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerProjectTools(server: McpServer, client: CqnceApiClient): void {

  // ── Projects ─────────────────────────────────────────────────────────────

  server.tool(
    'list_projects',
    'List all projects in the current tenant.',
    {},
    async () => {
      const result = await client.get('/v1/projects', {}, 'admin');
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'get_project',
    'Get full details of a project, including routing rules and webhook callbacks.',
    {
      projectId: z.string().describe('The project ID to retrieve.'),
    },
    async ({ projectId }) => {
      const result = await client.get(
        `/v1/projects/${encodeURIComponent(projectId)}`,
        {},
        'admin',
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'create_project',
    'Create a new project in the current tenant.',
    {
      name: z.string().describe('Unique name for the project within the tenant.'),
      description: z.string().optional().describe('Optional description.'),
      tags: z.array(z.string()).optional().describe('Optional list of tags.'),
      defaultAction: z
        .enum(['APPROVE', 'REJECT'])
        .optional()
        .nullable()
        .describe(
          'Default action when no routing rule matches a request ' +
          '(APPROVE, REJECT, or omit to leave PENDING).',
        ),
      strictSchemaValidation: z
        .boolean()
        .optional()
        .describe('Reject requests that do not match the configured payload schema.'),
      allowRequestBasedRouting: z
        .boolean()
        .optional()
        .describe('Allow clients to embed routing instructions in request metadata.'),
    },
    async (input) => {
      const result = await client.post('/v1/projects', input, 'admin');
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'update_project',
    "Update an existing project's settings.",
    {
      projectId: z.string().describe('The project ID to update.'),
      name: z.string().optional().describe('New project name.'),
      description: z.string().optional().describe('New description.'),
      tags: z.array(z.string()).optional().describe('Replace the list of tags.'),
      defaultAction: z
        .enum(['APPROVE', 'REJECT'])
        .optional()
        .nullable()
        .describe('New default action for unmatched requests.'),
      strictSchemaValidation: z.boolean().optional(),
      allowRequestBasedRouting: z.boolean().optional(),
    },
    async ({ projectId, ...body }) => {
      const result = await client.put(
        `/v1/projects/${encodeURIComponent(projectId)}`,
        body,
        'admin',
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // ── Routing Rules ─────────────────────────────────────────────────────────

  server.tool(
    'list_routing_rules',
    'List all routing rules for a project, ordered by priority (highest first).',
    {
      projectId: z.string().describe('The project whose routing rules to list.'),
    },
    async ({ projectId }) => {
      const result = await client.get(
        `/v1/projects/${encodeURIComponent(projectId)}/routing-rules`,
        {},
        'admin',
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'create_routing_rule',
    'Create a routing rule for a project. Routing rules determine which agents or teams ' +
    'receive a request, and in what mode (PARALLEL, SERIAL, MAJORITY, CHAIN). ' +
    'Rules are evaluated in priority order; the first matching rule is used.',
    {
      projectId: z.string().describe('The project to add the routing rule to.'),
      name: z.string().optional().describe('Optional human-readable name for the rule.'),
      mode: z
        .enum(['PARALLEL', 'SERIAL', 'MAJORITY', 'CHAIN'])
        .optional()
        .describe(
          'Routing mode: PARALLEL (first response wins), SERIAL (try agents one by one), ' +
          'MAJORITY (wait for quorum), CHAIN (all agents must respond). Defaults to PARALLEL.',
        ),
      agentIds: z
        .array(z.string())
        .optional()
        .describe('IDs of agents directly assigned to this rule.'),
      teamIds: z
        .array(z.string())
        .optional()
        .describe('IDs of agent teams assigned to this rule.'),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .optional()
        .nullable()
        .describe('Per-step timeout in milliseconds (default: 30000). Use null for no timeout (CHAIN mode only).'),
      quorum: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Number of matching decisions required (MAJORITY mode only).'),
      priority: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Rule priority; higher value = evaluated first. Defaults to 0.'),
      filterExpression: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Optional JSON filter expression to match against request payload/metadata. ' +
          'When omitted, the rule matches all requests.',
        ),
      requireStrongAuth: z
        .boolean()
        .optional()
        .describe('Require biometric authentication from agents before they can respond.'),
      tags: z
        .array(z.string())
        .optional()
        .describe('Tags to apply to requests matched by this rule. Supports {payload.field} placeholders.'),
    },
    async ({ projectId, ...body }) => {
      const result = await client.post(
        `/v1/projects/${encodeURIComponent(projectId)}/routing-rules`,
        body,
        'admin',
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'update_routing_rule',
    'Update an existing routing rule.',
    {
      projectId: z.string().describe('The project that owns the routing rule.'),
      ruleId: z.string().describe('The routing rule ID to update.'),
      name: z.string().optional().nullable().describe('New rule name.'),
      mode: z.enum(['PARALLEL', 'SERIAL', 'MAJORITY', 'CHAIN']).optional(),
      agentIds: z.array(z.string()).optional(),
      teamIds: z.array(z.string()).optional(),
      timeoutMs: z.number().int().min(1000).optional().nullable(),
      quorum: z.number().int().min(1).max(100).optional().nullable(),
      priority: z.number().int().min(0).optional(),
      filterExpression: z.record(z.string(), z.unknown()).optional().nullable(),
      requireStrongAuth: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
    },
    async ({ projectId, ruleId, ...body }) => {
      const result = await client.put(
        `/v1/projects/${encodeURIComponent(projectId)}/routing-rules/${encodeURIComponent(ruleId)}`,
        body,
        'admin',
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'delete_routing_rule',
    'Delete a routing rule from a project.',
    {
      projectId: z.string().describe('The project that owns the routing rule.'),
      ruleId: z.string().describe('The routing rule ID to delete.'),
    },
    async ({ projectId, ruleId }) => {
      const result = await client.delete(
        `/v1/projects/${encodeURIComponent(projectId)}/routing-rules/${encodeURIComponent(ruleId)}`,
        'admin',
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
