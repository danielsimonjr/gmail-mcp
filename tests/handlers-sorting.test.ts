import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let mockGmail: ReturnType<typeof makeMockGmail>;

function makeMockGmail() {
  return {
    users: {
      labels: { list: vi.fn(), get: vi.fn(), create: vi.fn() },
      messages: { list: vi.fn(), get: vi.fn(), modify: vi.fn() },
    },
  };
}

vi.mock("../src/client.js", async () => {
  return {
    getGmail: async () => mockGmail,
    withRetry: <T>(fn: () => Promise<T>) => fn(),
    wrap: async (_: string, fn: () => Promise<unknown>) => {
      try { return JSON.stringify(await fn()); }
      catch (err) { return JSON.stringify({ status: "error", error: (err as Error).message }); }
    },
  };
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gmail-mcp-h-"));
  process.env.GMAIL_MCP_CONFIG_DIR = tmp;
  delete process.env.GMAIL_MAP_FILE;
  mockGmail = makeMockGmail();
});

afterEach(() => {
  delete process.env.GMAIL_MCP_CONFIG_DIR;
  rmSync(tmp, { recursive: true, force: true });
  vi.resetModules();
});

describe("gmail_scan_labels", () => {
  it("scans non-excluded labels and updates sender_map", async () => {
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [{ id: "Label_1", name: "Work" }, { id: "INBOX", name: "INBOX" }] } });
    mockGmail.users.messages.list.mockResolvedValue({ data: { messages: [{ id: "m1" }] } });
    mockGmail.users.messages.get.mockResolvedValue({ data: { payload: { headers: [{ name: "From", value: "alice@example.com" }, { name: "Date", value: "Wed, 21 May 2026 10:30:00 +0000" }] } } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_scan_labels({}));
    expect(r.status).toBe("ok");
    expect(r.labels_scanned).toBe(1);  // INBOX excluded
    expect(r.total_senders).toBe(1);
    expect(r.new_or_updated).toBe(1);
  });
});

describe("gmail_sort_inbox", () => {
  it("returns error when sender_map is empty", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_sort_inbox({}));
    expect(r).toEqual({ status: "error", message: "No sender map. Run gmail_scan_labels first." });
  });
  it("moves inbox emails to mapped labels when map is populated", async () => {
    const { saveSenderMap } = await import("../src/state.js");
    await saveSenderMap({ "alice@example.com": { label: "Work", date: "Wed, 21 May 2026 10:30:00 +0000" } });
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [{ id: "L_W", name: "Work" }] } });
    mockGmail.users.messages.list.mockResolvedValue({ data: { messages: [{ id: "m1" }] } });
    mockGmail.users.messages.get.mockResolvedValue({ data: { payload: { headers: [{ name: "From", value: "alice@example.com" }, { name: "Subject", value: "Hi" }] } } });
    mockGmail.users.messages.modify.mockResolvedValue({ data: {} });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_sort_inbox({}));
    expect(r.status).toBe("ok");
    expect(r.moved).toBe(1);
  });
});

describe("gmail_preview_sort", () => {
  it("returns 'unknown' count and 'would_move' but does not mutate", async () => {
    const { saveSenderMap } = await import("../src/state.js");
    await saveSenderMap({ "alice@example.com": { label: "Work", date: "d" } });
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [{ id: "L_W", name: "Work" }] } });
    mockGmail.users.messages.list.mockResolvedValue({ data: { messages: [{ id: "m1" }, { id: "m2" }] } });
    mockGmail.users.messages.get
      .mockResolvedValueOnce({ data: { payload: { headers: [{ name: "From", value: "alice@example.com" }, { name: "Subject", value: "Known" }] } } })
      .mockResolvedValueOnce({ data: { payload: { headers: [{ name: "From", value: "bob@example.com" }, { name: "Subject", value: "Unknown" }] } } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_preview_sort({}));
    expect(r.status).toBe("ok");
    expect(r.total_inbox).toBe(2);
    expect(r.would_move).toBe(1);
    expect(r.unknown).toBe(1);
    expect(mockGmail.users.messages.modify).not.toHaveBeenCalled();
  });
});

describe("gmail_get_mappings", () => {
  it("returns full map by default", async () => {
    const { saveSenderMap } = await import("../src/state.js");
    await saveSenderMap({ "a@x.com": { label: "Work", date: "d" }, "b@x.com": { label: "News", date: "d" } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_get_mappings({}));
    expect(r.status).toBe("ok");
    expect(r.total_senders).toBe(2);
    expect(r.label_summary).toEqual({ Work: 1, News: 1 });
  });
  it("filters by label (case-insensitive)", async () => {
    const { saveSenderMap } = await import("../src/state.js");
    await saveSenderMap({ "a@x.com": { label: "Work", date: "d" }, "b@x.com": { label: "News", date: "d" } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_get_mappings({ label_filter: "work" }));
    expect(r.total_senders).toBe(2);
    expect(r.results_shown).toBe(1);
  });
});
