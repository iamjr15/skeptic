import * as fs from "node:fs";
import * as path from "node:path";
import { PRODUCT_NAME } from "../constants.js";
import type { Reporter, RunSummary, TestResult, StepResult, TestIdentifier } from "./types.js";
import { formatTestDisplayName } from "./types.js";
import { logger } from "../utils/logger.js";

export class JUnitReporter implements Reporter {
  private readonly outputDir: string;
  private readonly silent: boolean;

  constructor(outputDir: string, opts: { silent?: boolean } = {}) {
    this.outputDir = outputDir;
    this.silent = opts.silent ?? false;
  }

  onTestStart(_test: TestIdentifier): void {
    // no-op
  }

  onStepComplete(_step: StepResult, _index: number, _total: number, _test: TestIdentifier): void {
    // no-op
  }

  onTestComplete(_result: TestResult, _test: TestIdentifier): void {
    // no-op
  }

  onRunComplete(summary: RunSummary): void {
    fs.mkdirSync(this.outputDir, { recursive: true });
    const outPath = path.join(this.outputDir, "junit.xml");

    const totalTime = (summary.duration_ms / 1000).toFixed(3);
    const testsuites = summary.tests
      .map((test) => buildTestSuite(test, summary.tests))
      .join("\n");

    const xml = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<testsuites name="${esc(PRODUCT_NAME)}" tests="${summary.total}" failures="${summary.failed}" time="${totalTime}">`,
      testsuites,
      `</testsuites>`,
    ].join("\n");

    fs.writeFileSync(outPath, xml, "utf-8");
    if (!this.silent) logger.info(`JUnit report written to ${outPath}`);
  }
}

function buildTestSuite(test: TestResult, siblings: TestResult[]): string {
  const failures = test.steps.filter(
    (s) => s.status === "failed" || s.status === "error",
  ).length;
  const time = (test.duration_ms / 1000).toFixed(3);
  const displayName = formatTestDisplayName(test, siblings);

  const testcases = test.steps
    .map((step) => {
      const stepTime = (step.duration_ms / 1000).toFixed(3);
      if (step.status === "passed") {
        return `    <testcase classname="${esc(displayName)}" name="${esc(step.command)}" time="${stepTime}" />`;
      }
      const failureMsg = step.error ? `\n      <failure message="${esc(step.error)}">${esc(step.error)}</failure>\n    ` : "";
      return `    <testcase classname="${esc(displayName)}" name="${esc(step.command)}" time="${stepTime}">${failureMsg}</testcase>`;
    })
    .join("\n");

  return `  <testsuite name="${esc(displayName)}" tests="${test.steps.length}" failures="${failures}" time="${time}">\n${testcases}\n  </testsuite>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
