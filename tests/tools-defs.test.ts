import { describe, it, expect } from "vitest";
import { TOOLS } from "../src/tools.js";

const EXPECTED = [
  "gmail_scan_labels","gmail_sort_inbox","gmail_preview_sort","gmail_get_mappings",
  "gmail_list_labels","gmail_list_emails","gmail_read_email","gmail_search_emails",
  "gmail_move_emails","gmail_delete_emails","gmail_create_label","gmail_rename_label","gmail_delete_label",
  "gmail_mark_emails",
  "gmail_send_email","gmail_reply_email","gmail_forward_email",
  "gmail_create_draft","gmail_list_drafts","gmail_get_draft","gmail_update_draft","gmail_send_draft","gmail_delete_draft",
  "gmail_download_attachment",
].sort();

const READ_ONLY = new Set([
  "gmail_list_labels","gmail_list_emails","gmail_read_email","gmail_search_emails",
  "gmail_list_drafts","gmail_get_draft","gmail_get_mappings","gmail_preview_sort",
  "gmail_download_attachment",
]);
const DESTRUCTIVE = new Set([
  "gmail_send_email","gmail_send_draft","gmail_forward_email","gmail_reply_email",
  "gmail_delete_emails","gmail_delete_label",
]);

describe("TOOLS", () => {
  it("has exactly 24 tools with the expected names", () => {
    expect(TOOLS.map(t => t.name).sort()).toEqual(EXPECTED);
  });
  it("readOnlyHint matches §9.4 (9 tools)", () => {
    for (const t of TOOLS) {
      expect(t.annotations?.readOnlyHint ?? false).toBe(READ_ONLY.has(t.name));
    }
  });
  it("destructiveHint matches §9.4 (6 tools)", () => {
    for (const t of TOOLS) {
      expect(t.annotations?.destructiveHint ?? false).toBe(DESTRUCTIVE.has(t.name));
    }
  });
  it("every tool has a non-empty description", () => {
    for (const t of TOOLS) {
      expect((t.description ?? "").length).toBeGreaterThan(10);
    }
  });
  it("every tool has an object inputSchema", () => {
    for (const t of TOOLS) {
      expect((t.inputSchema as { type: string }).type).toBe("object");
    }
  });
});
