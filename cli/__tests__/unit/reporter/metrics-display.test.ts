import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConsoleReporter } from "../../../src/reporter/console-reporter.js";
import { HtmlReporter } from "../../../src/reporter/html-reporter.js";
import { JsonReporter } from "../../../src/reporter/json-reporter.js";
import type { TestResult, RunSummary } from "../../../src/reporter/types.js";
import type {
  AccessibilitySnapshot,
  NetworkSnapshot,
  PerformanceSnapshot,
} from "../../../src/observability/types.js";

const fullFlow = (metrics?: Record<string, unknown>): TestResult => ({
  name: "test-flow",
  file: "/tmp/test.yaml",
  status: "passed",
  duration_ms: 1234,
  steps: [],
  ...(metrics ? { metrics } : {}),
});

const fullPerf: PerformanceSnapshot = {
  fcp: 800,
  lcp: 2300,
  cls: 0.05,
  inp: 180,
  ttfb: 250,
  longAnimationFrames: [],
};

const fullNet: NetworkSnapshot = {
  requests: Array.from({ length: 42 }, (_, i) => ({
    url: `https://x/${i}`,
    method: "GET",
    resourceType: "xhr",
    timestamp: i,
    status: 200,
  })),
  issues: {
    failedRequests: [{ url: "https://x/500", method: "GET", status: 500 }],
    networkFailures: [{ url: "http://dead.invalid/", method: "GET", reason: "DNS" }],
    duplicates: [],
    mixedContent: [],
    corsErrors: [],
  },
};

const fullA11y: AccessibilitySnapshot = {
  violations: [
    { ruleId: "color-contrast", impact: "serious", engine: "axe", help: "h", nodes: [] },
    { ruleId: "image-alt", impact: "critical", engine: "axe", help: "h", nodes: [] },
    { ruleId: "aria-label", impact: "moderate", engine: "axe", help: "h", nodes: [] },
  ],
  summary: { violations: 3, passes: 10, incomplete: 0, dualEngine: false },
  standard: "WCAG2AA",
};

describe("ConsoleReporter metrics line", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emits metrics line with all five Web Vitals + net + a11y", () => {
    const reporter = new ConsoleReporter();
    reporter.onTestStart({ name: "t", file: "/t.yaml", testIndex: 0 });
    reporter.onTestComplete(
      fullFlow({
        performance: fullPerf,
        network: fullNet,
        accessibility: fullA11y,
      }),
      { name: "t", file: "/t.yaml", testIndex: 0 },
    );
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toMatch(/FCP 800ms/);
    expect(output).toMatch(/LCP 2\.30s/);
    expect(output).toMatch(/CLS 0\.050/);
    expect(output).toMatch(/INP 180ms/);
    expect(output).toMatch(/TTFB 250ms/);
    expect(output).toMatch(/a11y: 3 violations/);
    expect(output).toMatch(/net: 42 reqs/);
    expect(output).toMatch(/, 2 issues/);
  });

  it("omits metrics line entirely when metrics is undefined", () => {
    const reporter = new ConsoleReporter();
    reporter.onTestStart({ name: "t", file: "/t.yaml", testIndex: 0 });
    reporter.onTestComplete(fullFlow(), { name: "t", file: "/t.yaml", testIndex: 0 });
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).not.toMatch(/Metrics:/);
  });

  it("shows only metrics that fired; no 'CLS null' noise", () => {
    const reporter = new ConsoleReporter();
    const perf: PerformanceSnapshot = {
      fcp: 800,
      lcp: null,
      cls: null,
      inp: null,
      ttfb: null,
      longAnimationFrames: [],
    };
    reporter.onTestStart({ name: "t", file: "/t.yaml", testIndex: 0 });
    reporter.onTestComplete(fullFlow({ performance: perf }), {
      name: "t",
      file: "/t.yaml",
      testIndex: 0,
    });
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toMatch(/FCP 800ms/);
    expect(output).not.toMatch(/LCP/);
    expect(output).not.toMatch(/CLS/);
    expect(output).not.toMatch(/null/);
  });

  it("network issueCount includes all five categories", () => {
    const reporter = new ConsoleReporter();
    const net: NetworkSnapshot = {
      requests: [],
      issues: {
        failedRequests: [{ url: "a", method: "GET", status: 500 }],
        networkFailures: [{ url: "b", method: "GET", reason: "DNS" }],
        duplicates: [{ url: "c", method: "GET", count: 2, windowMs: 500 }],
        mixedContent: ["d"],
        corsErrors: [{ url: "e", method: "GET", reason: "CORS" }],
      },
    };
    reporter.onTestStart({ name: "t", file: "/t.yaml", testIndex: 0 });
    reporter.onTestComplete(fullFlow({ network: net }), {
      name: "t",
      file: "/t.yaml",
      testIndex: 0,
    });
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toMatch(/5 issues/);
  });
});

describe("HtmlReporter metrics section", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "html-metrics-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders flow-metrics section with metric cards when metrics present", () => {
    const reporter = new HtmlReporter(tmpDir);
    const summary: RunSummary = {
      total: 1,
      passed: 1,
      failed: 0,
      duration_ms: 1234,
      tests: [
        fullFlow({
          performance: fullPerf,
          network: fullNet,
          accessibility: fullA11y,
        }),
      ],
    };
    reporter.onRunComplete(summary);
    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toMatch(/<details class="flow-metrics" open>/);
    expect(html).toMatch(/Core Web Vitals/);
    expect(html).toMatch(/Network/);
    expect(html).toMatch(/Accessibility/);
    expect(html).toMatch(/LCP/);
    expect(html).toMatch(/42 request\(s\)/);
    expect(html).toMatch(/WCAG2AA/);
  });

  it("does NOT render flow-metrics <details> when metrics absent", () => {
    const reporter = new HtmlReporter(tmpDir);
    const summary: RunSummary = {
      total: 1,
      passed: 1,
      failed: 0,
      duration_ms: 1234,
      tests: [fullFlow()],
    };
    reporter.onRunComplete(summary);
    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    // CSS class rules are always in the stylesheet; what we check is the actual <details> element
    expect(html).not.toMatch(/<details class="flow-metrics"/);
  });
});

describe("JsonReporter metrics pass-through", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "json-metrics-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("serializes metrics at flows[i].metrics (top-level flows, not summary.tests)", () => {
    const reporter = new JsonReporter(tmpDir);
    const summary: RunSummary = {
      total: 1,
      passed: 1,
      failed: 0,
      duration_ms: 1234,
      tests: [
        fullFlow({
          performance: fullPerf,
          accessibility: fullA11y,
        }),
      ],
    };
    reporter.onRunComplete(summary);
    const raw = fs.readFileSync(path.join(tmpDir, "results.json"), "utf-8");
    const parsed = JSON.parse(raw) as {
      tests: Array<{ metrics?: { performance?: PerformanceSnapshot; accessibility?: AccessibilitySnapshot } }>;
    };
    expect(parsed.tests[0]?.metrics).toBeDefined();
    expect(parsed.tests[0]?.metrics?.performance).toEqual(fullPerf);
    expect(parsed.tests[0]?.metrics?.accessibility?.summary.violations).toBe(3);
  });
});
