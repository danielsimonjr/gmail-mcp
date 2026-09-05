# Gmail-mcp

A TypeScript-on-Bun MCP server providing 24 Gmail tools via the Google Gmail API.
Built on
[`@modelcontextprotocol/server`](https://github.com/modelcontextprotocol/typescript-sdk)
v2 (MCP 2.0 / 2026-07-28, with legacy 2025-era clients still served),
[`googleapis`](https://www.npmjs.com/package/googleapis), and
[`@google-cloud/local-auth`](https://www.npmjs.com/package/@google-cloud/local-auth).
Covers sorting, read/search, organize, mark, compose, drafts, and attachment
download. Features include pagination, attachment metadata and sending,
References-chain RFC 5322 threading, transient-error retry with exponential
backoff, and batch delete.

## Tools (24)

### Sorting (4)
| Tool | Description | Read-only |
|------|-------------|-----------|
| `gmail_scan_labels` | Scan all labels, build sender→label habit map | No |
| `gmail_sort_inbox` | Move inbox emails to mapped labels (live) | No |
| `gmail_preview_sort` | Dry run — show what sort_inbox would move | Yes |
| `gmail_get_mappings` | Return the current sender→label map | Yes |

### Read & Search (4)
| Tool | Description | Read-only |
|------|-------------|-----------|
| `gmail_list_labels` | List all labels with message counts; accepts `page_token` | Yes |
| `gmail_list_emails` | List emails in a label with previews; accepts `page_token` | Yes |
| `gmail_read_email` | Read full email content and attachment metadata by message ID | Yes |
| `gmail_search_emails` | Search by Gmail query syntax; accepts `page_token` | Yes |

### Organize (5)
| Tool | Description | Read-only |
|------|-------------|-----------|
| `gmail_move_emails` | Move email(s) to a label | No |
| `gmail_delete_emails` | Trash or permanently delete email(s) | No |
| `gmail_create_label` | Create a new label | No |
| `gmail_rename_label` | Rename an existing label | No |
| `gmail_delete_label` | Delete a label — **destructive** | No |

### Mark (1)
| Tool | Description | Read-only |
|------|-------------|-----------|
| `gmail_mark_emails` | Mark as read/unread/starred/unstarred | No |

### Compose (3)
| Tool | Description | Read-only |
|------|-------------|-----------|
| `gmail_send_email` | Compose and send a new email; optional `attachments` (local paths) — **destructive** | No |
| `gmail_reply_email` | Reply to an existing email (threaded, References chain) — **destructive** | No |
| `gmail_forward_email` | Forward an existing email — **destructive** | No |

### Drafts (6)
| Tool | Description | Read-only |
|------|-------------|-----------|
| `gmail_create_draft` | Create a draft; optional `in_reply_to` for threaded reply drafts | No |
| `gmail_list_drafts` | List drafts with recipient, subject, and snippet preview; accepts `page_token` | Yes |
| `gmail_get_draft` | Read full draft content and attachment metadata by draft ID | Yes |
| `gmail_update_draft` | Replace contents of an existing draft (preserves threading) | No |
| `gmail_send_draft` | Send an existing draft — **destructive** | No |
| `gmail_delete_draft` | Delete a draft | No |

### Attachment (1)
| Tool | Description | Read-only |
|------|-------------|-----------|
| `gmail_download_attachment` | Save an attachment to disk (default `~/Downloads/<filename>`) | No |

**Read-only tools (9):** `gmail_preview_sort`, `gmail_get_mappings`, `gmail_list_labels`,
`gmail_list_emails`, `gmail_read_email`, `gmail_search_emails`, `gmail_list_drafts`,
`gmail_get_draft`.

**Destructive tools (6):** `gmail_send_email`, `gmail_reply_email`, `gmail_forward_email`,
`gmail_send_draft`, `gmail_delete_emails`, `gmail_delete_label`.

## Design notes

- **Sender map mutex.** `withSenderMap` serializes concurrent `scan_labels` and
  `sort_inbox` calls via a Promise-chain mutex, preventing lost updates on overlapping
  writes to `~/.gmail_sorter/sender_map.json`. Corrupted maps are backed up to
  `.corrupted.<ISO-timestamp>` and replaced with an empty map rather than crashing.
- **OAuth via `@google-cloud/local-auth`.** On `node dist/auth-cli.js`, the browser
  OAuth flow completes and the token is written to `~/.gmail_sorter/token.json`. The
  server auto-refreshes the access token on expiry.
- **Pagination.** `gmail_list_emails`, `gmail_search_emails`, `gmail_list_drafts`, and
  `gmail_list_labels` accept an optional `page_token` parameter and return a
  `next_page_token` field when more pages exist. Pass the returned token back to fetch
  the next page.
- **Attachment metadata.** `gmail_read_email` and `gmail_get_draft` include an
  `attachments` field listing `[{filename, mime_type, size, attachment_id}]` for each
  attached file.
- **Attachment sending.** `gmail_send_email`, `gmail_reply_email`, `gmail_forward_email`,
  `gmail_create_draft`, and `gmail_update_draft` accept an optional `attachments:
  string[]` of local file paths. Files are base64-encoded and inserted into the MIME
  multipart body.
- **References-chain threading.** `gmail_reply_email` and `gmail_create_draft(in_reply_to=...)`
  construct `References: <orig-References> <orig-Message-ID>` per RFC 5322 §3.6.4.
  Previously only `In-Reply-To` was set, which broke deep-thread continuity in some
  clients.
- **Transient-error retry.** 429, 500, 502, 503, and 504 responses are retried up to
  3 times with exponential backoff. 400, 401, 403, and 404 are not retried.
- **Batch delete.** `gmail_delete_emails(permanent=true)` calls Gmail's
  `messages.batchDelete` (one API call) rather than N sequential `messages.delete`
  calls.
- **Consistent error envelope.** All tools return `{status: "error", error: "..."}` on
  failure via a `wrap()` helper — Google API exceptions do not bubble as MCP transport
  errors.
- **MCP annotations.** All 24 tools carry `readOnlyHint` or `destructiveHint`
  annotations as described above.

## Companion skill

This plugin ships a companion skill, `gmail` (`gmail-mcp:gmail`, slash
trigger `/gmail`), at `skills/gmail/SKILL.md`. It's a **safety-tiered**
playbook over the 24 tools above: read/search is free (no confirmation),
while every send, forward, reply, and delete tool requires explicit,
in-the-moment user confirmation before it's called — the skill classifies
every tool by risk and never auto-sends or hard-deletes.

## Prerequisites

- Bun 1.4 or newer (toolchain: install, scripts, tests)
- Node.js 24 or newer (runtime the Claude Code plugin launches with `node …/bundle/index.mjs`)
- A Dropbox Google OAuth app (or any Google Cloud project) with the
  `https://mail.google.com/` scope enabled and an OAuth 2.0 Desktop client
- `client_secret.json` downloaded from the Google Cloud Console

## Installation

```bash
git clone https://github.com/danielsimonjr/gmail-mcp.git
cd gmail-mcp
bun install
bun run build
```

The build emits `dist/index.js` (MCP server) and `dist/auth-cli.js` (auth CLI).

## Auth setup

Place `client_secret.json` at `~/.gmail_sorter/client_secret.json` (or at
`~/.config/gws/client_secret.json` if you previously used the `gws` tool — the
server checks both paths). Then run the one-time auth flow:

```bash
node dist/auth-cli.js
```

This opens a browser window for the Google OAuth consent screen. After you
authorize, the token is saved to `~/.gmail_sorter/token.json`. The server
auto-refreshes access tokens on expiry; re-running `auth-cli.js` is only
needed if you revoke the token or change scopes.

## Register with Claude Code

Add an entry to your MCP config (e.g.,
`~/.claude/local-marketplace/mcp-host/.mcp.json`):

```json
{
  "mcpServers": {
    "gmail": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/gmail-mcp/dist/index.js"]
    }
  }
}
```

Run `/reload-plugins` in Claude Code. Tools appear under the `mcp__gmail__*` prefix.

## Token compatibility

`loadToken` reads both `googleapis`-style tokens (`access_token`, `refresh_token`,
`expiry_date`, …) and legacy `google-auth-oauthlib`-style tokens (`token`, `scopes[]`,
`expiry` ISO string, …). If you were running the Python `server.py`, your existing
`~/.gmail_sorter/token.json` is recognized without modification — no re-auth needed.

## Development

```bash
bun run typecheck   # tsc --noEmit
bun test            # vitest run — unit + MCP protocol suite
bun run build       # emit dist/
bun run bundle      # rebuild bundle/index.mjs (plugin artifact)
```

## License

MIT — see [LICENSE](LICENSE).
