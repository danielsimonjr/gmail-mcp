import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getGmail, withRetry, wrap } from "./client.js";
import { withSenderMap, loadSenderMap, senderMapFile, type SenderMap } from "./state.js";
import { extractHeader, extractSenderEmail, decodeBody } from "./format.js";
import { extractAttachments } from "./attachments.js";

export type ToolHandler = (raw: unknown) => Promise<string>;

const EXCLUDED_LABELS = new Set([
  "INBOX", "SPAM", "TRASH", "DRAFT", "SENT",
  "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS", "CATEGORY_PERSONAL",
  "STARRED", "IMPORTANT", "UNREAD",
]);

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
export const HANDLERS: Record<string, ToolHandler> = {
  async gmail_scan_labels(raw) {
    z.object({}).passthrough().parse(raw);
    return wrap("gmail_scan_labels", async () => {
      const gmail = await getGmail();
      const labelsRes = await withRetry(() => gmail.users.labels.list({ userId: "me" }));
      const labels = (labelsRes.data.labels ?? []).filter(
        (l) => !EXCLUDED_LABELS.has(l.name ?? "") && !EXCLUDED_LABELS.has(l.id ?? ""),
      );
      let labelsScanned = 0;
      let newOrUpdated = 0;
      const newMap = await withSenderMap(async (m) => {
        for (const label of labels) {
          if (!label.id) continue;
          labelsScanned++;
          const msgList = await withRetry(() =>
            gmail.users.messages.list({ userId: "me", labelIds: [label.id!], maxResults: 100 }),
          );
          for (const ref of msgList.data.messages ?? []) {
            if (!ref.id) continue;
            const msg = await withRetry(() =>
              gmail.users.messages.get({
                userId: "me",
                id: ref.id!,
                format: "metadata",
                metadataHeaders: ["From", "Date"],
              }),
            );
            const headers = msg.data.payload?.headers ?? [];
            const sender = extractSenderEmail(extractHeader(headers, "From"));
            if (!sender) continue;
            const date = extractHeader(headers, "Date");
            const existing = m[sender];
            if (!existing || existing.label !== label.name) {
              m[sender] = { label: label.name ?? label.id, date };
              newOrUpdated++;
            }
          }
        }
        return m;
      });
      return {
        status: "ok",
        labels_scanned: labelsScanned,
        total_senders: Object.keys(newMap).length,
        new_or_updated: newOrUpdated,
        map_file: senderMapFile(),
      };
    });
  },

  async gmail_sort_inbox(raw) {
    z.object({}).passthrough().parse(raw);
    return wrap("gmail_sort_inbox", async () => {
      const map = await loadSenderMap();
      if (Object.keys(map).length === 0)
        return { status: "error", message: "No sender map. Run gmail_scan_labels first." };
      const gmail = await getGmail();
      const labelsRes = await withRetry(() => gmail.users.labels.list({ userId: "me" }));
      const labelByName: Record<string, string> = {};
      for (const l of labelsRes.data.labels ?? []) {
        if (l.name && l.id) labelByName[l.name] = l.id;
      }
      const inboxList = await withRetry(() =>
        gmail.users.messages.list({ userId: "me", labelIds: ["INBOX"], maxResults: 500 }),
      );
      const details: Array<{ subject: string; sender: string; label: string }> = [];
      let moved = 0;
      for (const ref of inboxList.data.messages ?? []) {
        if (!ref.id) continue;
        const msg = await withRetry(() =>
          gmail.users.messages.get({
            userId: "me",
            id: ref.id!,
            format: "metadata",
            metadataHeaders: ["From", "Subject"],
          }),
        );
        const headers = msg.data.payload?.headers ?? [];
        const sender = extractSenderEmail(extractHeader(headers, "From"));
        const subject = extractHeader(headers, "Subject");
        const targetLabel = map[sender]?.label;
        const targetId = targetLabel ? labelByName[targetLabel] : undefined;
        if (targetId) {
          await withRetry(() =>
            gmail.users.messages.modify({
              userId: "me",
              id: ref.id!,
              requestBody: { addLabelIds: [targetId], removeLabelIds: ["INBOX"] },
            }),
          );
          if (details.length < 50) details.push({ subject, sender, label: targetLabel! });
          moved++;
        }
      }
      return { status: "ok", moved, details };
    });
  },

  async gmail_preview_sort(raw) {
    z.object({}).passthrough().parse(raw);
    return wrap("gmail_preview_sort", async () => {
      const map = await loadSenderMap();
      if (Object.keys(map).length === 0)
        return { status: "error", message: "No sender map. Run gmail_scan_labels first." };
      const gmail = await getGmail();
      const inboxList = await withRetry(() =>
        gmail.users.messages.list({ userId: "me", labelIds: ["INBOX"], maxResults: 500 }),
      );
      const moveDetails: Array<{ subject: string; sender: string; label: string }> = [];
      const unknownDetails: Array<{ subject: string; sender: string }> = [];
      let wouldMove = 0;
      let unknown = 0;
      let total = 0;
      for (const ref of inboxList.data.messages ?? []) {
        if (!ref.id) continue;
        total++;
        const msg = await withRetry(() =>
          gmail.users.messages.get({
            userId: "me",
            id: ref.id!,
            format: "metadata",
            metadataHeaders: ["From", "Subject"],
          }),
        );
        const headers = msg.data.payload?.headers ?? [];
        const sender = extractSenderEmail(extractHeader(headers, "From"));
        const subject = extractHeader(headers, "Subject");
        const label = map[sender]?.label;
        if (label) {
          wouldMove++;
          if (moveDetails.length < 50) moveDetails.push({ subject, sender, label });
        } else {
          unknown++;
          if (unknownDetails.length < 20) unknownDetails.push({ subject, sender });
        }
      }
      return {
        status: "ok",
        total_inbox: total,
        would_move: wouldMove,
        unknown,
        move_details: moveDetails,
        unknown_details: unknownDetails,
      };
    });
  },

  async gmail_get_mappings(raw) {
    const { label_filter, limit } = z
      .object({ label_filter: z.string().nullish(), limit: z.number().default(200) })
      .parse(raw);
    return wrap("gmail_get_mappings", async () => {
      const map = await loadSenderMap();
      const filtered: SenderMap = {};
      const labelSummary: Record<string, number> = {};
      const filterLower = label_filter?.toLowerCase();
      let shown = 0;
      for (const [sender, entry] of Object.entries(map)) {
        labelSummary[entry.label] = (labelSummary[entry.label] ?? 0) + 1;
        if (filterLower && !entry.label.toLowerCase().includes(filterLower)) continue;
        if (shown < limit) {
          filtered[sender] = entry;
          shown++;
        }
      }
      return {
        status: "ok",
        total_senders: Object.keys(map).length,
        results_shown: Object.keys(filtered).length,
        map_file: senderMapFile(),
        mappings: filtered,
        label_summary: labelSummary,
      };
    });
  },

  async gmail_list_labels(raw) {
    z.object({}).passthrough().parse(raw);
    return wrap("gmail_list_labels", async () => {
      const gmail = await getGmail();
      const res = await withRetry(() => gmail.users.labels.list({ userId: "me" }));
      const labels = (res.data.labels ?? [])
        .map((l) => ({ name: l.name ?? "", id: l.id ?? "", type: l.type ?? "user", total: l.messagesTotal ?? 0, unread: l.messagesUnread ?? 0 }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { status: "ok", labels };
    });
  },

  async gmail_list_emails(raw) {
    const { label, limit, unread_only, page_token } = z.object({
      label: z.string().default("INBOX"),
      limit: z.number().default(20),
      unread_only: z.boolean().default(false),
      page_token: z.string().nullish(),
    }).parse(raw);
    return wrap("gmail_list_emails", async () => {
      const gmail = await getGmail();
      // Resolve label name → ID
      const labelsRes = await withRetry(() => gmail.users.labels.list({ userId: "me" }));
      const labelByName: Record<string, string> = {};
      for (const l of (labelsRes.data.labels ?? [])) if (l.name && l.id) labelByName[l.name] = l.id;
      const labelId = labelByName[label] ?? label;
      const listRes = await withRetry(() => gmail.users.messages.list({
        userId: "me",
        labelIds: [labelId],
        maxResults: limit,
        ...(unread_only ? { q: "is:unread" } : {}),
        ...(page_token ? { pageToken: page_token } : {}),
      }));
      const emails = await Promise.all(
        (listRes.data.messages ?? []).map(async (ref) => {
          const msg = await withRetry(() => gmail.users.messages.get({ userId: "me", id: ref.id!, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] }));
          const h = msg.data.payload?.headers ?? [];
          return { id: msg.data.id!, sender: extractHeader(h, "From"), subject: extractHeader(h, "Subject"), date: extractHeader(h, "Date"), snippet: msg.data.snippet ?? "" };
        }),
      );
      return { status: "ok", label, count: emails.length, emails, ...(listRes.data.nextPageToken ? { next_page_token: listRes.data.nextPageToken } : {}) };
    });
  },

  async gmail_read_email(raw) {
    const { message_id } = z.object({ message_id: z.string() }).parse(raw);
    return wrap("gmail_read_email", async () => {
      const gmail = await getGmail();
      const msg = await withRetry(() => gmail.users.messages.get({ userId: "me", id: message_id, format: "full" }));
      const h = msg.data.payload?.headers ?? [];
      const attachments = extractAttachments(msg.data.payload ?? undefined);
      const body = decodeBody(msg.data.payload ?? undefined).slice(0, 10000);
      return {
        status: "ok",
        id: msg.data.id!,
        from: extractHeader(h, "From"),
        to: extractHeader(h, "To"),
        subject: extractHeader(h, "Subject"),
        date: extractHeader(h, "Date"),
        body,
        labels: msg.data.labelIds ?? [],
        ...(attachments.length > 0 ? { attachments } : {}),
      };
    });
  },

  async gmail_search_emails(raw) {
    const { query, limit, page_token } = z.object({
      query: z.string(),
      limit: z.number().default(20),
      page_token: z.string().nullish(),
    }).parse(raw);
    return wrap("gmail_search_emails", async () => {
      const gmail = await getGmail();
      const listRes = await withRetry(() => gmail.users.messages.list({
        userId: "me", q: query, maxResults: limit,
        ...(page_token ? { pageToken: page_token } : {}),
      }));
      const emails = await Promise.all(
        (listRes.data.messages ?? []).map(async (ref) => {
          const msg = await withRetry(() => gmail.users.messages.get({ userId: "me", id: ref.id!, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] }));
          const h = msg.data.payload?.headers ?? [];
          return { id: msg.data.id!, sender: extractHeader(h, "From"), subject: extractHeader(h, "Subject"), date: extractHeader(h, "Date"), snippet: msg.data.snippet ?? "" };
        }),
      );
      return { status: "ok", query, count: emails.length, emails, ...(listRes.data.nextPageToken ? { next_page_token: listRes.data.nextPageToken } : {}) };
    });
  },
};
