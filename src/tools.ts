import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export type ToolHandler = (raw: unknown) => Promise<string>;

const RO_NON_DESTRUCTIVE = { readOnlyHint: true, destructiveHint: false };
const MUT_NON_DESTRUCTIVE = { readOnlyHint: false, destructiveHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true };

const STR = (description: string) => ({ type: "string" as const, description });
const STR_LIST = (description: string) => ({ type: "array" as const, items: { type: "string" as const }, description });

export const TOOLS: Tool[] = [
  // --- Sorting (4) ---
  { name: "gmail_scan_labels", description: "Scan all non-excluded labels, learn sender→label mappings, save to sender_map.json.", annotations: MUT_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "gmail_sort_inbox", description: "Apply learned sender→label mappings to inbox: move each email to its mapped label.", annotations: MUT_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "gmail_preview_sort", description: "Dry-run inbox sort — show what would be moved without mutating anything.", annotations: RO_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "gmail_get_mappings", description: "Read sender_map.json and return entries (optionally filtered by label, limited by count).", annotations: RO_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { label_filter: STR("Case-insensitive label substring match."), limit: { type: "number", description: "Max entries to return (default 200)." } }, additionalProperties: false } },
  // --- Read (4) ---
  { name: "gmail_list_labels", description: "List all Gmail labels (system + user) with total/unread counts.", annotations: RO_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "gmail_list_emails", description: "List emails under a label. Returns id, sender, subject, date, snippet per message. Supports pagination via page_token.", annotations: RO_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { label: STR("Label name or ID. Default 'INBOX'."), limit: { type: "number" }, unread_only: { type: "boolean" }, page_token: STR("Pagination cursor from a prior call.") }, additionalProperties: false } },
  { name: "gmail_read_email", description: "Read a full email body + headers + attachments metadata.", annotations: RO_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { message_id: STR("Gmail message ID.") }, required: ["message_id"], additionalProperties: false } },
  { name: "gmail_search_emails", description: "Search Gmail using its native query syntax (e.g. 'from:alice subject:foo'). Supports pagination.", annotations: RO_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { query: STR("Gmail search query."), limit: { type: "number" }, page_token: STR("Pagination cursor.") }, required: ["query"], additionalProperties: false } },
  // --- Organize (5) ---
  { name: "gmail_move_emails", description: "Move emails to a label (adds the label, removes INBOX).", annotations: MUT_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { message_ids: STR_LIST("Message IDs."), label: STR("Target label name or ID.") }, required: ["message_ids", "label"], additionalProperties: false } },
  { name: "gmail_delete_emails", description: "Trash or permanently delete emails. Defaults to trash (recoverable). When permanent=true, uses Gmail's batchDelete (irreversible).", annotations: DESTRUCTIVE,
    inputSchema: { type: "object", properties: { message_ids: STR_LIST("Message IDs."), permanent: { type: "boolean" } }, required: ["message_ids"], additionalProperties: false } },
  { name: "gmail_create_label", description: "Create a new Gmail label.", annotations: MUT_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { name: STR("New label name.") }, required: ["name"], additionalProperties: false } },
  { name: "gmail_rename_label", description: "Rename a label.", annotations: MUT_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { old_name: STR("Existing label name."), new_name: STR("New name.") }, required: ["old_name", "new_name"], additionalProperties: false } },
  { name: "gmail_delete_label", description: "Delete a label permanently.", annotations: DESTRUCTIVE,
    inputSchema: { type: "object", properties: { name: STR("Label name to delete.") }, required: ["name"], additionalProperties: false } },
  // --- Mark (1) ---
  { name: "gmail_mark_emails", description: "Mark emails read/unread/starred/unstarred.", annotations: MUT_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { message_ids: STR_LIST("Message IDs."), action: STR("'read', 'unread', 'star', or 'unstar'.") }, required: ["message_ids", "action"], additionalProperties: false } },
  // --- Compose (3) ---
  { name: "gmail_send_email", description: "Send a new email. Optional attachments by local file path.", annotations: DESTRUCTIVE,
    inputSchema: { type: "object", properties: { to: STR(""), subject: STR(""), body: STR(""), cc: STR(""), attachments: STR_LIST("Local file paths to attach.") }, required: ["to", "subject", "body"], additionalProperties: false } },
  { name: "gmail_reply_email", description: "Reply to an email, preserving thread + References chain. Optional attachments.", annotations: DESTRUCTIVE,
    inputSchema: { type: "object", properties: { message_id: STR(""), body: STR(""), attachments: STR_LIST("Local file paths.") }, required: ["message_id", "body"], additionalProperties: false } },
  { name: "gmail_forward_email", description: "Forward an email to a new recipient. Optional attachments.", annotations: DESTRUCTIVE,
    inputSchema: { type: "object", properties: { message_id: STR(""), to: STR(""), body: STR(""), attachments: STR_LIST("Local file paths.") }, required: ["message_id", "to"], additionalProperties: false } },
  // --- Draft (6) ---
  { name: "gmail_create_draft", description: "Create a new draft. If in_reply_to is set, threads with proper References chain. Optional attachments.", annotations: MUT_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { to: STR(""), subject: STR(""), body: STR(""), cc: STR(""), in_reply_to: STR("Message ID to reply to."), attachments: STR_LIST("Local file paths.") }, required: ["to", "subject", "body"], additionalProperties: false } },
  { name: "gmail_list_drafts", description: "List drafts with sender, subject, snippet. Supports pagination.", annotations: RO_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { limit: { type: "number" }, page_token: STR("Pagination cursor.") }, additionalProperties: false } },
  { name: "gmail_get_draft", description: "Read a draft's full content + attachments metadata.", annotations: RO_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { draft_id: STR("Draft ID.") }, required: ["draft_id"], additionalProperties: false } },
  { name: "gmail_update_draft", description: "Replace draft contents (preserves thread + References if set).", annotations: MUT_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { draft_id: STR(""), to: STR(""), subject: STR(""), body: STR(""), cc: STR(""), attachments: STR_LIST("Local file paths.") }, required: ["draft_id", "to", "subject", "body"], additionalProperties: false } },
  { name: "gmail_send_draft", description: "Send an existing draft.", annotations: DESTRUCTIVE,
    inputSchema: { type: "object", properties: { draft_id: STR("Draft ID.") }, required: ["draft_id"], additionalProperties: false } },
  { name: "gmail_delete_draft", description: "Delete a draft.", annotations: MUT_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { draft_id: STR("Draft ID.") }, required: ["draft_id"], additionalProperties: false } },
  // --- Attachment (1, new) ---
  { name: "gmail_download_attachment", description: "Download an attachment from a message to local disk. Default path: ~/Downloads/<filename>.", annotations: RO_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { message_id: STR(""), attachment_id: STR(""), local_path: STR("Optional explicit path or directory.") }, required: ["message_id", "attachment_id"], additionalProperties: false } },
];

// HANDLERS populated incrementally in Tasks 9–14.
export const HANDLERS: Record<string, ToolHandler> = {};
