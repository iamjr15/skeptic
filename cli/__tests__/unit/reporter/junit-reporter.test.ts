import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { JUnitReporter } from "../../../src/reporter/junit-reporter.js";
import type { RunSummary } from "../../../src/reporter/types.js";

describe("JUnitReporter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-junit-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSummary(overrides?: Partial<RunSummary>): RunSummary {
    return {
      total: 1,
      passed: 1,
      failed: 0,
      duration_ms: 1234,
      tests: [
        {
          name: "Login Test",
          file: "tests/login.spec.ts",
          status: "passed",
          duration_ms: 1000,
          steps: [
            { command: "navigate", args: { value: "/login" }, status: "passed", duration_ms: 200 },
            { command: "click", args: { target: "#email" }, status: "passed", duration_ms: 100 },
          ],
        },
      ],
      ...overrides,
    };
  }

  it("writes junit.xml to output directory", () => {
    const reporter = new JUnitReporter(tmpDir);
    reporter.onRunComplete(makeSummary());

    const outPath = path.join(tmpDir, "junit.xml");
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it("generates valid XML structure", () => {
    const reporter = new JUnitReporter(tmpDir);
    reporter.onRunComplete(makeSummary());

    const xml = fs.readFileSync(path.join(tmpDir, "junit.xml"), "utf-8");
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain("<testsuites");
    expect(xml).toContain("<testsuite");
    expect(xml).toContain("<testcase");
    expect(xml).toContain('name="skeptic"');
  });

  it("includes failure elements for failed steps", () => {
    const summary = makeSummary({
      passed: 0,
      failed: 1,
      tests: [
        {
          name: "Failing Test",
          file: "tests/fail.spec.ts",
          status: "failed",
          duration_ms: 500,
          steps: [
            { command: "navigate", args: {}, status: "passed", duration_ms: 100 },
            {
              command: "click",
              args: { target: "#missing" },
              status: "failed",
              duration_ms: 200,
              error: "Element not found: #missing",
            },
          ],
        },
      ],
    });

    const reporter = new JUnitReporter(tmpDir);
    reporter.onRunComplete(summary);

    const xml = fs.readFileSync(path.join(tmpDir, "junit.xml"), "utf-8");
    expect(xml).toContain("<failure");
    expect(xml).toContain("Element not found");
    expect(xml).toContain('failures="1"');
  });

  it("escapes special XML characters", () => {
    const summary = makeSummary({
      passed: 0,
      failed: 1,
      tests: [
        {
          name: 'Test with "quotes" & <angle>',
          file: "tests/special.spec.ts",
          status: "failed",
          duration_ms: 100,
          steps: [
            {
              command: "assert",
              args: {},
              status: "failed",
              duration_ms: 50,
              error: 'Expected "foo" but got <bar> & baz',
            },
          ],
        },
      ],
    });

    const reporter = new JUnitReporter(tmpDir);
    reporter.onRunComplete(summary);

    const xml = fs.readFileSync(path.join(tmpDir, "junit.xml"), "utf-8");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&lt;");
    expect(xml).toContain("&gt;");
    expect(xml).toContain("&quot;");
  });

  it("aggregates testsuites counts from the emitted testcases, not run-level totals", () => {
    // Each <testcase> is a step, so the <testsuites> tests/failures/skipped attributes must
    // sum the steps — NOT summary.total/summary.failed (the previous bug used the latter,
    // so the attributes never reconciled with the testcases they summarize).
    const summary = makeSummary({
      total: 99, // intentionally wrong run-level numbers; must be ignored
      passed: 99,
      failed: 99,
      tests: [
        {
          name: "Suite A",
          file: "tests/a.spec.ts",
          status: "passed",
          duration_ms: 300,
          steps: [
            { command: "navigate", args: {}, status: "passed", duration_ms: 100 },
            { command: "click", args: {}, status: "passed", duration_ms: 100 },
          ],
        },
        {
          name: "Suite B",
          file: "tests/b.spec.ts",
          status: "failed",
          duration_ms: 200,
          steps: [
            { command: "assert", args: {}, status: "failed", duration_ms: 50, error: "boom" },
          ],
        },
      ],
    });

    const reporter = new JUnitReporter(tmpDir);
    reporter.onRunComplete(summary);

    const xml = fs.readFileSync(path.join(tmpDir, "junit.xml"), "utf-8");
    // 3 steps total (2 passed + 1 failed), 1 failure, 0 skipped.
    expect(xml).toContain('<testsuites name="skeptic" tests="3" failures="1" skipped="0"');
    expect(xml).not.toContain('tests="99"');
  });

  it("emits <skipped/> for skipped steps and counts them", () => {
    const summary = makeSummary({
      tests: [
        {
          name: "Partly Skipped",
          file: "tests/skip.spec.ts",
          status: "passed",
          duration_ms: 150,
          steps: [
            { command: "navigate", args: {}, status: "passed", duration_ms: 100 },
            { command: "click", args: {}, status: "skipped", duration_ms: 0 },
          ],
        },
      ],
    });

    const reporter = new JUnitReporter(tmpDir);
    reporter.onRunComplete(summary);

    const xml = fs.readFileSync(path.join(tmpDir, "junit.xml"), "utf-8");
    expect(xml).toContain("<skipped />");
    expect(xml).toContain('<testsuites name="skeptic" tests="2" failures="0" skipped="1"');
    expect(xml).toContain('<testsuite name="Partly Skipped" tests="2" failures="0" skipped="1"');
  });

  it("represents a whole skipped test (test.skip, no steps) as a skipped testcase", () => {
    const summary = makeSummary({
      tests: [
        {
          name: "Skipped Test",
          file: "tests/whole-skip.spec.ts",
          status: "passed",
          skipped: true,
          duration_ms: 0,
          steps: [],
        },
      ],
    });

    const reporter = new JUnitReporter(tmpDir);
    reporter.onRunComplete(summary);

    const xml = fs.readFileSync(path.join(tmpDir, "junit.xml"), "utf-8");
    expect(xml).toContain('<testsuites name="skeptic" tests="1" failures="0" skipped="1"');
    expect(xml).toContain('name="Skipped Test"');
    expect(xml).toContain("<skipped />");
  });

  it("renders shardId suffix on testsuite + testcase under sharding", () => {
    const summary = makeSummary({
      tests: [
        {
          name: "Login Test",
          file: "tests/login.spec.ts",
          status: "passed",
          duration_ms: 1000,
          steps: [
            { command: "navigate", args: { value: "/login" }, status: "passed", duration_ms: 200 },
          ],
          shardId: 0,
        },
        {
          name: "Login Test",
          file: "tests/login.spec.ts",
          status: "passed",
          duration_ms: 1100,
          steps: [
            { command: "navigate", args: { value: "/login" }, status: "passed", duration_ms: 210 },
          ],
          shardId: 1,
        },
      ],
      total: 2,
      passed: 2,
    });

    const reporter = new JUnitReporter(tmpDir);
    reporter.onRunComplete(summary);

    const xml = fs.readFileSync(path.join(tmpDir, "junit.xml"), "utf-8");
    expect(xml).toContain('name="Login Test [shard 1]"');
    expect(xml).toContain('name="Login Test [shard 2]"');
    expect(xml).toContain('classname="Login Test [shard 1]"');
    expect(xml).toContain('classname="Login Test [shard 2]"');
  });

  it("does NOT add shard suffix when shardId is undefined", () => {
    const reporter = new JUnitReporter(tmpDir);
    reporter.onRunComplete(makeSummary());

    const xml = fs.readFileSync(path.join(tmpDir, "junit.xml"), "utf-8");
    expect(xml).not.toContain("[shard ");
    expect(xml).toContain('name="Login Test"');
  });
});
