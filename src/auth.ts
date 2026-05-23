import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
