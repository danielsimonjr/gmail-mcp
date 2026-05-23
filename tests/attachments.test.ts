import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractAttachments, attachmentToBuffer, readLocalAttachment } from "../src/attachments.js";
import type { gmail_v1 } from "googleapis";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "gmail-mcp-att-")); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("extractAttachments", () => {
  it("returns [] when no attachments", () => {
    expect(extractAttachments({ mimeType: "text/plain", body: { data: "x" } })).toEqual([]);
  });
  it("extracts top-level attachment with filename + size", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: "x" } },
        { mimeType: "application/pdf", filename: "report.pdf", body: { attachmentId: "ATT_1", size: 12345 } },
      ],
    };
    const result = extractAttachments(payload);
    expect(result).toEqual([{ filename: "report.pdf", mime_type: "application/pdf", size: 12345, attachment_id: "ATT_1" }]);
  });
  it("recurses nested multipart", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [{ mimeType: "image/png", filename: "img.png", body: { attachmentId: "ATT_X", size: 999 } }],
        },
      ],
    };
    expect(extractAttachments(payload)).toEqual([{ filename: "img.png", mime_type: "image/png", size: 999, attachment_id: "ATT_X" }]);
  });
  it("falls back to 'unnamed.<ext>' when filename empty", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      parts: [{ mimeType: "image/jpeg", filename: "", body: { attachmentId: "A", size: 1 } }],
    };
    expect(extractAttachments(payload)[0].filename).toBe("unnamed.jpeg");
  });
});

describe("attachmentToBuffer", () => {
  it("decodes base64url data into a Buffer", () => {
    const buf = attachmentToBuffer("aGk");
    expect(buf.toString("utf8")).toBe("hi");
  });
});

describe("readLocalAttachment", () => {
  it("reads a file from disk and infers mime type from extension", () => {
    const p = join(tmp, "report.pdf");
    writeFileSync(p, "PDFDATA");
    const att = readLocalAttachment(p);
    expect(att.filename).toBe("report.pdf");
    expect(att.mimeType).toBe("application/pdf");
    expect(att.data.toString()).toBe("PDFDATA");
  });
  it("falls back to application/octet-stream for unknown extensions", () => {
    const p = join(tmp, "thing.xyz");
    writeFileSync(p, "data");
    expect(readLocalAttachment(p).mimeType).toBe("application/octet-stream");
  });
});
