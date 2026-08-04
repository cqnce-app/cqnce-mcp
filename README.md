# @cqnce/mcp-server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes **cQnce** human-in-the-loop authorization as AI-callable tools.

Connect it to Claude Desktop, Cursor, GitHub Copilot, or any MCP-compatible AI agent so that the agent can request human approval before performing risky or irreversible actions.

---

## Why

AI agents increasingly perform consequential actions autonomously — deploying code, running database migrations, sending payments, modifying credentials. **cQnce** inserts a human into that loop: the agent asks for approval, a human approves or rejects on their phone, and the agent proceeds only if approved.

---

## Quick start

### 1. Install

```bash
npm install -g @cqnce/mcp-server
# or run without installing:
npx @cqnce/mcp-server
```

### 2. Configure environment

| Variable | Required | Description |
|---|---|---|
| `CQNCE_BASE_URL` | ✅ | Base URL of your cQnce backend (e.g. `https://api.example.com`) |
| `CQNCE_API_KEY` | For request tools | Project API key — grants access to request submission and monitoring |
| `CQNCE_ADMIN_TOKEN` | For management tools | Tenant admin JWT — grants access to project, agent, team, and callback management |

### 3. Add to Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "cqnce": {
      "command": "npx",
      "args": ["@cqnce/mcp-server"],
      "env": {
        "CQNCE_BASE_URL": "https://api.example.com",
        "CQNCE_API_KEY": "your-project-api-key"
      }
    }
  }
}
```

### 4. Add to Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "cqnce": {
      "command": "npx",
      "args": ["@cqnce/mcp-server"],
      "env": {
        "CQNCE_BASE_URL": "https://api.example.com",
        "CQNCE_API_KEY": "your-project-api-key"
      }
    }
  }
}
```

---

## Available tools

### 🔑 Human-in-the-loop approval gate

These tools use `CQNCE_API_KEY`.

| Tool | Description |
|---|---|
| `wait_for_approval` | **Primary tool.** Submit a request and block until a human approves or rejects. Proceed only if `status === "APPROVED"`. |
| `submit_authorization_request` | Submit a request and return immediately with a `requestId`. |
| `poll_request_status` | Check the current status of a request. |
| `cancel_request` | Cancel a pending request. |

#### Example: safe deployment

```
Please deploy the payments service to production.

[Agent calls wait_for_approval with payload:
  { action: "deploy", service: "payments", environment: "production", commit: "abc123" }]

[Human approves on their phone]

[Agent proceeds with deployment]
```

---

### 🔍 Request monitoring & audit

These tools use `CQNCE_API_KEY` (or `CQNCE_ADMIN_TOKEN` for cross-project queries).

| Tool | Description |
|---|---|
| `list_requests` | List requests with optional filters (status, project, date range, tags). |
| `get_request` | Get full details of a single request including agent responses. |
| `query_request_logs` | Query the event-level audit log (routing events, timeouts, decisions). |

---

### 📋 Project & routing management

These tools require `CQNCE_ADMIN_TOKEN`.

| Tool | Description |
|---|---|
| `list_projects` | List all projects in the tenant. |
| `get_project` | Get project details including routing rules and callbacks. |
| `create_project` | Create a new project. |
| `update_project` | Update project settings. |
| `list_routing_rules` | List routing rules for a project. |
| `create_routing_rule` | Create a routing rule (assigns agents/teams, sets mode and timeout). |
| `update_routing_rule` | Update an existing routing rule. |
| `delete_routing_rule` | Delete a routing rule. |

---

### 👥 Agent & team management

These tools require `CQNCE_ADMIN_TOKEN`.

| Tool | Description |
|---|---|
| `list_agents` | List all agents in the tenant with online status. |
| `get_agent` | Get details of a specific agent. |
| `invite_agent` | Invite an agent by phone number. |
| `list_agent_invites` | List all pending/accepted/declined invitations. |
| `list_teams` | List all agent teams. |
| `create_team` | Create a new team. |
| `add_agent_to_team` | Add an agent to a team. |
| `remove_agent_from_team` | Remove an agent from a team. |

---

### 📡 Webhook callback management

These tools require `CQNCE_ADMIN_TOKEN`.

| Tool | Description |
|---|---|
| `list_callbacks` | List webhook callbacks for a project. |
| `create_callback` | Add a webhook endpoint (returns signing secret). |
| `update_callback` | Update a callback URL, events, headers, or retry count. |
| `delete_callback` | Remove a webhook callback. |
| `rotate_callback_secret` | Rotate the HMAC signing secret for a callback. |

---

## MCP resources

When `CQNCE_ADMIN_TOKEN` is set, the server exposes:

| Resource URI | Description |
|---|---|
| `cqnce://projects` | All projects in the tenant (browsable without calling a tool). |

---

## Routing modes

When creating routing rules or submitting requests with `routingMode`, the supported modes are:

| Mode | Behaviour |
|---|---|
| `PARALLEL` | All agents notified simultaneously; first response wins. |
| `SERIAL` | Agents tried one at a time in order; next notified only after timeout of current. |
| `MAJORITY` | Waits for a configurable quorum of matching decisions. |
| `CHAIN` | Every agent in the chain must respond (not just the first). |

---

## Deployment

### Publishing to npm

The package must be published to npm before users can run it with `npx @cqnce/mcp-server` or install it globally with `npm install -g @cqnce/mcp-server`.

```bash
# 1. Build the TypeScript sources
cd mcp
npm run build

# 2. (Optional) Verify what will be published
npm pack --dry-run

# 3. Publish (requires npm login with publish rights to @cqnce)
npm publish
```

The `publishConfig` in `package.json` targets the public npm registry with scope `@cqnce`. Increment the `version` field in `package.json` before each publish (`npm version patch|minor|major`).

### Running from source (no npm publish required)

If you haven't published the package yet, you can still point any MCP client at the local build by using the `node` command instead of `npx`:

```json
{
  "mcpServers": {
    "cqnce": {
      "command": "node",
      "args": ["/absolute/path/to/cqnce/mcp/dist/index.js"],
      "env": {
        "CQNCE_BASE_URL": "https://api.example.com",
        "CQNCE_API_KEY": "your-project-api-key"
      }
    }
  }
}
```

Build the server first with `npm run build` from the `mcp/` directory whenever source files change.

---

## Security

- The MCP server runs locally via `stdio` transport — no network port is opened.
- API keys and admin tokens are read from environment variables and never logged.
- The server does **not** store or cache credentials between invocations.
- Webhook signing secrets returned by `create_callback` and `rotate_callback_secret` are shown once — store them securely.
