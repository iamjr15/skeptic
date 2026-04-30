import * as fs from "node:fs";
import * as path from "node:path";
import { PRODUCT_NAME } from "../constants.js";
import type { Reporter, RunSummary, TestResult, StepResult, TestIdentifier } from "./types.js";
import { formatTestDisplayName } from "./types.js";
import { logger } from "../utils/logger.js";

export class JUnitReporter implements Reporter {
  private readonly outputDir: string;

  constructor(outputDir: string) {
    this.outputDir = outputDir;
  }

  onTestStart(_flow: TestIdentifier): void {
    // no-op
  }

  onStepComplete(_step: StepResult, _index: number, _total: number, _flow: TestIdentifier): void {
    // no-op
  }

  onTestComplete(_result: TestResult, _flow: TestIdentifier): void {
    // no-op
  }

  onRunComplete(summary: RunSummary): void {
    fs.mkdirSync(this.outputDir, { recursive: true });
    const outPath = path.join(this.outputDir, "junit.xml");

    const totalTime = (summary.duration_ms / 1000).toFixed(3);
    const testsuites = summary.tests
      .map((flow) => buildTestSuite(flow, summary.tests))
      .join("\n");

    const xml = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<testsuites name="${esc(PRODUCT_NAME)}" tests="${summary.total}" failures="${summary.failed}" time="${totalTime}">`,
      testsuites,
      `</testsuites>`,
    ].join("\n");

    fs.writeFileSync(outPath, xml, "utf-8");
    logger.info(`JUnit report written to ${outPath}`);
  }
}

function buildTestSuite(flow: TestResult, siblings: TestResult[]): string {
  const failures = flow.steps.filter(
    (s) => s.status === "failed" || s.status === "error",
  ).length;
  const time = (flow.duration_ms / 1000).toFixed(3);
  const displayName = formatTestDisplayName(flow, siblings);

  const testcases = flow.steps
    .map((step) => {
      const stepTime = (step.duration_ms / 1000).toFixed(3);
      if (step.status === "passed") {
        return `    <testcase classname="${esc(displayName)}" name="${esc(step.command)}" time="${stepTime}" />`;
      }
      const failureMsg = step.error ? `\n      <failure message="${esc(step.error)}">${esc(step.error)}</failure>\n    ` : "";
      return `    <testcase classname="${esc(displayName)}" name="${esc(step.command)}" time="${stepTime}">${failureMsg}</testcase>`;
    })
    .join("\n");

  return `  <testsuite name="${esc(displayName)}" tests="${flow.steps.length}" failures="${failures}" time="${time}">\n${testcases}\n  </testsuite>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
