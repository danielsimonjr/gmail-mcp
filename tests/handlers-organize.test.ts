import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let mockGmail: ReturnType<typeof makeMockGmail>;
function makeMockGmail() {
  return {
    users: {
      labels: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
      messages: { modify: vi.fn(), trash: vi.fn(), delete: vi.fn(), batchDelete: vi.fn() },
    },
  };
}
vi.mock("../src/client.js", () => ({
  getGmail: async () => mockGmail,
  withRetry: <T>(fn: () => Promise<T>) => fn(),
  wrap: async (_: string, fn: () => Promise<unknown>) => {
    try { return JSON.stringify(await fn()); }
    catch (err) { return JSON.stringify({ status: "error", error: (err as Error).message }); }
  },
}));

beforeEach(() => { mockGmail = makeMockGmail(); });
afterEach(() => vi.resetModules());

describe("gmail_move_emails", () => {
  it("adds target label and removes INBOX for each ID", async () => {
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [{ id: "L_W", name: "Work" }] } });
    mockGmail.users.messages.modify.mockResolvedValue({ data: {} });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_move_emails({ message_ids: ["m1", "m2"], label: "Work" }));
    expect(r.status).toBe("ok");
    expect(r.moved).toBe(2);
    expect(r.target_label).toBe("Work");
    expect(mockGmail.users.messages.modify).toHaveBeenCalledTimes(2);
  });
});

describe("gmail_delete_emails", () => {
  it("trashes (not permanent) by default", async () => {
    mockGmail.users.messages.trash.mockResolvedValue({ data: {} });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_delete_emails({ message_ids: ["m1", "m2"] }));
    expect(r).toEqual({ status: "ok", deleted: 2, permanent: false });
    expect(mockGmail.users.messages.trash).toHaveBeenCalledTimes(2);
    expect(mockGmail.users.messages.batchDelete).not.toHaveBeenCalled();
  });
  it("uses batchDelete in ONE call when permanent=true", async () => {
    mockGmail.users.messages.batchDelete.mockResolvedValue({ data: {} });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_delete_emails({ message_ids: ["m1", "m2", "m3"], permanent: true }));
    expect(r).toEqual({ status: "ok", deleted: 3, permanent: true });
    expect(mockGmail.users.messages.batchDelete).toHaveBeenCalledTimes(1);
    expect(mockGmail.users.messages.batchDelete).toHaveBeenCalledWith({ userId: "me", requestBody: { ids: ["m1", "m2", "m3"] } });
    expect(mockGmail.users.messages.delete).not.toHaveBeenCalled();
  });
});

describe("gmail_create_label", () => {
  it("creates label with show visibility", async () => {
    mockGmail.users.labels.create.mockResolvedValue({ data: { id: "Label_42", name: "Foo" } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_create_label({ name: "Foo" }));
    expect(r).toEqual({ status: "ok", label: "Foo", id: "Label_42" });
  });
});

describe("gmail_rename_label", () => {
  it("renames an existing label", async () => {
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [{ id: "L1", name: "Old" }] } });
    mockGmail.users.labels.update.mockResolvedValue({ data: { id: "L1", name: "New" } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_rename_label({ old_name: "Old", new_name: "New" }));
    expect(r).toEqual({ status: "ok", old_name: "Old", new_name: "New" });
  });
  it("returns error if label not found", async () => {
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [] } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_rename_label({ old_name: "Nope", new_name: "X" }));
    expect(r).toEqual({ status: "error", message: "Label 'Nope' not found" });
  });
});

describe("gmail_delete_label", () => {
  it("deletes an existing label", async () => {
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [{ id: "L1", name: "DropMe" }] } });
    mockGmail.users.labels.delete.mockResolvedValue({ data: {} });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_delete_label({ name: "DropMe" }));
    expect(r).toEqual({ status: "ok", deleted: "DropMe" });
  });
});

describe("gmail_mark_emails", () => {
  it.each([
    ["read", { removeLabelIds: ["UNREAD"] }],
    ["unread", { addLabelIds: ["UNREAD"] }],
    ["star", { addLabelIds: ["STARRED"] }],
    ["unstar", { removeLabelIds: ["STARRED"] }],
  ])("action=%s applies the right label op", async (action, expectedBody) => {
    mockGmail.users.messages.modify.mockResolvedValue({ data: {} });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_mark_emails({ message_ids: ["m1"], action }));
    expect(r).toEqual({ status: "ok", marked: 1, action });
    expect(mockGmail.users.messages.modify).toHaveBeenCalledWith({ userId: "me", id: "m1", requestBody: expect.objectContaining(expectedBody) });
  });
  it("rejects unknown action", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_mark_emails({ message_ids: ["m1"], action: "foo" }));
    expect(r).toEqual({ status: "error", message: "Unknown action: foo. Use: read, unread, star, unstar" });
  });
});
