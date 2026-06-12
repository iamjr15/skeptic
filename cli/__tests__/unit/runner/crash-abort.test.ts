import { describe, expect, it, afterAll } from "vitest";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  executeRun,
  resolveConcurrency,
  type RunnerExecuteOptions,
} from "../../../src/runner/execute.js";
import type { WorkerStartConfig } from "../../../src/runner/ipc.js";
import type { ManifestEntry } from "../../../src/runner/discover.js";

const FIXTURES = path.resolve(import.meta.dirname, "../../fixtures/runner");
const crashWorker = pathToFileURL(path.join(FIXTURES, "crash-worker.mjs"));
const hangWorker = pathToFileURL(path.join(FIXTURES, "hang-worker.mjs"));
const flakyWorker = pathToFileURL(path.join(FIXTURES, "flaky-worker.mjs"));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-crash-"));
afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env["SKEPTIC_FLAKY_COUNTER"];
});

const baseConfig = (overrides: Partial<WorkerStartConfig> = {}): WorkerStartConfig => ({
  timeout: 5_000,
  hardTimeout: 10_000,
  outputDir: os.tmpdir(),
  envOverrides: {},
  observability: {
    forceAll: false,
    consoleRedaction: true,
    networkCaptureLimit: 50,
    duplicateWindowMs: 250,
    consoleCaptureLimit: 200,
    accessibilityDualEngine: false,
    accessibilityHtmlSnippetLimit: 200,
    accessibilityStandard: "WCAG21AA",
    autoAccessibilityAudit: false,
    accessibilityMaxRulesPerImpact: 100,
  },
  artifact: { fullPageScreenshots: false, blankFrameDetection: "off", writeSidecars: false },
  video: false,
  trace: false,
  headed: false,
  browserEngine: "chromium",
  retries: 0,
  ...overrides,
});

const entry = (file: string, ordinal: number, name: string): ManifestEntry => ({
  id: `${file}#${ordinal}`,
  file,
  ordinal,
  name,
  skip: false,
  only: false,
  use: {},
});

const buildOptions = (
  file: string,
  entries: ManifestEntry[],
  workerEntry: URL,
  overrides: Partial<RunnerExecuteOptions> = {},
): RunnerExecuteOptions => ({
  config: baseConfig(),
  reporters: [],
  partition: new Map([[file, entries]]),
  manifests: new Map(),
  bail: false,
  workerEntry,
  killGraceMs: 500,
  ...overrides,
});

describe("worker crash handling (B1 finding #1)", () => {
  it("synthesizes error results for every unfinished test and fails the run", async () => {
    const file = "/virtual/crash.spec.ts";
    const entries = [entry(file, 0, "alpha"), entry(file, 1, "beta")];
    const outcome = await executeRun(buildOptions(file, entries, crashWorker));

    // Both tests were unfinished when the worker died — neither is silently dropped.
    expect(outcome.summary.total).toBe(2);
    expect(outcome.summary.passed).toBe(0);
    expect(outcome.summary.failed).toBe(2);
    expect(outcome.results.every((r) => r.status === "error")).toBe(true);
    expect(outcome.results.every((r) => /worker crashed/i.test(r.steps[0]?.error ?? ""))).toBe(true);
  }, 20_000);
});

describe("abort signal (B1 finding #7)", () => {
  it("terminates an in-flight worker and resolves instead of hanging", async () => {
    const file = "/virtual/hang.spec.ts";
    const entries = [entry(file, 0, "hangs")];
    const controller = new AbortController();
    const promise = executeRun(
      buildOptions(file, entries, hangWorker, { signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 250);
    const outcome = await promise;
    // The hanging test produced no result; the run resolved rather than waiting on the kill timer.
    expect(outcome.results).toHaveLength(0);
  }, 20_000);

  it("stops scheduling when the signal is already aborted", async () => {
    const file = "/virtual/hang.spec.ts";
    const entries = [entry(file, 0, "hangs")];
    const controller = new AbortController();
    controller.abort();
    const outcome = await executeRun(
      buildOptions(file, entries, hangWorker, { signal: controller.signal }),
    );
    expect(outcome.results).toHaveLength(0);
  }, 20_000);
});

describe("flaky flag (B1 finding #8)", () => {
  it("marks a retried-then-passed test as flaky without counting it as a fresh pass", async () => {
    const counter = path.join(tmpRoot, "flaky-counter.txt");
    fs.writeFileSync(counter, "0");
    process.env["SKEPTIC_FLAKY_COUNTER"] = counter;

    const file = "/virtual/flaky.spec.ts";
    const entries = [entry(file, 0, "flaky")];
    const outcome = await executeRun(
      buildOptions(file, entries, flakyWorker, { config: baseConfig({ retries: 1 }) }),
    );

    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.status).toBe("passed");
    expect(outcome.results[0]?.flaky).toBe(true);
  }, 20_000);
});

describe("resolveConcurrency default (B1 finding #9)", () => {
  const opts = (over: Partial<RunnerExecuteOptions>): RunnerExecuteOptions =>
    ({ bail: false, ...over }) as RunnerExecuteOptions;

  it("an explicit --parallel value always wins (capped at partition count)", () => {
    expect(resolveConcurrency(opts({ concurrency: 4 }), 8)).toBe(4);
    expect(resolveConcurrency(opts({ concurrency: 16 }), 3)).toBe(3);
  });

  it("auto-picks min(specFileCount, ceil(cores/2)) when --parallel was not passed", () => {
    const cores =
      typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : os.cpus().length;
    const expected = Math.min(20, Math.max(1, Math.ceil(cores / 2)));
    expect(resolveConcurrency(opts({ concurrency: undefined }), 20)).toBe(expected);
  });

  it("forces serial under bail and for single-file runs", () => {
    expect(resolveConcurrency(opts({ bail: true, concurrency: undefined }), 8)).toBe(1);
    expect(resolveConcurrency(opts({ concurrency: undefined }), 1)).toBe(1);
  });
});
