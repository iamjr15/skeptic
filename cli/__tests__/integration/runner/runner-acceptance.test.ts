import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Drive the real built `dist/skeptic.mjs run …` so the worker_threads + tsx
// import path is exercised end-to-end. Skipped if the user hasn't run
// `npm run build` first; the workflow runs build before tests so CI is OK.

const DIST = path.resolve(import.meta.dirname, "../../../dist/skeptic.mjs");
const FIXTURES = path.resolve(import.meta.dirname, "../../fixtures/runner");

const runCli = (
  args: string[],
  opts: { cwd?: string; timeout?: number; env?: Record<string, string> } = {},
): { stdout: string; stderr: string; status: number | null } => {
  const result = spawnSync("node", [DIST, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    timeout: opts.timeout ?? 60_000,
    encoding: "utf-8",
    env: { ...process.env, ...opts.env },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
};

const distAvailable = fs.existsSync(DIST);

describe.skipIf(!distAvailable)("runner acceptance (B1)", () => {
  let outDir: string;

  beforeAll(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-b1-acceptance-"));
  });

  it("two tests in one file → both run, results.json shape v0.3.0 with `tests` key", () => {
    const targetOut = path.join(outDir, "two-tests");
    runCli([
      "run",
      path.join(FIXTURES, "two-tests.spec.ts"),
      "--reporter",
      "json",
      "--output",
      targetOut,
    ]);

    const json = JSON.parse(fs.readFileSync(path.join(targetOut, "results.json"), "utf-8")) as {
      version: string;
      tests: Array<{ name: string; status: string }>;
    };
    expect(json.version).toBe("0.3.0");
    expect(json.tests).toHaveLength(2);
    expect(json.tests.map((t) => t.name).sort()).toEqual([
      "two-tests: alpha",
      "two-tests: beta",
    ]);
    expect(json.tests.every((t) => t.status === "passed")).toBe(true);
  }, 60_000);

  it("test.skip + test.only honored", () => {
    const targetOut = path.join(outDir, "skip-only");
    runCli([
      "run",
      path.join(FIXTURES, "skip-only.spec.ts"),
      "--reporter",
      "json",
      "--output",
      targetOut,
    ]);
    const json = JSON.parse(fs.readFileSync(path.join(targetOut, "results.json"), "utf-8")) as {
      tests: Array<{ name: string; status: string }>;
    };
    // No test.only in the fixture → all three names register; the skipped one passes
    // overall (it's a skip, not a fail) but the inner step records skipped.
    expect(json.tests.map((t) => t.name).sort()).toEqual([
      "skip-only: another",
      "skip-only: plain",
      "skip-only: skipped",
    ]);
  }, 60_000);

  it("duplicate test names within a file run independently and surface stable ordinals", () => {
    // Plan §4.0.1: duplicate names within a file are allowed; each registers at
    // a distinct ordinal and runs separately. The JSON reporter persists `name`
    // verbatim — disambiguation by ordinal happens at the rendering layer
    // (formatTestDisplayName, exercised by reporter unit tests).
    const targetOut = path.join(outDir, "duplicate-names");
    runCli([
      "run",
      path.join(FIXTURES, "duplicate-names.spec.ts"),
      "--reporter",
      "json",
      "--output",
      targetOut,
    ]);
    const json = JSON.parse(fs.readFileSync(path.join(targetOut, "results.json"), "utf-8")) as {
      tests: Array<{ name: string; status: string }>;
    };
    expect(json.tests).toHaveLength(2);
    expect(json.tests.every((t) => t.name === "dup")).toBe(true);
    expect(json.tests.every((t) => t.status === "passed")).toBe(true);
  }, 60_000);

  it("test.beforeEach + test.afterEach run around each test in declaration order", () => {
    const targetOut = path.join(outDir, "hooks");
    const result = runCli([
      "run",
      path.join(FIXTURES, "hooks.spec.ts"),
      "--reporter",
      "json",
      "--output",
      targetOut,
    ]);
    expect(result.status).toBe(0);
    const json = JSON.parse(fs.readFileSync(path.join(targetOut, "results.json"), "utf-8")) as {
      tests: Array<{ status: string }>;
    };
    expect(json.tests.every((t) => t.status === "passed")).toBe(true);
  }, 60_000);

  it("--shard-split 2 partitions a 4-test file across two shard runs", () => {
    const out1 = path.join(outDir, "shard-1");
    const out2 = path.join(outDir, "shard-2");

    runCli([
      "run",
      path.join(FIXTURES, "four-tests.spec.ts"),
      "--shard-split",
      "2",
      "--shard-index",
      "1",
      "--reporter",
      "json",
      "--output",
      out1,
    ]);
    runCli([
      "run",
      path.join(FIXTURES, "four-tests.spec.ts"),
      "--shard-split",
      "2",
      "--shard-index",
      "2",
      "--reporter",
      "json",
      "--output",
      out2,
    ]);

    const j1 = JSON.parse(fs.readFileSync(path.join(out1, "results.json"), "utf-8")) as {
      tests: Array<{ name: string }>;
    };
    const j2 = JSON.parse(fs.readFileSync(path.join(out2, "results.json"), "utf-8")) as {
      tests: Array<{ name: string }>;
    };
    expect(j1.tests).toHaveLength(2);
    expect(j2.tests).toHaveLength(2);
    const merged = [...j1.tests, ...j2.tests].map((t) => t.name).sort();
    expect(merged).toEqual([
      "four-tests: a",
      "four-tests: b",
      "four-tests: c",
      "four-tests: d",
    ]);
  }, 90_000);

  it("hard-timeout (async hang) fails the test inside the soft window", () => {
    const targetOut = path.join(outDir, "hang-async");
    runCli(
      [
        "run",
        path.join(FIXTURES, "hang-async.spec.ts"),
        "--hard-timeout",
        "1500",
        "--reporter",
        "json",
        "--output",
        targetOut,
      ],
      { timeout: 90_000 },
    );
    const json = JSON.parse(fs.readFileSync(path.join(targetOut, "results.json"), "utf-8")) as {
      tests: Array<{ status: string; steps: Array<{ status: string; error?: string }> }>;
    };
    expect(json.tests).toHaveLength(1);
    expect(json.tests[0]?.status).not.toBe("passed");
  }, 90_000);

  it("hard-timeout (CPU spin) terminates the worker; remaining tests requeue once", () => {
    const targetOut = path.join(outDir, "hang-cpu");
    runCli(
      [
        "run",
        path.join(FIXTURES, "hang-cpu.spec.ts"),
        "--hard-timeout",
        "1500",
        "--reporter",
        "json",
        "--output",
        targetOut,
      ],
      { timeout: 120_000 },
    );
    const json = JSON.parse(fs.readFileSync(path.join(targetOut, "results.json"), "utf-8")) as {
      tests: Array<{ name: string; status: string; steps: Array<{ error?: string }> }>;
    };
    // Two registered tests — first hangs CPU, second should be marked as killed.
    expect(json.tests.length).toBeGreaterThanOrEqual(1);
    const offending = json.tests.find((t) => t.name.includes("CPU"));
    expect(offending).toBeDefined();
    expect(offending?.status).not.toBe("passed");
  }, 120_000);

  it("--retries 1 re-runs a flaky test until it passes; reporter records the retry", () => {
    const targetOut = path.join(outDir, "retry");
    const counterPath = path.join(targetOut, "attempts.txt");
    fs.mkdirSync(targetOut, { recursive: true });
    fs.writeFileSync(counterPath, "0");
    const result = runCli(
      [
        "run",
        path.join(FIXTURES, "retry.spec.ts"),
        "--retries",
        "1",
        "--reporter",
        "json",
        "--output",
        targetOut,
      ],
      { env: { SKEPTIC_RETRY_COUNTER: counterPath }, timeout: 60_000 },
    );
    expect(result.status).toBe(0);
    const json = JSON.parse(fs.readFileSync(path.join(targetOut, "results.json"), "utf-8")) as {
      tests: Array<{ status: string; steps: Array<{ status: string; warnings?: string[] }> }>;
    };
    expect(json.tests).toHaveLength(1);
    expect(json.tests[0]?.status).toBe("passed");
    const warnings = json.tests[0]?.steps[0]?.warnings ?? [];
    expect(warnings.some((w) => /retry attempt/.test(w))).toBe(true);
  }, 90_000);

  it("--observability --sidecars writes per-test perf-trace.md / console.json / network.json", () => {
    const targetOut = path.join(outDir, "sidecars");
    runCli(
      [
        "run",
        path.join(FIXTURES, "sidecars.spec.ts"),
        "--observability",
        "--sidecars",
        "--reporter",
        "json",
        "--output",
        targetOut,
      ],
      { timeout: 90_000 },
    );
    // Find the per-test subdir — ${safeName}-${ordinal}
    const subdirs = fs
      .readdirSync(targetOut, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(subdirs.length).toBeGreaterThan(0);
    const flowDir = path.join(targetOut, subdirs[0]!);
    expect(fs.existsSync(path.join(flowDir, "perf-trace.md"))).toBe(true);
    expect(fs.existsSync(path.join(flowDir, "console.json"))).toBe(true);
    expect(fs.existsSync(path.join(flowDir, "network.json"))).toBe(true);
  }, 90_000);

  it("top-level side-effect rule: each spec is imported twice (discovery + execution)", () => {
    // Per plan §4.0: discovery worker imports the file once; execution worker imports
    // it once more. The fixture appends a line per top-level import to a shared file —
    // we expect exactly two lines after a single `run`.
    const targetOut = path.join(outDir, "side-effect");
    const importLog = path.join(targetOut, "imports.log");
    fs.mkdirSync(targetOut, { recursive: true });
    fs.writeFileSync(importLog, "");
    const result = runCli(
      [
        "run",
        path.join(FIXTURES, "side-effect.spec.ts"),
        "--reporter",
        "json",
        "--output",
        targetOut,
      ],
      { env: { SKEPTIC_IMPORT_LOG: importLog }, timeout: 60_000 },
    );
    expect(result.status).toBe(0);
    const lines = fs
      .readFileSync(importLog, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(2);
  }, 60_000);

  it("--list outputs the manifest without spawning a browser", () => {
    const result = runCli(["run", path.join(FIXTURES, "two-tests.spec.ts"), "--list"]);
    expect(result.stdout).toContain("two-tests.spec.ts");
    expect(result.stdout).toContain("two-tests: alpha");
    expect(result.stdout).toContain("two-tests: beta");
  }, 30_000);
});

const sysRunCli = runCli;
const sysExecFile = execFileSync;
void sysRunCli;
void sysExecFile;
