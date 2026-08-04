import { CqnceApiClient } from '../client.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const VALID_EVENTS = [
  'request.approved',
  'request.rejected',
  'request.expired',
  'request.cancelled',
  'chain.step_approved',
  'serial.agent_timeout',
] as const;

export function registerCallbackTools(server: McpServer, client: CqnceApiClient): void {

  server.tool(
    'list_callbacks',
    'List all webhook callbacks configured for a project.',
    {
      projectId: z.string().describe('The project whose callbacks to list.'),
    },
    async ({ projectId }) => {
      const result = await client.get(
        `/v1/projects/${encodeURIComponent(projectId)}/callbacks`,
        {},
        'admin',
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'create_callback',
    'Configure a webhook endpoint that cQnce will call when a request is resolved. ' +
    'The response includes a signingSecret — store it securely and use it to verify ' +
    'the X-cQnce-Signature header on incoming webhook payloads.',
    {
      projectId: z.string().describe('The project to add the callback to.'),
      url: z.string().url().describe('The HTTPS webhook endpoint URL.'),
      events: z
        .array(z.enum(VALID_EVENTS))
        .min(1)
        .describe(
          'Events that trigger this webhook. ' +
          'Valid values: request.approved, request.rejected, request.expired, ' +
          'request.cancelled, chain.step_approved, serial.agent_timeout.',
        ),
      headerName: z
        .string()
        .optional()
        .nullable()
        .describe('Optional custom request header name to include in webhook calls.'),
      headerValue: z
        .string()
        .optional()
        .nullable()
        .describe('Value for the custom request header.'),
      maxRetries: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .describe('Maximum delivery retry attempts on failure (default: 3).'),
    },
    async ({ projectId, ...body }) => {
      const result = await client.post(
        `/v1/projects/${encodeURIComponent(projectId)}/callbacks`,
        body,
        'admin',
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'update_callback',
    'Update an existing webhook callback. ' +
    'Set rotateSecret to true to generate a new signing secret (the new secret is returned once).',
    {
      projectId: z.string().describe('The project that owns the callback.'),
      callbackId: z.string().describe('The callback ID to update.'),
      url: z.string().url().optional().describe('New webhook URL.'),
      events: z
        .array(z.enum(VALID_EVENTS))
        .min(1)
        .optional()
        .describe('New list of events.'),
      headerName: z.string().optional().nullable(),
      headerValue: z.string().optional().nullable(),
      maxRetries: z.number().int().min(0).max(20).optional(),
      rotateSecret: z
        .boolean()
        .optional()
        .describe('Set to true to rotate the HMAC signing secret.'),
    },
    async ({ projectId, callbackId, ...body }) => {
      const result = await client.put(
        `/v1/projects/${encodeURIComponent(projectId)}/callbacks/${encodeURIComponent(callbackId)}`,
        body,
        'admin',
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'delete_callback',
    'Delete a webhook callback from a project.',
    {
      projectId: z.string().describe('The project that owns the callback.'),
      callbackId: z.string().describe('The callback ID to delete.'),
    },
    async ({ projectId, callbackId }) => {
      const result = await client.delete(
        `/v1/projects/${encodeURIComponent(projectId)}/callbacks/${encodeURIComponent(callbackId)}`,
        'admin',
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'rotate_callback_secret',
    'Rotate the HMAC signing secret for a webhook callback. ' +
    'The new secret is returned once — update your webhook handler immediately.',
    {
      projectId: z.string().describe('The project that owns the callback.'),
      callbackId: z.string().describe("The callback ID whose secret to rotate."),
    },
    async ({ projectId, callbackId }) => {
      const result = await client.put(
        `/v1/projects/${encodeURIComponent(projectId)}/callbacks/${encodeURIComponent(callbackId)}`,
        { rotateSecret: true },
        'admin',
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
