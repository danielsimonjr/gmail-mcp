# Gmail MCP Server

MCP server that gives Claude Code direct access to Gmail via the Google Workspace CLI (`gws`).

## Tools

| Tool | Description |
|------|-------------|
| `gmail_triage` | Show unread inbox messages |
| `gmail_send` | Send an email (to, subject, body, optional cc) |
| `gmail_read` | Read a specific email by message ID |
| `gmail_search` | Search emails using Gmail query syntax |
| `gmail_reply` | Reply to an email |
| `gmail_reply_all` | Reply-all to an email |
| `gmail_forward` | Forward an email |
| `gmail_labels` | List all Gmail labels |

## Prerequisites

1. Install Google Workspace CLI: `npm install -g @googleworkspace/cli`
2. Authenticate: `gws auth login -s gmail`

## Setup

```bash
git clone https://github.com/danielsimonjr/gmail-mcp.git
cd gmail-mcp
npm install
```

Add to `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "gmail": {
      "command": "node",
      "args": ["/path/to/gmail-mcp/server.js"]
    }
  }
}
```

Restart Claude Code. The gmail tools will be available.

## License

MIT
