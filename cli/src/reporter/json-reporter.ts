import * as fs from "node:fs";
import * as path from "node:path";
import type { Reporter, RunSummary, TestResult, StepResult, TestIdentifier } from "./types.js";
import type {
  AccessibilitySnapshot,
  ConsoleSnapshot,
  NetworkSnapshot,
  PerformanceSnapshot,
} from "../observability/types.js";
import { logger } from "../utils/logger.js";

interface MetricsSummary {
  perfRating?: "good" | "needs-improvement" | "poor";
  a11yViolations?: number;
  networkIssues?: number;
  consoleErrors?: number;
}

const computeMetricsSummary = (metrics: Record<string, unknown> | undefined): MetricsSummary | undefined => {
  if (!metrics) return undefined;
  const out: MetricsSummary = {};
  const perf = metrics["performance"] as PerformanceSnapshot | undefined;
  if (perf && (perf.lcp !== null || perf.cls !== null || perf.inp !== null)) {
    // worst-of-three: any "poor" → poor, any "needs-improvement" → needs-improvement
    let worst: 0 | 1 | 2 = 0; // 0=good, 1=needs, 2=poor
    const bump = (rank: 0 | 1 | 2): void => { if (rank > worst) worst = rank; };
    if (perf.lcp !== null) bump(perf.lcp <= 2500 ? 0 : perf.lcp <= 4000 ? 1 : 2);
    if (perf.cls !== null) bump(perf.cls <= 0.1 ? 0 : perf.cls <= 0.25 ? 1 : 2);
    if (perf.inp !== null) bump(perf.inp <= 200 ? 0 : perf.inp <= 500 ? 1 : 2);
    out.perfRating = worst === 0 ? "good" : worst === 1 ? "needs-improvement" : "poor";
  }
  const net = metrics["network"] as NetworkSnapshot | undefined;
  if (net) {
    out.networkIssues =
      net.issues.failedRequests.length +
      net.issues.networkFailures.length +
      net.issues.duplicates.length +
      net.issues.mixedContent.length +
      net.issues.corsErrors.length;
  }
  const a11y = metrics["accessibility"] as AccessibilitySnapshot | undefined;
  if (a11y) out.a11yViolations = a11y.summary.violations;
  const con = metrics["console"] as ConsoleSnapshot | undefined;
  if (con) out.consoleErrors = con.summary.errorCount;
  return Object.keys(out).length > 0 ? out : undefined;
};

export class JsonReporter implements Reporter {
  private readonly outputDir: string;

  constructor(outputDir: string) {
    this.outputDir = outputDir;
  }

  onTestStart(_flow: TestIdentifier): void {
    // no-op for JSON reporter
  }

  onStepComplete(_step: StepResult, _index: number, _total: number, _flow: TestIdentifier): void {
    // no-op for JSON reporter
  }

  onTestComplete(_result: TestResult, _flow: TestIdentifier): void {
    // no-op for JSON reporter
  }

  onRunComplete(summary: RunSummary): void {
    fs.mkdirSync(this.outputDir, { recursive: true });
    const outPath = path.join(this.outputDir, "results.json");

    const testsWithSummary = summary.tests.map((test) => {
      const metricsSummary = computeMetricsSummary(test.metrics);
      return metricsSummary !== undefined
        ? { ...test, metricsSummary }
        : test;
    });

    const output = {
      // 0.3.0 — flows → tests rename (TS-pivot). 0.2.0 added artifacts + diagnostics + metricsSummary.
      version: "0.3.0",
      timestamp: new Date().toISOString(),
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      duration_ms: summary.duration_ms,
      tests: testsWithSummary,
    };

    const pretty = process.env["SKEPTIC_JSON_PRETTY"] === "true";
    fs.writeFileSync(outPath, JSON.stringify(output, null, pretty ? 2 : 0), "utf-8");
    logger.info(`JSON report written to ${outPath}`);
  }
}
