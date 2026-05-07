import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Plan B0.5 §7 / Codex round 3 #1 — confirm the `skeptic-cli` package surface is
 * real: a fresh consumer project that declares `"skeptic-cli": "file:..."` can
 * `import { test, expect } from "skeptic-cli"` after `npm install`.
 *
 * Skipped when `dist/index.mjs` is missing (run `npm run build` first).
 */
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DIST = path.resolve(REPO_ROOT, "dist/index.mjs");
const distAvailable = fs.existsSync(DIST);
const npmShellOptions = process.platform === "win32" ? { shell: true } : {};

describe.skipIf(!distAvailable)("skeptic-cli public package surface", () => {
  let consumer: string;

  beforeAll(() => {
    consumer = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-pkg-import-"));
    fs.writeFileSync(
      path.join(consumer, "package.json"),
      JSON.stringify(
        {
          name: "skeptic-pkg-import-probe",
          version: "0.0.0",
          private: true,
          type: "module",
          dependencies: { "skeptic-cli": pathToFileURL(REPO_ROOT).href },
        },
        null,
        2,
      ),
    );
    // `npm install` with `--no-package-lock --no-audit --no-fund --silent` to keep
    // the test quiet and isolated. The install creates a symlink-or-copy of the
    // workspace, which is enough to verify the exports map.
    const installed = spawnSync(
      "npm",
      ["install", "--no-package-lock", "--no-audit", "--no-fund", "--silent"],
      { cwd: consumer, encoding: "utf-8", timeout: 120_000, ...npmShellOptions },
    );
    expect(
      installed.status,
      [
        "[package-imports] npm install failed",
        installed.error ? `error: ${installed.error.message}` : undefined,
        installed.stdout ? `stdout:\n${installed.stdout}` : undefined,
        installed.stderr ? `stderr:\n${installed.stderr}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    ).toBe(0);
  });

  afterAll(() => {
    if (consumer) fs.rmSync(consumer, { recursive: true, force: true });
  });

  it("import { test, expect } from 'skeptic-cli' resolves to functions", () => {
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import('skeptic-cli').then(m => { if (typeof m.test !== 'function') process.exit(1); if (typeof m.expect !== 'function') process.exit(2); console.log('OK'); }).catch(e => { console.error(e.message); process.exit(3); })`,
      ],
      { cwd: consumer, encoding: "utf-8", timeout: 30_000 },
    );
    expect(
      probe.status,
      [
        "[package-imports] probe import failed",
        probe.error ? `error: ${probe.error.message}` : undefined,
        probe.stdout ? `stdout:\n${probe.stdout}` : undefined,
        probe.stderr ? `stderr:\n${probe.stderr}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    ).toBe(0);
    expect(probe.stdout.trim()).toBe("OK");
  }, 60_000);
});
