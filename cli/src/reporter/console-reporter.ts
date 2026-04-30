import chalk from "chalk";
import { PRODUCT_NAME } from "../constants.js";
import type { Reporter, RunSummary, TestResult, StepResult, TestIdentifier } from "./types.js";
import type {
  AccessibilitySnapshot,
  NetworkSnapshot,
  PerformanceSnapshot,
} from "../observability/types.js";

export class ConsoleReporter implements Reporter {
  private readonly verbose: boolean;
  private readonly concurrency: number;
  private readonly shardLabel: string | undefined;
  private readonly suppressFinalSummary: boolean;
  private readonly buffer: Map<string, string[]> = new Map();

  constructor(
    opts: {
      verbose?: boolean;
      concurrency?: number;
      shardLabel?: string;
      suppressFinalSummary?: boolean;
    } = {},
  ) {
    this.verbose = opts.verbose ?? false;
    this.concurrency = opts.concurrency ?? 1;
    this.shardLabel = opts.shardLabel;
    this.suppressFinalSummary = opts.suppressFinalSummary ?? false;
  }

  /** Single output gate. When shardLabel is set, every line is prefixed with it. */
  private write(line: string): void {
    console.log(this.shardLabel ? `${this.shardLabel} ${line}` : line);
  }

  onTestStart(flow: TestIdentifier): void {
    if (this.concurrency > 1) {
      const lines = [
        "",
        `${chalk.bold(`  ${flow.name}`)} ${chalk.dim(`(${flow.file})`)}`,
      ];
      this.buffer.set(flow.name, lines);
    } else {
      this.write("");
      this.write(`${chalk.bold(`  ${flow.name}`)} ${chalk.dim(`(${flow.file})`)}`);
    }
  }

  onStepComplete(step: StepResult, index: number, total: number, flow: TestIdentifier): void {
    const icon =
      step.status === "passed"
        ? chalk.green("  ✓")
        : step.status === "failed"
          ? chalk.red("  ✗")
          : chalk.yellow("  ⚠");

    const duration = chalk.dim(`(${step.duration_ms}ms)`);
    const label = this.verbose
      ? `${step.command} ${typeof step.args === "string" ? step.args : JSON.stringify(step.args)}`
      : step.command;

    const line = `${icon} ${chalk.dim(`${index + 1}/${total}`)} ${label} ${duration}`;
    const errorLine = (step.error && (step.status === "failed" || step.status === "error"))
      ? chalk.red(`      ${step.error}`)
      : undefined;

    // Print baseline/current/diff paths for visual-regression failures
    const diffLines: string[] = [];
    if (step.diffPath) {
      if (step.baselinePath) diffLines.push(chalk.dim(`      baseline: ${step.baselinePath}`));
      if (step.currentPath) diffLines.push(chalk.dim(`      current:  ${step.currentPath}`));
      diffLines.push(chalk.dim(`      diff:     ${step.diffPath}`));
    }

    // Non-fatal warnings (soft-timeout, retryIfNoChange) — rendered in yellow after the step line.
    const warningLines: string[] = step.warnings?.map((w) => chalk.yellow(`      ⚠ ${w}`)) ?? [];

    if (this.concurrency > 1 && flow) {
      const buf = this.buffer.get(flow.name);
      if (buf) {
        buf.push(line);
        if (errorLine) buf.push(errorLine);
        for (const l of diffLines) buf.push(l);
        for (const l of warningLines) buf.push(l);
      }
    } else {
      this.write(line);
      if (errorLine) this.write(errorLine);
      for (const l of diffLines) this.write(l);
      for (const l of warningLines) this.write(l);
    }
  }

  onTestComplete(result: TestResult, _flow: TestIdentifier): void {
    const status =
      result.status === "passed"
        ? chalk.bgGreen.black(" PASS ")
        : chalk.bgRed.white(" FAIL ");

    const metricsLine = formatMetricsLine(result.metrics);

    const videoPath = result.artifacts?.video?.path;
    const tracePath = result.artifacts?.trace;
    if (this.concurrency > 1) {
      const buf = this.buffer.get(result.name);
      if (buf) {
        buf.push(`  ${status} ${chalk.dim(`${result.duration_ms}ms`)}`);
        if (videoPath) buf.push(`  ${chalk.dim("Video:")} ${chalk.cyan(videoPath)}`);
        if (tracePath) buf.push(`  ${chalk.dim("Trace:")} ${chalk.cyan(tracePath)}`);
        if (metricsLine) buf.push(metricsLine);
        // Flush buffered output through the shard-aware write gate.
        for (const line of buf) this.write(line);
        this.buffer.delete(result.name);
      }
    } else {
      this.write(`  ${status} ${chalk.dim(`${result.duration_ms}ms`)}`);
      if (videoPath) this.write(`  ${chalk.dim("Video:")} ${chalk.cyan(videoPath)}`);
      if (tracePath) this.write(`  ${chalk.dim("Trace:")} ${chalk.cyan(tracePath)}`);
      if (metricsLine) this.write(metricsLine);
    }
  }

  onRunComplete(summary: RunSummary): void {
    if (this.suppressFinalSummary) return;
    this.write("");
    this.write(chalk.bold(`  ${PRODUCT_NAME} Results`));
    this.write(chalk.dim("  ─".repeat(20)));

    const parts: string[] = [];
    if (summary.passed > 0) parts.push(chalk.green(`${summary.passed} passed`));
    if (summary.failed > 0) parts.push(chalk.red(`${summary.failed} failed`));
    parts.push(`${summary.total} total`);

    this.write(`  ${parts.join(chalk.dim(", "))}`);
    this.write(`  ${chalk.dim(`Duration: ${formatDuration(summary.duration_ms)}`)}`);
    this.write("");
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatMs(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
}

function formatMetricsLine(metrics: Record<string, unknown> | undefined): string | null {
  if (!metrics) return null;
  const parts: string[] = [];

  const perf = metrics.performance as PerformanceSnapshot | undefined;
  if (perf) {
    const bits: string[] = [];
    if (perf.fcp !== null) bits.push(`FCP ${formatMs(perf.fcp)}`);
    if (perf.lcp !== null) bits.push(`LCP ${formatMs(perf.lcp)}`);
    if (perf.cls !== null) bits.push(`CLS ${perf.cls.toFixed(3)}`);
    if (perf.inp !== null) bits.push(`INP ${formatMs(perf.inp)}`);
    if (perf.ttfb !== null) bits.push(`TTFB ${formatMs(perf.ttfb)}`);
    if (bits.length > 0) parts.push(`perf: ${bits.join(", ")}`);
  }

  const net = metrics.network as NetworkSnapshot | undefined;
  if (net) {
    const issueCount =
      net.issues.failedRequests.length +
      net.issues.networkFailures.length +
      net.issues.duplicates.length +
      net.issues.mixedContent.length +
      net.issues.corsErrors.length;
    parts.push(`net: ${net.requests.length} reqs${issueCount > 0 ? `, ${issueCount} issues` : ""}`);
  }

  const a11y = metrics.accessibility as AccessibilitySnapshot | undefined;
  if (a11y) parts.push(`a11y: ${a11y.summary.violations} violations`);

  if (parts.length === 0) return null;
  return `  ${chalk.dim("Metrics:")} ${chalk.dim(parts.join(" · "))}`;
}
