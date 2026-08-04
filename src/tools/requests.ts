import { CqnceApiClient } from '../client.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const TERMINAL_STATUSES = new Set(['APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerRequestTools(server: McpServer, client: CqnceApiClient): void {

  // ── Scenario 1: Human-in-the-loop approval gate ─────────────────────────

  server.tool(
    'submit_authorization_request',
    'Submit a human authorization request to cQnce. Use this BEFORE performing any ' +
    'risky, destructive, or irreversible action (e.g. deploying to production, executing ' +
    'a database migration, making a payment, modifying credentials). Returns a requestId ' +
    'that you can pass to wait_for_approval or poll_request_status.',
    {
      payload: z
        .record(z.string(), z.unknown())
        .describe(
          'Structured description of the action requiring authorization. ' +
          'Include all context a human needs to approve or reject (e.g. action, target, amount, reason).',
        ),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Optional additional context (correlation IDs, tags, environment, etc.).'),
      routingRuleId: z
        .string()
        .optional()
        .describe('Directly select a routing rule by ID, bypassing filter evaluation.'),
      routingMode: z
        .enum(['PARALLEL', 'SERIAL', 'MAJORITY', 'CHAIN'])
        .optional()
        .describe('Override the routing mode configured on the matching rule.'),
      callbackUrl: z
        .string()
        .optional()
        .describe('Webhook URL to notify when the request is resolved.'),
      wsClientId: z
        .string()
        .optional()
        .describe('WebSocket client ID for real-time status delivery.'),
    },
    async (input) => {
      const result = await client.post<{ requestId: string; status: string }>(
        '/v1/requests',
        input,
        'apiKey',
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    'poll_request_status',
    'Check the current status of a cQnce authorization request. ' +
    'Terminal statuses are: APPROVED, REJECTED, EXPIRED, CANCELLED. ' +
    'PENDING means the request is still waiting for a human decision. ' +
    'For a blocking wait, use wait_for_approval instead.',
    {
      requestId: z.string().describe('The request ID returned by submit_authorization_request.'),
    },
    async ({ requestId }) => {
      const result = await client.get(
        `/v1/requests/${encodeURIComponent(requestId)}/status`,
        {},
        'apiKey',
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'wait_for_approval',
    'Submit an authorization request and BLOCK until a human approves or rejects it ' +
    '(or until the timeout elapses). This is the primary tool for human-in-the-loop ' +
    'workflows: call it, wait for the result, and proceed ONLY if status is APPROVED. ' +
    'If status is REJECTED or EXPIRED, do NOT proceed with the action.',
    {
      payload: z
        .record(z.string(), z.unknown())
        .describe(
          'Structured description of the action requiring authorization. ' +
          'Include all context a human needs to approve or reject.',
        ),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Optional additional context (correlation IDs, tags, environment, etc.).'),
      routingRuleId: z
        .string()
        .optional()
        .describe('Directly select a routing rule by ID, bypassing filter evaluation.'),
      routingMode: z
        .enum(['PARALLEL', 'SERIAL', 'MAJORITY', 'CHAIN'])
        .optional()
        .describe('Override the routing mode configured on the matching rule.'),
      callbackUrl: z
        .string()
        .optional()
        .describe('Webhook URL to notify when the request is resolved.'),
      timeoutMs: z
        .number()
        .int()
        .min(5000)
        .optional()
        .describe(
          'Maximum milliseconds to wait for a human decision before giving up (default: 300000 = 5 min).',
        ),
      pollIntervalMs: z
        .number()
        .int()
        .min(1000)
        .optional()
        .describe('How often to poll for a status update in milliseconds (default: 3000).'),
    },
    async (input) => {
      const { timeoutMs = 300_000, pollIntervalMs = 3_000, ...submitInput } = input;

      // Submit the request
      const submitted = await client.post<{ requestId: string; status: string }>(
        '/v1/requests',
        submitInput,
        'apiKey',
      );

      const { requestId, status: initialStatus } = submitted;

      if (TERMINAL_STATUSES.has(initialStatus)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ requestId, status: initialStatus }, null, 2),
            },
          ],
        };
      }

      // Poll until terminal or timeout
      const deadline = Date.now() + timeoutMs;
      while (true) {
        await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));

        if (Date.now() >= deadline) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    requestId,
                    status: 'TIMEOUT',
                    message: `No human decision received within ${timeoutMs}ms. The request (${requestId}) is still pending in cQnce.`,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const poll = await client.get<{ status: string; decision?: string }>(
          `/v1/requests/${encodeURIComponent(requestId)}/status`,
          {},
          'apiKey',
        );

        if (TERMINAL_STATUSES.has(poll['status'] as string)) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ requestId, ...poll }, null, 2) }],
          };
        }
      }
    },
  );

  server.tool(
    'cancel_request',
    'Cancel a pending cQnce authorization request. ' +
    'Use this if the action is no longer needed and you want to release the human agents.',
    {
      requestId: z.string().describe('The request ID to cancel.'),
    },
    async ({ requestId }) => {
      const result = await client.post(
        `/v1/requests/${encodeURIComponent(requestId)}/cancel`,
        undefined,
        'apiKey',
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // ── Scenario 4: Request monitoring & audit ───────────────────────────────

  server.tool(
    'list_requests',
    'List authorization requests for this project. ' +
    'Useful for monitoring ongoing requests, debugging workflows, and auditing decisions.',
    {
      status: z
        .enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'])
        .optional()
        .describe('Filter by request status.'),
      projectId: z
        .string()
        .optional()
        .describe('Filter by project ID (admin token required when used).'),
      startDate: z
        .string()
        .optional()
        .describe('ISO 8601 start date filter (e.g. 2024-01-01).'),
      endDate: z
        .string()
        .optional()
        .describe('ISO 8601 end date filter (e.g. 2024-12-31).'),
      tags: z
        .array(z.string())
        .optional()
        .describe('Filter by one or more tags.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Maximum number of results to return (default: 50).'),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Pagination offset (default: 0).'),
    },
    async (input) => {
      const auth = client.hasApiKey() ? 'apiKey' : 'admin';
      const { tags, ...rest } = input;
      const query: Record<string, string | number | boolean | undefined> = { ...rest };

      if (tags && tags.length > 0) {
        const url = new URL(`${client.baseUrl}/v1/requests`);
        for (const [k, v] of Object.entries(query)) {
          if (v !== undefined) url.searchParams.set(k, String(v));
        }
        for (const t of tags) url.searchParams.append('tags', t);
        const apiKey = process.env['CQNCE_API_KEY'];
        const adminToken = process.env['CQNCE_ADMIN_TOKEN'];
        const headers: Record<string, string> = auth === 'apiKey' && apiKey
          ? { 'x-api-key': apiKey }
          : { 'Authorization': 'Bearer ' + (adminToken ?? '') };
        const res = await fetch(url.toString(), { headers });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
        return { content: [{ type: 'text' as const, text }] };
      }

      const result = await client.get('/v1/requests', query, auth);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'get_request',
    'Get full details of a single authorization request, including payload, metadata, ' +
    'agent responses, and current status.',
    {
      requestId: z.string().describe('The request ID to retrieve.'),
    },
    async ({ requestId }) => {
      const auth = client.hasApiKey() ? 'apiKey' : 'admin';
      const result = await client.get(
        `/v1/requests/${encodeURIComponent(requestId)}`,
        {},
        auth,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'query_request_logs',
    'Query the event-level audit log for authorization requests. ' +
    'Returns routing events, timeouts, and decision events for debugging and compliance.',
    {
      requestId: z
        .string()
        .optional()
        .describe('Filter logs for a specific request ID.'),
      projectId: z
        .string()
        .optional()
        .describe('Filter logs for a specific project ID.'),
      event: z
        .string()
        .optional()
        .describe('Filter by event type (e.g. ROUTED, RESPONDED, RESOLVED, EXPIRED).'),
      search: z
        .string()
        .optional()
        .describe('Full-text search across request IDs and log details.'),
      startDate: z
        .string()
        .optional()
        .describe('ISO 8601 start date filter.'),
      endDate: z
        .string()
        .optional()
        .describe('ISO 8601 end date filter.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe('Maximum number of log entries to return (default: 50).'),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Pagination offset (default: 0).'),
    },
    async (input) => {
      const result = await client.get('/v1/logs', input as Record<string, string | number | boolean | undefined>, 'admin');
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
