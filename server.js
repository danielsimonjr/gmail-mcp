#!/usr/bin/env node
/**
 * Gmail MCP Server
 *
 * Wraps the Google Workspace CLI (gws) as an MCP server,
 * providing Gmail tools for Claude Code.
 *
 * Prerequisites: gws installed and authenticated (gws auth login -s gmail)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const GWS_PATH = process.env.GWS_PATH || "gws";

async function runGws(args) {
  try {
    const { stdout, stderr } = await execFileAsync(GWS_PATH, args, {
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 5,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return stdout.trim();
  } catch (err) {
    if (err.stdout) return err.stdout.trim();
    throw new Error(`gws error: ${err.message}`);
  }
}

async function runGwsJson(args) {
  const output = await runGws(args);
  try {
    return JSON.parse(output);
  } catch {
    return { raw: output };
  }
}

const server = new McpServer({
  name: "gmail-mcp",
  version: "1.0.0",
});

// --- Tools ---

server.tool(
  "gmail_triage",
  "Show unread inbox messages with sender, subject, and date",
  {},
  async () => {
    const result = await runGws(["gmail", "+triage"]);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "gmail_send",
  "Send an email",
  {
    to: z.string().describe("Recipient email address"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Email body text"),
    cc: z.string().optional().describe("CC recipients (comma-separated)"),
  },
  async ({ to, subject, body, cc }) => {
    const args = ["gmail", "+send", "--to", to, "--subject", subject, "--body", body];
    if (cc) args.push("--cc", cc);
    const result = await runGws(args);
    return { content: [{ type: "text", text: `Email sent.\n${result}` }] };
  }
);

server.tool(
  "gmail_read",
  "Read a specific email by message ID",
  {
    messageId: z.string().describe("Gmail message ID"),
  },
  async ({ messageId }) => {
    const result = await runGwsJson([
      "gmail", "users", "messages", "get",
      "--params", JSON.stringify({ userId: "me", id: messageId, format: "full" }),
    ]);
    // Extract useful info
    const headers = {};
    if (result.payload && result.payload.headers) {
      for (const h of result.payload.headers) {
        headers[h.name] = h.value;
      }
    }
    const output = [
      `From: ${headers.From || "?"}`,
      `To: ${headers.To || "?"}`,
      `Subject: ${headers.Subject || "?"}`,
      `Date: ${headers.Date || "?"}`,
      "",
      result.snippet || "(no preview)",
    ].join("\n");
    return { content: [{ type: "text", text: output }] };
  }
);

server.tool(
  "gmail_search",
  "Search emails using Gmail query syntax",
  {
    query: z.string().describe("Gmail search query (e.g., 'from:editor@journal.com', 'subject:book proposal', 'is:unread')"),
    maxResults: z.number().optional().default(10).describe("Maximum results to return"),
  },
  async ({ query, maxResults }) => {
    const result = await runGwsJson([
      "gmail", "users", "messages", "list",
      "--params", JSON.stringify({ userId: "me", q: query, maxResults }),
    ]);
    if (!result.messages || result.messages.length === 0) {
      return { content: [{ type: "text", text: "No messages found." }] };
    }
    // Get snippets for each message
    const summaries = [];
    for (const msg of result.messages.slice(0, maxResults)) {
      try {
        const detail = await runGwsJson([
          "gmail", "users", "messages", "get",
          "--params", JSON.stringify({ userId: "me", id: msg.id, format: "metadata", metadataHeaders: ["Subject", "From", "Date"] }),
        ]);
        const headers = {};
        if (detail.payload && detail.payload.headers) {
          for (const h of detail.payload.headers) headers[h.name] = h.value;
        }
        summaries.push(`${headers.Date || "?"} | ${headers.From || "?"} | ${headers.Subject || "?"}`);
      } catch {
        summaries.push(`Message ${msg.id} (could not fetch details)`);
      }
    }
    return { content: [{ type: "text", text: summaries.join("\n") }] };
  }
);

server.tool(
  "gmail_reply",
  "Reply to an email by message ID",
  {
    messageId: z.string().describe("Gmail message ID to reply to"),
    body: z.string().describe("Reply body text"),
  },
  async ({ messageId, body }) => {
    const result = await runGws([
      "gmail", "+reply", "--message-id", messageId, "--body", body,
    ]);
    return { content: [{ type: "text", text: `Reply sent.\n${result}` }] };
  }
);

server.tool(
  "gmail_reply_all",
  "Reply-all to an email by message ID",
  {
    messageId: z.string().describe("Gmail message ID to reply-all to"),
    body: z.string().describe("Reply body text"),
  },
  async ({ messageId, body }) => {
    const result = await runGws([
      "gmail", "+reply-all", "--message-id", messageId, "--body", body,
    ]);
    return { content: [{ type: "text", text: `Reply-all sent.\n${result}` }] };
  }
);

server.tool(
  "gmail_forward",
  "Forward an email to another recipient",
  {
    messageId: z.string().describe("Gmail message ID to forward"),
    to: z.string().describe("Recipient email address"),
  },
  async ({ messageId, to }) => {
    const result = await runGws([
      "gmail", "+forward", "--message-id", messageId, "--to", to,
    ]);
    return { content: [{ type: "text", text: `Forwarded.\n${result}` }] };
  }
);

server.tool(
  "gmail_labels",
  "List all Gmail labels",
  {},
  async () => {
    const result = await runGwsJson([
      "gmail", "users", "labels", "list",
      "--params", JSON.stringify({ userId: "me" }),
    ]);
    if (result.labels) {
      const names = result.labels.map((l) => l.name).sort().join("\n");
      return { content: [{ type: "text", text: names }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
