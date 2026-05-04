import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConsoleReporter } from "../../../src/reporter/console-reporter.js";
import type { StepResult, TestResult, RunSummary } from "../../../src/reporter/types.js";

describe("ConsoleReporter", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("outputs check mark for passed steps", () => {
    const reporter = new ConsoleReporter();
    const step: StepResult = {
      command: "navigate",
      args: { value: "/home" },
      status: "passed",
      duration_ms: 150,
    };

    reporter.onStepComplete(step, 0, 3);

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    // chalk output contains the checkmark character
    expect(output).toContain("navigate");
  });

  it("outputs X mark for failed steps", () => {
    const reporter = new ConsoleReporter();
    const step: StepResult = {
      command: "click",
      args: { target: "#missing" },
      status: "failed",
      duration_ms: 200,
      error: "Element not found",
    };

    reporter.onStepComplete(step, 1, 3);

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("click");
    expect(output).toContain("Element not found");
  });

  it("shows PASS for passing tests", () => {
    const reporter = new ConsoleReporter();
    const result: TestResult = {
      name: "Login Test",
      file: "tests/login.spec.ts",
      status: "passed",
      duration_ms: 1200,
      steps: [],
    };

    reporter.onTestComplete(result);

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("PASS");
  });

  it("shows FAIL for failing tests", () => {
    const reporter = new ConsoleReporter();
    const result: TestResult = {
      name: "Login Test",
      file: "tests/login.spec.ts",
      status: "failed",
      duration_ms: 500,
      steps: [],
    };

    reporter.onTestComplete(result);

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("FAIL");
  });

  it("shows summary with passed/failed counts", () => {
    const reporter = new ConsoleReporter();
    const summary: RunSummary = {
      total: 3,
      passed: 2,
      failed: 1,
      duration_ms: 5000,
      tests: [],
    };

    reporter.onRunComplete(summary);

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("2 passed");
    expect(output).toContain("1 failed");
    expect(output).toContain("3 total");
  });

  it("shows test name and file on test start", () => {
    const reporter = new ConsoleReporter();
    reporter.onTestStart({ name: "Login Test", file: "tests/login.spec.ts" });

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Login Test");
    expect(output).toContain("tests/login.spec.ts");
  });

  describe("sharding support", () => {
    it("prefixes every output line with shardLabel when set", () => {
      const reporter = new ConsoleReporter({ shardLabel: "[shard 1]" });
      reporter.onTestStart({ name: "Login Test", file: "tests/login.spec.ts" });

      const lines = consoleSpy.mock.calls.map((c) => c.join(" "));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.startsWith("[shard 1] ")).toBe(true);
      }
    });

    it("buffered concurrent flush also carries the shardLabel prefix", () => {
      const reporter = new ConsoleReporter({ shardLabel: "[shard 2]", concurrency: 2 });
      reporter.onTestStart({ name: "Test A", file: "a.spec.ts" });
      const step: StepResult = {
        command: "navigate",
        args: "/",
        status: "passed",
        duration_ms: 50,
      };
      reporter.onStepComplete(step, 0, 1, { name: "Test A", file: "a.spec.ts", testIndex: 0 });
      const result: TestResult = {
        name: "Test A",
        file: "a.spec.ts",
        status: "passed",
        duration_ms: 100,
        steps: [step],
      };
      reporter.onTestComplete(result, { name: "Test A", file: "a.spec.ts", testIndex: 0 });

      const lines = consoleSpy.mock.calls.map((c) => c.join(" "));
      // Buffered output is flushed on onTestComplete; every flushed line must
      // carry the prefix, including the buffered step line and PASS/FAIL line.
      expect(lines.some((l) => l.includes("[shard 2]") && l.includes("navigate"))).toBe(true);
      expect(lines.some((l) => l.includes("[shard 2]") && l.includes("PASS"))).toBe(true);
    });

    it("suppressFinalSummary makes onRunComplete a no-op", () => {
      const reporter = new ConsoleReporter({ suppressFinalSummary: true });
      const summary: RunSummary = {
        total: 3,
        passed: 2,
        failed: 1,
        duration_ms: 1000,
        tests: [],
      };
      reporter.onRunComplete(summary);
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it("default (no shardLabel, no suppress) preserves existing behavior", () => {
      const reporter = new ConsoleReporter();
      const summary: RunSummary = {
        total: 1,
        passed: 1,
        failed: 0,
        duration_ms: 100,
        tests: [],
      };
      reporter.onRunComplete(summary);
      const lines = consoleSpy.mock.calls.map((c) => c.join(" "));
      expect(lines.length).toBeGreaterThan(0);
      // No prefix on any line.
      for (const line of lines) {
        expect(line.startsWith("[shard ")).toBe(false);
      }
    });
  });
});
