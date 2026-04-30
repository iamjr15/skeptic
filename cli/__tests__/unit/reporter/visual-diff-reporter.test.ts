import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConsoleReporter } from "../../../src/reporter/console-reporter.js";
import { HtmlReporter } from "../../../src/reporter/html-reporter.js";
import type { StepResult, TestIdentifier, TestResult, RunSummary } from "../../../src/reporter/types.js";

const flowId: TestIdentifier = { name: "visual-flow", file: "/tmp/v.yaml", testIndex: 0 };

function stepFailure(overrides: Partial<StepResult> = {}): StepResult {
  return {
    command: "assert-screenshot",
    args: { path: "home" },
    status: "failed",
    duration_ms: 42,
    error: "Visual regression: 75% match",
    ...overrides,
  };
}

function buildSummary(flow: TestResult): RunSummary {
  return { total: 1, passed: 0, failed: 1, duration_ms: flow.duration_ms, tests: [flow] };
}

describe("console reporter — visual diff output", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("prints baseline/current/diff paths for visual regression failures", () => {
    const reporter = new ConsoleReporter();
    const step = stepFailure({
      baselinePath: "/out/baseline-home.png",
      currentPath: "/out/current-home.png",
      diffPath: "/out/diff-home.png",
    });
    reporter.onStepComplete(step, 0, 1, flowId);
    const output = consoleSpy.mock.calls.flat().join("\n");
    expect(output).toContain("/out/baseline-home.png");
    expect(output).toContain("/out/current-home.png");
    expect(output).toContain("/out/diff-home.png");
  });

  it("does NOT print a diff block for non-visual failures (screenshot only)", () => {
    const reporter = new ConsoleReporter();
    const step = stepFailure({
      command: "click",
      error: "element not found",
      screenshot: "/out/failure-step-1.png",
    });
    reporter.onStepComplete(step, 0, 1, flowId);
    const output = consoleSpy.mock.calls.flat().join("\n");
    expect(output).not.toContain("baseline:");
    expect(output).not.toContain("current:");
    expect(output).not.toContain("diff:");
  });
});

describe("html reporter — visual diff output", () => {
  let tmpDir: string;
  let baselinePath: string;
  let currentPath: string;
  let diffPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-html-diff-"));
    // tiny 1x1 png buffer (not a real png, just bytes to prove embedding works)
    baselinePath = path.join(tmpDir, "baseline.png");
    currentPath = path.join(tmpDir, "current.png");
    diffPath = path.join(tmpDir, "diff.png");
    fs.writeFileSync(baselinePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(currentPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(diffPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders a 3-column visual-diff grid for visual regression failures", () => {
    const reporter = new HtmlReporter(tmpDir);
    const flow: TestResult = {
      name: "visual-flow",
      file: "/tmp/v.yaml",
      status: "failed",
      duration_ms: 42,
      steps: [
        stepFailure({ baselinePath, currentPath, diffPath, screenshot: diffPath }),
      ],
    };
    reporter.onRunComplete(buildSummary(flow));
    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain(`class="visual-diff"`);
    expect(html).toMatch(/<figure><figcaption>Baseline<\/figcaption>/);
    expect(html).toMatch(/<figure><figcaption>Current<\/figcaption>/);
    expect(html).toMatch(/<figure><figcaption>Diff<\/figcaption>/);
  });

  it("falls back to single screenshot rendering for non-visual failures", () => {
    const reporter = new HtmlReporter(tmpDir);
    const flow: TestResult = {
      name: "click-flow",
      file: "/tmp/c.yaml",
      status: "failed",
      duration_ms: 10,
      steps: [
        stepFailure({ command: "click", screenshot: diffPath }),
      ],
    };
    reporter.onRunComplete(buildSummary(flow));
    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain(`class="screenshot"`);
    expect(html).not.toContain(`class="visual-diff"`);
  });
});
