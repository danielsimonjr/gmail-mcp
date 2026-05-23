import { randomBytes } from "node:crypto";

export interface MessageOpts {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  inReplyTo?: string;
  references?: string;
  from?: string;
}

export interface Attachment {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface MultipartOpts extends MessageOpts {
  attachments: Attachment[];
}

export function base64urlEncode(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function commonHeaders(o: MessageOpts): string[] {
  const lines: string[] = [];
  lines.push(`To: ${o.to}`);
  if (o.from) lines.push(`From: ${o.from}`);
  if (o.cc) lines.push(`Cc: ${o.cc}`);
  lines.push(`Subject: ${o.subject}`);
  if (o.inReplyTo) lines.push(`In-Reply-To: ${o.inReplyTo}`);
  if (o.references) lines.push(`References: ${o.references}`);
  lines.push("MIME-Version: 1.0");
  return lines;
}

export function buildPlainMessage(o: MessageOpts): string {
  const headers = commonHeaders(o);
  headers.push("Content-Type: text/plain; charset=UTF-8");
  headers.push("Content-Transfer-Encoding: 8bit");
  const message = headers.join("\r\n") + "\r\n\r\n" + o.body;
  return base64urlEncode(message);
}

export function buildMultipartMessage(o: MultipartOpts): string {
  const boundary = `----=_boundary_${randomBytes(12).toString("hex")}`;
  const headers = commonHeaders(o);
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const parts: string[] = [];
  // Body part
  parts.push(`--${boundary}`);
  parts.push("Content-Type: text/plain; charset=UTF-8");
  parts.push("Content-Transfer-Encoding: 8bit");
  parts.push("");
  parts.push(o.body);
  parts.push("");
  // Attachment parts
  for (const att of o.attachments) {
    parts.push(`--${boundary}`);
    parts.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`);
    parts.push("Content-Transfer-Encoding: base64");
    parts.push(`Content-Disposition: attachment; filename="${att.filename}"`);
    parts.push("");
    // wrap base64 at 76 chars per RFC 2045
    const b64 = att.data.toString("base64");
    for (let i = 0; i < b64.length; i += 76) {
      parts.push(b64.substring(i, i + 76));
    }
    parts.push("");
  }
  parts.push(`--${boundary}--`);

  const message = headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n");
  return base64urlEncode(message);
}
