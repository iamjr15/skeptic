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
    const suites = summary.tests.map((test) => buildTestSuite(test, summary.tests));

    // The aggregate `tests`/`failures`/`skipped` attributes must summarize the actual
    // <testcase> elements emitted (one per step, plus a synthetic case for whole-test
    // skips) — not the run's test-level totals. The previous code mixed the two (test-level
    // counts over step-level testcases), so the numbers never reconciled.
    const totalTests = suites.reduce((n, s) => n + s.tests, 0);
    const totalFailures = suites.reduce((n, s) => n + s.failures, 0);
    const totalSkipped = suites.reduce((n, s) => n + s.skipped, 0);

    const xml = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<testsuites name="${esc(PRODUCT_NAME)}" tests="${totalTests}" failures="${totalFailures}" skipped="${totalSkipped}" time="${totalTime}">`,
      suites.map((s) => s.xml).join("\n"),
      `</testsuites>`,
    ].join("\n");

    fs.writeFileSync(outPath, xml, "utf-8");
    if (!this.silent) logger.info(`JUnit report written to ${outPath}`);
  }
}

interface SuiteRender {
  xml: string;
  tests: number;
  failures: number;
  skipped: number;
}

function buildTestSuite(test: TestResult, siblings: TestResult[]): SuiteRender {
  const time = (test.duration_ms / 1000).toFixed(3);
  const displayName = formatTestDisplayName(test, siblings);

  // A test declared `test.skip(...)` never runs its body, so it has no steps. Emit a single
  // skipped testcase so the skip shows up in the tally rather than vanishing as an empty
  // testsuite (which most JUnit consumers read as "0 tests").
  if (test.skipped && test.steps.length === 0) {
    const xml =
      `  <testsuite name="${esc(displayName)}" tests="1" failures="0" skipped="1" time="${time}">\n` +
      `    <testcase classname="${esc(displayName)}" name="${esc(test.name)}" time="${time}"><skipped /></testcase>\n` +
      `  </testsuite>`;
    return { xml, tests: 1, failures: 0, skipped: 1 };
  }

  const failures = test.steps.filter(
    (s) => s.status === "failed" || s.status === "error",
  ).length;
  const skipped = test.steps.filter((s) => s.status === "skipped").length;

  const testcases = test.steps
    .map((step) => {
      const stepTime = (step.duration_ms / 1000).toFixed(3);
      if (step.status === "passed") {
        return `    <testcase classname="${esc(displayName)}" name="${esc(step.command)}" time="${stepTime}" />`;
      }
      if (step.status === "skipped") {
        return `    <testcase classname="${esc(displayName)}" name="${esc(step.command)}" time="${stepTime}"><skipped /></testcase>`;
      }
      const failureMsg = step.error ? `\n      <failure message="${esc(step.error)}">${esc(step.error)}</failure>\n    ` : "";
      return `    <testcase classname="${esc(displayName)}" name="${esc(step.command)}" time="${stepTime}">${failureMsg}</testcase>`;
    })
    .join("\n");

  const xml =
    `  <testsuite name="${esc(displayName)}" tests="${test.steps.length}" failures="${failures}" skipped="${skipped}" time="${time}">\n` +
    `${testcases}\n  </testsuite>`;

  return { xml, tests: test.steps.length, failures, skipped };
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
