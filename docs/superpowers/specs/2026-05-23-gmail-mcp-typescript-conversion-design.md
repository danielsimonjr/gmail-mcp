# gmail-mcp → TypeScript SDK conversion — Design

**Date:** 2026-05-23
**Repo:** `C:/Users/danie/Dropbox/Github/gmail-mcp` (dir unchanged; display name becomes `Gmail-mcp`)
**Target version:** `0.2.0` (after cutover)
**Source:** Python `server.py` (FastMCP, 1237 LOC) + stale `server.js` (214 LOC, to delete)

## 1. Scope

Convert `gmail-mcp` from Python (FastMCP, `python -X utf8 server.py`) to TypeScript on `@modelcontextprotocol/sdk`, compiled to `dist/`. In-place replacement. Strict JSON-output parity for the 23 existing tools' input/output shapes; plus 1 new tool, 6 cross-cutting feature additions, and 5 design fixes (§9).

### 1.1 Tool surface — 24 tools total

The 23 Python tools, unchanged input/output:

- **Sorting (4):** `gmail_scan_labels`, `gmail_sort_inbox`, `gmail_preview_sort`, `gmail_get_mappings`
- **Read & search (4):** `gmail_list_labels`, `gmail_list_emails`, `gmail_read_email`, `gmail_search_emails`
- **Organize (5):** `gmail_move_emails`, `gmail_delete_emails`, `gmail_create_label`, `gmail_rename_label`, `gmail_delete_label`
- **Mark (1):** `gmail_mark_emails`
- **Compose (3):** `gmail_send_email`, `gmail_reply_email`, `gmail_forward_email`
- **Draft (6):** `gmail_create_draft`, `gmail_list_drafts`, `gmail_get_draft`, `gmail_update_draft`, `gmail_send_draft`, `gmail_delete_draft`

Plus the new tool:

- **`gmail_download_attachment(message_id, attachment_id, local_path?)`** — saves binary attachment to disk. Default path `~/Downloads/<filename>`. Returns `{status, local_path, size}`.

### 1.2 Feature additions across existing tools (§§4–8)

| # | Addition | Tools affected |
|---|---|---|
| F1 | Pagination (`page_token` in, `next_page_token` out) | `list_emails`, `search_emails`, `list_drafts`, `list_labels` |
| F2 | Attachment metadata in reads (`attachments: [{filename, mime_type, size, attachment_id}]`) | `read_email`, `get_draft` |
| F3 | Attachment sending (`attachments: string[]` of local paths) | `send_email`, `reply_email`, `forward_email`, `create_draft`, `update_draft` |
| F4 | References-chain threading (RFC 5322 compliant) | `reply_email`, `create_draft` |
| F5 | Retry on transient (429/500/503) up to 3× with exponential backoff | All API-touching tools |
| F6 | Batch delete via `messages.batchDelete` | `delete_emails(permanent=true)` |

## 2. Non-goals

- Renaming the repo directory or tool prefix (would break `.mcp.json` paths and every existing tool reference).
- Server-side filters / forwarding rules (Gmail Settings API). Out of scope; can be a future add.
- Calendar/Drive/Contacts integration.
- Attachment auto-download in `read_email` (response size explosion). Separate tool only.
- Conversation/thread-level read (Gmail has `threads.get` but Python doesn't use it; not in this port).
- IMAP/POP fallback (Gmail API only).

## 3. Module layout

```
src/
  auth.ts          — OAuth flow, token persistence, refresh
  client.ts        — Gmail API client wrapper with retry, error envelope
  state.ts         — sender_map.json load/save with mutex + corrupted-recovery
  mime.ts          — MIME message construction (plain + multipart for attachments)
  attachments.ts   — Attachment extract / encode / download helpers
  format.ts        — RFC 2822 date pass-through, snippet truncation, body decode
  tools.ts         — TOOLS[] (24 defs) + HANDLERS map
  index.ts         — MCP server wiring (ListTools / CallTool / stdio)
  auth-cli.ts      — Separate CLI entry: dist/auth-cli.js (replaces `python server.py --auth`)
tests/             — 14+ test files mirroring src/, target ≥90 tests
```

Same shape as time-mcp + dropbox-mcp. Larger than both, but each module has one clear responsibility. `tools.ts` will be ~600 lines (24 tools × ~25 LOC including descriptions); split into 4 logical groups (sort/read/organize/compose-draft) inside the file with banner comments.

## 4. OAuth + token persistence (§4)

| Aspect | Decision |
|---|---|
| Token path | `path.join(os.homedir(), ".gmail_sorter", "token.json")` — matches Python |
| Client-secret search order | `~/.gmail_sorter/client_secret.json` → `~/.config/gws/client_secret.json` (Python parity, for users coming from `gws`) |
| Scopes | `["https://mail.google.com/"]` — matches Python |
| Library | `googleapis` (npm) + `@google-cloud/local-auth` for the initial browser flow |
| Token refresh | Automatic via googleapis client when access_token expires (refresh_token must be present in token.json) |
| Auth entry point | `dist/auth-cli.js` (separate CLI). Replaces `python server.py --auth`. Runs the local-auth browser flow, writes `token.json`, prints authenticated email |

**Existing token.json survives the cutover.** The TS port reads the same path/format (googleapis `setCredentials` expects the same fields google-auth-oauthlib writes: `token`, `refresh_token`, `token_uri`, `client_id`, `client_secret`, `scopes`, `expiry`).

## 5. State model — sender_map.json (§5)

Same path/format pattern as time-mcp's state.json.

- Path: `path.join(os.homedir(), ".gmail_sorter", "sender_map.json")` — matches Python
- Env override: `GMAIL_MAP_FILE` (full file path override, matches Python's behavior)
- Format: UTF-8 JSON, 2-space indent, no ASCII escaping
- Atomic write: tempfile → renameSync with 3-retry exponential backoff on `EBUSY`/`EPERM`
- Mutex around mutations (fix D1, §9.1)
- Corrupted-file recovery (fix D2, §9.2)
- Shape (unchanged from Python):
  ```json
  {
    "alice@example.com": { "label": "Work", "date": "Wed, 21 May 2026 10:30:00 +0000" },
    ...
  }
  ```

## 6. Pagination (F1)

Gmail API returns a `nextPageToken` (string) when more results exist. The current Python port silently truncates at the user's `limit`; the TS port surfaces it.

**Input addition:** `page_token?: string` on `list_emails`, `search_emails`, `list_drafts`, `list_labels`. Omitted → first page.

**Output addition:** `next_page_token?: string` in the response. Present iff Gmail returned one. Omitted on the last page.

**Backwards-compat:** Existing clients that don't read `next_page_token` still see all the same fields they expected; they just stop at the first page (same as Python).

## 7. Attachments (F2, F3, + new download tool)

### 7.1 Metadata in reads (`read_email`, `get_draft`)

Adds `attachments` field to the response:

```json
"attachments": [
  { "filename": "report.pdf", "mime_type": "application/pdf", "size": 124356, "attachment_id": "ANGjdJ9..." },
  ...
]
```

Walk `payload.parts[]` recursively. A part is an attachment when it has `body.attachmentId` (the Gmail discriminator — distinguishes from inline content). `filename` from `part.filename`; if empty, fall back to `"unnamed.<extension-from-mime>"`. `size` from `body.size`.

If a message has no attachments, omit the field (don't emit `"attachments": []` — keeps JSON parity tight).

### 7.2 Download tool (new)

```typescript
gmail_download_attachment({
  message_id: string,
  attachment_id: string,
  local_path?: string,  // default: ~/Downloads/<filename-from-message>
})
```

Calls `users.messages.attachments.get({userId:"me", messageId, id:attachmentId})` → base64url body → decode → write to `local_path` (or default). Returns:

```json
{ "status": "ok", "local_path": "/Users/.../Downloads/report.pdf", "size": 124356 }
```

If `local_path` is a directory (not a file), filename is appended from the attachment's `filename`. Creates parent dirs as needed.

### 7.3 Sending attachments

`send_email`, `reply_email`, `forward_email`, `create_draft`, `update_draft` gain `attachments?: string[]` — array of local file paths.

When present, MIME message becomes `multipart/mixed`:
- Part 1: `multipart/alternative` containing the text body
- Parts 2+: each attachment as `application/octet-stream` (or detected MIME) with `Content-Disposition: attachment; filename="..."` and base64 body

For plain bodies (no attachments), keep the simple `text/plain` MIME from Python parity.

Use **manual MIME construction** (no nodemailer). Plain-text path is ~5 lines; multipart-with-attachments is ~30 lines. nodemailer would be 1MB of dependency for a 1-call use case.

## 8. References-chain threading (F4)

**Python's bug:** `reply_email` and `create_draft(in_reply_to=...)` set only `In-Reply-To: <orig-Message-ID>`. Per [RFC 5322 §3.6.4](https://datatracker.ietf.org/doc/html/rfc5322#section-3.6.4), the proper way is:

- `In-Reply-To: <orig-Message-ID>`
- `References: <orig-References> <orig-Message-ID>` (the chain — orig's References followed by orig's Message-ID, space-separated)

Gmail's thread-detection works on References-chain. Deep chains break threading without this fix.

**Fix:** Extract both `Message-ID` and `References` (if present) from the original message's headers. Construct `References` as `<orig-References-stripped> <orig-Message-ID>` (or just `<orig-Message-ID>` if no References was present).

## 9. Design fixes

### 9.1 sender_map mutex (D1)

```typescript
let queue: Promise<unknown> = Promise.resolve();
export async function withSenderMap<T>(fn: (m: SenderMap) => Promise<T> | T): Promise<T> { ... }
```

`gmail_scan_labels` and `gmail_sort_inbox` both read-modify-write `sender_map.json`. Concurrent calls can race. Same Promise-chain mutex as time-mcp's `withState`. Reads (`gmail_get_mappings`) bypass the mutex.

### 9.2 Corrupted sender_map recovery (D2)

On JSON parse failure: rename to `sender_map.json.corrupted.<ISO-ts>`, log to stderr, return empty `{}`. Same pattern as time-mcp §9.3.

### 9.3 Stderr logging (D3)

Every failure mode gets one stderr line: token refresh failure, save_state failure, retry exhaustion, OAuth flow errors. Stdout stays pure JSON-RPC.

### 9.4 MCP annotations (D4)

| `readOnlyHint: true` (9 tools) | `destructiveHint: true` (6 tools) | Mutating, non-destructive (9 tools) |
|---|---|---|
| `list_labels`, `list_emails`, `read_email`, `search_emails`, `list_drafts`, `get_draft`, `get_mappings`, `preview_sort`, `download_attachment` | `send_email`, `send_draft`, `forward_email`, `reply_email`, `delete_emails`, `delete_label` | `mark_emails`, `move_emails`, `create_label`, `rename_label`, `scan_labels`, `sort_inbox`, `create_draft`, `update_draft`, `delete_draft` |

Note `delete_draft` is NOT destructiveHint:true — drafts are local-only and easy to recreate. `delete_emails(permanent=false)` moves to trash (recoverable); only `permanent=true` is truly destructive — but since the same tool handles both, marking it destructive errs on the safe side from the LLM's perspective.

### 9.5 Consistent error envelope (D5)

Every handler is wrapped:

```typescript
async function wrap(name: string, fn: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await fn());
  } catch (err) {
    const e = err as { code?: number; message?: string };
    return JSON.stringify({
      status: "error",
      error: e.message || String(err),
      ...(e.code !== undefined ? { code: e.code } : {}),
    });
  }
}
```

Today Google API errors (`HttpError`, `RefreshError`) bubble up as MCP transport errors. The wrap normalizes to the same `{status:"error", error:"..."}` shape the Python's caught-error paths use.

### 9.6 Retry on transient errors (F5)

In `client.ts`:

```typescript
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const PERMANENT_AUTH = new Set([400, 401, 403, 404]);

async function withRetry<T>(fn: () => Promise<T>, max = 3): Promise<T> {
  for (let attempt = 0; attempt < max; attempt++) {
    try { return await fn(); }
    catch (err) {
      const code = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
      if (PERMANENT_AUTH.has(code as number)) throw err;
      if (!TRANSIENT.has(code as number) || attempt === max - 1) throw err;
      await new Promise(r => setTimeout(r, 250 * 2 ** attempt));
    }
  }
  throw new Error("unreachable");
}
```

429 specifically: respect `Retry-After` header if present, else exponential. 401: do NOT retry (googleapis client should auto-refresh; if refresh fails, retrying won't help). 403/404: permanent error, no retry.

## 10. MIME construction

**Plain text (no attachments):**
```
To: <to>
From: <user-email>
Subject: <subject>
[Cc: <cc>]
[In-Reply-To: <id>]
[References: <chain>]
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

<body>
```

Base64url-encode the whole string. Pass to `messages.send({raw})`.

**With attachments (multipart/mixed):** Standard MIME boundary construction. ~30 LOC; well-bounded, tested with a known good message structure.

## 11. Renaming

| Where | Old | New |
|---|---|---|
| `README.md` H1 | `# gmail-mcp` | `# Gmail-mcp` |
| `package.json` `name` | unchanged | `gmail-mcp` (npm requires lowercase) |
| `package.json` `description` | (n/a) | mentions "Gmail-mcp" |
| MCP `Server({name})` | `gmail_mcp` | `Gmail-mcp` |
| Repo dir | `gmail-mcp` | **unchanged** |
| Tool prefix | `gmail_` | **unchanged** |
| `.mcp.json` server key | `gmail` | **unchanged** (would force every prompt/tool reference to migrate) |

## 12. Testing

vitest, mirroring time-mcp pattern. Target **≥90 tests** across 14 files. Real Google API calls are mocked (vitest's `vi.mock` of `googleapis`).

| File | Coverage |
|---|---|
| `auth.test.ts` | token load/refresh, client_secret search order, missing-secret error |
| `state.test.ts` | sender_map load/save, mutex serializes concurrent writes, corrupted-file backup |
| `mime.test.ts` | plain-text MIME headers correct; multipart/mixed with 1 attachment; multipart/mixed with 3 attachments; non-ASCII subject (`=?UTF-8?B?...?=` encoded); reply with References chain |
| `attachments.test.ts` | extract metadata from nested parts; download path defaulting; binary write round-trip |
| `format.test.ts` | RFC 2822 date pass-through; snippet truncation; body decode (text/plain preferred); html fallback; recursive multipart |
| `client.test.ts` | retry on 429/500/503 with backoff; no retry on 400/401/403/404; max-retries respected |
| `handlers-sorting.test.ts` | 4 sorting tools; race-safe scan_labels under mutex |
| `handlers-read.test.ts` | 4 read tools; pagination next_page_token surfaces |
| `handlers-organize.test.ts` | 5 organize tools; batch_delete optimization on permanent=true |
| `handlers-mark.test.ts` | 1 mark tool; invalid-action error wording |
| `handlers-compose.test.ts` | 3 compose tools; attachment sending; References chain on reply |
| `handlers-draft.test.ts` | 6 draft tools; attachments preserved on update; References chain on create_draft with in_reply_to |
| `handlers-attachment.test.ts` | new download tool; default path; explicit path; dir-as-path |
| `smoke.test.ts` | TOOLS↔HANDLERS symmetry (24 entries); annotation table matches §9.4 |

## 13. Cutover (Task-N equivalent)

**`.mcp.json`** — change the `gmail` entry:

```json
"gmail": {
  "type": "stdio",
  "command": "node",
  "args": ["C:/Users/danie/Dropbox/Github/gmail-mcp/dist/index.js"],
  "env": { "_RETRY": "2026-05-23-gmail-mcp-ts-cutover" }
}
```

User runs `/reload-plugins`. Live-verify: `gmail_list_labels` (read-only, smallest possible call); `gmail_list_emails(label:"INBOX", limit:1)` to confirm read path works.

## 14. Cleanup (post-verification only)

- Remove `server.py`, `server.js` (the stale GWS wrapper), `requirements.txt`. Delete `package.json` (the partial NPM one — replaced fully).
- Update `README.md` for Node-based install + auth flow.
- Add `CHANGELOG.md` entry `## [0.2.0] - 2026-05-23` covering the port + the 6 feature additions + the 5 design fixes + the rename.
- Retire `C:/Users/danie/.venvs/gmail-mcp`.

## 15. Risks / open items

| Risk | Mitigation |
|---|---|
| Existing `token.json` format incompatible with googleapis client | Field-by-field load: explicit map of `google-auth-oauthlib` field names → googleapis `Credentials` fields. Tested with a known-good token in `auth.test.ts` |
| MIME construction subtle bugs (line-ending normalization, encoding) | All MIME tests assert on byte-exact output. CRLF normalized to `\r\n` per RFC 5322 §2.3 |
| `@google-cloud/local-auth` opens a localhost callback server — Windows Defender / firewall may block on first run | Documented in README. Same risk as Python — Python's `run_local_server(port=0)` does the same thing |
| Gmail rate-limit different in TS path due to retry timing | Retry budget capped at 3× total per request. Exponential backoff caps at ~1s |
| Attachment in multipart message exceeds Gmail's 25MB message limit | Document the limit; don't try to chunk. Return Google's 413 error verbatim via the wrap envelope |
| Pagination breaks downstream LLM workflows that didn't expect `next_page_token` | Field is optional; existing consumers see the same data. New field is additive |
| References-chain header rendering on weird whitespace from sender | Test corner cases: empty References, multi-line folded References, References with stray whitespace |
