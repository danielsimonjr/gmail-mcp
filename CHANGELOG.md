# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-05-24

### Changed

- **Rewrote in TypeScript** on `@modelcontextprotocol/sdk` + `googleapis` +
  `@google-cloud/local-auth`. The Python `server.py` is retired; the stale
  GWS wrapper `server.js` is also retired. Invocation changes from
  `python -X utf8 server.py` to `node dist/index.js`. Auth setup is
  `node dist/auth-cli.js` (was `python server.py --auth`). Tool surface
  is 23 existing + 1 new = 24 total.
- **Renamed display to "Gmail-mcp"** (capital G) in README title,
  `package.json` description, and the MCP `Server({name})` constructor.
  Directory and `mcp__gmail__*` tool prefix are unchanged.

### Added

- **Pagination** on `gmail_list_emails`, `gmail_search_emails`,
  `gmail_list_drafts`, and `gmail_list_labels`. Each accepts an optional
  `page_token` parameter and returns `next_page_token` when more pages exist.
- **Attachment metadata** in `gmail_read_email` and `gmail_get_draft`: a new
  `attachments` field lists `[{filename, mime_type, size, attachment_id}]`
  for every attached file.
- **Attachment sending** on `gmail_send_email`, `gmail_reply_email`,
  `gmail_forward_email`, `gmail_create_draft`, and `gmail_update_draft`: an
  optional `attachments: string[]` of local file paths is base64-encoded and
  inserted into the MIME multipart body.
- **New tool `gmail_download_attachment`** — saves an attachment to disk
  (default `~/Downloads/<filename>`); accepts `message_id`, `attachment_id`,
  `filename`, and optional `save_path`.
- **References-chain threading** per RFC 5322 §3.6.4 on `gmail_reply_email`
  and `gmail_create_draft(in_reply_to=...)`. Previously only `In-Reply-To` was
  set; now `References: <orig-References> <orig-Message-ID>` is constructed,
  fixing deep-thread breakage in strict clients.
- **Transient-error retry**: 429/500/502/503/504 are retried up to 3 times
  with exponential backoff. 400/401/403/404 are not retried.
- **Batch delete** on `gmail_delete_emails(permanent=true)` uses Gmail's
  `messages.batchDelete` (one API call) instead of N sequential
  `messages.delete` calls.
- `readOnlyHint` / `destructiveHint` MCP annotations on all 24 tools
  (9 read-only; 6 destructive: `send_email`, `send_draft`, `forward_email`,
  `reply_email`, `delete_emails`, `delete_label`).

### Fixed

- **Sender map mutex.** `withSenderMap` serializes concurrent `scan_labels`
  and `sort_inbox` calls via a Promise-chain mutex, preventing lost updates
  on overlapping writes to `~/.gmail_sorter/sender_map.json`.
- **Corrupted sender map recovery.** Bad JSON in `sender_map.json` is now
  backed up to `.corrupted.<ISO-timestamp>` with a stderr log, and the server
  falls back to an empty map rather than crashing.
- **Stderr logging** on token-refresh failures, map-save failures, and retry
  exhaustion. Previously silent.
- **Consistent error envelope.** All tools return `{status:"error", error:
  "..."}` via a `wrap()` helper — previously Google API exceptions bubbled as
  MCP transport errors.

### Removed

- `server.py` — Python FastMCP implementation.
- `server.js` — stale GWS stdio wrapper.
- `requirements.txt` — Python dependency list.

### Token compatibility

`loadToken` reads both `googleapis`-style tokens (`access_token`,
`refresh_token`, `expiry_date`, …) and legacy `google-auth-oauthlib`-style
tokens (`token`, `scopes[]`, `expiry` ISO string, …). Existing
`~/.gmail_sorter/token.json` files written by the Python implementation are
recognized without modification — no re-auth is needed after upgrading.

### Tests

97 vitest tests across 14 files: state persistence + sender-map mutex +
corruption recovery, auth token loading (both formats), Gmail client
mocking, format/MIME helpers, handler suites for sorting / read / organize /
mark / compose / draft / attachment, tool-definition annotation checks, and
a `TOOLS↔HANDLERS` symmetry smoke test.

---

## [0.1.0] - 2026-04-26 (Python — retroactively versioned)

The complete Python implementation, never tagged as a release.

### Added

- `server.py` — FastMCP server exposing 23 Gmail tools via `google-api-python-client`
  and `google-auth-oauthlib`.
- `--auth` flag on `server.py` to run the one-time browser OAuth flow and
  write `~/.gmail_sorter/token.json`.
- Sender→label habit map at `~/.gmail_sorter/sender_map.json`, built by
  `gmail_scan_labels` and consumed by `gmail_sort_inbox`.
- Optional `gws` credential path fallback:
  `~/.config/gws/client_secret.json`.
- `requirements.txt` listing `google-api-python-client`,
  `google-auth-httplib2`, `google-auth-oauthlib`, `mcp[cli]`, `fastmcp`.
