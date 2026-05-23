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
  const localAuth = await authenticate({
    keyfilePath: clientSecret,
    scopes: SCOPES,
  });
  await saveToken(localAuth.credentials);
  // Re-wrap credentials in a googleapis-native OAuth2Client to satisfy
  // the type expected by google.gmail() (googleapis bundles its own
  // google-auth-library version which differs from @google-cloud/local-auth's).
  const auth = new google.auth.OAuth2();
  auth.setCredentials(localAuth.credentials);
  const gmail = google.gmail({ version: "v1", auth });
  const profile = await gmail.users.getProfile({ userId: "me" });
  process.stderr.write(`Gmail-mcp: authenticated as ${profile.data.emailAddress}\n`);
  process.stderr.write(`Gmail-mcp: token saved to ${configDir()}/token.json\n`);
}

main().catch((err) => {
  process.stderr.write(`Gmail-mcp: auth failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
