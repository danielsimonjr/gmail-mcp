import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
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

  it("negotiates the 2026-07-28 (MCP 2.0) era and lists tools", async () => {
    client = new Client(
      { name: "gmail-mcp-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(spawnTransport());

    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");

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
