# Gmail MCP Server

A FastMCP server providing 23 Gmail tools via the Google Gmail API. Direct API access — no external CLI dependency.

## Tools (23)

### Sorting (4)
| Tool | Description |
|------|-------------|
| `gmail_scan_labels` | Scan all labels, build sender→label habit map |
| `gmail_sort_inbox` | Move inbox emails to mapped labels (live) |
| `gmail_preview_sort` | Dry run — show what would move |
| `gmail_get_mappings` | Return the sender→label map |

### Read & Search (4)
| Tool | Description |
|------|-------------|
| `gmail_list_labels` | List all labels with message counts |
| `gmail_list_emails` | List emails in a label with previews |
| `gmail_read_email` | Read full email content by message ID |
| `gmail_search_emails` | Search by Gmail query syntax |

### Organize (5)
| Tool | Description |
|------|-------------|
| `gmail_move_emails` | Move email(s) to a label |
| `gmail_delete_emails` | Trash or permanently delete email(s) |
| `gmail_create_label` | Create a new label |
| `gmail_rename_label` | Rename an existing label |
| `gmail_delete_label` | Delete a label |

### Mark (1)
| Tool | Description |
|------|-------------|
| `gmail_mark_emails` | Mark as read/unread/starred/unstarred |

### Compose (3)
| Tool | Description |
|------|-------------|
| `gmail_send_email` | Compose and send a new email |
| `gmail_reply_email` | Reply to an existing email (threaded) |
| `gmail_forward_email` | Forward an existing email |

### Drafts (6)
| Tool | Description |
|------|-------------|
| `gmail_create_draft` | Create a draft (optional `in_reply_to` for threaded reply drafts) |
| `gmail_list_drafts` | List drafts with recipient, subject, and snippet preview |
| `gmail_get_draft` | Read full draft content by draft ID |
| `gmail_update_draft` | Replace contents of an existing draft (preserves threading) |
| `gmail_send_draft` | Send an existing draft |
| `gmail_delete_draft` | Delete a draft |

## Prerequisites

- Python 3.11+
- Google Cloud project with Gmail API enabled
- OAuth2 client credentials (`client_secret.json`)

## Setup

### 1. Get Google OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project → Enable Gmail API
3. Create OAuth 2.0 credentials (Desktop application)
4. Download `client_secret.json`
5. Place it at `~/.gmail_sorter/client_secret.json`

Or if you already have `gws` authenticated, the server will find `~/.config/gws/client_secret.json` automatically.

### 2. Install Dependencies

```bash
pip install -r requirements.txt
```

### 3. Authenticate (one-time)

```bash
python server.py --auth
```

This opens a browser for Google OAuth. After authorization, a token is saved to `~/.gmail_sorter/token.json`.

### 4. Register with Claude Code

```bash
claude mcp add --transport stdio --scope user gmail-mcp -- python -X utf8 /path/to/gmail-mcp/server.py
```

### 5. Restart Claude Code

The 23 gmail tools will be available.

## Configuration

| File | Purpose |
|------|---------|
| `~/.gmail_sorter/client_secret.json` | OAuth2 client credentials |
| `~/.gmail_sorter/token.json` | Saved OAuth2 token (auto-refreshes) |
| `~/.gmail_sorter/sender_map.json` | Sender→label habit map |
| `~/.gmail_sorter/.env` | Optional environment overrides |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GMAIL_MAP_FILE` | Custom path for sender map JSON |

## License

MIT
