# @cqnce/mcp-server

Official MCP server for [cQnce](https://cqnce.app) — add human-in-the-loop authorization to any AI agent or workflow.

Connect Claude, Cursor, GitHub Copilot, or any MCP-compatible client to cQnce so the AI can request human approval before performing risky or irreversible actions.

## Quick start

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "cqnce": {
      "command": "npx",
      "args": ["-y", "@cqnce/mcp-server"],
      "env": {
        "CQNCE_API_KEY": "your-project-api-key"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project (or the global `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "cqnce": {
      "command": "npx",
      "args": ["-y", "@cqnce/mcp-server"],
      "env": {
        "CQNCE_API_KEY": "your-project-api-key"
      }
    }
  }
}
```

### Any MCP client (stdio transport)

```bash
CQNCE_API_KEY=your-project-api-key npx @cqnce/mcp-server
```

### Cloud agents (Streamable HTTP / remote MCP)

For cloud-hosted agents that cannot run local processes, use the cQnce MCP Worker deployed on Cloudflare Workers. It speaks the [MCP Streamable HTTP transport](https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/transports/#streamable-http) and is stateless — every request authenticates with your API key.

Configure your cloud agent framework to connect to:

```
https://mcp.cqnce.app/mcp
Authorization: Bearer <your-project-api-key>
```

Example (Claude API with MCP):

```json
{
  "type": "url",
  "url": "https://mcp.cqnce.app/mcp",
  "name": "cqnce",
  "authorization_token": "your-project-api-key"
}
```

#### Self-hosting

The Worker source is in this repository. Deploy your own instance to Cloudflare Workers:

```bash
npm install
npx wrangler deploy
```

Set `CQNCE_BASE_URL` in the Cloudflare dashboard if you use a private cQnce deployment (defaults to `https://api.cqnce.app`).

## Configuration

| Variable | Required | Description |
|---|---|---|
| `CQNCE_API_KEY` | Yes | Project API key from [cqnce.app](https://cqnce.app) |
| `CQNCE_BASE_URL` | No | API base URL (default: `https://api.cqnce.app`) |
| `CQNCE_ADMIN_TOKEN` | No | Tenant admin JWT — enables project/agent/team management tools |

## Tools

### Core (requires `CQNCE_API_KEY`)

| Tool | Description |
|---|---|
| `wait_for_approval` | Submit a request and **block** until a human approves or rejects it. This is the primary tool for human-in-the-loop workflows. |
| `submit_authorization_request` | Submit a request and return the `requestId` immediately (non-blocking). |
| `poll_request_status` | Check the current status of a request by ID. |
| `cancel_request` | Cancel a pending request. |
| `list_requests` | List requests for this project (filterable by status, date, tags). |
| `get_request` | Get full details of a single request including agent responses. |

### Admin (requires `CQNCE_ADMIN_TOKEN`)

Project management, routing rule configuration, agent/team management, and webhook callbacks.

## Example

Once configured, you can tell Claude:

> "Before deleting the production database, ask for human approval via cQnce."

Claude will call `wait_for_approval` with the action details, pause until a human approves or rejects from the cQnce mobile app, and only proceed if the status is `APPROVED`.

## Requirements

- Node.js 18+
- A cQnce account and project API key — [sign up free](https://cqnce.app)
