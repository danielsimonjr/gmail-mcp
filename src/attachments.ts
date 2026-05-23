import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { gmail_v1 } from "googleapis";

export interface AttachmentMeta {
  filename: string;
  mime_type: string;
  size: number;
  attachment_id: string;
}

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".html": "text/html",
  ".json": "application/json",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function extractAttachments(payload: gmail_v1.Schema$MessagePart | undefined): AttachmentMeta[] {
  if (!payload) return [];
  const out: AttachmentMeta[] = [];
  function walk(part: gmail_v1.Schema$MessagePart) {
    if (part.body?.attachmentId) {
      const filename = part.filename || `unnamed.${(part.mimeType ?? "").split("/")[1] || "bin"}`;
      out.push({
        filename,
        mime_type: part.mimeType ?? "application/octet-stream",
        size: part.body.size ?? 0,
        attachment_id: part.body.attachmentId,
      });
    }
    if (part.parts) for (const p of part.parts) walk(p);
  }
  walk(payload);
  return out;
}

export function attachmentToBuffer(b64url: string): Buffer {
  return Buffer.from(b64url.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export interface LocalAttachment {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export function readLocalAttachment(path: string): LocalAttachment {
  const data = readFileSync(path);
  const filename = basename(path);
  const ext = extname(path).toLowerCase();
  const mimeType = MIME_BY_EXT[ext] ?? "application/octet-stream";
  return { filename, mimeType, data };
}
