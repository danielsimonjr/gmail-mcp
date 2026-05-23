import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
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
