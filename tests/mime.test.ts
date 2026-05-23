import { describe, it, expect } from "vitest";
import { buildPlainMessage, buildMultipartMessage, base64urlEncode } from "../src/mime.js";

describe("base64urlEncode", () => {
  it("encodes string to base64url (no padding)", () => {
    expect(base64urlEncode("Hello, world!")).toBe("SGVsbG8sIHdvcmxkIQ");
  });
  it("uses URL-safe characters (- and _)", () => {
    const input = Buffer.from([0xfb, 0xef, 0xff]).toString("utf8");
    const encoded = base64urlEncode(input);
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe("buildPlainMessage", () => {
  it("emits correct headers and body for minimal message", () => {
    const raw = buildPlainMessage({ to: "a@b.c", subject: "Hi", body: "Hello" });
    const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(decoded).toContain("To: a@b.c");
    expect(decoded).toContain("Subject: Hi");
    expect(decoded).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(decoded).toMatch(/\r\n\r\nHello$/);
  });
  it("includes CC when set", () => {
    const raw = buildPlainMessage({ to: "a@b.c", subject: "Hi", body: "h", cc: "c@d.e" });
    const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(decoded).toContain("Cc: c@d.e");
  });
  it("includes In-Reply-To and References when set", () => {
    const raw = buildPlainMessage({
      to: "a@b.c", subject: "Re: Hi", body: "thx",
      inReplyTo: "<orig@x.com>", references: "<orig@x.com>",
    });
    const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(decoded).toContain("In-Reply-To: <orig@x.com>");
    expect(decoded).toContain("References: <orig@x.com>");
  });
  it("uses CRLF line endings (RFC 5322)", () => {
    const raw = buildPlainMessage({ to: "a@b.c", subject: "Hi", body: "B" });
    const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(decoded.includes("\r\n")).toBe(true);
  });
});

describe("buildMultipartMessage", () => {
  it("builds a multipart/mixed with one attachment", () => {
    const raw = buildMultipartMessage({
      to: "a@b.c", subject: "Hi", body: "see attached",
      attachments: [{ filename: "test.txt", mimeType: "text/plain", data: Buffer.from("payload") }],
    });
    const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(decoded).toContain("Content-Type: multipart/mixed; boundary=");
    expect(decoded).toContain('filename="test.txt"');
    expect(decoded).toContain("Content-Disposition: attachment");
    expect(decoded).toContain(Buffer.from("payload").toString("base64"));
  });
  it("preserves threading headers", () => {
    const raw = buildMultipartMessage({
      to: "a@b.c", subject: "Re: Hi", body: "thx",
      attachments: [{ filename: "x.txt", mimeType: "text/plain", data: Buffer.from("x") }],
      inReplyTo: "<orig@x.com>", references: "<old@y.com> <orig@x.com>",
    });
    const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(decoded).toContain("In-Reply-To: <orig@x.com>");
    expect(decoded).toContain("References: <old@y.com> <orig@x.com>");
  });
});
