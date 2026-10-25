import { build } from "esbuild";
import { readFileSync } from "node:fs";

// The committed bundle/index.mjs had NO build script and no bundler dependency, so the
// shipped artifact was UNREPRODUCIBLE: a source fix could land while the plugin kept serving
// whatever was committed, and no gate would object because tests run against src/.
//
// The flags below were recovered from the shipped artifact rather than guessed:
//   __commonJS / __toESM helpers   -> esbuild, bundle: true
//   line 2 createRequire banner    -> format esm, platform node, this exact shim
//   line 1 shebang                 -> the entry is a bin
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// NO SHEBANG IN THE BANNER. src/index.ts already starts with one and esbuild preserves it;
// adding a second emits `#!/usr/bin/env node` on line 2, which is a syntax error rather than
// a comment. That mistake crashed a sibling repo's first rebuild.
const banner =
  "import { createRequire as __createRequire } from 'node:module';" +
  "import { fileURLToPath as __fileURLToPath } from 'node:url';" +
  "import { dirname as __dirnameOf } from 'node:path';" +
  "const require = __createRequire(import.meta.url);" +
  "const __filename = __fileURLToPath(import.meta.url);" +
  "const __dirname = __dirnameOf(__filename);";

// The output file can be changed by the environment, so a check can build into a temp file and compare it with the committed bundle.
const outfile = process.env.BUNDLE_OUT ?? "plugin/bundle/index.mjs";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: { js: banner },
  outfile,
  // debug asks for supports-color inside a try block and declares it optional, so no install brings it. A node_modules
  // folder above the repository can still supply it, with has-flag, and the bundle then depends on the machine.
  // External keeps both packages out, so every build gives the same bundle. debug falls back to its basic colors.
  external: ["supports-color"],
  logLevel: "warning",
  // The version the server reports about itself is INJECTED, never written in source.
  // It previously read "0.2.0" while package.json said 0.3.1, so the deployed server
  // misreported itself by two releases - and serverInfo.version is the signal used to
  // prove a deploy landed, so a stale deploy and a healthy one looked identical.
  define: { __PKG_VERSION__: JSON.stringify(pkg.version) },
});

console.log(`bundled -> ${outfile} (version ${pkg.version})`);
