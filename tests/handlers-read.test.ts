import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let mockGmail: ReturnType<typeof makeMockGmail>;
function makeMockGmail() {
  return {
    users: {
      labels: { list: vi.fn() },
      messages: { list: vi.fn(), get: vi.fn() },
      drafts: { list: vi.fn() },
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
afterEach(() => { vi.resetModules(); });

describe("gmail_list_labels", () => {
  it("returns sorted labels with totals", async () => {
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [
      { id: "INBOX", name: "INBOX", type: "system", messagesTotal: 50, messagesUnread: 5 },
      { id: "Work", name: "Work", type: "user", messagesTotal: 10, messagesUnread: 2 },
    ] } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_list_labels({}));
    expect(r.status).toBe("ok");
    expect(r.labels.length).toBe(2);
    // Sorted alphabetically by name
    expect(r.labels[0].name).toBe("INBOX");
  });
});

describe("gmail_list_emails", () => {
  it("returns emails with id, sender, subject, date, snippet", async () => {
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [{ id: "INBOX", name: "INBOX" }] } });
    mockGmail.users.messages.list.mockResolvedValue({ data: { messages: [{ id: "m1" }] } });
    mockGmail.users.messages.get.mockResolvedValue({ data: { id: "m1", snippet: "Hi there...", payload: { headers: [
      { name: "From", value: "Alice <alice@x.com>" }, { name: "Subject", value: "Hi" }, { name: "Date", value: "Wed, 21 May 2026 10:30:00 +0000" },
    ] } } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_list_emails({ label: "INBOX", limit: 20 }));
    expect(r.status).toBe("ok");
    expect(r.label).toBe("INBOX");
    expect(r.count).toBe(1);
    expect(r.emails[0]).toMatchObject({ id: "m1", sender: "Alice <alice@x.com>", subject: "Hi", date: "Wed, 21 May 2026 10:30:00 +0000", snippet: "Hi there..." });
  });
  it("surfaces next_page_token when present", async () => {
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [] } });
    mockGmail.users.messages.list.mockResolvedValue({ data: { messages: [], nextPageToken: "TOKEN_NEXT" } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_list_emails({ label: "INBOX" }));
    expect(r.next_page_token).toBe("TOKEN_NEXT");
  });
  it("uses unread_only via q='is:unread'", async () => {
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [] } });
    mockGmail.users.messages.list.mockResolvedValue({ data: { messages: [] } });
    const { HANDLERS } = await import("../src/tools.js");
    await HANDLERS.gmail_list_emails({ label: "INBOX", unread_only: true });
    expect(mockGmail.users.messages.list).toHaveBeenCalledWith(expect.objectContaining({ q: "is:unread" }));
  });
});

describe("gmail_read_email", () => {
  it("returns id, from, to, subject, date, body, labels, attachments", async () => {
    function b64url(s: string) { return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
    mockGmail.users.messages.get.mockResolvedValue({ data: {
      id: "m1", labelIds: ["INBOX", "Work"],
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "Alice <alice@x.com>" }, { name: "To", value: "you@x.com" },
          { name: "Subject", value: "Hi" }, { name: "Date", value: "Wed, 21 May 2026 10:30:00 +0000" },
        ],
        parts: [
          { mimeType: "text/plain", body: { data: b64url("Hello!") } },
          { mimeType: "application/pdf", filename: "doc.pdf", body: { attachmentId: "ATT_1", size: 1234 } },
        ],
      },
    } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_read_email({ message_id: "m1" }));
    expect(r.id).toBe("m1");
    expect(r.from).toBe("Alice <alice@x.com>");
    expect(r.subject).toBe("Hi");
    expect(r.body).toBe("Hello!");
    expect(r.labels).toEqual(["INBOX", "Work"]);
    expect(r.attachments).toEqual([{ filename: "doc.pdf", mime_type: "application/pdf", size: 1234, attachment_id: "ATT_1" }]);
  });
  it("omits attachments field when message has none", async () => {
    function b64url(s: string) { return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
    mockGmail.users.messages.get.mockResolvedValue({ data: {
      id: "m1", labelIds: [],
      payload: { mimeType: "text/plain", headers: [], body: { data: b64url("plain body") } },
    } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_read_email({ message_id: "m1" }));
    expect("attachments" in r).toBe(false);
  });
});

describe("gmail_search_emails", () => {
  it("passes the query through and surfaces next_page_token", async () => {
    mockGmail.users.messages.list.mockResolvedValue({ data: { messages: [{ id: "m1" }], nextPageToken: "T" } });
    mockGmail.users.messages.get.mockResolvedValue({ data: { id: "m1", snippet: "...", payload: { headers: [{ name: "From", value: "a@x.com" }] } } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_search_emails({ query: "from:alice", limit: 5 }));
    expect(r.query).toBe("from:alice");
    expect(r.count).toBe(1);
    expect(r.next_page_token).toBe("T");
    expect(mockGmail.users.messages.list).toHaveBeenCalledWith(expect.objectContaining({ q: "from:alice" }));
  });
});
