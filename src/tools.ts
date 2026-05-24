import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getGmail, withRetry, wrap } from "./client.js";
import { withSenderMap, loadSenderMap, senderMapFile, type SenderMap } from "./state.js";
import { extractHeader, extractSenderEmail, decodeBody } from "./format.js";
import { extractAttachments, readLocalAttachment } from "./attachments.js";
import { buildPlainMessage, buildMultipartMessage } from "./mime.js";

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

// Shared helpers — also used by Task 13 (draft handlers).
function buildMessage(opts: {
  to: string; subject: string; body: string; cc?: string;
  inReplyTo?: string; references?: string; from?: string;
  attachments?: string[];
}): string {
  if (opts.attachments && opts.attachments.length > 0) {
    return buildMultipartMessage({
      ...opts,
      attachments: opts.attachments.map(readLocalAttachment),
    });
  }
  return buildPlainMessage(opts);
}

function buildReferencesChain(origReferences: string, origMessageId: string): string {
  const trimmed = origReferences.trim();
  return trimmed ? `${trimmed} ${origMessageId}` : origMessageId;
}

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

  async gmail_move_emails(raw) {
    const { message_ids, label } = z.object({ message_ids: z.array(z.string()), label: z.string() }).parse(raw);
    return wrap("gmail_move_emails", async () => {
      const gmail = await getGmail();
      const labelsRes = await withRetry(() => gmail.users.labels.list({ userId: "me" }));
      const labelByName: Record<string, string> = {};
      for (const l of (labelsRes.data.labels ?? [])) if (l.name && l.id) labelByName[l.name] = l.id;
      const targetId = labelByName[label] ?? label;
      for (const id of message_ids) {
        await withRetry(() => gmail.users.messages.modify({ userId: "me", id, requestBody: { addLabelIds: [targetId], removeLabelIds: ["INBOX"] } }));
      }
      return { status: "ok", moved: message_ids.length, target_label: label };
    });
  },

  async gmail_delete_emails(raw) {
    const { message_ids, permanent } = z.object({ message_ids: z.array(z.string()), permanent: z.boolean().default(false) }).parse(raw);
    return wrap("gmail_delete_emails", async () => {
      const gmail = await getGmail();
      if (permanent) {
        // Batch in one API call
        await withRetry(() => gmail.users.messages.batchDelete({ userId: "me", requestBody: { ids: message_ids } }));
      } else {
        for (const id of message_ids) {
          await withRetry(() => gmail.users.messages.trash({ userId: "me", id }));
        }
      }
      return { status: "ok", deleted: message_ids.length, permanent };
    });
  },

  async gmail_create_label(raw) {
    const { name } = z.object({ name: z.string() }).parse(raw);
    return wrap("gmail_create_label", async () => {
      const gmail = await getGmail();
      const res = await withRetry(() => gmail.users.labels.create({ userId: "me", requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" } }));
      return { status: "ok", label: res.data.name ?? name, id: res.data.id ?? "" };
    });
  },

  async gmail_rename_label(raw) {
    const { old_name, new_name } = z.object({ old_name: z.string(), new_name: z.string() }).parse(raw);
    return wrap("gmail_rename_label", async () => {
      const gmail = await getGmail();
      const labelsRes = await withRetry(() => gmail.users.labels.list({ userId: "me" }));
      const match = (labelsRes.data.labels ?? []).find((l) => l.name === old_name);
      if (!match?.id) return { status: "error", message: `Label '${old_name}' not found` };
      await withRetry(() => gmail.users.labels.update({ userId: "me", id: match.id!, requestBody: { id: match.id!, name: new_name } }));
      return { status: "ok", old_name, new_name };
    });
  },

  async gmail_delete_label(raw) {
    const { name } = z.object({ name: z.string() }).parse(raw);
    return wrap("gmail_delete_label", async () => {
      const gmail = await getGmail();
      const labelsRes = await withRetry(() => gmail.users.labels.list({ userId: "me" }));
      const match = (labelsRes.data.labels ?? []).find((l) => l.name === name);
      if (!match?.id) return { status: "error", message: `Label '${name}' not found` };
      await withRetry(() => gmail.users.labels.delete({ userId: "me", id: match.id! }));
      return { status: "ok", deleted: name };
    });
  },

  async gmail_mark_emails(raw) {
    const { message_ids, action } = z.object({ message_ids: z.array(z.string()), action: z.string() }).parse(raw);
    return wrap("gmail_mark_emails", async () => {
      const ops: Record<string, { addLabelIds?: string[]; removeLabelIds?: string[] }> = {
        read: { removeLabelIds: ["UNREAD"] },
        unread: { addLabelIds: ["UNREAD"] },
        star: { addLabelIds: ["STARRED"] },
        unstar: { removeLabelIds: ["STARRED"] },
      };
      const body = ops[action];
      if (!body) return { status: "error", message: `Unknown action: ${action}. Use: read, unread, star, unstar` };
      const gmail = await getGmail();
      for (const id of message_ids) {
        await withRetry(() => gmail.users.messages.modify({ userId: "me", id, requestBody: body }));
      }
      return { status: "ok", marked: message_ids.length, action };
    });
  },

  async gmail_send_email(raw) {
    const args = z.object({
      to: z.string(), subject: z.string(), body: z.string(),
      cc: z.string().nullish(), attachments: z.array(z.string()).nullish(),
    }).parse(raw);
    return wrap("gmail_send_email", async () => {
      const gmail = await getGmail();
      const message = buildMessage({
        to: args.to, subject: args.subject, body: args.body,
        cc: args.cc ?? undefined,
        attachments: args.attachments ?? undefined,
      });
      const res = await withRetry(() => gmail.users.messages.send({ userId: "me", requestBody: { raw: message } }));
      return { status: "ok", message_id: res.data.id ?? "" };
    });
  },

  async gmail_reply_email(raw) {
    const args = z.object({
      message_id: z.string(), body: z.string(),
      attachments: z.array(z.string()).nullish(),
    }).parse(raw);
    return wrap("gmail_reply_email", async () => {
      const gmail = await getGmail();
      const orig = await withRetry(() => gmail.users.messages.get({ userId: "me", id: args.message_id, format: "metadata", metadataHeaders: ["Subject", "From", "Message-ID", "References"] }));
      const h = orig.data.payload?.headers ?? [];
      const origSubject = extractHeader(h, "Subject");
      const origFrom = extractHeader(h, "From");
      const origMsgId = extractHeader(h, "Message-ID");
      const origRefs = extractHeader(h, "References");
      const subject = /^re:\s/i.test(origSubject) ? origSubject : `Re: ${origSubject}`;
      const message = buildMessage({
        to: origFrom,
        subject,
        body: args.body,
        inReplyTo: origMsgId,
        references: buildReferencesChain(origRefs, origMsgId),
        attachments: args.attachments ?? undefined,
      });
      const res = await withRetry(() => gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: message, threadId: orig.data.threadId ?? undefined },
      }));
      return { status: "ok", message_id: res.data.id ?? "", thread_id: res.data.threadId ?? orig.data.threadId ?? "" };
    });
  },

  async gmail_forward_email(raw) {
    const args = z.object({
      message_id: z.string(), to: z.string(),
      body: z.string().default(""),
      attachments: z.array(z.string()).nullish(),
    }).parse(raw);
    return wrap("gmail_forward_email", async () => {
      const gmail = await getGmail();
      const orig = await withRetry(() => gmail.users.messages.get({ userId: "me", id: args.message_id, format: "full" }));
      const h = orig.data.payload?.headers ?? [];
      const origSubject = extractHeader(h, "Subject");
      const origFrom = extractHeader(h, "From");
      const origBody = decodeBody(orig.data.payload ?? undefined);
      const subject = /^fwd:\s/i.test(origSubject) ? origSubject : `Fwd: ${origSubject}`;
      const forwardBody = `${args.body}\n\n---------- Forwarded message ----------\nFrom: ${origFrom}\nSubject: ${origSubject}\n\n${origBody}`;
      const message = buildMessage({
        to: args.to,
        subject,
        body: forwardBody,
        attachments: args.attachments ?? undefined,
      });
      const res = await withRetry(() => gmail.users.messages.send({ userId: "me", requestBody: { raw: message } }));
      return { status: "ok", message_id: res.data.id ?? "", forwarded_to: args.to };
    });
  },

  async gmail_create_draft(raw) {
    const args = z.object({
      to: z.string(), subject: z.string(), body: z.string(),
      cc: z.string().nullish(), in_reply_to: z.string().nullish(),
      attachments: z.array(z.string()).nullish(),
    }).parse(raw);
    return wrap("gmail_create_draft", async () => {
      const gmail = await getGmail();
      let threadId: string | undefined;
      let inReplyTo: string | undefined;
      let references: string | undefined;
      if (args.in_reply_to) {
        const orig = await withRetry(() => gmail.users.messages.get({ userId: "me", id: args.in_reply_to!, format: "metadata", metadataHeaders: ["Message-ID", "References"] }));
        const h = orig.data.payload?.headers ?? [];
        threadId = orig.data.threadId ?? undefined;
        inReplyTo = extractHeader(h, "Message-ID");
        references = buildReferencesChain(extractHeader(h, "References"), inReplyTo);
      }
      const message = buildMessage({
        to: args.to, subject: args.subject, body: args.body,
        cc: args.cc ?? undefined, inReplyTo, references,
        attachments: args.attachments ?? undefined,
      });
      const res = await withRetry(() => gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw: message, threadId } } }));
      return { status: "ok", draft_id: res.data.id ?? "", message_id: res.data.message?.id ?? "", thread_id: res.data.message?.threadId ?? "" };
    });
  },

  async gmail_list_drafts(raw) {
    const { limit, page_token } = z.object({ limit: z.number().default(20), page_token: z.string().nullish() }).parse(raw);
    return wrap("gmail_list_drafts", async () => {
      const gmail = await getGmail();
      const listRes = await withRetry(() => gmail.users.drafts.list({ userId: "me", maxResults: limit, ...(page_token ? { pageToken: page_token } : {}) }));
      const drafts = await Promise.all((listRes.data.drafts ?? []).map(async (d) => {
        const draft = await withRetry(() => gmail.users.drafts.get({ userId: "me", id: d.id!, format: "metadata" }));
        const headers = draft.data.message?.payload?.headers ?? [];
        return {
          draft_id: draft.data.id ?? "",
          message_id: draft.data.message?.id ?? "",
          thread_id: draft.data.message?.threadId ?? "",
          to: extractHeader(headers, "To"),
          subject: extractHeader(headers, "Subject"),
          snippet: draft.data.message?.snippet ?? "",
        };
      }));
      return { status: "ok", count: drafts.length, drafts, ...(listRes.data.nextPageToken ? { next_page_token: listRes.data.nextPageToken } : {}) };
    });
  },

  async gmail_get_draft(raw) {
    const { draft_id } = z.object({ draft_id: z.string() }).parse(raw);
    return wrap("gmail_get_draft", async () => {
      const gmail = await getGmail();
      const draft = await withRetry(() => gmail.users.drafts.get({ userId: "me", id: draft_id, format: "full" }));
      const headers = draft.data.message?.payload?.headers ?? [];
      const attachments = extractAttachments(draft.data.message?.payload ?? undefined);
      const body = decodeBody(draft.data.message?.payload ?? undefined);
      return {
        status: "ok",
        draft_id: draft.data.id ?? "",
        message_id: draft.data.message?.id ?? "",
        thread_id: draft.data.message?.threadId ?? "",
        to: extractHeader(headers, "To"),
        cc: extractHeader(headers, "Cc"),
        subject: extractHeader(headers, "Subject"),
        body,
        ...(attachments.length > 0 ? { attachments } : {}),
      };
    });
  },

  async gmail_update_draft(raw) {
    const args = z.object({
      draft_id: z.string(), to: z.string(), subject: z.string(), body: z.string(),
      cc: z.string().nullish(), attachments: z.array(z.string()).nullish(),
    }).parse(raw);
    return wrap("gmail_update_draft", async () => {
      const gmail = await getGmail();
      const existing = await withRetry(() => gmail.users.drafts.get({ userId: "me", id: args.draft_id, format: "full" }));
      const h = existing.data.message?.payload?.headers ?? [];
      const threadId = existing.data.message?.threadId ?? undefined;
      const inReplyTo = extractHeader(h, "In-Reply-To") || undefined;
      const references = extractHeader(h, "References") || undefined;
      const message = buildMessage({
        to: args.to, subject: args.subject, body: args.body,
        cc: args.cc ?? undefined, inReplyTo, references,
        attachments: args.attachments ?? undefined,
      });
      const res = await withRetry(() => gmail.users.drafts.update({ userId: "me", id: args.draft_id, requestBody: { message: { raw: message, threadId } } }));
      return { status: "ok", draft_id: args.draft_id, message_id: res.data.message?.id ?? "", thread_id: res.data.message?.threadId ?? threadId ?? "" };
    });
  },

  async gmail_send_draft(raw) {
    const { draft_id } = z.object({ draft_id: z.string() }).parse(raw);
    return wrap("gmail_send_draft", async () => {
      const gmail = await getGmail();
      const res = await withRetry(() => gmail.users.drafts.send({ userId: "me", requestBody: { id: draft_id } }));
      return { status: "ok", message_id: res.data.id ?? "", thread_id: res.data.threadId ?? "" };
    });
  },

  async gmail_delete_draft(raw) {
    const { draft_id } = z.object({ draft_id: z.string() }).parse(raw);
    return wrap("gmail_delete_draft", async () => {
      const gmail = await getGmail();
      await withRetry(() => gmail.users.drafts.delete({ userId: "me", id: draft_id }));
      return { status: "ok", draft_id, deleted: true };
    });
  },
};
