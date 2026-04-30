import { describe, expect, it } from "vitest";
import { formatPerfTraceMarkdown } from "../../../src/reporter/perf-trace-md.js";
import type { PerformanceSnapshot } from "../../../src/observability/types.js";

const perfWithLoaf = (
  scripts: Array<{
    invoker?: string;
    sourceURL?: string;
    sourceFunctionName?: string;
    duration: number;
    forcedStyleAndLayoutDuration: number;
  }>,
  blockingDuration = 200,
): PerformanceSnapshot => ({
  fcp: null,
  lcp: null,
  cls: null,
  inp: null,
  ttfb: null,
  longAnimationFrames: [
    {
      startTime: 100,
      duration: 500,
      blockingDuration,
      scripts: scripts.map((s) => ({
        invoker: s.invoker ?? "",
        sourceURL: s.sourceURL ?? "",
        sourceFunctionName: s.sourceFunctionName ?? "",
        duration: s.duration,
        forcedStyleAndLayoutDuration: s.forcedStyleAndLayoutDuration,
      })),
    },
  ],
});

describe("perf-trace-md LoAF script fields", () => {
  it("renders ⚠ forced layout flag when max script forced-layout > 30 ms", () => {
    const md = formatPerfTraceMarkdown({
      performance: perfWithLoaf([
        { sourceFunctionName: "slow", duration: 80, forcedStyleAndLayoutDuration: 50 },
      ]),
    });
    expect(md).toContain("⚠ forced layout: 50ms");
  });

  it("does NOT render frame-level forced-layout flag when all scripts are at or below 30 ms", () => {
    const md = formatPerfTraceMarkdown({
      performance: perfWithLoaf([
        { sourceFunctionName: "fast", duration: 80, forcedStyleAndLayoutDuration: 25 },
        { sourceFunctionName: "fast2", duration: 40, forcedStyleAndLayoutDuration: 0 },
      ]),
    });
    // The frame heading must not have the ⚠ flag…
    const frameHeading = md.split("\n").find((l) => l.startsWith("### Frame 1"));
    expect(frameHeading).toBeDefined();
    expect(frameHeading).not.toContain("forced layout");
    // …but the per-script ranking still surfaces non-zero forced-layout for scripts.
    expect(md).toContain("forced layout 25ms");
  });

  it("computes the frame-level flag from the MAX across scripts (per Chromium spec)", () => {
    const md = formatPerfTraceMarkdown({
      performance: perfWithLoaf([
        { sourceFunctionName: "a", duration: 80, forcedStyleAndLayoutDuration: 10 },
        { sourceFunctionName: "b", duration: 40, forcedStyleAndLayoutDuration: 90 },
      ]),
    });
    expect(md).toContain("⚠ forced layout: 90ms");
  });

  it("POOR threshold lifted to >150 ms — 120 ms blocking is no longer flagged", () => {
    const md = formatPerfTraceMarkdown({
      performance: perfWithLoaf(
        [{ sourceFunctionName: "x", duration: 30, forcedStyleAndLayoutDuration: 0 }],
        120,
      ),
    });
    expect(md).not.toContain("⚠ POOR");
  });

  it("POOR flag still fires above the new 150 ms threshold", () => {
    const md = formatPerfTraceMarkdown({
      performance: perfWithLoaf(
        [{ sourceFunctionName: "x", duration: 30, forcedStyleAndLayoutDuration: 0 }],
        200,
      ),
    });
    expect(md).toContain("⚠ POOR");
  });

  it("renders 'Scripts (sorted by duration):' subsection with top-3 + forced-layout cost", () => {
    const md = formatPerfTraceMarkdown({
      performance: perfWithLoaf([
        { sourceFunctionName: "small", duration: 5, forcedStyleAndLayoutDuration: 0 },
        { sourceFunctionName: "biggest", duration: 200, forcedStyleAndLayoutDuration: 60 },
        { sourceFunctionName: "medium", duration: 80, forcedStyleAndLayoutDuration: 0 },
        { sourceFunctionName: "second", duration: 100, forcedStyleAndLayoutDuration: 10 },
      ]),
    });
    expect(md).toContain("**Scripts (sorted by duration):**");
    // Top-3 by duration are biggest (200) > second (100) > medium (80). The 5 ms
    // entry must NOT appear in the ranked sub-section.
    const ranked = md.split("**Scripts (sorted by duration):**")[1] ?? "";
    expect(ranked.indexOf("biggest")).toBeGreaterThan(-1);
    expect(ranked.indexOf("second")).toBeGreaterThan(-1);
    expect(ranked.indexOf("medium")).toBeGreaterThan(-1);
    // forced-layout is rendered only when > 0
    expect(ranked).toContain("forced layout 60ms");
    expect(ranked).toContain("forced layout 10ms");
    // Note: medium has 0 forced-layout, so no forced-layout suffix
    const mediumLine = ranked.split("\n").find((l) => l.includes("medium"));
    expect(mediumLine).toBeDefined();
    expect(mediumLine).not.toContain("forced layout");
  });

  it("renders Server-Timing as a sub-list under Navigation Timing when present", () => {
    const md = formatPerfTraceMarkdown({
      performance: {
        fcp: null,
        lcp: null,
        cls: null,
        inp: null,
        ttfb: null,
        longAnimationFrames: [],
        navigationTiming: {
          ttfb: 50,
          domContentLoaded: 100,
          loadComplete: 200,
          serverTiming: [
            { name: "cache", duration: 12, description: "hit" },
            { name: "edge", duration: 3 },
            { name: "cdn-pop" },
          ],
        },
      },
    });
    expect(md).toContain("- **Server-Timing**:");
    expect(md).toContain("`cache` (12ms) — hit");
    expect(md).toContain("`edge` (3ms)");
    expect(md).toContain("`cdn-pop`");
  });

  it("omits Server-Timing line when empty/missing", () => {
    const md = formatPerfTraceMarkdown({
      performance: {
        fcp: null,
        lcp: null,
        cls: null,
        inp: null,
        ttfb: null,
        longAnimationFrames: [],
        navigationTiming: { ttfb: 50, domContentLoaded: 100, loadComplete: 200 },
      },
    });
    expect(md).not.toContain("Server-Timing");
  });
});
