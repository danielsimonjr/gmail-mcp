import { describe, it, expect } from "vitest";
import { extractHeader, extractSenderEmail, decodeBody } from "../src/format.js";
import type { gmail_v1 } from "googleapis";

const H = (n: string, v: string) => ({ name: n, value: v });

describe("extractHeader", () => {
  it("case-insensitive lookup", () => {
    const headers = [H("Subject", "Hi"), H("From", "a@b.c")];
    expect(extractHeader(headers, "subject")).toBe("Hi");
    expect(extractHeader(headers, "SUBJECT")).toBe("Hi");
    expect(extractHeader(headers, "From")).toBe("a@b.c");
  });
  it("returns empty string when missing", () => {
    expect(extractHeader([], "Subject")).toBe("");
    expect(extractHeader([H("X", "y")], "Subject")).toBe("");
  });
});

describe("extractSenderEmail", () => {
  it("parses 'Name <email>' form", () => {
    expect(extractSenderEmail("Alice <alice@example.com>")).toBe("alice@example.com");
  });
  it("parses bare email form", () => {
    expect(extractSenderEmail("bob@example.com")).toBe("bob@example.com");
  });
  it("lowercases", () => {
    expect(extractSenderEmail("CHARLIE@EXAMPLE.COM")).toBe("charlie@example.com");
  });
  it("returns empty string on empty input", () => {
    expect(extractSenderEmail("")).toBe("");
  });
});

describe("decodeBody", () => {
  function b64url(s: string): string {
    return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  it("decodes single text/plain body", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "text/plain",
      body: { data: b64url("Hello, world!") },
    };
    expect(decodeBody(payload)).toBe("Hello, world!");
  });
  it("prefers text/plain over text/html in multipart/alternative", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: b64url("<p>html</p>") } },
        { mimeType: "text/plain", body: { data: b64url("plain") } },
      ],
    };
    expect(decodeBody(payload)).toBe("plain");
  });
  it("falls back to text/html if no text/plain", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/alternative",
      parts: [{ mimeType: "text/html", body: { data: b64url("<p>html</p>") } }],
    };
    expect(decodeBody(payload)).toBe("<p>html</p>");
  });
  it("recurses nested multipart", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [{ mimeType: "text/plain", body: { data: b64url("nested!") } }],
        },
      ],
    };
    expect(decodeBody(payload)).toBe("nested!");
  });
  it("returns empty string when no body found", () => {
    expect(decodeBody({ mimeType: "text/plain", body: {} })).toBe("");
    expect(decodeBody({})).toBe("");
  });
  it("handles base64url decode of UTF-8 (emoji)", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "text/plain",
      body: { data: b64url("Hello 🌍 world") },
    };
    expect(decodeBody(payload)).toBe("Hello 🌍 world");
  });
});
