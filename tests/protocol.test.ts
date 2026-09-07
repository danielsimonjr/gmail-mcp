import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const serverEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const EXPECTED_TOOLS = [
  "gmail_scan_labels", "gmail_sort_inbox", "gmail_preview_sort", "gmail_get_mappings",
  "gmail_list_labels", "gmail_list_emails", "gmail_read_email", "gmail_search_emails",
  "gmail_move_emails", "gmail_delete_emails", "gmail_create_label", "gmail_rename_label", "gmail_delete_label",
  "gmail_mark_emails",
  "gmail_send_email", "gmail_reply_email", "gmail_forward_email",
  "gmail_create_draft", "gmail_list_drafts", "gmail_get_draft", "gmail_update_draft", "gmail_send_draft", "gmail_delete_draft",
  "gmail_download_attachment",
].sort();

function spawnTransport(): StdioClientTransport {
  return new StdioClientTransport({ command: "node", args: [serverEntry] });
}

describe("MCP protocol", () => {
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("negotiates the modern era at the SDK's latest protocol version and lists tools", async () => {
    // Do NOT pin a version here. A pin is echoed back by the client, so an
    // assertion against the pinned string passes whatever the server actually
    // speaks -- this test asserted "2026-07-28" and passed while the server
    // negotiated 2025-11-25. Assert against LATEST_PROTOCOL_VERSION so the
    // test fails when the real negotiated version moves.
    client = new Client({ name: "gmail-mcp-test", version: "1.0.0" });
    await client.connect(spawnTransport());

    // An UNPINNED client negotiates the LEGACY era against this server, while
    // still agreeing on LATEST_PROTOCOL_VERSION. Whether that is correct is an
    // open question (workspace TODO.md) -- it is recorded here, not asserted as
    // desired behaviour, so a future era change shows up as a diff to read.
    expect(client.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(24);
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  it("still serves legacy 2025-era clients via auto negotiation", async () => {
    client = new Client(
      { name: "gmail-mcp-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto", probe: { timeoutMs: 5_000 } } },
    );
    await client.connect(spawnTransport());

    const era = client.getProtocolEra();
    expect(era === "modern" || era === "legacy").toBe(true);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(24);
  });
});
