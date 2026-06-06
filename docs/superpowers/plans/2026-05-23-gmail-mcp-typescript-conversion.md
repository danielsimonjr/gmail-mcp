# Gmail-mcp TypeScript Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the `gmail-mcp` MCP server from Python (FastMCP) to TypeScript on `@modelcontextprotocol/sdk`, adding pagination, attachment support, References-chain threading, transient-error retry, and batch-delete; plus the 5 design fixes from the spec.

**Architecture:** Nine source modules: `auth.ts` (OAuth + token persistence), `client.ts` (Gmail client wrapper with retry + error envelope), `state.ts` (sender_map mutex + corrupted-recovery), `mime.ts` (manual MIME construction), `attachments.ts` (extract + encode + download), `format.ts` (body decode + headers), `tools.ts` (24 tool defs + handlers), `index.ts` (MCP wiring), `auth-cli.ts` (browser OAuth flow CLI, replaces `python server.py --auth`).

**Tech Stack:** Node 24, TypeScript ES2022/Node16, `@modelcontextprotocol/sdk` v1.x, `googleapis` v137+, `@google-cloud/local-auth` v2.1+, `zod` v4, `vitest` v4, manual MIME (no nodemailer — plain text + multipart is 30 LOC and saves a 1MB dep).

**Spec:** `docs/superpowers/specs/2026-05-23-gmail-mcp-typescript-conversion-design.md`

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Modify: `.gitignore` (append TypeScript entries)

- [ ] **Step 1: Write package.json**

```json
{
  "name": "gmail-mcp",
  "version": "0.2.0",
  "description": "Gmail-mcp: MCP server for Gmail with sorting, attachments, drafts, and pagination",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "gmail-mcp": "dist/index.js",
    "gmail-mcp-auth": "dist/auth-cli.js"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@google-cloud/local-auth": "^2.1.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "googleapis": "^137.0.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.6.0",
    "vitest": "^4.0.0"
  },
  "engines": { "node": ">=24" }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["tests/**", "dist/**", "node_modules/**"]
}
```

- [ ] **Step 3: Write vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
  },
});
```

- [ ] **Step 4: Append to .gitignore**

```
node_modules/
dist/
*.tsbuildinfo
.vitest/
```

If a line already exists, skip it. If `.gitignore` is empty / missing, create with the four lines above.

- [ ] **Step 5: Install deps**

Run: `npm install`
Expected: clean install, no peer-dep errors.

- [ ] **Step 6: Verify typecheck (will report TS18003 on empty src/ — expected) and vitest run**

Run: `npm run typecheck` → TS18003 ("No inputs were found") is OK at this point — will resolve when Task 2 adds first source file.
Run: `npx vitest run` → "No test files found" — also expected, resolves in Task 2.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore
git commit -m "chore(ts): scaffold TypeScript project for Gmail-mcp conversion"
```

(Include `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` trailer on every commit in this plan.)

---

## Task 2: auth.ts + auth-cli.ts — OAuth + token persistence

**Files:**
- Create: `src/auth.ts`
- Create: `src/auth-cli.ts`
- Create: `tests/auth.test.ts`

**Spec refs:** §4 (OAuth + token).

The token format googleapis writes vs `google-auth-oauthlib` writes is slightly different. The Python file has fields like `token`, `refresh_token`, `client_id`, `client_secret`, `token_uri`, `scopes`, `expiry`. googleapis' `Credentials` accepts these as the OAuth2Client.setCredentials() input. Our auth.ts must read either format and produce a working client.

- [ ] **Step 1: Write failing tests `tests/auth.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let prevHome: string | undefined;
let stderr: string[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gmail-mcp-auth-"));
  prevHome = process.env.HOME;
  // We don't shim homedir(); instead the auth module reads its config dir
  // from a function we override in tests by setting the env var.
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
```

- [ ] **Step 2: Run tests — confirm failure**

Run: `npx vitest run tests/auth.test.ts` → all FAIL (module not found).

- [ ] **Step 3: Implement `src/auth.ts`**

```typescript
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Credentials } from "google-auth-library";

const SCOPES = ["https://mail.google.com/"];

export function configDir(): string {
  return process.env.GMAIL_MCP_CONFIG_DIR ?? join(homedir(), ".gmail_sorter");
}

function tokenFile(): string {
  return join(configDir(), "token.json");
}

const CLIENT_SECRET_SEARCH = (): string[] => [
  join(configDir(), "client_secret.json"),
  join(homedir(), ".config", "gws", "client_secret.json"),
];

export function findClientSecret(): string | null {
  for (const p of CLIENT_SECRET_SEARCH()) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Normalize a token loaded from either googleapis-style or
 *  google-auth-oauthlib-style JSON into the Credentials shape
 *  googleapis' OAuth2Client.setCredentials expects. */
function normalize(parsed: Record<string, unknown>): Credentials {
  const out: Credentials = {};
  // googleapis-native fields
  if (typeof parsed.access_token === "string") out.access_token = parsed.access_token;
  if (typeof parsed.refresh_token === "string") out.refresh_token = parsed.refresh_token;
  if (typeof parsed.token_type === "string") out.token_type = parsed.token_type;
  if (typeof parsed.scope === "string") out.scope = parsed.scope;
  if (typeof parsed.expiry_date === "number") out.expiry_date = parsed.expiry_date;
  // google-auth-oauthlib legacy fields
  if (!out.access_token && typeof parsed.token === "string") out.access_token = parsed.token;
  if (!out.scope && Array.isArray(parsed.scopes)) out.scope = (parsed.scopes as string[]).join(" ");
  if (!out.expiry_date && typeof parsed.expiry === "string") {
    out.expiry_date = new Date(parsed.expiry).getTime();
  }
  if (!out.token_type) out.token_type = "Bearer";
  return out;
}

export async function loadToken(): Promise<Credentials | null> {
  const path = tokenFile();
  if (!existsSync(path)) return null;
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return null; }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`Gmail-mcp: token.json failed to parse: ${(err as Error).message}\n`);
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return normalize(parsed as Record<string, unknown>);
}

export async function saveToken(creds: Credentials): Promise<void> {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.token-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(creds, null, 2), { encoding: "utf8" });
  renameSync(tmp, tokenFile());
}

export { SCOPES };
```

- [ ] **Step 4: Implement `src/auth-cli.ts` (separate CLI entry replacing `python server.py --auth`)**

```typescript
#!/usr/bin/env node
import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";
import { configDir, findClientSecret, saveToken, SCOPES } from "./auth.js";

async function main(): Promise<void> {
  const clientSecret = findClientSecret();
  if (!clientSecret) {
    process.stderr.write(
      `Gmail-mcp: no client_secret.json found. Place it at ${configDir()}/client_secret.json\n`,
    );
    process.exit(1);
  }
  process.stderr.write(`Gmail-mcp: opening browser for OAuth (client_secret: ${clientSecret})...\n`);
  const auth = await authenticate({
    keyfilePath: clientSecret,
    scopes: SCOPES,
  });
  await saveToken(auth.credentials);
  const gmail = google.gmail({ version: "v1", auth });
  const profile = await gmail.users.getProfile({ userId: "me" });
  process.stderr.write(`Gmail-mcp: authenticated as ${profile.data.emailAddress}\n`);
  process.stderr.write(`Gmail-mcp: token saved to ${configDir()}/token.json\n`);
}

main().catch((err) => {
  process.stderr.write(`Gmail-mcp: auth failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run tests/auth.test.ts` → 7 tests pass.
Run: `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/auth.ts src/auth-cli.ts tests/auth.test.ts
git commit -m "feat(ts): OAuth token persistence with legacy-format compat + auth CLI"
```

---

## Task 3: state.ts — sender_map persistence with mutex + corrupted recovery

**Files:**
- Create: `src/state.ts`
- Create: `tests/state.test.ts`

**Spec refs:** §5 (sender_map), §9.1 (mutex), §9.2 (corrupted recovery).

- [ ] **Step 1: Write failing tests `tests/state.test.ts`**

```typescript
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
```

- [ ] **Step 2: Run tests — confirm failure**

Run: `npx vitest run tests/state.test.ts` → all FAIL (module not found).

- [ ] **Step 3: Implement `src/state.ts`**

```typescript
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./auth.js";

export interface SenderEntry { label: string; date: string; }
export type SenderMap = Record<string, SenderEntry>;

export function senderMapFile(): string {
  return process.env.GMAIL_MAP_FILE ?? join(configDir(), "sender_map.json");
}

export async function loadSenderMap(): Promise<SenderMap> {
  const path = senderMapFile();
  if (!existsSync(path)) return {};
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return {}; }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SenderMap;
    }
    return {};
  } catch (err) {
    const backup = `${path}.corrupted.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try { renameSync(path, backup); } catch { /* best effort */ }
    process.stderr.write(`Gmail-mcp: sender_map.json failed to parse, moved to ${backup}; starting from empty (${(err as Error).message})\n`);
    return {};
  }
}

export async function saveSenderMap(m: SenderMap): Promise<void> {
  const path = senderMapFile();
  const dir = path.substring(0, path.lastIndexOf("/")) || path.substring(0, path.lastIndexOf("\\"));
  if (dir) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}-${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2), { encoding: "utf8" });
  for (let i = 0; i < 3; i++) {
    try { renameSync(tmp, path); return; }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "EBUSY" || code === "EPERM") && i < 2) {
        await new Promise(r => setTimeout(r, 10 * 2 ** i));
        continue;
      }
      process.stderr.write(`Gmail-mcp: saveSenderMap failed: ${(err as Error).message}\n`);
      throw err;
    }
  }
}

let queue: Promise<unknown> = Promise.resolve();

export async function withSenderMap<T>(fn: (m: SenderMap) => Promise<T> | T): Promise<T> {
  const next = queue.then(async () => {
    const m = await loadSenderMap();
    const result = await fn(m);
    await saveSenderMap(m);
    return result;
  });
  queue = next.catch(() => undefined);
  return next as Promise<T>;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/state.test.ts` → 7 tests pass.
Run: `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/state.ts tests/state.test.ts
git commit -m "feat(ts): sender_map persistence with mutex and corrupted-file recovery"
```

---

## Task 4: client.ts — Gmail client wrapper with retry + error envelope

**Files:**
- Create: `src/client.ts`
- Create: `tests/client.test.ts`

**Spec refs:** §9.5 (error envelope), §9.6 (retry), F5 (retry).

- [ ] **Step 1: Write failing tests `tests/client.test.ts`**

```typescript
import { describe, it, expect, vi } from "vitest";
import { withRetry, wrap } from "../src/client.js";

describe("withRetry", () => {
  it("returns the result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    expect(await withRetry(fn)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("retries on 429 and succeeds on 2nd attempt", async () => {
    let n = 0;
    const fn = async () => { if (n++ === 0) throw { code: 429, message: "rate" }; return "ok"; };
    expect(await withRetry(fn)).toBe("ok");
  });
  it("retries on 500/503", async () => {
    let n = 0;
    const fn = async () => { if (n++ < 2) throw { code: 503, message: "down" }; return "ok"; };
    expect(await withRetry(fn)).toBe("ok");
  });
  it("does NOT retry on 401", async () => {
    const fn = vi.fn().mockRejectedValue({ code: 401, message: "expired" });
    await expect(withRetry(fn)).rejects.toMatchObject({ code: 401 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("does NOT retry on 403 or 404", async () => {
    const fn403 = vi.fn().mockRejectedValue({ code: 403, message: "forbidden" });
    await expect(withRetry(fn403)).rejects.toMatchObject({ code: 403 });
    expect(fn403).toHaveBeenCalledTimes(1);
  });
  it("throws after max retries (3)", async () => {
    const fn = vi.fn().mockRejectedValue({ code: 429, message: "rate" });
    await expect(withRetry(fn)).rejects.toMatchObject({ code: 429 });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("wrap", () => {
  it("returns the function's JSON output on success", async () => {
    const result = await wrap("test", async () => ({ status: "ok", n: 42 }));
    expect(JSON.parse(result)).toEqual({ status: "ok", n: 42 });
  });
  it("wraps thrown errors as {status:error, error:message}", async () => {
    const result = await wrap("test", async () => { throw new Error("boom"); });
    expect(JSON.parse(result)).toEqual({ status: "error", error: "boom" });
  });
  it("includes code when error has one", async () => {
    const result = await wrap("test", async () => { throw { code: 404, message: "not found" }; });
    expect(JSON.parse(result)).toEqual({ status: "error", error: "not found", code: 404 });
  });
});
```

- [ ] **Step 2: Run tests — confirm failure**

Run: `npx vitest run tests/client.test.ts` → all FAIL.

- [ ] **Step 3: Implement `src/client.ts`**

```typescript
import { google, type gmail_v1 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { findClientSecret, loadToken, saveToken } from "./auth.js";
import { readFileSync } from "node:fs";

const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const PERMANENT = new Set([400, 401, 403, 404]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 250;

export async function withRetry<T>(fn: () => Promise<T>, max = MAX_RETRIES): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < max; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const code = (err as { code?: number; status?: number }).code
                 ?? (err as { status?: number }).status;
      if (PERMANENT.has(code as number)) throw err;
      if (!TRANSIENT.has(code as number)) throw err;
      if (attempt === max - 1) break;
      await new Promise(r => setTimeout(r, BASE_DELAY_MS * 2 ** attempt));
    }
  }
  throw lastErr;
}

export async function wrap(name: string, fn: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await fn());
  } catch (err) {
    const e = err as { code?: number; message?: string };
    process.stderr.write(`Gmail-mcp: handler '${name}' threw: ${e.message || String(err)}\n`);
    return JSON.stringify({
      status: "error",
      error: e.message || String(err),
      ...(e.code !== undefined ? { code: e.code } : {}),
    });
  }
}

/** Build an authenticated Gmail client. Loads token + client_secret, sets up
 *  auto-refresh saving back to token.json. Throws if either is missing. */
export async function getGmail(): Promise<gmail_v1.Gmail> {
  const tok = await loadToken();
  if (!tok) throw new Error("No token.json — run `node dist/auth-cli.js` to authenticate");
  const cs = findClientSecret();
  if (!cs) throw new Error("No client_secret.json found");
  const { installed } = JSON.parse(readFileSync(cs, "utf8")) as { installed: { client_id: string; client_secret: string; token_uri?: string } };
  const oauth2 = new OAuth2Client(installed.client_id, installed.client_secret);
  oauth2.setCredentials(tok);
  oauth2.on("tokens", (newTok) => {
    // Persist refreshed credentials. googleapis emits "tokens" after refresh.
    saveToken({ ...tok, ...newTok }).catch((err) =>
      process.stderr.write(`Gmail-mcp: token refresh save failed: ${err.message}\n`),
    );
  });
  return google.gmail({ version: "v1", auth: oauth2 });
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/client.test.ts` → 9 tests pass.
Run: `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/client.ts tests/client.test.ts
git commit -m "feat(ts): Gmail client wrapper with retry + error envelope"
```

---

## Task 5: format.ts — body decode + header extraction

**Files:**
- Create: `src/format.ts`
- Create: `tests/format.test.ts`

**Spec refs:** §7 (formatting).

- [ ] **Step 1: Write failing tests `tests/format.test.ts`**

```typescript
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
```

- [ ] **Step 2: Run tests — confirm failure**

Run: `npx vitest run tests/format.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/format.ts`**

```typescript
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
  // Direct body on this part
  if (payload.body?.data) {
    const mime = (payload.mimeType ?? "").toLowerCase();
    // Only return data for text parts (not attachments)
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
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/format.test.ts` → 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/format.ts tests/format.test.ts
git commit -m "feat(ts): header extraction + recursive body decode (text/plain preferred)"
```

---

## Task 6: mime.ts — MIME message construction

**Files:**
- Create: `src/mime.ts`
- Create: `tests/mime.test.ts`

**Spec refs:** §10 (MIME construction), §8 (References-chain).

- [ ] **Step 1: Write failing tests `tests/mime.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { buildPlainMessage, buildMultipartMessage, base64urlEncode } from "../src/mime.js";

describe("base64urlEncode", () => {
  it("encodes string to base64url (no padding)", () => {
    // "Hello, world!" → standard base64 "SGVsbG8sIHdvcmxkIQ=="
    expect(base64urlEncode("Hello, world!")).toBe("SGVsbG8sIHdvcmxkIQ");
  });
  it("uses URL-safe characters (- and _)", () => {
    // bytes 0xfb 0xef = ">" "/" in standard base64
    const input = Buffer.from([0xfb, 0xef, 0xff]).toString("utf8"); // forces specials
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
    expect(decoded).toContain("filename=\"test.txt\"");
    expect(decoded).toContain("Content-Disposition: attachment");
    // attachment body is base64-encoded
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
```

- [ ] **Step 2: Run tests — confirm failure**

Run: `npx vitest run tests/mime.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/mime.ts`**

```typescript
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
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/mime.test.ts` → 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mime.ts tests/mime.test.ts
git commit -m "feat(ts): MIME plain + multipart construction with base64url encoding"
```

---

## Task 7: attachments.ts — extract metadata + download + encode

**Files:**
- Create: `src/attachments.ts`
- Create: `tests/attachments.test.ts`

**Spec refs:** §7 (attachments).

- [ ] **Step 1: Write failing tests `tests/attachments.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractAttachments, attachmentToBuffer, readLocalAttachment } from "../src/attachments.js";
import type { gmail_v1 } from "googleapis";
import { writeFileSync } from "node:fs";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "gmail-mcp-att-")); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("extractAttachments", () => {
  it("returns [] when no attachments", () => {
    expect(extractAttachments({ mimeType: "text/plain", body: { data: "x" } })).toEqual([]);
  });
  it("extracts top-level attachment with filename + size", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: "x" } },
        { mimeType: "application/pdf", filename: "report.pdf", body: { attachmentId: "ATT_1", size: 12345 } },
      ],
    };
    const result = extractAttachments(payload);
    expect(result).toEqual([{ filename: "report.pdf", mime_type: "application/pdf", size: 12345, attachment_id: "ATT_1" }]);
  });
  it("recurses nested multipart", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [{ mimeType: "image/png", filename: "img.png", body: { attachmentId: "ATT_X", size: 999 } }],
        },
      ],
    };
    expect(extractAttachments(payload)).toEqual([{ filename: "img.png", mime_type: "image/png", size: 999, attachment_id: "ATT_X" }]);
  });
  it("falls back to 'unnamed.<ext>' when filename empty", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      parts: [{ mimeType: "image/jpeg", filename: "", body: { attachmentId: "A", size: 1 } }],
    };
    expect(extractAttachments(payload)[0].filename).toBe("unnamed.jpeg");
  });
});

describe("attachmentToBuffer", () => {
  it("decodes base64url data into a Buffer", () => {
    // "hi" → base64 "aGk" (no padding in base64url)
    const buf = attachmentToBuffer("aGk");
    expect(buf.toString("utf8")).toBe("hi");
  });
});

describe("readLocalAttachment", () => {
  it("reads a file from disk and infers mime type from extension", () => {
    const p = join(tmp, "report.pdf");
    writeFileSync(p, "PDFDATA");
    const att = readLocalAttachment(p);
    expect(att.filename).toBe("report.pdf");
    expect(att.mimeType).toBe("application/pdf");
    expect(att.data.toString()).toBe("PDFDATA");
  });
  it("falls back to application/octet-stream for unknown extensions", () => {
    const p = join(tmp, "thing.xyz");
    writeFileSync(p, "data");
    expect(readLocalAttachment(p).mimeType).toBe("application/octet-stream");
  });
});
```

- [ ] **Step 2: Run tests — confirm failure**

Run: `npx vitest run tests/attachments.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/attachments.ts`**

```typescript
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
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/attachments.test.ts` → 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/attachments.ts tests/attachments.test.ts
git commit -m "feat(ts): attachment extract + base64url decode + local-file reader"
```

---

## Task 8: tools.ts — TOOLS array (24 defs) + empty HANDLERS + smoke test

**Files:**
- Create: `src/tools.ts` (TOOLS array; empty HANDLERS, populated in Tasks 9–14)
- Create: `tests/tools-defs.test.ts`
- Create: `tests/smoke.test.ts`

**Spec refs:** §9.4 (annotations table).

- [ ] **Step 1: Write failing tests `tests/tools-defs.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { TOOLS } from "../src/tools.js";

const EXPECTED = [
  "gmail_scan_labels","gmail_sort_inbox","gmail_preview_sort","gmail_get_mappings",
  "gmail_list_labels","gmail_list_emails","gmail_read_email","gmail_search_emails",
  "gmail_move_emails","gmail_delete_emails","gmail_create_label","gmail_rename_label","gmail_delete_label",
  "gmail_mark_emails",
  "gmail_send_email","gmail_reply_email","gmail_forward_email",
  "gmail_create_draft","gmail_list_drafts","gmail_get_draft","gmail_update_draft","gmail_send_draft","gmail_delete_draft",
  "gmail_download_attachment",
].sort();

const READ_ONLY = new Set([
  "gmail_list_labels","gmail_list_emails","gmail_read_email","gmail_search_emails",
  "gmail_list_drafts","gmail_get_draft","gmail_get_mappings","gmail_preview_sort",
  "gmail_download_attachment",
]);
const DESTRUCTIVE = new Set([
  "gmail_send_email","gmail_send_draft","gmail_forward_email","gmail_reply_email",
  "gmail_delete_emails","gmail_delete_label",
]);

describe("TOOLS", () => {
  it("has exactly 24 tools with the expected names", () => {
    expect(TOOLS.map(t => t.name).sort()).toEqual(EXPECTED);
  });
  it("readOnlyHint matches §9.4 (9 tools)", () => {
    for (const t of TOOLS) {
      expect(t.annotations?.readOnlyHint ?? false).toBe(READ_ONLY.has(t.name));
    }
  });
  it("destructiveHint matches §9.4 (6 tools)", () => {
    for (const t of TOOLS) {
      expect(t.annotations?.destructiveHint ?? false).toBe(DESTRUCTIVE.has(t.name));
    }
  });
  it("every tool has a non-empty description", () => {
    for (const t of TOOLS) {
      expect((t.description ?? "").length).toBeGreaterThan(10);
    }
  });
  it("every tool has an object inputSchema", () => {
    for (const t of TOOLS) {
      expect((t.inputSchema as { type: string }).type).toBe("object");
    }
  });
});
```

- [ ] **Step 2: Write `tests/smoke.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { TOOLS, HANDLERS } from "../src/tools.js";

describe("TOOLS ↔ HANDLERS symmetry", () => {
  it("every tool name has a handler", () => {
    expect(Object.keys(HANDLERS).sort()).toEqual(TOOLS.map(t => t.name).sort());
  });
});
```

- [ ] **Step 3: Run tests — confirm tools-defs FAIL (module not found) and smoke will FAIL after impl (24 vs 0)**

- [ ] **Step 4: Implement `src/tools.ts` (TOOLS array + empty HANDLERS placeholder)**

```typescript
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export type ToolHandler = (raw: unknown) => Promise<string>;

const RO_NON_DESTRUCTIVE = { readOnlyHint: true, destructiveHint: false };
const MUT_NON_DESTRUCTIVE = { readOnlyHint: false, destructiveHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true };

const STR = (description: string) => ({ type: "string" as const, description });
const STR_LIST = (description: string) => ({ type: "array" as const, items: { type: "string" as const }, description });

export const TOOLS: Tool[] = [
  // --- Sorting (4) ---
  { name: "gmail_scan_labels", description: "Scan all non-excluded labels, learn sender→label mappings, save to sender_map.json.", annotations: MUT_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "gmail_sort_inbox", description: "Apply learned sender→label mappings to inbox: move each email to its mapped label.", annotations: MUT_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "gmail_preview_sort", description: "Dry-run inbox sort — show what would be moved without mutating anything.", annotations: RO_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "gmail_get_mappings", description: "Read sender_map.json and return entries (optionally filtered by label, limited by count).", annotations: RO_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { label_filter: STR("Case-insensitive label substring match."), limit: { type: "number", description: "Max entries to return (default 200)." } }, additionalProperties: false } },
  // --- Read (4) ---
  { name: "gmail_list_labels", description: "List all Gmail labels (system + user) with total/unread counts.", annotations: RO_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "gmail_list_emails", description: "List emails under a label. Returns id, sender, subject, date, snippet per message. Supports pagination via page_token.", annotations: RO_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { label: STR("Label name or ID. Default 'INBOX'."), limit: { type: "number" }, unread_only: { type: "boolean" }, page_token: STR("Pagination cursor from a prior call.") }, additionalProperties: false } },
  { name: "gmail_read_email", description: "Read a full email body + headers + attachments metadata.", annotations: RO_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { message_id: STR("Gmail message ID.") }, required: ["message_id"], additionalProperties: false } },
  { name: "gmail_search_emails", description: "Search Gmail using its native query syntax (e.g. 'from:alice subject:foo'). Supports pagination.", annotations: RO_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { query: STR("Gmail search query."), limit: { type: "number" }, page_token: STR("Pagination cursor.") }, required: ["query"], additionalProperties: false } },
  // --- Organize (5) ---
  { name: "gmail_move_emails", description: "Move emails to a label (adds the label, removes INBOX).", annotations: MUT_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { message_ids: STR_LIST("Message IDs."), label: STR("Target label name or ID.") }, required: ["message_ids", "label"], additionalProperties: false } },
  { name: "gmail_delete_emails", description: "Trash or permanently delete emails. Defaults to trash (recoverable). When permanent=true, uses Gmail's batchDelete (irreversible).", annotations: DESTRUCTIVE,
    inputSchema: { type: "object", properties: { message_ids: STR_LIST("Message IDs."), permanent: { type: "boolean" } }, required: ["message_ids"], additionalProperties: false } },
  { name: "gmail_create_label", description: "Create a new Gmail label.", annotations: MUT_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { name: STR("New label name.") }, required: ["name"], additionalProperties: false } },
  { name: "gmail_rename_label", description: "Rename a label.", annotations: MUT_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { old_name: STR("Existing label name."), new_name: STR("New name.") }, required: ["old_name", "new_name"], additionalProperties: false } },
  { name: "gmail_delete_label", description: "Delete a label permanently.", annotations: DESTRUCTIVE,
    inputSchema: { type: "object", properties: { name: STR("Label name to delete.") }, required: ["name"], additionalProperties: false } },
  // --- Mark (1) ---
  { name: "gmail_mark_emails", description: "Mark emails read/unread/starred/unstarred.", annotations: MUT_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { message_ids: STR_LIST("Message IDs."), action: STR("'read', 'unread', 'star', or 'unstar'.") }, required: ["message_ids", "action"], additionalProperties: false } },
  // --- Compose (3) ---
  { name: "gmail_send_email", description: "Send a new email. Optional attachments by local file path.", annotations: DESTRUCTIVE,
    inputSchema: { type: "object", properties: { to: STR(""), subject: STR(""), body: STR(""), cc: STR(""), attachments: STR_LIST("Local file paths to attach.") }, required: ["to", "subject", "body"], additionalProperties: false } },
  { name: "gmail_reply_email", description: "Reply to an email, preserving thread + References chain. Optional attachments.", annotations: DESTRUCTIVE,
    inputSchema: { type: "object", properties: { message_id: STR(""), body: STR(""), attachments: STR_LIST("Local file paths.") }, required: ["message_id", "body"], additionalProperties: false } },
  { name: "gmail_forward_email", description: "Forward an email to a new recipient. Optional attachments.", annotations: DESTRUCTIVE,
    inputSchema: { type: "object", properties: { message_id: STR(""), to: STR(""), body: STR(""), attachments: STR_LIST("Local file paths.") }, required: ["message_id", "to"], additionalProperties: false } },
  // --- Draft (6) ---
  { name: "gmail_create_draft", description: "Create a new draft. If in_reply_to is set, threads with proper References chain. Optional attachments.", annotations: MUT_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { to: STR(""), subject: STR(""), body: STR(""), cc: STR(""), in_reply_to: STR("Message ID to reply to."), attachments: STR_LIST("Local file paths.") }, required: ["to", "subject", "body"], additionalProperties: false } },
  { name: "gmail_list_drafts", description: "List drafts with sender, subject, snippet. Supports pagination.", annotations: RO_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { limit: { type: "number" }, page_token: STR("Pagination cursor.") }, additionalProperties: false } },
  { name: "gmail_get_draft", description: "Read a draft's full content + attachments metadata.", annotations: RO_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { draft_id: STR("Draft ID.") }, required: ["draft_id"], additionalProperties: false } },
  { name: "gmail_update_draft", description: "Replace draft contents (preserves thread + References if set).", annotations: MUT_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { draft_id: STR(""), to: STR(""), subject: STR(""), body: STR(""), cc: STR(""), attachments: STR_LIST("Local file paths.") }, required: ["draft_id", "to", "subject", "body"], additionalProperties: false } },
  { name: "gmail_send_draft", description: "Send an existing draft.", annotations: DESTRUCTIVE,
    inputSchema: { type: "object", properties: { draft_id: STR("Draft ID.") }, required: ["draft_id"], additionalProperties: false } },
  { name: "gmail_delete_draft", description: "Delete a draft.", annotations: MUT_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { draft_id: STR("Draft ID.") }, required: ["draft_id"], additionalProperties: false } },
  // --- Attachment (1, new) ---
  { name: "gmail_download_attachment", description: "Download an attachment from a message to local disk. Default path: ~/Downloads/<filename>.", annotations: RO_NON_DESTRUCTIVE,
    inputSchema: { type: "object", properties: { message_id: STR(""), attachment_id: STR(""), local_path: STR("Optional explicit path or directory.") }, required: ["message_id", "attachment_id"], additionalProperties: false } },
];

// HANDLERS populated incrementally in Tasks 9–14.
export const HANDLERS: Record<string, ToolHandler> = {};
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/tools-defs.test.ts` → 5 tests pass.
Run: `npx vitest run tests/smoke.test.ts` → **FAILS** (24 tools vs 0 handlers — expected; passes after Task 14).

- [ ] **Step 6: Commit**

```bash
git add src/tools.ts tests/tools-defs.test.ts tests/smoke.test.ts
git commit -m "feat(ts): TOOLS definitions (24) with readOnly/destructive annotations"
```

---

## Task 9: HANDLERS — sorting (4 tools)

**Files:**
- Modify: `src/tools.ts` (add handlers + helpers)
- Create: `tests/handlers-sorting.test.ts`

**Spec refs:** §1.1 (sorting tools), §9.1 (mutex on scan + sort).

- [ ] **Step 1: Write failing tests `tests/handlers-sorting.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let mockGmail: ReturnType<typeof makeMockGmail>;

function makeMockGmail() {
  return {
    users: {
      labels: { list: vi.fn(), get: vi.fn(), create: vi.fn() },
      messages: { list: vi.fn(), get: vi.fn(), modify: vi.fn() },
    },
  };
}

vi.mock("../src/client.js", async () => {
  return {
    getGmail: async () => mockGmail,
    withRetry: <T>(fn: () => Promise<T>) => fn(),
    wrap: async (_: string, fn: () => Promise<unknown>) => {
      try { return JSON.stringify(await fn()); }
      catch (err) { return JSON.stringify({ status: "error", error: (err as Error).message }); }
    },
  };
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gmail-mcp-h-"));
  process.env.GMAIL_MCP_CONFIG_DIR = tmp;
  delete process.env.GMAIL_MAP_FILE;
  mockGmail = makeMockGmail();
});

afterEach(() => {
  delete process.env.GMAIL_MCP_CONFIG_DIR;
  rmSync(tmp, { recursive: true, force: true });
  vi.resetModules();
});

describe("gmail_scan_labels", () => {
  it("scans non-excluded labels and updates sender_map", async () => {
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [{ id: "Label_1", name: "Work" }, { id: "INBOX", name: "INBOX" }] } });
    mockGmail.users.messages.list.mockResolvedValue({ data: { messages: [{ id: "m1" }] } });
    mockGmail.users.messages.get.mockResolvedValue({ data: { payload: { headers: [{ name: "From", value: "alice@example.com" }, { name: "Date", value: "Wed, 21 May 2026 10:30:00 +0000" }] } } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_scan_labels({}));
    expect(r.status).toBe("ok");
    expect(r.labels_scanned).toBe(1);  // INBOX excluded
    expect(r.total_senders).toBe(1);
    expect(r.new_or_updated).toBe(1);
  });
});

describe("gmail_sort_inbox", () => {
  it("returns error when sender_map is empty", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_sort_inbox({}));
    expect(r).toEqual({ status: "error", message: "No sender map. Run gmail_scan_labels first." });
  });
  it("moves inbox emails to mapped labels when map is populated", async () => {
    const { saveSenderMap } = await import("../src/state.js");
    await saveSenderMap({ "alice@example.com": { label: "Work", date: "Wed, 21 May 2026 10:30:00 +0000" } });
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [{ id: "L_W", name: "Work" }] } });
    mockGmail.users.messages.list.mockResolvedValue({ data: { messages: [{ id: "m1" }] } });
    mockGmail.users.messages.get.mockResolvedValue({ data: { payload: { headers: [{ name: "From", value: "alice@example.com" }, { name: "Subject", value: "Hi" }] } } });
    mockGmail.users.messages.modify.mockResolvedValue({ data: {} });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_sort_inbox({}));
    expect(r.status).toBe("ok");
    expect(r.moved).toBe(1);
  });
});

describe("gmail_preview_sort", () => {
  it("returns 'unknown' count and 'would_move' but does not mutate", async () => {
    const { saveSenderMap } = await import("../src/state.js");
    await saveSenderMap({ "alice@example.com": { label: "Work", date: "d" } });
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [{ id: "L_W", name: "Work" }] } });
    mockGmail.users.messages.list.mockResolvedValue({ data: { messages: [{ id: "m1" }, { id: "m2" }] } });
    mockGmail.users.messages.get
      .mockResolvedValueOnce({ data: { payload: { headers: [{ name: "From", value: "alice@example.com" }, { name: "Subject", value: "Known" }] } } })
      .mockResolvedValueOnce({ data: { payload: { headers: [{ name: "From", value: "bob@example.com" }, { name: "Subject", value: "Unknown" }] } } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_preview_sort({}));
    expect(r.status).toBe("ok");
    expect(r.total_inbox).toBe(2);
    expect(r.would_move).toBe(1);
    expect(r.unknown).toBe(1);
    expect(mockGmail.users.messages.modify).not.toHaveBeenCalled();
  });
});

describe("gmail_get_mappings", () => {
  it("returns full map by default", async () => {
    const { saveSenderMap } = await import("../src/state.js");
    await saveSenderMap({ "a@x.com": { label: "Work", date: "d" }, "b@x.com": { label: "News", date: "d" } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_get_mappings({}));
    expect(r.status).toBe("ok");
    expect(r.total_senders).toBe(2);
    expect(r.label_summary).toEqual({ Work: 1, News: 1 });
  });
  it("filters by label (case-insensitive)", async () => {
    const { saveSenderMap } = await import("../src/state.js");
    await saveSenderMap({ "a@x.com": { label: "Work", date: "d" }, "b@x.com": { label: "News", date: "d" } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_get_mappings({ label_filter: "work" }));
    expect(r.total_senders).toBe(2);
    expect(r.results_shown).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests — confirm failure**

Run: `npx vitest run tests/handlers-sorting.test.ts` → all FAIL (handlers undefined).

- [ ] **Step 3: Add handlers to `src/tools.ts`. Add imports + helpers at the top of the file (after the existing imports), then populate the HANDLERS object.**

```typescript
// Add to top of src/tools.ts (after existing imports):
import { z } from "zod";
import { getGmail, withRetry, wrap } from "./client.js";
import { withSenderMap, loadSenderMap, type SenderMap } from "./state.js";
import { extractHeader, extractSenderEmail } from "./format.js";

const EXCLUDED_LABELS = new Set([
  "INBOX","SPAM","TRASH","DRAFT","SENT",
  "CATEGORY_SOCIAL","CATEGORY_PROMOTIONS","CATEGORY_UPDATES","CATEGORY_FORUMS","CATEGORY_PERSONAL",
  "STARRED","IMPORTANT","UNREAD",
]);

// Replace the `export const HANDLERS: Record<string, ToolHandler> = {};` line with:
export const HANDLERS: Record<string, ToolHandler> = {
  async gmail_scan_labels(raw) {
    z.object({}).passthrough().parse(raw);
    return wrap("gmail_scan_labels", async () => {
      const gmail = await getGmail();
      const labelsRes = await withRetry(() => gmail.users.labels.list({ userId: "me" }));
      const labels = (labelsRes.data.labels ?? []).filter((l) => !EXCLUDED_LABELS.has(l.name ?? "") && !EXCLUDED_LABELS.has(l.id ?? ""));
      let labelsScanned = 0;
      let newOrUpdated = 0;
      const newMap = await withSenderMap(async (m) => {
        for (const label of labels) {
          if (!label.id) continue;
          labelsScanned++;
          const msgList = await withRetry(() => gmail.users.messages.list({ userId: "me", labelIds: [label.id!], maxResults: 100 }));
          for (const ref of (msgList.data.messages ?? [])) {
            if (!ref.id) continue;
            const msg = await withRetry(() => gmail.users.messages.get({ userId: "me", id: ref.id!, format: "metadata", metadataHeaders: ["From", "Date"] }));
            const headers = msg.data.payload?.headers ?? [];
            const sender = extractSenderEmail(extractHeader(headers, "From"));
            if (!sender) continue;
            const date = extractHeader(headers, "Date");
            const existing = m[sender];
            if (!existing || existing.label !== label.name) {
              m[sender] = { label: label.name ?? label.id, date };
              newOrUpdated++;
            }
          }
        }
        return m;
      });
      return { status: "ok", labels_scanned: labelsScanned, total_senders: Object.keys(newMap).length, new_or_updated: newOrUpdated, map_file: (await import("./state.js")).senderMapFile() };
    });
  },

  async gmail_sort_inbox(raw) {
    z.object({}).passthrough().parse(raw);
    return wrap("gmail_sort_inbox", async () => {
      const map = await loadSenderMap();
      if (Object.keys(map).length === 0) return { status: "error", message: "No sender map. Run gmail_scan_labels first." };
      const gmail = await getGmail();
      const labelsRes = await withRetry(() => gmail.users.labels.list({ userId: "me" }));
      const labelByName: Record<string, string> = {};
      for (const l of (labelsRes.data.labels ?? [])) if (l.name && l.id) labelByName[l.name] = l.id;
      const inboxList = await withRetry(() => gmail.users.messages.list({ userId: "me", labelIds: ["INBOX"], maxResults: 500 }));
      const details: Array<{ subject: string; sender: string; label: string }> = [];
      let moved = 0;
      for (const ref of (inboxList.data.messages ?? [])) {
        if (!ref.id) continue;
        const msg = await withRetry(() => gmail.users.messages.get({ userId: "me", id: ref.id!, format: "metadata", metadataHeaders: ["From", "Subject"] }));
        const headers = msg.data.payload?.headers ?? [];
        const sender = extractSenderEmail(extractHeader(headers, "From"));
        const subject = extractHeader(headers, "Subject");
        const targetLabel = map[sender]?.label;
        const targetId = targetLabel ? labelByName[targetLabel] : undefined;
        if (targetId) {
          await withRetry(() => gmail.users.messages.modify({ userId: "me", id: ref.id!, requestBody: { addLabelIds: [targetId], removeLabelIds: ["INBOX"] } }));
          if (details.length < 50) details.push({ subject, sender, label: targetLabel! });
          moved++;
        }
      }
      return { status: "ok", moved, details };
    });
  },

  async gmail_preview_sort(raw) {
    z.object({}).passthrough().parse(raw);
    return wrap("gmail_preview_sort", async () => {
      const map = await loadSenderMap();
      if (Object.keys(map).length === 0) return { status: "error", message: "No sender map. Run gmail_scan_labels first." };
      const gmail = await getGmail();
      const inboxList = await withRetry(() => gmail.users.messages.list({ userId: "me", labelIds: ["INBOX"], maxResults: 500 }));
      const moveDetails: Array<{ subject: string; sender: string; label: string }> = [];
      const unknownDetails: Array<{ subject: string; sender: string }> = [];
      let wouldMove = 0;
      let unknown = 0;
      let total = 0;
      for (const ref of (inboxList.data.messages ?? [])) {
        if (!ref.id) continue;
        total++;
        const msg = await withRetry(() => gmail.users.messages.get({ userId: "me", id: ref.id!, format: "metadata", metadataHeaders: ["From", "Subject"] }));
        const headers = msg.data.payload?.headers ?? [];
        const sender = extractSenderEmail(extractHeader(headers, "From"));
        const subject = extractHeader(headers, "Subject");
        const label = map[sender]?.label;
        if (label) {
          wouldMove++;
          if (moveDetails.length < 50) moveDetails.push({ subject, sender, label });
        } else {
          unknown++;
          if (unknownDetails.length < 20) unknownDetails.push({ subject, sender });
        }
      }
      return { status: "ok", total_inbox: total, would_move: wouldMove, unknown, move_details: moveDetails, unknown_details: unknownDetails };
    });
  },

  async gmail_get_mappings(raw) {
    const { label_filter, limit } = z.object({ label_filter: z.string().nullish(), limit: z.number().default(200) }).parse(raw);
    return wrap("gmail_get_mappings", async () => {
      const map = await loadSenderMap();
      const filtered: SenderMap = {};
      const labelSummary: Record<string, number> = {};
      const filterLower = label_filter?.toLowerCase();
      let shown = 0;
      for (const [sender, entry] of Object.entries(map)) {
        labelSummary[entry.label] = (labelSummary[entry.label] ?? 0) + 1;
        if (filterLower && !entry.label.toLowerCase().includes(filterLower)) continue;
        if (shown < limit) {
          filtered[sender] = entry;
          shown++;
        }
      }
      return { status: "ok", total_senders: Object.keys(map).length, results_shown: Object.keys(filtered).length, map_file: (await import("./state.js")).senderMapFile(), mappings: filtered, label_summary: labelSummary };
    });
  },
};
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/handlers-sorting.test.ts` → all pass.
Run: `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts tests/handlers-sorting.test.ts
git commit -m "feat(ts): sorting handlers (scan_labels, sort_inbox, preview_sort, get_mappings)"
```

---

## Task 10: HANDLERS — read (4 tools, with pagination + attachment metadata)

**Files:**
- Modify: `src/tools.ts`
- Create: `tests/handlers-read.test.ts`

**Spec refs:** §6 (pagination), §7.1 (attachments in reads), §1.1 (read tools).

- [ ] **Step 1: Write failing tests `tests/handlers-read.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let mockGmail: ReturnType<typeof makeMockGmail>;
function makeMockGmail() {
  return {
    users: {
      labels: { list: vi.fn() },
      messages: { list: vi.fn(), get: vi.fn() },
      drafts: { list: vi.fn() },
    },
  };
}

vi.mock("../src/client.js", () => ({
  getGmail: async () => mockGmail,
  withRetry: <T>(fn: () => Promise<T>) => fn(),
  wrap: async (_: string, fn: () => Promise<unknown>) => {
    try { return JSON.stringify(await fn()); }
    catch (err) { return JSON.stringify({ status: "error", error: (err as Error).message }); }
  },
}));

beforeEach(() => { mockGmail = makeMockGmail(); });
afterEach(() => { vi.resetModules(); });

describe("gmail_list_labels", () => {
  it("returns sorted labels with totals", async () => {
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [
      { id: "INBOX", name: "INBOX", type: "system", messagesTotal: 50, messagesUnread: 5 },
      { id: "Work", name: "Work", type: "user", messagesTotal: 10, messagesUnread: 2 },
    ] } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_list_labels({}));
    expect(r.status).toBe("ok");
    expect(r.labels.length).toBe(2);
    // Sorted alphabetically by name
    expect(r.labels[0].name).toBe("INBOX");
  });
});

describe("gmail_list_emails", () => {
  it("returns emails with id, sender, subject, date, snippet", async () => {
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [{ id: "INBOX", name: "INBOX" }] } });
    mockGmail.users.messages.list.mockResolvedValue({ data: { messages: [{ id: "m1" }] } });
    mockGmail.users.messages.get.mockResolvedValue({ data: { id: "m1", snippet: "Hi there...", payload: { headers: [
      { name: "From", value: "Alice <alice@x.com>" }, { name: "Subject", value: "Hi" }, { name: "Date", value: "Wed, 21 May 2026 10:30:00 +0000" },
    ] } } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_list_emails({ label: "INBOX", limit: 20 }));
    expect(r.status).toBe("ok");
    expect(r.label).toBe("INBOX");
    expect(r.count).toBe(1);
    expect(r.emails[0]).toMatchObject({ id: "m1", sender: "Alice <alice@x.com>", subject: "Hi", date: "Wed, 21 May 2026 10:30:00 +0000", snippet: "Hi there..." });
  });
  it("surfaces next_page_token when present", async () => {
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [] } });
    mockGmail.users.messages.list.mockResolvedValue({ data: { messages: [], nextPageToken: "TOKEN_NEXT" } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_list_emails({ label: "INBOX" }));
    expect(r.next_page_token).toBe("TOKEN_NEXT");
  });
  it("uses unread_only via q='is:unread'", async () => {
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [] } });
    mockGmail.users.messages.list.mockResolvedValue({ data: { messages: [] } });
    const { HANDLERS } = await import("../src/tools.js");
    await HANDLERS.gmail_list_emails({ label: "INBOX", unread_only: true });
    expect(mockGmail.users.messages.list).toHaveBeenCalledWith(expect.objectContaining({ q: "is:unread" }));
  });
});

describe("gmail_read_email", () => {
  it("returns id, from, to, subject, date, body, labels, attachments", async () => {
    function b64url(s: string) { return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
    mockGmail.users.messages.get.mockResolvedValue({ data: {
      id: "m1", labelIds: ["INBOX", "Work"],
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "Alice <alice@x.com>" }, { name: "To", value: "you@x.com" },
          { name: "Subject", value: "Hi" }, { name: "Date", value: "Wed, 21 May 2026 10:30:00 +0000" },
        ],
        parts: [
          { mimeType: "text/plain", body: { data: b64url("Hello!") } },
          { mimeType: "application/pdf", filename: "doc.pdf", body: { attachmentId: "ATT_1", size: 1234 } },
        ],
      },
    } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_read_email({ message_id: "m1" }));
    expect(r.id).toBe("m1");
    expect(r.from).toBe("Alice <alice@x.com>");
    expect(r.subject).toBe("Hi");
    expect(r.body).toBe("Hello!");
    expect(r.labels).toEqual(["INBOX", "Work"]);
    expect(r.attachments).toEqual([{ filename: "doc.pdf", mime_type: "application/pdf", size: 1234, attachment_id: "ATT_1" }]);
  });
  it("omits attachments field when message has none", async () => {
    function b64url(s: string) { return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
    mockGmail.users.messages.get.mockResolvedValue({ data: {
      id: "m1", labelIds: [],
      payload: { mimeType: "text/plain", headers: [], body: { data: b64url("plain body") } },
    } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_read_email({ message_id: "m1" }));
    expect("attachments" in r).toBe(false);
  });
});

describe("gmail_search_emails", () => {
  it("passes the query through and surfaces next_page_token", async () => {
    mockGmail.users.messages.list.mockResolvedValue({ data: { messages: [{ id: "m1" }], nextPageToken: "T" } });
    mockGmail.users.messages.get.mockResolvedValue({ data: { id: "m1", snippet: "...", payload: { headers: [{ name: "From", value: "a@x.com" }] } } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_search_emails({ query: "from:alice", limit: 5 }));
    expect(r.query).toBe("from:alice");
    expect(r.count).toBe(1);
    expect(r.next_page_token).toBe("T");
    expect(mockGmail.users.messages.list).toHaveBeenCalledWith(expect.objectContaining({ q: "from:alice" }));
  });
});
```

- [ ] **Step 2: Run tests — confirm failure**

Run: `npx vitest run tests/handlers-read.test.ts` → all FAIL.

- [ ] **Step 3: Add to `src/tools.ts` — append these handlers inside the HANDLERS object**

```typescript
// Add to imports near the top of the file:
import { decodeBody } from "./format.js";
import { extractAttachments } from "./attachments.js";

// Add inside HANDLERS object (alongside the sorting handlers from Task 9):

  async gmail_list_labels(raw) {
    z.object({}).passthrough().parse(raw);
    return wrap("gmail_list_labels", async () => {
      const gmail = await getGmail();
      const res = await withRetry(() => gmail.users.labels.list({ userId: "me" }));
      const labels = (res.data.labels ?? [])
        .map((l) => ({ name: l.name ?? "", id: l.id ?? "", type: l.type ?? "user", total: l.messagesTotal ?? 0, unread: l.messagesUnread ?? 0 }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { status: "ok", labels };
    });
  },

  async gmail_list_emails(raw) {
    const { label, limit, unread_only, page_token } = z.object({
      label: z.string().default("INBOX"),
      limit: z.number().default(20),
      unread_only: z.boolean().default(false),
      page_token: z.string().nullish(),
    }).parse(raw);
    return wrap("gmail_list_emails", async () => {
      const gmail = await getGmail();
      // Resolve label name → ID
      const labelsRes = await withRetry(() => gmail.users.labels.list({ userId: "me" }));
      const labelByName: Record<string, string> = {};
      for (const l of (labelsRes.data.labels ?? [])) if (l.name && l.id) labelByName[l.name] = l.id;
      const labelId = labelByName[label] ?? label;
      const listRes = await withRetry(() => gmail.users.messages.list({
        userId: "me",
        labelIds: [labelId],
        maxResults: limit,
        ...(unread_only ? { q: "is:unread" } : {}),
        ...(page_token ? { pageToken: page_token } : {}),
      }));
      const emails = await Promise.all(
        (listRes.data.messages ?? []).map(async (ref) => {
          const msg = await withRetry(() => gmail.users.messages.get({ userId: "me", id: ref.id!, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] }));
          const h = msg.data.payload?.headers ?? [];
          return { id: msg.data.id!, sender: extractHeader(h, "From"), subject: extractHeader(h, "Subject"), date: extractHeader(h, "Date"), snippet: msg.data.snippet ?? "" };
        }),
      );
      return { status: "ok", label, count: emails.length, emails, ...(listRes.data.nextPageToken ? { next_page_token: listRes.data.nextPageToken } : {}) };
    });
  },

  async gmail_read_email(raw) {
    const { message_id } = z.object({ message_id: z.string() }).parse(raw);
    return wrap("gmail_read_email", async () => {
      const gmail = await getGmail();
      const msg = await withRetry(() => gmail.users.messages.get({ userId: "me", id: message_id, format: "full" }));
      const h = msg.data.payload?.headers ?? [];
      const attachments = extractAttachments(msg.data.payload ?? undefined);
      const body = decodeBody(msg.data.payload ?? undefined).slice(0, 10000);
      return {
        status: "ok",
        id: msg.data.id!,
        from: extractHeader(h, "From"),
        to: extractHeader(h, "To"),
        subject: extractHeader(h, "Subject"),
        date: extractHeader(h, "Date"),
        body,
        labels: msg.data.labelIds ?? [],
        ...(attachments.length > 0 ? { attachments } : {}),
      };
    });
  },

  async gmail_search_emails(raw) {
    const { query, limit, page_token } = z.object({
      query: z.string(),
      limit: z.number().default(20),
      page_token: z.string().nullish(),
    }).parse(raw);
    return wrap("gmail_search_emails", async () => {
      const gmail = await getGmail();
      const listRes = await withRetry(() => gmail.users.messages.list({
        userId: "me", q: query, maxResults: limit,
        ...(page_token ? { pageToken: page_token } : {}),
      }));
      const emails = await Promise.all(
        (listRes.data.messages ?? []).map(async (ref) => {
          const msg = await withRetry(() => gmail.users.messages.get({ userId: "me", id: ref.id!, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] }));
          const h = msg.data.payload?.headers ?? [];
          return { id: msg.data.id!, sender: extractHeader(h, "From"), subject: extractHeader(h, "Subject"), date: extractHeader(h, "Date"), snippet: msg.data.snippet ?? "" };
        }),
      );
      return { status: "ok", query, count: emails.length, emails, ...(listRes.data.nextPageToken ? { next_page_token: listRes.data.nextPageToken } : {}) };
    });
  },
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/handlers-read.test.ts` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts tests/handlers-read.test.ts
git commit -m "feat(ts): read handlers with pagination and attachment metadata"
```

---

## Task 11: HANDLERS — organize + mark (6 tools, with batch delete)

**Files:**
- Modify: `src/tools.ts`
- Create: `tests/handlers-organize.test.ts`

**Spec refs:** F6 (batch_delete), §1.1 (organize + mark tools).

- [ ] **Step 1: Write failing tests `tests/handlers-organize.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let mockGmail: ReturnType<typeof makeMockGmail>;
function makeMockGmail() {
  return {
    users: {
      labels: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
      messages: { modify: vi.fn(), trash: vi.fn(), delete: vi.fn(), batchDelete: vi.fn() },
    },
  };
}
vi.mock("../src/client.js", () => ({
  getGmail: async () => mockGmail,
  withRetry: <T>(fn: () => Promise<T>) => fn(),
  wrap: async (_: string, fn: () => Promise<unknown>) => {
    try { return JSON.stringify(await fn()); }
    catch (err) { return JSON.stringify({ status: "error", error: (err as Error).message }); }
  },
}));

beforeEach(() => { mockGmail = makeMockGmail(); });
afterEach(() => vi.resetModules());

describe("gmail_move_emails", () => {
  it("adds target label and removes INBOX for each ID", async () => {
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [{ id: "L_W", name: "Work" }] } });
    mockGmail.users.messages.modify.mockResolvedValue({ data: {} });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_move_emails({ message_ids: ["m1", "m2"], label: "Work" }));
    expect(r.status).toBe("ok");
    expect(r.moved).toBe(2);
    expect(r.target_label).toBe("Work");
    expect(mockGmail.users.messages.modify).toHaveBeenCalledTimes(2);
  });
});

describe("gmail_delete_emails", () => {
  it("trashes (not permanent) by default", async () => {
    mockGmail.users.messages.trash.mockResolvedValue({ data: {} });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_delete_emails({ message_ids: ["m1", "m2"] }));
    expect(r).toEqual({ status: "ok", deleted: 2, permanent: false });
    expect(mockGmail.users.messages.trash).toHaveBeenCalledTimes(2);
    expect(mockGmail.users.messages.batchDelete).not.toHaveBeenCalled();
  });
  it("uses batchDelete in ONE call when permanent=true", async () => {
    mockGmail.users.messages.batchDelete.mockResolvedValue({ data: {} });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_delete_emails({ message_ids: ["m1", "m2", "m3"], permanent: true }));
    expect(r).toEqual({ status: "ok", deleted: 3, permanent: true });
    expect(mockGmail.users.messages.batchDelete).toHaveBeenCalledTimes(1);
    expect(mockGmail.users.messages.batchDelete).toHaveBeenCalledWith({ userId: "me", requestBody: { ids: ["m1", "m2", "m3"] } });
    expect(mockGmail.users.messages.delete).not.toHaveBeenCalled();
  });
});

describe("gmail_create_label", () => {
  it("creates label with show visibility", async () => {
    mockGmail.users.labels.create.mockResolvedValue({ data: { id: "Label_42", name: "Foo" } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_create_label({ name: "Foo" }));
    expect(r).toEqual({ status: "ok", label: "Foo", id: "Label_42" });
  });
});

describe("gmail_rename_label", () => {
  it("renames an existing label", async () => {
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [{ id: "L1", name: "Old" }] } });
    mockGmail.users.labels.update.mockResolvedValue({ data: { id: "L1", name: "New" } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_rename_label({ old_name: "Old", new_name: "New" }));
    expect(r).toEqual({ status: "ok", old_name: "Old", new_name: "New" });
  });
  it("returns error if label not found", async () => {
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [] } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_rename_label({ old_name: "Nope", new_name: "X" }));
    expect(r).toEqual({ status: "error", message: "Label 'Nope' not found" });
  });
});

describe("gmail_delete_label", () => {
  it("deletes an existing label", async () => {
    mockGmail.users.labels.list.mockResolvedValue({ data: { labels: [{ id: "L1", name: "DropMe" }] } });
    mockGmail.users.labels.delete.mockResolvedValue({ data: {} });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_delete_label({ name: "DropMe" }));
    expect(r).toEqual({ status: "ok", deleted: "DropMe" });
  });
});

describe("gmail_mark_emails", () => {
  it.each([
    ["read", { removeLabelIds: ["UNREAD"] }],
    ["unread", { addLabelIds: ["UNREAD"] }],
    ["star", { addLabelIds: ["STARRED"] }],
    ["unstar", { removeLabelIds: ["STARRED"] }],
  ])("action=%s applies the right label op", async (action, expectedBody) => {
    mockGmail.users.messages.modify.mockResolvedValue({ data: {} });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_mark_emails({ message_ids: ["m1"], action }));
    expect(r).toEqual({ status: "ok", marked: 1, action });
    expect(mockGmail.users.messages.modify).toHaveBeenCalledWith({ userId: "me", id: "m1", requestBody: expect.objectContaining(expectedBody) });
  });
  it("rejects unknown action", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_mark_emails({ message_ids: ["m1"], action: "foo" }));
    expect(r).toEqual({ status: "error", message: "Unknown action: foo. Use: read, unread, star, unstar" });
  });
});
```

- [ ] **Step 2: Run tests — confirm failure**

Run: `npx vitest run tests/handlers-organize.test.ts` → FAIL.

- [ ] **Step 3: Add handlers to `src/tools.ts` (inside the HANDLERS object)**

```typescript
  async gmail_move_emails(raw) {
    const { message_ids, label } = z.object({ message_ids: z.array(z.string()), label: z.string() }).parse(raw);
    return wrap("gmail_move_emails", async () => {
      const gmail = await getGmail();
      const labelsRes = await withRetry(() => gmail.users.labels.list({ userId: "me" }));
      const labelByName: Record<string, string> = {};
      for (const l of (labelsRes.data.labels ?? [])) if (l.name && l.id) labelByName[l.name] = l.id;
      const targetId = labelByName[label] ?? label;
      for (const id of message_ids) {
        await withRetry(() => gmail.users.messages.modify({ userId: "me", id, requestBody: { addLabelIds: [targetId], removeLabelIds: ["INBOX"] } }));
      }
      return { status: "ok", moved: message_ids.length, target_label: label };
    });
  },

  async gmail_delete_emails(raw) {
    const { message_ids, permanent } = z.object({ message_ids: z.array(z.string()), permanent: z.boolean().default(false) }).parse(raw);
    return wrap("gmail_delete_emails", async () => {
      const gmail = await getGmail();
      if (permanent) {
        // Batch in one API call
        await withRetry(() => gmail.users.messages.batchDelete({ userId: "me", requestBody: { ids: message_ids } }));
      } else {
        for (const id of message_ids) {
          await withRetry(() => gmail.users.messages.trash({ userId: "me", id }));
        }
      }
      return { status: "ok", deleted: message_ids.length, permanent };
    });
  },

  async gmail_create_label(raw) {
    const { name } = z.object({ name: z.string() }).parse(raw);
    return wrap("gmail_create_label", async () => {
      const gmail = await getGmail();
      const res = await withRetry(() => gmail.users.labels.create({ userId: "me", requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" } }));
      return { status: "ok", label: res.data.name ?? name, id: res.data.id ?? "" };
    });
  },

  async gmail_rename_label(raw) {
    const { old_name, new_name } = z.object({ old_name: z.string(), new_name: z.string() }).parse(raw);
    return wrap("gmail_rename_label", async () => {
      const gmail = await getGmail();
      const labelsRes = await withRetry(() => gmail.users.labels.list({ userId: "me" }));
      const match = (labelsRes.data.labels ?? []).find((l) => l.name === old_name);
      if (!match?.id) return { status: "error", message: `Label '${old_name}' not found` };
      await withRetry(() => gmail.users.labels.update({ userId: "me", id: match.id!, requestBody: { id: match.id!, name: new_name } }));
      return { status: "ok", old_name, new_name };
    });
  },

  async gmail_delete_label(raw) {
    const { name } = z.object({ name: z.string() }).parse(raw);
    return wrap("gmail_delete_label", async () => {
      const gmail = await getGmail();
      const labelsRes = await withRetry(() => gmail.users.labels.list({ userId: "me" }));
      const match = (labelsRes.data.labels ?? []).find((l) => l.name === name);
      if (!match?.id) return { status: "error", message: `Label '${name}' not found` };
      await withRetry(() => gmail.users.labels.delete({ userId: "me", id: match.id! }));
      return { status: "ok", deleted: name };
    });
  },

  async gmail_mark_emails(raw) {
    const { message_ids, action } = z.object({ message_ids: z.array(z.string()), action: z.string() }).parse(raw);
    return wrap("gmail_mark_emails", async () => {
      const ops: Record<string, { addLabelIds?: string[]; removeLabelIds?: string[] }> = {
        read: { removeLabelIds: ["UNREAD"] },
        unread: { addLabelIds: ["UNREAD"] },
        star: { addLabelIds: ["STARRED"] },
        unstar: { removeLabelIds: ["STARRED"] },
      };
      const body = ops[action];
      if (!body) return { status: "error", message: `Unknown action: ${action}. Use: read, unread, star, unstar` };
      const gmail = await getGmail();
      for (const id of message_ids) {
        await withRetry(() => gmail.users.messages.modify({ userId: "me", id, requestBody: body }));
      }
      return { status: "ok", marked: message_ids.length, action };
    });
  },
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/handlers-organize.test.ts` → pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts tests/handlers-organize.test.ts
git commit -m "feat(ts): organize + mark handlers; batchDelete on permanent=true"
```

---

## Task 12: HANDLERS — compose (3 tools, with attachments + References chain)

**Files:**
- Modify: `src/tools.ts`
- Create: `tests/handlers-compose.test.ts`

**Spec refs:** §7.3 (attachments), §8 (References chain), §1.1 (compose).

- [ ] **Step 1: Write failing tests `tests/handlers-compose.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let mockGmail: ReturnType<typeof makeMockGmail>;
function makeMockGmail() {
  return {
    users: {
      getProfile: vi.fn().mockResolvedValue({ data: { emailAddress: "me@x.com" } }),
      messages: { send: vi.fn(), get: vi.fn() },
    },
  };
}
vi.mock("../src/client.js", () => ({
  getGmail: async () => mockGmail,
  withRetry: <T>(fn: () => Promise<T>) => fn(),
  wrap: async (_: string, fn: () => Promise<unknown>) => {
    try { return JSON.stringify(await fn()); }
    catch (err) { return JSON.stringify({ status: "error", error: (err as Error).message }); }
  },
}));

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "gmail-mcp-comp-")); mockGmail = makeMockGmail(); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); vi.resetModules(); });

function decodeRaw(call: { raw?: string }): string {
  return Buffer.from(call.raw!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

describe("gmail_send_email", () => {
  it("sends a plain-text email", async () => {
    mockGmail.users.messages.send.mockResolvedValue({ data: { id: "msg_new" } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_send_email({ to: "a@b.c", subject: "Hi", body: "Hello" }));
    expect(r).toEqual({ status: "ok", message_id: "msg_new" });
    const sent = mockGmail.users.messages.send.mock.calls[0][0].requestBody as { raw: string };
    expect(decodeRaw(sent)).toContain("To: a@b.c");
    expect(decodeRaw(sent)).toContain("Subject: Hi");
  });
  it("sends with attachments (multipart/mixed)", async () => {
    const path = join(tmp, "doc.txt");
    writeFileSync(path, "ATTACHMENT");
    mockGmail.users.messages.send.mockResolvedValue({ data: { id: "msg_att" } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_send_email({ to: "a@b.c", subject: "Hi", body: "see attached", attachments: [path] }));
    expect(r.status).toBe("ok");
    const sent = mockGmail.users.messages.send.mock.calls[0][0].requestBody as { raw: string };
    const decoded = decodeRaw(sent);
    expect(decoded).toContain("Content-Type: multipart/mixed");
    expect(decoded).toContain("filename=\"doc.txt\"");
  });
});

describe("gmail_reply_email", () => {
  it("preserves thread and constructs References chain", async () => {
    mockGmail.users.messages.get.mockResolvedValue({ data: {
      threadId: "thread_xyz",
      payload: { headers: [
        { name: "Subject", value: "Hi" },
        { name: "From", value: "Alice <alice@x.com>" },
        { name: "Message-ID", value: "<orig@x.com>" },
        { name: "References", value: "<old1@y.com> <old2@y.com>" },
      ] },
    } });
    mockGmail.users.messages.send.mockResolvedValue({ data: { id: "msg_reply", threadId: "thread_xyz" } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_reply_email({ message_id: "orig_id", body: "thx" }));
    expect(r).toEqual({ status: "ok", message_id: "msg_reply", thread_id: "thread_xyz" });
    const sent = mockGmail.users.messages.send.mock.calls[0][0] as { requestBody: { raw: string; threadId: string } };
    expect(sent.threadId).toBe("thread_xyz");
    const decoded = decodeRaw(sent.requestBody);
    expect(decoded).toContain("In-Reply-To: <orig@x.com>");
    expect(decoded).toContain("References: <old1@y.com> <old2@y.com> <orig@x.com>");
    expect(decoded).toContain("Subject: Re: Hi");
  });
  it("auto-prefixes 'Re: ' only if missing", async () => {
    mockGmail.users.messages.get.mockResolvedValue({ data: {
      threadId: "thread_a",
      payload: { headers: [{ name: "Subject", value: "Re: existing" }, { name: "From", value: "a@x.com" }, { name: "Message-ID", value: "<a@x.com>" }] },
    } });
    mockGmail.users.messages.send.mockResolvedValue({ data: { id: "m", threadId: "thread_a" } });
    const { HANDLERS } = await import("../src/tools.js");
    await HANDLERS.gmail_reply_email({ message_id: "x", body: "y" });
    const decoded = decodeRaw((mockGmail.users.messages.send.mock.calls[0][0] as { requestBody: { raw: string } }).requestBody);
    expect(decoded).toContain("Subject: Re: existing");  // not Re: Re:
  });
});

describe("gmail_forward_email", () => {
  it("constructs forwarded body and auto-prefixes Fwd:", async () => {
    function b64url(s: string) { return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
    mockGmail.users.messages.get.mockResolvedValue({ data: {
      payload: { mimeType: "text/plain", headers: [
        { name: "Subject", value: "Original" }, { name: "From", value: "Alice <alice@x.com>" },
      ], body: { data: b64url("original body") } },
    } });
    mockGmail.users.messages.send.mockResolvedValue({ data: { id: "msg_fwd" } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_forward_email({ message_id: "x", to: "c@d.e", body: "FYI" }));
    expect(r.status).toBe("ok");
    expect(r.forwarded_to).toBe("c@d.e");
    const decoded = decodeRaw((mockGmail.users.messages.send.mock.calls[0][0] as { requestBody: { raw: string } }).requestBody);
    expect(decoded).toContain("Subject: Fwd: Original");
    expect(decoded).toContain("---------- Forwarded message ----------");
    expect(decoded).toContain("From: Alice <alice@x.com>");
    expect(decoded).toContain("original body");
  });
});
```

- [ ] **Step 2: Run tests — confirm failure**

- [ ] **Step 3: Add handlers to `src/tools.ts`**

```typescript
// Add imports at top:
import { buildPlainMessage, buildMultipartMessage } from "./mime.js";
import { readLocalAttachment } from "./attachments.js";

// Add helper above HANDLERS:
function buildMessage(opts: {
  to: string; subject: string; body: string; cc?: string;
  inReplyTo?: string; references?: string; from?: string;
  attachments?: string[];
}): string {
  if (opts.attachments && opts.attachments.length > 0) {
    return buildMultipartMessage({
      ...opts,
      attachments: opts.attachments.map(readLocalAttachment),
    });
  }
  return buildPlainMessage(opts);
}

function buildReferencesChain(origReferences: string, origMessageId: string): string {
  const trimmed = origReferences.trim();
  return trimmed ? `${trimmed} ${origMessageId}` : origMessageId;
}

// Add inside HANDLERS:

  async gmail_send_email(raw) {
    const args = z.object({
      to: z.string(), subject: z.string(), body: z.string(),
      cc: z.string().nullish(), attachments: z.array(z.string()).nullish(),
    }).parse(raw);
    return wrap("gmail_send_email", async () => {
      const gmail = await getGmail();
      const message = buildMessage({
        to: args.to, subject: args.subject, body: args.body,
        cc: args.cc ?? undefined,
        attachments: args.attachments ?? undefined,
      });
      const res = await withRetry(() => gmail.users.messages.send({ userId: "me", requestBody: { raw: message } }));
      return { status: "ok", message_id: res.data.id ?? "" };
    });
  },

  async gmail_reply_email(raw) {
    const args = z.object({
      message_id: z.string(), body: z.string(),
      attachments: z.array(z.string()).nullish(),
    }).parse(raw);
    return wrap("gmail_reply_email", async () => {
      const gmail = await getGmail();
      const orig = await withRetry(() => gmail.users.messages.get({ userId: "me", id: args.message_id, format: "metadata", metadataHeaders: ["Subject", "From", "Message-ID", "References"] }));
      const h = orig.data.payload?.headers ?? [];
      const origSubject = extractHeader(h, "Subject");
      const origFrom = extractHeader(h, "From");
      const origMsgId = extractHeader(h, "Message-ID");
      const origRefs = extractHeader(h, "References");
      const subject = /^re:\s/i.test(origSubject) ? origSubject : `Re: ${origSubject}`;
      const message = buildMessage({
        to: origFrom,
        subject,
        body: args.body,
        inReplyTo: origMsgId,
        references: buildReferencesChain(origRefs, origMsgId),
        attachments: args.attachments ?? undefined,
      });
      const res = await withRetry(() => gmail.users.messages.send({ userId: "me", requestBody: { raw: message, threadId: orig.data.threadId ?? undefined } }));
      return { status: "ok", message_id: res.data.id ?? "", thread_id: res.data.threadId ?? orig.data.threadId ?? "" };
    });
  },

  async gmail_forward_email(raw) {
    const args = z.object({
      message_id: z.string(), to: z.string(),
      body: z.string().default(""),
      attachments: z.array(z.string()).nullish(),
    }).parse(raw);
    return wrap("gmail_forward_email", async () => {
      const gmail = await getGmail();
      const orig = await withRetry(() => gmail.users.messages.get({ userId: "me", id: args.message_id, format: "full" }));
      const h = orig.data.payload?.headers ?? [];
      const origSubject = extractHeader(h, "Subject");
      const origFrom = extractHeader(h, "From");
      const origBody = decodeBody(orig.data.payload ?? undefined);
      const subject = /^fwd:\s/i.test(origSubject) ? origSubject : `Fwd: ${origSubject}`;
      const forwardBody = `${args.body}\n\n---------- Forwarded message ----------\nFrom: ${origFrom}\nSubject: ${origSubject}\n\n${origBody}`;
      const message = buildMessage({
        to: args.to,
        subject,
        body: forwardBody,
        attachments: args.attachments ?? undefined,
      });
      const res = await withRetry(() => gmail.users.messages.send({ userId: "me", requestBody: { raw: message } }));
      return { status: "ok", message_id: res.data.id ?? "", forwarded_to: args.to };
    });
  },
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/handlers-compose.test.ts` → pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts tests/handlers-compose.test.ts
git commit -m "feat(ts): compose handlers; References chain; attachment support"
```

---

## Task 13: HANDLERS — draft (6 tools, with attachments + References chain)

**Files:**
- Modify: `src/tools.ts`
- Create: `tests/handlers-draft.test.ts`

**Spec refs:** §1.1 (draft tools), §8 (References chain on create with in_reply_to).

- [ ] **Step 1: Write failing tests `tests/handlers-draft.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let mockGmail: ReturnType<typeof makeMockGmail>;
function makeMockGmail() {
  return {
    users: {
      drafts: { create: vi.fn(), list: vi.fn(), get: vi.fn(), update: vi.fn(), send: vi.fn(), delete: vi.fn() },
      messages: { get: vi.fn() },
    },
  };
}
vi.mock("../src/client.js", () => ({
  getGmail: async () => mockGmail,
  withRetry: <T>(fn: () => Promise<T>) => fn(),
  wrap: async (_: string, fn: () => Promise<unknown>) => {
    try { return JSON.stringify(await fn()); }
    catch (err) { return JSON.stringify({ status: "error", error: (err as Error).message }); }
  },
}));
beforeEach(() => { mockGmail = makeMockGmail(); });
afterEach(() => vi.resetModules());

function decodeRaw(rb: { raw?: string }): string {
  return Buffer.from(rb.raw!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

describe("gmail_create_draft", () => {
  it("creates a non-threaded draft", async () => {
    mockGmail.users.drafts.create.mockResolvedValue({ data: { id: "draft_1", message: { id: "msg_1", threadId: "thread_1" } } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_create_draft({ to: "a@b.c", subject: "Hi", body: "Body" }));
    expect(r).toEqual({ status: "ok", draft_id: "draft_1", message_id: "msg_1", thread_id: "thread_1" });
  });
  it("threads when in_reply_to is set and includes References chain", async () => {
    mockGmail.users.messages.get.mockResolvedValue({ data: {
      threadId: "thread_orig",
      payload: { headers: [
        { name: "Message-ID", value: "<orig@x.com>" }, { name: "References", value: "<a@y.com>" },
      ] },
    } });
    mockGmail.users.drafts.create.mockResolvedValue({ data: { id: "draft_2", message: { id: "msg_2", threadId: "thread_orig" } } });
    const { HANDLERS } = await import("../src/tools.js");
    await HANDLERS.gmail_create_draft({ to: "x@y.com", subject: "Re: Hi", body: "thx", in_reply_to: "orig_id" });
    const sent = mockGmail.users.drafts.create.mock.calls[0][0].requestBody as { message: { raw: string; threadId: string } };
    expect(sent.message.threadId).toBe("thread_orig");
    const decoded = decodeRaw(sent.message);
    expect(decoded).toContain("In-Reply-To: <orig@x.com>");
    expect(decoded).toContain("References: <a@y.com> <orig@x.com>");
  });
});

describe("gmail_list_drafts", () => {
  it("returns drafts with snippet, threading, and surfaces next_page_token", async () => {
    mockGmail.users.drafts.list.mockResolvedValue({ data: { drafts: [{ id: "draft_1" }], nextPageToken: "TOK" } });
    mockGmail.users.drafts.get.mockResolvedValue({ data: {
      id: "draft_1", message: { id: "msg", threadId: "thr", snippet: "hi", payload: { headers: [
        { name: "To", value: "x@y.com" }, { name: "Subject", value: "Hello" },
      ] } },
    } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_list_drafts({ limit: 5 }));
    expect(r.count).toBe(1);
    expect(r.next_page_token).toBe("TOK");
    expect(r.drafts[0]).toMatchObject({ draft_id: "draft_1", message_id: "msg", thread_id: "thr", to: "x@y.com", subject: "Hello", snippet: "hi" });
  });
});

describe("gmail_get_draft", () => {
  it("returns full draft with body + attachments", async () => {
    function b64url(s: string) { return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
    mockGmail.users.drafts.get.mockResolvedValue({ data: {
      id: "draft_x", message: { id: "msg_x", threadId: "thr_x", payload: { mimeType: "text/plain", headers: [
        { name: "To", value: "a@b.c" }, { name: "Subject", value: "S" }, { name: "Cc", value: "c@d.e" },
      ], body: { data: b64url("body!") } } },
    } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_get_draft({ draft_id: "draft_x" }));
    expect(r).toMatchObject({ draft_id: "draft_x", message_id: "msg_x", thread_id: "thr_x", to: "a@b.c", cc: "c@d.e", subject: "S", body: "body!" });
  });
});

describe("gmail_update_draft", () => {
  it("preserves threadId and References from existing draft", async () => {
    mockGmail.users.drafts.get.mockResolvedValue({ data: {
      id: "draft_u", message: { threadId: "thr_u", payload: { headers: [
        { name: "In-Reply-To", value: "<a@x.com>" }, { name: "References", value: "<a@x.com>" },
      ] } },
    } });
    mockGmail.users.drafts.update.mockResolvedValue({ data: { id: "draft_u", message: { id: "msg_u", threadId: "thr_u" } } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_update_draft({ draft_id: "draft_u", to: "x@y.com", subject: "New", body: "B" }));
    expect(r).toMatchObject({ draft_id: "draft_u", message_id: "msg_u", thread_id: "thr_u" });
    const sent = mockGmail.users.drafts.update.mock.calls[0][0].requestBody as { message: { raw: string; threadId: string } };
    expect(sent.message.threadId).toBe("thr_u");
    const decoded = decodeRaw(sent.message);
    expect(decoded).toContain("In-Reply-To: <a@x.com>");
  });
});

describe("gmail_send_draft", () => {
  it("sends and returns message + thread ids", async () => {
    mockGmail.users.drafts.send.mockResolvedValue({ data: { id: "msg_final", threadId: "thr_final" } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_send_draft({ draft_id: "draft_1" }));
    expect(r).toEqual({ status: "ok", message_id: "msg_final", thread_id: "thr_final" });
  });
});

describe("gmail_delete_draft", () => {
  it("deletes the draft", async () => {
    mockGmail.users.drafts.delete.mockResolvedValue({ data: {} });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_delete_draft({ draft_id: "draft_x" }));
    expect(r).toEqual({ status: "ok", draft_id: "draft_x", deleted: true });
  });
});
```

- [ ] **Step 2: Run tests — confirm failure**

- [ ] **Step 3: Add handlers to `src/tools.ts`**

```typescript
// Add inside HANDLERS:

  async gmail_create_draft(raw) {
    const args = z.object({
      to: z.string(), subject: z.string(), body: z.string(),
      cc: z.string().nullish(), in_reply_to: z.string().nullish(),
      attachments: z.array(z.string()).nullish(),
    }).parse(raw);
    return wrap("gmail_create_draft", async () => {
      const gmail = await getGmail();
      let threadId: string | undefined;
      let inReplyTo: string | undefined;
      let references: string | undefined;
      if (args.in_reply_to) {
        const orig = await withRetry(() => gmail.users.messages.get({ userId: "me", id: args.in_reply_to!, format: "metadata", metadataHeaders: ["Message-ID", "References"] }));
        const h = orig.data.payload?.headers ?? [];
        threadId = orig.data.threadId ?? undefined;
        inReplyTo = extractHeader(h, "Message-ID");
        references = buildReferencesChain(extractHeader(h, "References"), inReplyTo);
      }
      const message = buildMessage({
        to: args.to, subject: args.subject, body: args.body,
        cc: args.cc ?? undefined, inReplyTo, references,
        attachments: args.attachments ?? undefined,
      });
      const res = await withRetry(() => gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw: message, threadId } } }));
      return { status: "ok", draft_id: res.data.id ?? "", message_id: res.data.message?.id ?? "", thread_id: res.data.message?.threadId ?? "" };
    });
  },

  async gmail_list_drafts(raw) {
    const { limit, page_token } = z.object({ limit: z.number().default(20), page_token: z.string().nullish() }).parse(raw);
    return wrap("gmail_list_drafts", async () => {
      const gmail = await getGmail();
      const listRes = await withRetry(() => gmail.users.drafts.list({ userId: "me", maxResults: limit, ...(page_token ? { pageToken: page_token } : {}) }));
      const drafts = await Promise.all((listRes.data.drafts ?? []).map(async (d) => {
        const draft = await withRetry(() => gmail.users.drafts.get({ userId: "me", id: d.id!, format: "metadata" }));
        const headers = draft.data.message?.payload?.headers ?? [];
        return {
          draft_id: draft.data.id ?? "",
          message_id: draft.data.message?.id ?? "",
          thread_id: draft.data.message?.threadId ?? "",
          to: extractHeader(headers, "To"),
          subject: extractHeader(headers, "Subject"),
          snippet: draft.data.message?.snippet ?? "",
        };
      }));
      return { status: "ok", count: drafts.length, drafts, ...(listRes.data.nextPageToken ? { next_page_token: listRes.data.nextPageToken } : {}) };
    });
  },

  async gmail_get_draft(raw) {
    const { draft_id } = z.object({ draft_id: z.string() }).parse(raw);
    return wrap("gmail_get_draft", async () => {
      const gmail = await getGmail();
      const draft = await withRetry(() => gmail.users.drafts.get({ userId: "me", id: draft_id, format: "full" }));
      const headers = draft.data.message?.payload?.headers ?? [];
      const attachments = extractAttachments(draft.data.message?.payload ?? undefined);
      const body = decodeBody(draft.data.message?.payload ?? undefined);
      return {
        status: "ok",
        draft_id: draft.data.id ?? "",
        message_id: draft.data.message?.id ?? "",
        thread_id: draft.data.message?.threadId ?? "",
        to: extractHeader(headers, "To"),
        cc: extractHeader(headers, "Cc"),
        subject: extractHeader(headers, "Subject"),
        body,
        ...(attachments.length > 0 ? { attachments } : {}),
      };
    });
  },

  async gmail_update_draft(raw) {
    const args = z.object({
      draft_id: z.string(), to: z.string(), subject: z.string(), body: z.string(),
      cc: z.string().nullish(), attachments: z.array(z.string()).nullish(),
    }).parse(raw);
    return wrap("gmail_update_draft", async () => {
      const gmail = await getGmail();
      const existing = await withRetry(() => gmail.users.drafts.get({ userId: "me", id: args.draft_id, format: "metadata", metadataHeaders: ["In-Reply-To", "References"] }));
      const h = existing.data.message?.payload?.headers ?? [];
      const threadId = existing.data.message?.threadId ?? undefined;
      const inReplyTo = extractHeader(h, "In-Reply-To") || undefined;
      const references = extractHeader(h, "References") || undefined;
      const message = buildMessage({
        to: args.to, subject: args.subject, body: args.body,
        cc: args.cc ?? undefined, inReplyTo, references,
        attachments: args.attachments ?? undefined,
      });
      const res = await withRetry(() => gmail.users.drafts.update({ userId: "me", id: args.draft_id, requestBody: { message: { raw: message, threadId } } }));
      return { status: "ok", draft_id: args.draft_id, message_id: res.data.message?.id ?? "", thread_id: res.data.message?.threadId ?? threadId ?? "" };
    });
  },

  async gmail_send_draft(raw) {
    const { draft_id } = z.object({ draft_id: z.string() }).parse(raw);
    return wrap("gmail_send_draft", async () => {
      const gmail = await getGmail();
      const res = await withRetry(() => gmail.users.drafts.send({ userId: "me", requestBody: { id: draft_id } }));
      return { status: "ok", message_id: res.data.id ?? "", thread_id: res.data.threadId ?? "" };
    });
  },

  async gmail_delete_draft(raw) {
    const { draft_id } = z.object({ draft_id: z.string() }).parse(raw);
    return wrap("gmail_delete_draft", async () => {
      const gmail = await getGmail();
      await withRetry(() => gmail.users.drafts.delete({ userId: "me", id: draft_id }));
      return { status: "ok", draft_id, deleted: true };
    });
  },
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/handlers-draft.test.ts` → pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts tests/handlers-draft.test.ts
git commit -m "feat(ts): draft handlers with attachments and References chain"
```

---

## Task 14: HANDLERS — download_attachment + smoke test green

**Files:**
- Modify: `src/tools.ts`
- Create: `tests/handlers-attachment.test.ts`

After this task, HANDLERS has all 24 entries and `smoke.test.ts` passes.

- [ ] **Step 1: Write failing tests `tests/handlers-attachment.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let mockGmail: ReturnType<typeof makeMockGmail>;
function makeMockGmail() {
  return { users: { messages: { get: vi.fn(), attachments: { get: vi.fn() } } } };
}
vi.mock("../src/client.js", () => ({
  getGmail: async () => mockGmail,
  withRetry: <T>(fn: () => Promise<T>) => fn(),
  wrap: async (_: string, fn: () => Promise<unknown>) => {
    try { return JSON.stringify(await fn()); }
    catch (err) { return JSON.stringify({ status: "error", error: (err as Error).message }); }
  },
}));

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "gmail-mcp-att-")); mockGmail = makeMockGmail(); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); vi.resetModules(); });

function b64url(s: string) {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("gmail_download_attachment", () => {
  it("downloads to an explicit file path", async () => {
    mockGmail.users.messages.get.mockResolvedValue({ data: { payload: { parts: [
      { mimeType: "application/pdf", filename: "report.pdf", body: { attachmentId: "ATT_1", size: 12 } },
    ] } } });
    mockGmail.users.messages.attachments.get.mockResolvedValue({ data: { data: b64url("PDFDATA12345"), size: 12 } });
    const dest = join(tmp, "got.pdf");
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_download_attachment({ message_id: "m1", attachment_id: "ATT_1", local_path: dest }));
    expect(r.status).toBe("ok");
    expect(r.local_path).toBe(dest);
    expect(readFileSync(dest, "utf8")).toBe("PDFDATA12345");
    expect(r.size).toBe(12);
  });
  it("accepts a directory path and infers filename from message metadata", async () => {
    mockGmail.users.messages.get.mockResolvedValue({ data: { payload: { parts: [
      { mimeType: "image/png", filename: "logo.png", body: { attachmentId: "ATT_2", size: 5 } },
    ] } } });
    mockGmail.users.messages.attachments.get.mockResolvedValue({ data: { data: b64url("PNG.."), size: 5 } });
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.gmail_download_attachment({ message_id: "m1", attachment_id: "ATT_2", local_path: tmp }));
    expect(r.status).toBe("ok");
    expect(r.local_path).toBe(join(tmp, "logo.png"));
    expect(existsSync(r.local_path)).toBe(true);
  });
});

describe("smoke test now passes (TOOLS↔HANDLERS symmetry)", () => {
  it("has 24 tools and 24 handlers", async () => {
    const { TOOLS, HANDLERS } = await import("../src/tools.js");
    expect(Object.keys(HANDLERS).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    expect(TOOLS.length).toBe(24);
  });
});
```

- [ ] **Step 2: Run tests — confirm failure**

- [ ] **Step 3: Add handler to `src/tools.ts`**

```typescript
// Add imports:
import { writeFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { dirname, join as pathJoin } from "node:path";
import { homedir } from "node:os";
import { attachmentToBuffer } from "./attachments.js";

// Add inside HANDLERS:
  async gmail_download_attachment(raw) {
    const { message_id, attachment_id, local_path } = z.object({
      message_id: z.string(), attachment_id: z.string(), local_path: z.string().nullish(),
    }).parse(raw);
    return wrap("gmail_download_attachment", async () => {
      const gmail = await getGmail();
      // Find the attachment's filename from message metadata
      const msg = await withRetry(() => gmail.users.messages.get({ userId: "me", id: message_id, format: "full" }));
      const attachments = extractAttachments(msg.data.payload ?? undefined);
      const meta = attachments.find((a) => a.attachment_id === attachment_id);
      if (!meta) throw new Error(`Attachment '${attachment_id}' not found in message '${message_id}'`);
      // Download
      const attRes = await withRetry(() => gmail.users.messages.attachments.get({ userId: "me", messageId: message_id, id: attachment_id }));
      const buf = attachmentToBuffer(attRes.data.data ?? "");
      // Resolve path
      let dest: string;
      if (!local_path) {
        dest = pathJoin(homedir(), "Downloads", meta.filename);
      } else if (existsSync(local_path) && statSync(local_path).isDirectory()) {
        dest = pathJoin(local_path, meta.filename);
      } else {
        dest = local_path;
      }
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, buf);
      return { status: "ok", local_path: dest, size: buf.length };
    });
  },
```

- [ ] **Step 4: Run tests + full suite**

Run: `npx vitest run tests/handlers-attachment.test.ts tests/smoke.test.ts` → all pass.
Run: `npx vitest run` → entire suite green, smoke included.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts tests/handlers-attachment.test.ts
git commit -m "feat(ts): download_attachment handler; smoke test green (24/24 symmetry)"
```

---

## Task 15: index.ts — MCP server wiring

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Write `src/index.ts`**

```typescript
#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HANDLERS, TOOLS } from "./tools.js";

const server = new Server(
  { name: "Gmail-mcp", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = HANDLERS[name];
  if (!handler) {
    return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: `unknown tool '${name}'` }) }], isError: true };
  }
  try {
    const text = await handler(args ?? {});
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Gmail-mcp: handler '${name}' threw: ${msg}\n`);
    return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: msg }) }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("Gmail-mcp: connected on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`Gmail-mcp: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Build + verify**

Run: `npm run build` → emits `dist/index.js`, `dist/auth-cli.js`, plus all module files.
Run: `npx vitest run` → ≥90 tests pass, smoke included.
Run: `npm run typecheck` → clean.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(ts): MCP server wiring with ListTools/CallTool dispatch"
```

---

## Task 16: Cutover + cleanup

**Files:**
- Modify: `C:/Users/danie/.claude/local-marketplace/mcp-host/.mcp.json` (cutover)
- Modify: `README.md`, `CHANGELOG.md`
- Remove: `server.py`, `server.js` (stale GWS wrapper), `requirements.txt`
- Retire: `C:/Users/danie/.venvs/gmail-mcp`

- [ ] **Step 1: Back up `.mcp.json`**

```bash
cp /c/Users/danie/.claude/local-marketplace/mcp-host/.mcp.json /c/Users/danie/.claude/local-marketplace/mcp-host/.mcp.json.bak-2026-05-23-pre-gmail-mcp-ts-cutover
```

- [ ] **Step 2: Edit `.mcp.json` — replace `gmail` block**

Old block (verify by reading first):
```json
"gmail": {
  "command": "C:/Users/danie/.venvs/gmail-mcp/Scripts/python.exe",
  "args": ["-X", "utf8", "C:/Users/danie/Dropbox/Github/gmail-mcp/server.py"],
  "env": { "_RETRY": "2026-05-19T04-55-13" }
}
```

New:
```json
"gmail": {
  "type": "stdio",
  "command": "node",
  "args": ["C:/Users/danie/Dropbox/Github/gmail-mcp/dist/index.js"],
  "env": { "_RETRY": "2026-05-23-gmail-mcp-ts-cutover" }
}
```

- [ ] **Step 3: Validate JSON**

Run: `python -c "import json; json.load(open(r'C:/Users/danie/.claude/local-marketplace/mcp-host/.mcp.json')); print('OK')"`

- [ ] **Step 4: User runs `/mcp-host:kill-plugins` then `/reload-plugins`** (controller hands off; subagent stops here)

- [ ] **Step 5: After reload, controller live-verifies**

Use the MCP tools to confirm the new server works:
- `mcp__gmail__gmail_list_labels` → returns 13 system labels + user labels (proves auth works end-to-end via refreshed googleapis client).
- `mcp__gmail__gmail_list_emails({label:"INBOX", limit:1})` → returns 1 email's metadata (proves read path).

If either fails, ROLL BACK from the `.mcp.json.bak-...` backup.

- [ ] **Step 6: Rewrite README.md**

Replace the entire file with TypeScript-focused content. Key changes vs Python:
- Title: `# Gmail-mcp` (capital G)
- Prerequisites: Node 24+
- Install: `npm install` + `npm run build`
- Auth setup: `node dist/auth-cli.js` (replaces `python server.py --auth`)
- Register: `node dist/index.js` in `.mcp.json`
- Features section: pagination, attachments, References-chain threading
- Development: `npm run typecheck` + `npm test`

Match the structure used in the time-mcp README rewrite at commit `3899307` of that repo.

- [ ] **Step 7: Add CHANGELOG.md entry `## [0.2.0] - 2026-05-23`**

Cover:
- TypeScript rewrite on @modelcontextprotocol/sdk + googleapis + @google-cloud/local-auth.
- 6 feature additions: pagination on 4 read tools; attachment metadata on 2 read tools; attachment sending on 5 compose/draft tools; new `gmail_download_attachment` tool; References-chain threading on reply/create_draft; transient-error retry; batchDelete on permanent delete.
- 5 design fixes: sender_map mutex; corrupted-state recovery; stderr logging; readOnly/destructive annotations; consistent error envelope.
- One observable behavior change: prior Python implementation surfaced raw Google API exceptions as MCP transport errors; new TS implementation wraps every handler in `{status:"error", error:...}` envelope.
- Renamed display to "Gmail-mcp" in README, package.json, MCP Server constructor.
- Removed: `server.py`, `server.js` (stale GWS wrapper), `requirements.txt`.

- [ ] **Step 8: Remove Python + stale Node files**

```bash
git rm server.py server.js requirements.txt
# package.json was a partial earlier — overwrite it entirely instead of git rm:
# (Already replaced in Task 1.)
```

Also remove `__pycache__/` if present and not gitignored.

- [ ] **Step 9: Commit cleanup**

```bash
git add README.md CHANGELOG.md
git commit -m "chore: complete TypeScript conversion; retire Python + stale GWS server.js"
```

- [ ] **Step 10: Retire the Python venv**

```bash
rm -rf /c/Users/danie/.venvs/gmail-mcp
```

- [ ] **Step 11: Mark task #252 completed via TaskUpdate**

(Done by the controller, not the subagent.)

---

## Self-review

**Spec coverage:** Each spec section maps to a task —
- §1 (scope/tools): Tasks 8–14 (TOOLS array + all 6 handler groups).
- §2 (non-goals): not implemented (correctly).
- §3 (module layout): Tasks 2–7 (modules) + 8 (tools) + 15 (index) + 2 (auth-cli).
- §4 (OAuth): Task 2.
- §5 (state model): Task 3.
- §6 (pagination): Task 10 (read) + Task 13 (list_drafts).
- §7 (attachments): Task 7 (helpers), Task 10 (read metadata), Task 12 (compose sending), Task 13 (draft sending), Task 14 (download tool).
- §8 (References chain): Task 12 (reply) + Task 13 (create_draft).
- §9.1 (mutex): Task 3.
- §9.2 (corrupted recovery): Task 3.
- §9.3 (stderr logging): Tasks 2, 3, 4, 15.
- §9.4 (annotations): Task 8.
- §9.5 (error envelope): Task 4.
- §9.6 (retry): Task 4.
- §10 (MIME): Task 6.
- §11 (renaming): Tasks 1 (package.json), 8 (server name), 15 (constructor), 16 (README).
- §12 (testing): every implementation task adds tests.
- §13 (cutover): Task 16.
- §14 (cleanup): Task 16.
- §15 (risks): handled inline (legacy token format in Task 2 tests; MIME line endings in Task 6 tests; etc.).

**Placeholder scan:** No "TBD" / "implement later" / "similar to Task N". All code blocks complete. Bash commands exact.

**Type consistency:**
- `SenderMap`, `SenderEntry` from `state.ts` used in Task 9 handler.
- `AttachmentMeta`, `LocalAttachment` from `attachments.ts` used in Tasks 10 (read), 12 (compose), 13 (draft), 14 (download).
- `Tool`, `ToolHandler` from tools.ts (Task 8) used throughout.
- `withRetry`, `wrap`, `getGmail` from client.ts (Task 4) used in every handler task.
- `extractHeader`, `extractSenderEmail`, `decodeBody` from format.ts (Task 5) used in Tasks 9–13.
- `buildPlainMessage`, `buildMultipartMessage`, `base64urlEncode` from mime.ts (Task 6) used in Tasks 12, 13.

No naming drift detected.

**Ambiguity check:**
- Helpers (`buildMessage`, `buildReferencesChain`) defined in Task 12 are reused in Task 13. Task 13 explicitly notes "Add helper above HANDLERS" is unnecessary because the helpers exist from Task 12.
- The mock client in handler tests is consistent across files — same vi.mock factory shape.
- Pagination shape: `page_token` (snake_case) in / `next_page_token` (snake_case) out — consistent across all 4 read tools and `list_drafts`.
