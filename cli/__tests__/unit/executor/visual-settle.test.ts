import { describe, it, expect, vi } from "vitest";
import { PNG } from "pngjs";
import type { Page } from "playwright";
import { ExecutionContext } from "../../../src/executor/context.js";
import {
  awaitVisualSettle,
  detectBlankFrame,
  DISABLED_SETTLE,
  OBSERVABILITY_SETTLE_PROFILE,
  type VisualSettleConfig,
} from "../../../src/executor/visual-settle.js";

const buildPng = (width: number, height: number, fill: number): Buffer => {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) << 2;
      png.data[i] = fill;
      png.data[i + 1] = fill;
      png.data[i + 2] = fill;
      png.data[i + 3] = 0xff;
    }
  }
  return PNG.sync.write(png);
};

const makePage = (): Page => {
  return {
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(buildPng(256, 256, 0xff)),
    isClosed: vi.fn().mockReturnValue(false),
  } as unknown as Page;
};

const makeCtx = (page: Page): ExecutionContext =>
  new ExecutionContext(page, "https://example.com");

describe("awaitVisualSettle", () => {
  it("is a no-op fast-path when disabled", async () => {
    const page = makePage();
    const ctx = makeCtx(page);

    await awaitVisualSettle(page, ctx, DISABLED_SETTLE);

    expect(page.waitForLoadState).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("calls networkidle wait and double-RAF when enabled", async () => {
    const page = makePage();
    const ctx = makeCtx(page);

    await awaitVisualSettle(page, ctx, OBSERVABILITY_SETTLE_PROFILE);

    expect(page.waitForLoadState).toHaveBeenCalledWith("networkidle", { timeout: 500 });
    // animationFrames=2 → two evaluate calls each performing double-RAF
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });

  it("short-circuits when ctx.abortReason is set", async () => {
    const page = makePage();
    const ctx = makeCtx(page);
    ctx.abortReason = "hard-timeout";

    await awaitVisualSettle(page, ctx, OBSERVABILITY_SETTLE_PROFILE);

    expect(page.waitForLoadState).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("races against hardCeilingMs", async () => {
    const slowPage = {
      waitForLoadState: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
      evaluate: vi.fn().mockResolvedValue(undefined),
      isClosed: vi.fn().mockReturnValue(false),
    } as unknown as Page;
    const ctx = makeCtx(slowPage);

    const cfg: VisualSettleConfig = {
      enabled: true,
      networkIdleMs: 60_000, // would otherwise hang the test
      animationFrames: 0,
      pixelStableMs: 0,
      hardCeilingMs: 50, // ceiling fires first
    };

    const start = Date.now();
    await awaitVisualSettle(slowPage, ctx, cfg);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
  });

  it("survives a page that closes mid-settle", async () => {
    const page = makePage();
    (page.isClosed as ReturnType<typeof vi.fn>).mockReturnValueOnce(false).mockReturnValue(true);
    const ctx = makeCtx(page);

    await expect(
      awaitVisualSettle(page, ctx, OBSERVABILITY_SETTLE_PROFILE),
    ).resolves.toBeUndefined();
  });
});

const buildVariedPng = (width: number, height: number): Buffer => {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) << 2;
      png.data[i] = (x * 7 + y * 11) & 0xff;
      png.data[i + 1] = (x * 13 + y * 17) & 0xff;
      png.data[i + 2] = (x * 19 + y * 23) & 0xff;
      png.data[i + 3] = 0xff;
    }
  }
  return PNG.sync.write(png);
};

describe("detectBlankFrame", () => {
  it("flags a tiny all-black PNG (the jigyansurout symptom — both flags fire)", () => {
    // The benchmark artifact reproduces this exactly: a small, uniform-black PNG.
    const allBlack = buildPng(160, 90, 0);
    const decision = detectBlankFrame(allBlack);
    expect(decision.blank).toBe(true);
    expect(decision.reasons.length).toBe(2);
  });

  it("does not flag a varied small PNG (variance flag clears)", () => {
    // Tiny buffer but high variance. Size flag fires; variance flag does not.
    // blank requires BOTH, so this stays false.
    const buf = buildVariedPng(64, 64);
    const decision = detectBlankFrame(buf);
    expect(decision.blank).toBe(false);
  });

  it("does not flag a real-content (varied + larger) PNG", () => {
    // Bigger and varied — neither flag fires.
    const buf = buildVariedPng(640, 480);
    const decision = detectBlankFrame(buf);
    expect(decision.blank).toBe(false);
  });

  it("returns metadata for diagnostic reporting", () => {
    const allBlack = buildPng(160, 90, 0);
    const decision = detectBlankFrame(allBlack);
    expect(decision.meta.byteSize).toBe(allBlack.byteLength);
    expect(decision.meta.channelRange).toBe(0);
  });
});
