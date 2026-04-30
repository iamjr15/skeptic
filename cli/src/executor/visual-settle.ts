import type { Page } from "playwright";
import { PNG } from "pngjs";
import type { ExecutionContext } from "./context.js";
import { logger } from "../utils/logger.js";

/**
 * Configuration for the visual-settle helper used before screenshots and (optionally) before
 * video finalization. The helper is a no-op fast-path when `enabled` is false — keeps the
 * non-observability default zero-cost.
 */
export interface VisualSettleConfig {
  enabled: boolean;
  /** Wait for `networkidle` with this ceiling (ms). 0 disables the network wait. */
  networkIdleMs: number;
  /** Number of double-RAF cycles to await. 0 disables. The single most effective settle
   *  for canvas / WebGL preloaders in practice (most clear by the second RAF). */
  animationFrames: number;
  /** Optional pixel-stability poll budget (ms). 0 disables; the cost is one extra
   *  centred screenshot per poll iteration plus a CRC32 hash. */
  pixelStableMs: number;
  /** Overall hard ceiling (ms). Wraps the whole helper in a Node-side Promise.race so a
   *  misbehaving page can't blow the step's hardTimeout. */
  hardCeilingMs: number;
}

export const DISABLED_SETTLE: VisualSettleConfig = {
  enabled: false,
  networkIdleMs: 0,
  animationFrames: 0,
  pixelStableMs: 0,
  hardCeilingMs: 0,
};

export const OBSERVABILITY_SETTLE_PROFILE: VisualSettleConfig = {
  enabled: true,
  networkIdleMs: 500,
  animationFrames: 2,
  pixelStableMs: 0,
  hardCeilingMs: 1500,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for the page to visually settle. Each step re-checks `ctx.abortReason` so a fired
 * hardTimeout short-circuits the helper without touching the page.
 *
 * Step order:
 *   1. networkidle wait (capped via Promise.race against a sleep)
 *   2. double-RAF, `cfg.animationFrames` times
 *   3. optional pixel-stability poll (off by default)
 *
 * The whole helper races against `cfg.hardCeilingMs`. If the ceiling fires first the helper
 * resolves quietly so the caller can decide what to do (screenshot still proceeds).
 */
export const awaitVisualSettle = async (
  page: Page,
  ctx: ExecutionContext,
  cfg: VisualSettleConfig,
): Promise<void> => {
  if (!cfg.enabled) return;
  if (ctx.abortReason !== null) return;
  if (page.isClosed()) return;

  const body = async (): Promise<void> => {
    if (cfg.networkIdleMs > 0) {
      try {
        await Promise.race([
          page.waitForLoadState("networkidle", { timeout: cfg.networkIdleMs }),
          sleep(cfg.networkIdleMs),
        ]);
      } catch {
        // networkidle timeouts are fine — we already capped via the race
      }
      if (ctx.abortReason !== null || page.isClosed()) return;
    }

    for (let i = 0; i < cfg.animationFrames; i++) {
      try {
        await page.evaluate(
          "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
        );
      } catch {
        return;
      }
      if (ctx.abortReason !== null || page.isClosed()) return;
    }

    if (cfg.pixelStableMs > 0) {
      const pollDeadline = Date.now() + cfg.pixelStableMs;
      let lastHash: number | null = null;
      let stableHits = 0;
      while (Date.now() < pollDeadline) {
        if (ctx.abortReason !== null || page.isClosed()) return;
        try {
          const buf = await page.screenshot({
            clip: { x: 0, y: 0, width: 256, height: 256 },
            type: "png",
          });
          const hash = crc32(buf);
          if (lastHash !== null && hash === lastHash) {
            stableHits++;
            if (stableHits >= 2) return;
          } else {
            stableHits = 0;
          }
          lastHash = hash;
        } catch {
          return;
        }
        await sleep(50);
      }
    }
  };

  if (cfg.hardCeilingMs <= 0) {
    await body();
    return;
  }
  await Promise.race([body(), sleep(cfg.hardCeilingMs)]);
};

export interface BlankFrameDecision {
  blank: boolean;
  reasons: string[];
  meta: { byteSize: number; channelRange: number };
}

const SCREENSHOT_BLANK_BYTE_FLOOR = 8 * 1024;
const PIXEL_VARIANCE_THRESHOLD = 8;
const SAMPLE_TARGET = 4096;

/**
 * Heuristic blank-frame detector. Both flags must trigger to call a frame "blank":
 *   1. Pixel-variance: max channel range across ~4 096 sampled pixels is < 8 (near-uniform).
 *   2. File-size sanity: bytes < 8 KB (statistically improbable for a meaningful screenshot).
 *
 * Either flag alone is just a "suspect" reason — both together flag blank=true. This keeps
 * legitimately uniform UIs (empty form pages with one button) from false-positives while
 * reliably catching black WebGL preloaders.
 */
export const detectBlankFrame = (buffer: Buffer): BlankFrameDecision => {
  const reasons: string[] = [];
  const byteSize = buffer.byteLength;
  const sizeFlag = byteSize < SCREENSHOT_BLANK_BYTE_FLOOR;
  if (sizeFlag) {
    reasons.push(`byte size ${byteSize} below floor ${SCREENSHOT_BLANK_BYTE_FLOOR}`);
  }

  let varianceFlag = false;
  let channelRange = 0;
  try {
    const png = PNG.sync.read(buffer);
    const { width, height, data } = png;
    const pixelCount = width * height;
    if (pixelCount > 0) {
      const stride = Math.max(1, Math.floor(pixelCount / SAMPLE_TARGET));
      let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
      for (let i = 0; i < pixelCount; i += stride) {
        const offset = i * 4;
        const r = data[offset]!;
        const g = data[offset + 1]!;
        const b = data[offset + 2]!;
        if (r < rMin) rMin = r; if (r > rMax) rMax = r;
        if (g < gMin) gMin = g; if (g > gMax) gMax = g;
        if (b < bMin) bMin = b; if (b > bMax) bMax = b;
      }
      channelRange = Math.max(rMax - rMin, gMax - gMin, bMax - bMin);
      varianceFlag = channelRange < PIXEL_VARIANCE_THRESHOLD;
      if (varianceFlag) {
        reasons.push(`pixel channel range ${channelRange} below threshold ${PIXEL_VARIANCE_THRESHOLD}`);
      }
    }
  } catch (err) {
    logger.debug(
      `[visual-settle] PNG decode failed in blank-frame check: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    blank: sizeFlag && varianceFlag,
    reasons,
    meta: { byteSize, channelRange },
  };
};

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};
