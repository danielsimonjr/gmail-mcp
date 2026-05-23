import { google, type gmail_v1 } from "googleapis";
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
  const { installed } = JSON.parse(readFileSync(cs, "utf8")) as {
    installed: { client_id: string; client_secret: string; token_uri?: string };
  };
  const oauth2 = new google.auth.OAuth2(installed.client_id, installed.client_secret);
  oauth2.setCredentials(tok);
  oauth2.on("tokens", (newTok) => {
    // Persist refreshed credentials. googleapis emits "tokens" after refresh.
    saveToken({ ...tok, ...newTok }).catch((err) =>
      process.stderr.write(`Gmail-mcp: token refresh save failed: ${(err as Error).message}\n`),
    );
  });
  return google.gmail({ version: "v1", auth: oauth2 });
}
