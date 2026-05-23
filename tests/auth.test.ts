import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let stderr: string[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gmail-mcp-auth-"));
  process.env.GMAIL_MCP_CONFIG_DIR = tmp;
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
    stderr.push(String(s));
    return true;
  });
});

afterEach(() => {
  delete process.env.GMAIL_MCP_CONFIG_DIR;
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("configDir", () => {
  it("honors GMAIL_MCP_CONFIG_DIR when set", async () => {
    const { configDir } = await import("../src/auth.js");
    expect(configDir()).toBe(tmp);
  });
});

describe("loadToken", () => {
  it("returns null when token.json is missing", async () => {
    const { loadToken } = await import("../src/auth.js");
    expect(await loadToken()).toBeNull();
  });

  it("loads a googleapis-style token", async () => {
    writeFileSync(join(tmp, "token.json"), JSON.stringify({
      access_token: "ya29.test",
      refresh_token: "1//rt",
      scope: "https://mail.google.com/",
      token_type: "Bearer",
      expiry_date: 9999999999000,
    }));
    const { loadToken } = await import("../src/auth.js");
    const tok = await loadToken();
    expect(tok).not.toBeNull();
    expect(tok!.refresh_token).toBe("1//rt");
  });

  it("loads a google-auth-oauthlib-style token (legacy)", async () => {
    writeFileSync(join(tmp, "token.json"), JSON.stringify({
      token: "ya29.legacy",
      refresh_token: "1//legacy-rt",
      token_uri: "https://oauth2.googleapis.com/token",
      client_id: "abc.apps.googleusercontent.com",
      client_secret: "GOCSPX-xxx",
      scopes: ["https://mail.google.com/"],
      expiry: "2026-05-23T15:00:00Z",
    }));
    const { loadToken } = await import("../src/auth.js");
    const tok = await loadToken();
    expect(tok).not.toBeNull();
    expect(tok!.access_token).toBe("ya29.legacy");
    expect(tok!.refresh_token).toBe("1//legacy-rt");
  });

  it("logs to stderr and returns null on corrupted token.json", async () => {
    writeFileSync(join(tmp, "token.json"), "{not valid json");
    const { loadToken } = await import("../src/auth.js");
    expect(await loadToken()).toBeNull();
    expect(stderr.join("")).toMatch(/token\.json failed to parse/);
  });
});

describe("findClientSecret", () => {
  it("returns the config-dir path when client_secret.json exists there", async () => {
    writeFileSync(join(tmp, "client_secret.json"), "{}");
    const { findClientSecret } = await import("../src/auth.js");
    expect(findClientSecret()).toBe(join(tmp, "client_secret.json"));
  });

  it("returns null when no client_secret.json is found", async () => {
    const { findClientSecret } = await import("../src/auth.js");
    expect(findClientSecret()).toBeNull();
  });
});

describe("saveToken", () => {
  it("writes JSON in googleapis format with 2-space indent", async () => {
    const { saveToken } = await import("../src/auth.js");
    await saveToken({
      access_token: "ya29.new",
      refresh_token: "1//new",
      scope: "https://mail.google.com/",
      token_type: "Bearer",
      expiry_date: 9999999999000,
    });
    const raw = readFileSync(join(tmp, "token.json"), "utf8");
    expect(raw).toContain('"access_token": "ya29.new"');
    expect(raw).toContain("  \"refresh_token\":");
  });
});
