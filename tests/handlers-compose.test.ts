import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let mockGmail: ReturnType<typeof makeMockGmail>;
function makeMockGmail() {
  return {
    users: {
      getProfile: vi.fn().mockResolvedValue({ data: { emailAddress: "me@x.com" } }),
      messages: { send: vi.fn(), get: vi.fn() },
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

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "gmail-mcp-comp-")); mockGmail = makeMockGmail(); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); vi.resetModules(); });

function decodeRaw(call: { raw?: string }): string {
  return Buffer.from(call.raw!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

describe("gmail_send_email", () => {
  it("sends a plain-text email", async () => {
    mockGmail.users.messages.send.mockResolvedValue({ data: { id: "msg_new" } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_send_email({ to: "a@b.c", subject: "Hi", body: "Hello" }));
    expect(r).toEqual({ status: "ok", message_id: "msg_new" });
    const sent = mockGmail.users.messages.send.mock.calls[0][0].requestBody as { raw: string };
    expect(decodeRaw(sent)).toContain("To: a@b.c");
    expect(decodeRaw(sent)).toContain("Subject: Hi");
  });
  it("sends with attachments (multipart/mixed)", async () => {
    const path = join(tmp, "doc.txt");
    writeFileSync(path, "ATTACHMENT");
    mockGmail.users.messages.send.mockResolvedValue({ data: { id: "msg_att" } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_send_email({ to: "a@b.c", subject: "Hi", body: "see attached", attachments: [path] }));
    expect(r.status).toBe("ok");
    const sent = mockGmail.users.messages.send.mock.calls[0][0].requestBody as { raw: string };
    const decoded = decodeRaw(sent);
    expect(decoded).toContain("Content-Type: multipart/mixed");
    expect(decoded).toContain("filename=\"doc.txt\"");
  });
});

describe("gmail_reply_email", () => {
  it("preserves thread and constructs References chain", async () => {
    mockGmail.users.messages.get.mockResolvedValue({ data: {
      threadId: "thread_xyz",
      payload: { headers: [
        { name: "Subject", value: "Hi" },
        { name: "From", value: "Alice <alice@x.com>" },
        { name: "Message-ID", value: "<orig@x.com>" },
        { name: "References", value: "<old1@y.com> <old2@y.com>" },
      ] },
    } });
    mockGmail.users.messages.send.mockResolvedValue({ data: { id: "msg_reply", threadId: "thread_xyz" } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_reply_email({ message_id: "orig_id", body: "thx" }));
    expect(r).toEqual({ status: "ok", message_id: "msg_reply", thread_id: "thread_xyz" });
    const sent = mockGmail.users.messages.send.mock.calls[0][0] as { requestBody: { raw: string; threadId: string } };
    expect(sent.requestBody.threadId).toBe("thread_xyz");
    const decoded = decodeRaw(sent.requestBody);
    expect(decoded).toContain("In-Reply-To: <orig@x.com>");
    expect(decoded).toContain("References: <old1@y.com> <old2@y.com> <orig@x.com>");
    expect(decoded).toContain("Subject: Re: Hi");
  });
  it("auto-prefixes 'Re: ' only if missing", async () => {
    mockGmail.users.messages.get.mockResolvedValue({ data: {
      threadId: "thread_a",
      payload: { headers: [{ name: "Subject", value: "Re: existing" }, { name: "From", value: "a@x.com" }, { name: "Message-ID", value: "<a@x.com>" }] },
    } });
    mockGmail.users.messages.send.mockResolvedValue({ data: { id: "m", threadId: "thread_a" } });
    const { HANDLERS } = await import("../src/tools.js");
    await HANDLERS.gmail_reply_email({ message_id: "x", body: "y" });
    const decoded = decodeRaw((mockGmail.users.messages.send.mock.calls[0][0] as { requestBody: { raw: string } }).requestBody);
    expect(decoded).toContain("Subject: Re: existing");  // not Re: Re:
  });
});

describe("gmail_forward_email", () => {
  it("constructs forwarded body and auto-prefixes Fwd:", async () => {
    function b64url(s: string) { return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
    mockGmail.users.messages.get.mockResolvedValue({ data: {
      payload: { mimeType: "text/plain", headers: [
        { name: "Subject", value: "Original" }, { name: "From", value: "Alice <alice@x.com>" },
      ], body: { data: b64url("original body") } },
    } });
    mockGmail.users.messages.send.mockResolvedValue({ data: { id: "msg_fwd" } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_forward_email({ message_id: "x", to: "c@d.e", body: "FYI" }));
    expect(r.status).toBe("ok");
    expect(r.forwarded_to).toBe("c@d.e");
    const decoded = decodeRaw((mockGmail.users.messages.send.mock.calls[0][0] as { requestBody: { raw: string } }).requestBody);
    expect(decoded).toContain("Subject: Fwd: Original");
    expect(decoded).toContain("---------- Forwarded message ----------");
    expect(decoded).toContain("From: Alice <alice@x.com>");
    expect(decoded).toContain("original body");
  });
});
