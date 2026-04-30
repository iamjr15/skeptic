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
          name: "Login Flow",
          file: "flows/login.yaml",
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
          name: "Failing Flow",
          file: "flows/fail.yaml",
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
          name: 'Flow with "quotes" & <angle>',
          file: "flows/special.yaml",
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

  it("includes correct test counts in testsuites element", () => {
    const summary = makeSummary({
      total: 2,
      passed: 1,
      failed: 1,
    });

    const reporter = new JUnitReporter(tmpDir);
    reporter.onRunComplete(summary);

    const xml = fs.readFileSync(path.join(tmpDir, "junit.xml"), "utf-8");
    expect(xml).toContain('tests="2"');
    expect(xml).toContain('failures="1"');
  });

  it("renders shardId suffix on testsuite + testcase under sharding", () => {
    const summary = makeSummary({
      tests: [
        {
          name: "Login Flow",
          file: "flows/login.yaml",
          status: "passed",
          duration_ms: 1000,
          steps: [
            { command: "navigate", args: { value: "/login" }, status: "passed", duration_ms: 200 },
          ],
          shardId: 0,
        },
        {
          name: "Login Flow",
          file: "flows/login.yaml",
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
    expect(xml).toContain('name="Login Flow [shard 1]"');
    expect(xml).toContain('name="Login Flow [shard 2]"');
    expect(xml).toContain('classname="Login Flow [shard 1]"');
    expect(xml).toContain('classname="Login Flow [shard 2]"');
  });

  it("does NOT add shard suffix when shardId is undefined", () => {
    const reporter = new JUnitReporter(tmpDir);
    reporter.onRunComplete(makeSummary());

    const xml = fs.readFileSync(path.join(tmpDir, "junit.xml"), "utf-8");
    expect(xml).not.toContain("[shard ");
    expect(xml).toContain('name="Login Flow"');
  });
});
