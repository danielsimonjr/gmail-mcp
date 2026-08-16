#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HANDLERS, TOOLS } from "./tools.js";

// Injected by scripts/bundle.mjs from package.json. MUST be declared at module scope:
// a `declare const` inside a function is TS1184, which a vitest run (per-file transpile)
// does not catch but `tsc` does.
//
// It is a declaration rather than a literal because the literal drifted. This file said
// "0.2.0" while package.json said 0.3.1, so the deployed server misreported itself by two
// releases - and serverInfo.version is exactly what both agents read to prove a deploy
// landed, which made a stale deploy indistinguishable from a healthy one.
declare const __PKG_VERSION__: string;

// `tsc` (npm run build) does not apply esbuild's define, so keep a fallback for that path
// and for a direct `node dist/index.js` run.
const VERSION = typeof __PKG_VERSION__ === "string" ? __PKG_VERSION__ : "0.0.0-dev";

const server = new Server(
  { name: "Gmail-mcp", version: VERSION },
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
