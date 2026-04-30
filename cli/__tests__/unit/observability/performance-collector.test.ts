import { describe, expect, it, vi } from "vitest";
import { PerformanceCollector } from "../../../src/observability/collectors/performance-collector.js";
import type { Page } from "playwright";
import type { ExecutionContext } from "../../../src/executor/context.js";

const mockCtx = {} as ExecutionContext;

const mockPage = (evaluateResult: unknown = null, isClosed: boolean = false): Page => {
  const addInitScript = vi.fn().mockResolvedValue(undefined);
  const evaluate = vi.fn().mockResolvedValue(evaluateResult);
  const isClosedFn = vi.fn().mockReturnValue(isClosed);
  return {
    addInitScript,
    evaluate,
    isClosed: isClosedFn,
  } as unknown as Page;
};

describe("PerformanceCollector", () => {
  it("attach calls addInitScript ONCE with combined content", async () => {
    const collector = new PerformanceCollector();
    const page = mockPage();
    await collector.attach(page, mockCtx);

    const addInitScript = page.addInitScript as unknown as ReturnType<typeof vi.fn>;
    expect(addInitScript).toHaveBeenCalledTimes(1);

    const arg = addInitScript.mock.calls[0]![0] as { content: string };
    expect(arg).toHaveProperty("content");
    // Contains web-vitals IIFE markers
    expect(arg.content).toMatch(/webVitals/);
    expect(arg.content).toMatch(/onLCP/);
    // Contains our wrapper markers
    expect(arg.content).toMatch(/__skepticMetrics/);
    expect(arg.content).toMatch(/long-animation-frame/);
  });

  it("snapshot returns a normalized PerformanceSnapshot from page.evaluate output", async () => {
    const collector = new PerformanceCollector();
    const page = mockPage({
      fcp: 1200.7,
      lcp: 2300.1,
      cls: 0.0567,
      inp: 180.4,
      ttfb: 250.9,
      longAnimationFrames: [],
    });
    await collector.attach(page, mockCtx);
    const snap = await collector.snapshot();
    // Core web-vitals must be present and rounded; navigationTiming/resources are
    // best-effort extras populated by additional page.evaluate() calls.
    expect(snap).toMatchObject({
      fcp: 1200.7,
      lcp: 2300.1,
      cls: 0.057,   // rounded to 3 decimals
      inp: 180,     // rounded to int
      ttfb: 251,    // rounded to int
      longAnimationFrames: [],
    });
  });

  it("snapshot preserves null when metric did not fire", async () => {
    const collector = new PerformanceCollector();
    const page = mockPage({
      fcp: 1200,
      lcp: null,
      cls: null,
      inp: null,
      ttfb: null,
      longAnimationFrames: [],
    });
    await collector.attach(page, mockCtx);
    const snap = await collector.snapshot();
    expect(snap.lcp).toBeNull();
    expect(snap.cls).toBeNull();
    expect(snap.inp).toBeNull();
    expect(snap.ttfb).toBeNull();
    expect(snap.fcp).toBe(1200);
  });

  it("snapshot returns empty shape when page is closed", async () => {
    const collector = new PerformanceCollector();
    const page = mockPage(null, true);
    await collector.attach(page, mockCtx);
    const snap = await collector.snapshot();
    expect(snap).toEqual({
      fcp: null,
      lcp: null,
      cls: null,
      inp: null,
      ttfb: null,
      longAnimationFrames: [],
    });
    // Evaluate should not have been called when page is closed
    expect((page.evaluate as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("snapshot returns empty shape when evaluate throws", async () => {
    const collector = new PerformanceCollector();
    const page = mockPage();
    (page.evaluate as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    await collector.attach(page, mockCtx);
    const snap = await collector.snapshot();
    expect(snap.fcp).toBeNull();
    expect(snap.lcp).toBeNull();
  });

  it("snapshot truncates LoAF entries to buffer limit", async () => {
    const collector = new PerformanceCollector();
    const frames = Array.from({ length: 100 }, (_, i) => ({
      startTime: i,
      duration: 10,
      blockingDuration: 5,
      scripts: [],
    }));
    const page = mockPage({
      fcp: null,
      lcp: null,
      cls: null,
      inp: null,
      ttfb: null,
      longAnimationFrames: frames,
    });
    await collector.attach(page, mockCtx);
    const snap = await collector.snapshot();
    expect(snap.longAnimationFrames).toHaveLength(50);
  });

  it("detach clears page reference", async () => {
    const collector = new PerformanceCollector();
    const page = mockPage();
    await collector.attach(page, mockCtx);
    await collector.detach();
    // After detach, snapshot must return empty (no page)
    const snap = await collector.snapshot();
    expect(snap.fcp).toBeNull();
  });
});
