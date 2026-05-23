import type { gmail_v1 } from "googleapis";

export function extractHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  if (!headers) return "";
  const lower = name.toLowerCase();
  for (const h of headers) {
    if ((h.name ?? "").toLowerCase() === lower) return h.value ?? "";
  }
  return "";
}

export function extractSenderEmail(from: string): string {
  if (!from) return "";
  const match = /<([^>]+)>/.exec(from);
  return (match ? match[1] : from).trim().toLowerCase();
}

function b64urlDecode(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** Recursively extract message body, preferring text/plain over text/html. */
export function decodeBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  // Direct body on this part (text/* only — skip attachments)
  if (payload.body?.data) {
    const mime = (payload.mimeType ?? "").toLowerCase();
    if (mime.startsWith("text/")) return b64urlDecode(payload.body.data);
  }
  if (!payload.parts || payload.parts.length === 0) return "";
  // Prefer text/plain
  for (const p of payload.parts) {
    if ((p.mimeType ?? "").toLowerCase() === "text/plain" && p.body?.data) {
      return b64urlDecode(p.body.data);
    }
  }
  // Fall back to text/html
  for (const p of payload.parts) {
    if ((p.mimeType ?? "").toLowerCase() === "text/html" && p.body?.data) {
      return b64urlDecode(p.body.data);
    }
  }
  // Recurse into nested multipart
  for (const p of payload.parts) {
    if ((p.mimeType ?? "").toLowerCase().startsWith("multipart/")) {
      const sub = decodeBody(p);
      if (sub) return sub;
    }
  }
  return "";
}
