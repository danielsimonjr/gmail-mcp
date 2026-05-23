import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let stderr: string[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gmail-mcp-state-"));
  process.env.GMAIL_MCP_CONFIG_DIR = tmp;
  delete process.env.GMAIL_MAP_FILE;
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
    stderr.push(String(s));
    return true;
  });
});

afterEach(() => {
  delete process.env.GMAIL_MCP_CONFIG_DIR;
  delete process.env.GMAIL_MAP_FILE;
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("senderMapFile", () => {
  it("defaults to <configDir>/sender_map.json", async () => {
    const { senderMapFile } = await import("../src/state.js");
    expect(senderMapFile()).toBe(join(tmp, "sender_map.json"));
  });
  it("respects GMAIL_MAP_FILE override", async () => {
    process.env.GMAIL_MAP_FILE = join(tmp, "custom-map.json");
    const { senderMapFile } = await import("../src/state.js");
    expect(senderMapFile()).toBe(join(tmp, "custom-map.json"));
  });
});

describe("loadSenderMap / saveSenderMap", () => {
  it("returns {} when file missing", async () => {
    const { loadSenderMap } = await import("../src/state.js");
    expect(await loadSenderMap()).toEqual({});
  });
  it("round-trips with non-ASCII labels (no escaping)", async () => {
    const { loadSenderMap, saveSenderMap } = await import("../src/state.js");
    await saveSenderMap({ "alice@déjà.com": { label: "Wörk 🔔", date: "Wed, 21 May 2026 10:30:00 +0000" } });
    const raw = readFileSync(join(tmp, "sender_map.json"), "utf8");
    expect(raw).toContain('"alice@déjà.com"');
    expect(raw).toContain('"Wörk 🔔"');
    expect(raw).toContain("  \"alice@");  // 2-space indent
    expect((await loadSenderMap())["alice@déjà.com"].label).toBe("Wörk 🔔");
  });
  it("backs up corrupted sender_map and logs to stderr", async () => {
    writeFileSync(join(tmp, "sender_map.json"), "{not json");
    const { loadSenderMap } = await import("../src/state.js");
    expect(await loadSenderMap()).toEqual({});
    const backup = readdirSync(tmp).find((f) => f.startsWith("sender_map.json.corrupted."));
    expect(backup).toBeDefined();
    expect(readFileSync(join(tmp, backup!), "utf8")).toBe("{not json");
    expect(stderr.join("")).toMatch(/sender_map\.json failed to parse/);
  });
});

describe("withSenderMap (mutex)", () => {
  it("serializes 50 concurrent additions — no lost updates", async () => {
    const { withSenderMap, saveSenderMap } = await import("../src/state.js");
    await saveSenderMap({});
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        withSenderMap(async (m) => {
          await new Promise((r) => setImmediate(r)); // yield so naive impl races
          m[`s${i.toString().padStart(2, "0")}@x.com`] = { label: `L${i}`, date: "d" };
        }),
      ),
    );
    const raw = JSON.parse(readFileSync(join(tmp, "sender_map.json"), "utf8"));
    expect(Object.keys(raw).length).toBe(50);
  });
  it("does not poison the queue when a callback throws", async () => {
    const { withSenderMap, saveSenderMap } = await import("../src/state.js");
    await saveSenderMap({});
    await expect(withSenderMap(async () => { throw new Error("nope"); })).rejects.toThrow("nope");
    await expect(withSenderMap(async (m) => { m["ok@x.com"] = { label: "ok", date: "d" }; return "done"; })).resolves.toBe("done");
  });
});
