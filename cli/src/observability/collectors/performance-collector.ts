import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Page } from "playwright";
import type {
  Collector,
  CollectorName,
  NavigationTiming,
  PerformanceSnapshot,
  ResourceTiming,
} from "../types.js";
import type { ExecutionContext } from "../../executor/context.js";
import { logger } from "../../utils/logger.js";
import { getWebVitalsIifeScript } from "../../utils/asset-path.js";
import { redactUrl } from "../url-redact.js";

// Three-tier resolution (handled by getWebVitalsIifeScript):
//   - SEA: extract embedded `web-vitals.iife.js` to a temp file, return path
//   - Bundled (npm dist): dist/web-vitals.iife.js sibling
//   - Dev: node_modules/web-vitals/dist/web-vitals.iife.js
// If the file isn't found at the resolved path, we no-op cleanly and the
// collector reports "metric did not fire" rather than throwing ENOENT.
const resolveWebVitalsIifePath = (): string | null => {
  try {
    const candidate = getWebVitalsIifeScript();
    if (!existsSync(candidate)) {
      logger.warn(
        `[perf] web-vitals IIFE bundle not found at ${candidate} — performance metrics disabled.`,
      );
      return null;
    }
    return candidate;
  } catch (err) {
    logger.warn(
      `[perf] could not resolve web-vitals: ${err instanceof Error ? err.message : String(err)} — performance metrics disabled`,
    );
    return null;
  }
};

const WEB_VITALS_IIFE_PATH = resolveWebVitalsIifePath();
const LOAF_BUFFER_LIMIT = 50;

let cachedWebVitalsSource: string | null = null;

const loadWebVitalsSource = async (): Promise<string | null> => {
  if (WEB_VITALS_IIFE_PATH === null) return null;
  if (cachedWebVitalsSource !== null) return cachedWebVitalsSource;
  cachedWebVitalsSource = await readFile(WEB_VITALS_IIFE_PATH, "utf-8");
  return cachedWebVitalsSource;
};

const buildInitScript = (webVitalsSource: string): string => `
${webVitalsSource}
;(() => {
  if (window.__skepticMetrics) return;
  window.__skepticMetrics = { fcp: null, lcp: null, cls: null, inp: null, ttfb: null, longAnimationFrames: [] };
  if (typeof webVitals === 'undefined') return;
  const { onFCP, onLCP, onCLS, onINP, onTTFB } = webVitals;
  // reportAllChanges: true makes onLCP/onCLS/onINP fire continuously on every update
  // rather than only on page-hidden. Without this, snapshot() taken mid-flow reads
  // null for these metrics. FCP/TTFB fire on first paint regardless and don't need it.
  const opts = { reportAllChanges: true };
  onFCP((v) => window.__skepticMetrics.fcp = v.value);
  onLCP((v) => window.__skepticMetrics.lcp = v.value, opts);
  onCLS((v) => window.__skepticMetrics.cls = v.value, opts);
  onINP((v) => window.__skepticMetrics.inp = v.value, opts);
  onTTFB((v) => window.__skepticMetrics.ttfb = v.value);
  if (typeof PerformanceObserver !== 'undefined' &&
      PerformanceObserver.supportedEntryTypes &&
      PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) {
    try {
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (window.__skepticMetrics.longAnimationFrames.length >= ${LOAF_BUFFER_LIMIT}) return;
          window.__skepticMetrics.longAnimationFrames.push({
            startTime: e.startTime,
            duration: e.duration,
            blockingDuration: e.blockingDuration || 0,
            scripts: (e.scripts || []).map((s) => ({
              invoker: s.invoker || '',
              sourceURL: s.sourceURL || '',
              sourceFunctionName: s.sourceFunctionName || '',
              duration: s.duration || 0,
              forcedStyleAndLayoutDuration: s.forcedStyleAndLayoutDuration || 0,
            })),
          });
        }
      });
      obs.observe({ type: 'long-animation-frame', buffered: true });
    } catch (_err) { /* LoAF unsupported — silent no-op */ }
  }
})();
`;

export class PerformanceCollector implements Collector {
  readonly name: CollectorName = "performance";
  private page: Page | null = null;

  async attach(page: Page, _ctx: ExecutionContext): Promise<void> {
    this.page = page;
    const webVitalsSource = await loadWebVitalsSource();
    if (webVitalsSource === null) return; // module-load warning already emitted; no-op
    await page.addInitScript({ content: buildInitScript(webVitalsSource) });
  }

  async snapshot(): Promise<PerformanceSnapshot> {
    const empty: PerformanceSnapshot = {
      fcp: null,
      lcp: null,
      cls: null,
      inp: null,
      ttfb: null,
      longAnimationFrames: [],
    };
    if (!this.page || this.page.isClosed()) return empty;
    try {
      const result = await this.page.evaluate<PerformanceSnapshot>(
        "window.__skepticMetrics || { fcp: null, lcp: null, cls: null, inp: null, ttfb: null, longAnimationFrames: [] }",
      );

      const navigationTiming = await this.captureNavigationTiming();
      const resources = await this.captureResources();

      const out: PerformanceSnapshot = {
        fcp: result.fcp,
        lcp: result.lcp,
        cls: result.cls === null ? null : Math.round((result.cls ?? 0) * 1000) / 1000,
        inp: result.inp === null ? null : Math.round(result.inp ?? 0),
        ttfb: result.ttfb === null ? null : Math.round(result.ttfb ?? 0),
        longAnimationFrames: (result.longAnimationFrames ?? []).slice(0, LOAF_BUFFER_LIMIT),
      };
      if (navigationTiming) out.navigationTiming = navigationTiming;
      if (resources) out.resources = resources;
      return out;
    } catch (err) {
      logger.debug(
        `[perf] snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return empty;
    }
  }

  /**
   * Best-effort read of navigation timing. Uses PerformanceNavigationTiming when available
   * (modern browsers); silently returns null on failure. ~2 ms cost on a warm page.
   */
  private async captureNavigationTiming(): Promise<NavigationTiming | null> {
    if (!this.page || this.page.isClosed()) return null;
    try {
      const raw = await this.page.evaluate<NavigationTiming | null>(
        `(() => {
          try {
            const entries = performance.getEntriesByType('navigation');
            const nav = entries && entries[0];
            if (!nav) return null;
            const start = nav.startTime || 0;
            // Server-Timing is small extra signal: most origins don't send the header,
            // so render only when present. Each entry has { name, duration, description }.
            const serverTimingRaw = Array.isArray(nav.serverTiming) ? nav.serverTiming : [];
            const serverTiming = serverTimingRaw.slice(0, 50).map((s) => {
              const out = { name: String(s.name || '') };
              if (typeof s.duration === 'number') out.duration = Math.round(s.duration);
              if (s.description) out.description = String(s.description);
              return out;
            });
            const result = {
              ttfb: nav.responseStart != null ? Math.round(nav.responseStart - start) : null,
              domContentLoaded: nav.domContentLoadedEventEnd != null
                ? Math.round(nav.domContentLoadedEventEnd - start) : null,
              loadComplete: nav.loadEventEnd != null && nav.loadEventEnd > 0
                ? Math.round(nav.loadEventEnd - start) : null,
            };
            if (serverTiming.length > 0) result.serverTiming = serverTiming;
            return result;
          } catch { return null; }
        })()`,
      );
      return raw ?? null;
    } catch (err) {
      logger.debug(
        `[perf] navigationTiming snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Capture PerformanceResourceTiming entries — the page already collected them at zero cost,
   * we just read them out. transferSize is the over-the-wire bytes (compressed). encodedBodySize
   * is the response payload after compression. URLs are redacted via `redactUrl` for query strings.
   */
  private async captureResources(): Promise<ResourceTiming[] | null> {
    if (!this.page || this.page.isClosed()) return null;
    try {
      const raw = await this.page.evaluate<ResourceTiming[]>(
        `(() => {
          try {
            const entries = performance.getEntriesByType('resource') || [];
            return entries.slice(0, 200).map((e) => ({
              name: e.name,
              initiatorType: e.initiatorType || '',
              duration: Math.round(e.duration || 0),
              transferSize: e.transferSize || 0,
              encodedBodySize: e.encodedBodySize || 0,
              decodedBodySize: e.decodedBodySize || 0,
            }));
          } catch { return []; }
        })()`,
      );
      return raw.map((r) => ({ ...r, name: redactUrl(r.name) }));
    } catch (err) {
      logger.debug(
        `[perf] resource timing snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async detach(): Promise<void> {
    this.page = null;
  }
}
