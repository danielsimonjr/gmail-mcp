import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let mockGmail: ReturnType<typeof makeMockGmail>;
function makeMockGmail() {
  return {
    users: {
      drafts: { create: vi.fn(), list: vi.fn(), get: vi.fn(), update: vi.fn(), send: vi.fn(), delete: vi.fn() },
      messages: { get: vi.fn() },
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

function decodeRaw(rb: { raw?: string }): string {
  return Buffer.from(rb.raw!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

describe("gmail_create_draft", () => {
  it("creates a non-threaded draft", async () => {
    mockGmail.users.drafts.create.mockResolvedValue({ data: { id: "draft_1", message: { id: "msg_1", threadId: "thread_1" } } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_create_draft({ to: "a@b.c", subject: "Hi", body: "Body" }));
    expect(r).toEqual({ status: "ok", draft_id: "draft_1", message_id: "msg_1", thread_id: "thread_1" });
  });
  it("threads when in_reply_to is set and includes References chain", async () => {
    mockGmail.users.messages.get.mockResolvedValue({ data: {
      threadId: "thread_orig",
      payload: { headers: [
        { name: "Message-ID", value: "<orig@x.com>" }, { name: "References", value: "<a@y.com>" },
      ] },
    } });
    mockGmail.users.drafts.create.mockResolvedValue({ data: { id: "draft_2", message: { id: "msg_2", threadId: "thread_orig" } } });
    const { HANDLERS } = await import("../src/tools.js");
    await HANDLERS.gmail_create_draft({ to: "x@y.com", subject: "Re: Hi", body: "thx", in_reply_to: "orig_id" });
    const sent = mockGmail.users.drafts.create.mock.calls[0][0].requestBody as { message: { raw: string; threadId: string } };
    expect(sent.message.threadId).toBe("thread_orig");
    const decoded = decodeRaw(sent.message);
    expect(decoded).toContain("In-Reply-To: <orig@x.com>");
    expect(decoded).toContain("References: <a@y.com> <orig@x.com>");
  });
});

describe("gmail_list_drafts", () => {
  it("returns drafts with snippet, threading, and surfaces next_page_token", async () => {
    mockGmail.users.drafts.list.mockResolvedValue({ data: { drafts: [{ id: "draft_1" }], nextPageToken: "TOK" } });
    mockGmail.users.drafts.get.mockResolvedValue({ data: {
      id: "draft_1", message: { id: "msg", threadId: "thr", snippet: "hi", payload: { headers: [
        { name: "To", value: "x@y.com" }, { name: "Subject", value: "Hello" },
      ] } },
    } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_list_drafts({ limit: 5 }));
    expect(r.count).toBe(1);
    expect(r.next_page_token).toBe("TOK");
    expect(r.drafts[0]).toMatchObject({ draft_id: "draft_1", message_id: "msg", thread_id: "thr", to: "x@y.com", subject: "Hello", snippet: "hi" });
  });
});

describe("gmail_get_draft", () => {
  it("returns full draft with body + attachments", async () => {
    function b64url(s: string) { return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
    mockGmail.users.drafts.get.mockResolvedValue({ data: {
      id: "draft_x", message: { id: "msg_x", threadId: "thr_x", payload: { mimeType: "text/plain", headers: [
        { name: "To", value: "a@b.c" }, { name: "Subject", value: "S" }, { name: "Cc", value: "c@d.e" },
      ], body: { data: b64url("body!") } } },
    } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_get_draft({ draft_id: "draft_x" }));
    expect(r).toMatchObject({ draft_id: "draft_x", message_id: "msg_x", thread_id: "thr_x", to: "a@b.c", cc: "c@d.e", subject: "S", body: "body!" });
  });
});

describe("gmail_update_draft", () => {
  it("preserves threadId and References from existing draft", async () => {
    mockGmail.users.drafts.get.mockResolvedValue({ data: {
      id: "draft_u", message: { threadId: "thr_u", payload: { headers: [
        { name: "In-Reply-To", value: "<a@x.com>" }, { name: "References", value: "<a@x.com>" },
      ] } },
    } });
    mockGmail.users.drafts.update.mockResolvedValue({ data: { id: "draft_u", message: { id: "msg_u", threadId: "thr_u" } } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_update_draft({ draft_id: "draft_u", to: "x@y.com", subject: "New", body: "B" }));
    expect(r).toMatchObject({ draft_id: "draft_u", message_id: "msg_u", thread_id: "thr_u" });
    const sent = mockGmail.users.drafts.update.mock.calls[0][0].requestBody as { message: { raw: string; threadId: string } };
    expect(sent.message.threadId).toBe("thr_u");
    const decoded = decodeRaw(sent.message);
    expect(decoded).toContain("In-Reply-To: <a@x.com>");
  });
});

describe("gmail_send_draft", () => {
  it("sends and returns message + thread ids", async () => {
    mockGmail.users.drafts.send.mockResolvedValue({ data: { id: "msg_final", threadId: "thr_final" } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_send_draft({ draft_id: "draft_1" }));
    expect(r).toEqual({ status: "ok", message_id: "msg_final", thread_id: "thr_final" });
  });
});

describe("gmail_delete_draft", () => {
  it("deletes the draft", async () => {
    mockGmail.users.drafts.delete.mockResolvedValue({ data: {} });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_delete_draft({ draft_id: "draft_x" }));
    expect(r).toEqual({ status: "ok", draft_id: "draft_x", deleted: true });
  });
});
