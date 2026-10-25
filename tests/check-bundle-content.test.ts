import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { compareBundles, firstDifference, normalizeLineEndings } from "../scripts/check-bundle-content.mjs";

// scripts/check-bundle-content.mjs builds the bundle again and compares it with the committed
// plugin/bundle/index.mjs. The plugin runs the committed bundle, not dist/, and no other check reads it.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "check-bundle-content.mjs");

describe("normalizeLineEndings", () => {
  it("turns CRLF into LF and leaves lone CR and LF alone", () => {
    expect(normalizeLineEndings("a\r\nb\nc\rd")).toBe("a\nb\nc\rd");
  });
});

describe("firstDifference", () => {
  it("returns null for equal texts", () => {
    expect(firstDifference("a\nb\nc", "a\nb\nc")).toBeNull();
  });

  it("names the first line that differs, counted from 1", () => {
    expect(firstDifference("a\nb\nc", "a\nX\nc")).toEqual({ line: 2, committed: "b", fresh: "X" });
  });

  it("finds a text that ends early", () => {
    expect(firstDifference("a\nb", "a\nb\nc")).toEqual({ line: 3, committed: "", fresh: "c" });
  });

  it("cuts a long line to 120 characters", () => {
    expect(firstDifference("x".repeat(300), "y")?.committed).toHaveLength(120);
  });
});

describe("compareBundles", () => {
  it("accepts equal bundles", () => {
    const result = compareBundles({ committed: "one\ntwo\n", fresh: "one\ntwo\n" });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("matches a fresh build");
  });

  it("accepts a committed bundle whose line endings a checkout converted to CRLF", () => {
    expect(compareBundles({ committed: "one\r\ntwo\r\n", fresh: "one\ntwo\n" }).ok).toBe(true);
  });

  it("rejects a stale bundle and names the first differing line and the command that fixes it", () => {
    const result = compareBundles({ committed: "one\nold\nthree\n", fresh: "one\nnew\nthree\n" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("line 2");
    expect(result.message).toContain("old");
    expect(result.message).toContain("new");
    expect(result.message).toContain("node scripts/bundle.mjs");
  });

  it("rejects an empty committed bundle", () => {
    expect(compareBundles({ committed: "", fresh: "one\n" }).ok).toBe(false);
  });
});

describe("check-bundle-content command", () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  // A stand-in repository: its build script writes the file named by BUNDLE_OUT.
  function makeRoot(committed: string | null, built: string): string {
    const folder = mkdtempSync(join(tmpdir(), "bundle-content-"));
    folders.push(folder);
    mkdirSync(join(folder, "scripts"));
    mkdirSync(join(folder, "plugin", "bundle"), { recursive: true });
    writeFileSync(
      join(folder, "scripts", "bundle.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.BUNDLE_OUT, ${JSON.stringify(built)});\n`,
    );
    if (committed !== null) writeFileSync(join(folder, "plugin", "bundle", "index.mjs"), committed);
    return folder;
  }

  function run(folder: string): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [script, "--root", folder], { encoding: "utf8" });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("exits 0 when the fresh build equals the committed bundle", () => {
    const result = run(makeRoot("export {};\n", "export {};\n"));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("matches a fresh build");
  });

  it("exits 1 when the committed bundle is stale", () => {
    const result = run(makeRoot("export const a = 1;\n", "export const a = 2;\n"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("line 1");
  });

  it("exits 1 when the committed bundle is missing", () => {
    const result = run(makeRoot(null, "export {};\n"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is missing");
  });

  it("exits 1 when the build script fails", () => {
    const folder = makeRoot("export {};\n", "export {};\n");
    writeFileSync(join(folder, "scripts", "bundle.mjs"), "process.exit(7);\n");
    const result = run(folder);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("build");
  });
});

describe("the bundle build", () => {
  // The bundle must hold only code that the repository installs. A module that the bundler finds in a
  // folder above the repository makes the build depend on the machine: debug asks for the optional
  // package supports-color, and a node_modules folder above the repository supplied it, together with
  // has-flag. A build in a clean checkout then gave another bundle.
  it("holds no module from a folder above the repository", () => {
    const folder = mkdtempSync(join(tmpdir(), "bundle-hermetic-"));
    try {
      const out = join(folder, "index.mjs");
      const build = spawnSync(process.execPath, [join(root, "scripts", "bundle.mjs")], {
        cwd: root,
        env: { ...process.env, BUNDLE_OUT: out },
        encoding: "utf8",
      });
      expect(build.status, build.stderr).toBe(0);
      const above = readFileSync(out, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("// ../"));
      expect(above).toEqual([]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, 120_000);
});
