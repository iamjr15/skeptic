import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { boundPath, boundResolveFlows } from "../../../src/commands/acp.js";

// Lessons.md #20 lists three traversal vectors that boundPath / boundResolveFlows
// must reject:
//   1. Absolute paths (/etc/passwd)
//   2. Lexical traversal (../../etc/passwd)
//   3. Symlink escape (root-internal symlink that realpaths outside the root)
// This test pins all three so any future change to the sandbox is caught.

describe("ACP sandboxing (boundPath, boundResolveFlows)", () => {
  let root: string;
  let rootReal: string;
  let outside: string;

  beforeAll(() => {
    // Realpath the tmpdir up front: macOS aliases /var → /private/var, so the
    // session-root realpath check needs the canonical form.
    const tmpReal = fs.realpathSync(os.tmpdir());
    root = fs.mkdtempSync(path.join(tmpReal, "skeptic-acp-sandbox-"));
    rootReal = fs.realpathSync(root);
    fs.mkdirSync(path.join(root, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "tests", "ok.spec.ts"),
      "import { test } from 'skeptic-cli'; test('ok', async () => {});\n",
    );

    // Create a sibling directory outside the session root and drop a target
    // file there. The symlink case below points into this directory.
    outside = fs.mkdtempSync(path.join(tmpReal, "skeptic-acp-outside-"));
    fs.writeFileSync(path.join(outside, "secret.spec.ts"), "// secret\n");
    fs.symlinkSync(
      path.join(outside, "secret.spec.ts"),
      path.join(root, "tests", "escape.spec.ts"),
    );
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("boundPath rejects absolute paths", () => {
    expect(() => boundPath(root, rootReal, "/etc/passwd.spec.ts")).toThrow(
      /must be relative to session root/,
    );
  });

  it("boundPath rejects lexical traversal (../)", () => {
    expect(() => boundPath(root, rootReal, "../../etc/passwd.spec.ts")).toThrow(
      /escapes session root/,
    );
  });

  it("boundPath accepts in-root paths", () => {
    expect(() => boundPath(root, rootReal, "tests/ok.spec.ts")).not.toThrow();
  });

  it("boundPath rejects a symlink that escapes the root via realpath", () => {
    // tests/escape.spec.ts EXISTS inside the root, but realpaths to ${outside}/secret.spec.ts.
    expect(() => boundPath(root, rootReal, "tests/escape.spec.ts")).toThrow(
      /Symlink escapes session root/,
    );
  });

  it("boundResolveFlows globs in-root specs but excludes symlink escapes", async () => {
    await expect(boundResolveFlows(root, rootReal, "tests/**/*.spec.ts")).rejects.toThrow(
      /Glob match escapes session root via symlink/,
    );
  });

  it("boundResolveFlows rejects glob patterns containing ../", async () => {
    await expect(
      boundResolveFlows(root, rootReal, "../**/*.spec.ts"),
    ).rejects.toThrow(/relative to session root/);
  });
});
