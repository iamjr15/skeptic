import { describe, it, expect } from "vitest";
import {
  buildWorkerConfig,
  ensureJsonReporter,
  resolveRunExitCode,
} from "../../../src/commands/run.js";
import type { RunCommandOptions } from "../../../src/commands/run.js";
import { loadConfig } from "../../../src/config/loader.js";

// Real schema defaults (no config file in this dir → loadConfig returns pure defaults).
const defaults = loadConfig({});
const build = (opts: Partial<RunCommandOptions> = {}) =>
  buildWorkerConfig(opts as RunCommandOptions, defaults, {});

describe("buildWorkerConfig — visual-settle wiring (#1)", () => {
  it("leaves visualSettle undefined when the flag is omitted (falls back to observability.forceAll in the worker)", () => {
    expect(build({}).visualSettle).toBeUndefined();
  });

  it("forwards --visual-settle as visualSettle: true", () => {
    expect(build({ visualSettle: true }).visualSettle).toBe(true);
  });

  it("forwards --no-visual-settle as visualSettle: false even under --observability", () => {
    const cfg = build({ visualSettle: false, observability: true });
    expect(cfg.visualSettle).toBe(false);
  });
});

describe("buildWorkerConfig — blank-frame-detection config wiring (#2)", () => {
  it("flows the --blank-frame-detection mode into artifact.blankFrameDetection", () => {
    expect(build({ blankFrameDetection: "fail" }).artifact.blankFrameDetection).toBe("fail");
  });

  it("defaults to 'fail' under --observability and 'warn' otherwise", () => {
    expect(build({ observability: true }).artifact.blankFrameDetection).toBe("fail");
    expect(build({}).artifact.blankFrameDetection).toBe("warn");
  });
});

describe("buildWorkerConfig — auto-parallelism (#4 / Runner handoff)", () => {
  it("leaves parallel undefined when --parallel was not passed (runner auto-picks)", () => {
    expect(build({}).parallel).toBeUndefined();
  });

  it("forwards an explicit --parallel value", () => {
    expect(build({ parallel: 3 }).parallel).toBe(3);
  });
});

describe("buildWorkerConfig — screenshotOnFailure (Runner handoff)", () => {
  it("wires the config default (true)", () => {
    expect(build({}).screenshotOnFailure).toBe(true);
  });

  it("honors a config-level screenshotOnFailure: false", () => {
    const off = loadConfig({});
    off.execution.screenshotOnFailure = false;
    expect(buildWorkerConfig({} as RunCommandOptions, off, {}).screenshotOnFailure).toBe(false);
  });
});

describe("buildWorkerConfig — soft/hard timeout de-conflation (Runner handoff)", () => {
  it("does NOT let a soft --timeout become the hard ceiling", () => {
    const cfg = build({ timeout: 1234 });
    expect(cfg.timeout).toBe(1234);
    // hardTimeout must fall back to the config default, NOT to opts.timeout.
    expect(cfg.hardTimeout).toBe(defaults.browser.timeout);
    expect(cfg.hardTimeout).not.toBe(1234);
  });

  it("honors an explicit --hard-timeout", () => {
    expect(build({ hardTimeout: 9000 }).hardTimeout).toBe(9000);
  });
});

describe("ensureJsonReporter — always-write-results.json contract (#7)", () => {
  it("appends json when the resolved set omits it", () => {
    expect(ensureJsonReporter(["console"])).toEqual(["console", "json"]);
  });

  it("is a no-op when json is already present", () => {
    expect(ensureJsonReporter(["json", "html"])).toEqual(["json", "html"]);
  });

  it("preserves an empty set as just json", () => {
    expect(ensureJsonReporter([])).toEqual(["json"]);
  });
});

describe("resolveRunExitCode — exit codes (#5 / #10)", () => {
  it("returns 130 on interrupt regardless of results", () => {
    expect(resolveRunExitCode(true, { total: 5, failed: 0 })).toBe(130);
  });

  it("returns 1 when zero tests were discovered/executed", () => {
    expect(resolveRunExitCode(false, { total: 0, failed: 0 })).toBe(1);
  });

  it("returns 1 when any test failed", () => {
    expect(resolveRunExitCode(false, { total: 3, failed: 1 })).toBe(1);
  });

  it("returns 0 on a clean pass", () => {
    expect(resolveRunExitCode(false, { total: 3, failed: 0 })).toBe(0);
  });
});
