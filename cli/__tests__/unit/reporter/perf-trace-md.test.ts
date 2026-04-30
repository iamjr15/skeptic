import { describe, it, expect } from "vitest";
import { formatPerfTraceMarkdown } from "../../../src/reporter/perf-trace-md.js";
import type {
  AccessibilitySnapshot,
  ConsoleSnapshot,
  NetworkSnapshot,
  PerformanceSnapshot,
} from "../../../src/observability/types.js";

const samplePerf = (): PerformanceSnapshot => ({
  fcp: 1188,
  lcp: 3412,
  cls: 0.11,
  inp: 150,
  ttfb: 175,
  longAnimationFrames: [
    {
      startTime: 100,
      duration: 884,
      blockingDuration: 745,
      scripts: [
        { invoker: "DOMWindow.onload", sourceURL: "https://example.com/main.js", sourceFunctionName: "init", duration: 65 },
      ],
    },
  ],
  navigationTiming: { ttfb: 175, domContentLoaded: 968, loadComplete: 1036 },
  resources: [
    { name: "https://example.com/big.js", initiatorType: "script", duration: 200, transferSize: 50_000, encodedBodySize: 50_000, decodedBodySize: 150_000 },
    { name: "https://example.com/api?token=secret", initiatorType: "fetch", duration: 30, transferSize: 1_000, encodedBodySize: 1_000, decodedBodySize: 1_000 },
  ],
});

describe("formatPerfTraceMarkdown", () => {
  it("renders Web Vitals with rating labels", () => {
    const md = formatPerfTraceMarkdown({ performance: samplePerf() });
    expect(md).toContain("## Web Vitals");
    expect(md).toContain("**FCP**: 1188ms (good)");
    expect(md).toContain("**LCP**: 3412ms (needs-improvement)");
    expect(md).toContain("**CLS**: 0.110 (needs-improvement)");
    expect(md).toContain("**INP**: 150ms (good)");
  });

  it("renders Navigation Timing when present", () => {
    const md = formatPerfTraceMarkdown({ performance: samplePerf() });
    expect(md).toContain("## Navigation Timing");
    expect(md).toContain("**TTFB**: 175ms");
    expect(md).toContain("**DOM Content Loaded**: 968ms");
    expect(md).toContain("**Load Complete**: 1036ms");
  });

  it("renders LoAF with script attribution and POOR tag for blocking > 100ms", () => {
    const md = formatPerfTraceMarkdown({ performance: samplePerf() });
    expect(md).toContain("Long Animation Frames");
    expect(md).toContain("⚠ POOR");
    expect(md).toContain("Source: https://example.com/main.js");
  });

  it("renders Resources sourced from PerformanceSnapshot.resources, not network", () => {
    const md = formatPerfTraceMarkdown({ performance: samplePerf() });
    expect(md).toContain("## Resources");
    expect(md).toContain("Slowest Resources");
    // URL was redacted at capture time — token=secret would have already been replaced
    expect(md).toContain("https://example.com/big.js");
  });

  it("omits Resources entirely when PerformanceSnapshot.resources is missing", () => {
    const perf = samplePerf();
    delete perf.resources;
    const md = formatPerfTraceMarkdown({ performance: perf });
    expect(md).not.toContain("## Resources");
  });

  it("renders Network section with structured issues", () => {
    const net: NetworkSnapshot = {
      requests: [
        { url: "https://api/x", method: "GET", status: 500, resourceType: "xhr", timestamp: 1 },
      ],
      issues: {
        failedRequests: [{ url: "https://api/x", method: "GET", status: 500 }],
        networkFailures: [],
        duplicates: [],
        mixedContent: [],
        corsErrors: [],
      },
    };
    const md = formatPerfTraceMarkdown({ network: net });
    expect(md).toContain("## Network");
    expect(md).toContain("HTTP failures");
    expect(md).toContain("500 GET https://api/x");
  });

  it("renders Console summary and raises a banner when redaction is disabled", () => {
    const con: ConsoleSnapshot = {
      messages: [
        { type: "error", text: "boom", timestamp: 1 },
        { type: "warning", text: "uh oh", timestamp: 2 },
      ],
      summary: { total: 2, errorCount: 1, warningCount: 1, infoCount: 0, redactionDisabled: true },
    };
    const md = formatPerfTraceMarkdown({ console: con });
    expect(md).toContain("## Console");
    expect(md).toContain("2 message(s)");
    expect(md).toContain("Redaction is disabled");
    expect(md).toContain("**error**: boom");
  });

  it("renders Accessibility violations grouped by impact", () => {
    const a11y: AccessibilitySnapshot = {
      violations: [
        { ruleId: "color-contrast", impact: "serious", engine: "axe", help: "Insufficient contrast", helpUrl: "https://x", nodes: [] },
        { ruleId: "image-alt", impact: "critical", engine: "axe", help: "Missing alt text", nodes: [] },
      ],
      summary: { violations: 2, passes: 50, incomplete: 0, dualEngine: false },
      standard: "WCAG21AA",
    };
    const md = formatPerfTraceMarkdown({ accessibility: a11y });
    expect(md).toContain("## Accessibility");
    expect(md).toContain("Standard: WCAG21AA");
    expect(md).toContain("### Critical");
    expect(md).toContain("### Serious");
    expect(md).toContain("**image-alt**");
    expect(md).toContain("**color-contrast**");
  });

  it("returns just the title when given empty input", () => {
    const md = formatPerfTraceMarkdown({});
    expect(md.startsWith("# Performance Trace")).toBe(true);
    expect(md).not.toContain("## Web Vitals");
    expect(md).not.toContain("## Network");
  });

  it("renders a truncation banner when bucket size exceeds the cap", () => {
    const violations = Array.from({ length: 12 }, (_, i) => ({
      ruleId: `rule-${i}`,
      impact: "serious" as const,
      engine: "axe" as const,
      help: `help ${i}`,
      nodes: [],
    }));
    const a11y: AccessibilitySnapshot = {
      violations,
      summary: { violations: 12, passes: 0, incomplete: 0, dualEngine: false },
      standard: "WCAG21AA",
    };
    const md = formatPerfTraceMarkdown({ accessibility: a11y }, { accessibilityMaxRulesPerImpact: 5 });
    expect(md).toContain("### Serious (12)");
    // First 5 rendered, remaining 7 announced via banner.
    expect(md).toContain("**rule-0**");
    expect(md).toContain("**rule-4**");
    expect(md).not.toContain("**rule-5**");
    expect(md).toContain("...and 7 more — see audit.md");
  });

  it("does not show the truncation banner when bucket fits within the cap (default 100)", () => {
    const violations = Array.from({ length: 30 }, (_, i) => ({
      ruleId: `rule-${i}`,
      impact: "minor" as const,
      engine: "axe" as const,
      help: `help ${i}`,
      nodes: [],
    }));
    const a11y: AccessibilitySnapshot = {
      violations,
      summary: { violations: 30, passes: 0, incomplete: 0, dualEngine: false },
      standard: "WCAG21AA",
    };
    const md = formatPerfTraceMarkdown({ accessibility: a11y });
    expect(md).toContain("### Minor (30)");
    expect(md).toContain("**rule-29**");
    expect(md).not.toContain("see audit.md");
  });
});
