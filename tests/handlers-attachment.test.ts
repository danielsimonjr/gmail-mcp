import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let mockGmail: ReturnType<typeof makeMockGmail>;
function makeMockGmail() {
  return { users: { messages: { get: vi.fn(), attachments: { get: vi.fn() } } } };
}
vi.mock("../src/client.js", () => ({
  getGmail: async () => mockGmail,
  withRetry: <T>(fn: () => Promise<T>) => fn(),
  wrap: async (_: string, fn: () => Promise<unknown>) => {
    try { return JSON.stringify(await fn()); }
    catch (err) { return JSON.stringify({ status: "error", error: (err as Error).message }); }
  },
}));

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "gmail-mcp-att-")); mockGmail = makeMockGmail(); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); vi.resetModules(); });

function b64url(s: string) {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("gmail_download_attachment", () => {
  it("downloads to an explicit file path", async () => {
    mockGmail.users.messages.get.mockResolvedValue({ data: { payload: { parts: [
      { mimeType: "application/pdf", filename: "report.pdf", body: { attachmentId: "ATT_1", size: 12 } },
    ] } } });
    mockGmail.users.messages.attachments.get.mockResolvedValue({ data: { data: b64url("PDFDATA12345"), size: 12 } });
    const dest = join(tmp, "got.pdf");
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_download_attachment({ message_id: "m1", attachment_id: "ATT_1", local_path: dest }));
    expect(r.status).toBe("ok");
    expect(r.local_path).toBe(dest);
    expect(readFileSync(dest, "utf8")).toBe("PDFDATA12345");
    expect(r.size).toBe(12);
  });
  it("accepts a directory path and infers filename from message metadata", async () => {
    mockGmail.users.messages.get.mockResolvedValue({ data: { payload: { parts: [
      { mimeType: "image/png", filename: "logo.png", body: { attachmentId: "ATT_2", size: 5 } },
    ] } } });
    mockGmail.users.messages.attachments.get.mockResolvedValue({ data: { data: b64url("PNG.."), size: 5 } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_download_attachment({ message_id: "m1", attachment_id: "ATT_2", local_path: tmp }));
    expect(r.status).toBe("ok");
    expect(r.local_path).toBe(join(tmp, "logo.png"));
    expect(existsSync(r.local_path)).toBe(true);
  });
});

describe("smoke test now passes (TOOLS↔HANDLERS symmetry)", () => {
  it("has 24 tools and 24 handlers", async () => {
    const { TOOLS, HANDLERS } = await import("../src/tools.js");
    expect(Object.keys(HANDLERS).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    expect(TOOLS.length).toBe(24);
  });
});
