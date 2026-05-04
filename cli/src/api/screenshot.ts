import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { Locator, Page } from "playwright";
import type { ExecutionContext } from "../executor/context.js";
import type { StepDiagnostic } from "../executor/types.js";
import { captureAriaSnapshot } from "../executor/aria-snapshot-capture.js";
import { resolveElement } from "../executor/element-resolver.js";
import { isAnnotatableRefEntry, type AriaRefEntry } from "../executor/aria-ref-types.js";
import {
  injectAnnotationOverlay,
  removeAnnotationOverlay,
  type AnnotationBox,
  type AnnotationOverlayItem,
} from "../executor/annotation-overlay.js";

export interface ScreenshotOptions {
  fullPage?: boolean;
  /** When true, inject numbered badges over interactive refs before capture and
   *  attach an `annotation-map` diagnostic to the result. */
  annotate?: boolean;
  /** CSS selector scoping the annotated set. Defaults to `body`. */
  annotateScope?: string;
}

export interface AnnotationMapEntry {
  label: number;
  ref: string;
  role: string;
  boundingBox: AnnotationBox;
  selectorHint?: string;
}

export interface ScreenshotResult {
  path: string;
  diagnostics: StepDiagnostic[];
  /** Populated only when `opts.annotate === true`. Contains one entry per labeled
   *  badge — refs whose bbox could not be resolved are skipped (off-screen / detached). */
  annotations?: AnnotationMapEntry[];
}

const sanitizeName = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, "_");

export const takeScreenshot = async (
  page: Page,
  ctx: ExecutionContext,
  name: string,
  opts: ScreenshotOptions = {},
): Promise<ScreenshotResult> => {
  const outDir = ctx.testDir;
  await mkdir(outDir, { recursive: true });
  const safeName = sanitizeName(name);
  const filePath = join(outDir, `${safeName}.png`);

  const fullPage = opts.fullPage ?? ctx.artifactConfig.fullPageScreenshots;

  if (opts.annotate) {
    const result = await captureAnnotatedScreenshot(page, filePath, {
      fullPage,
      scope: opts.annotateScope ?? "body",
    });
    ctx.addScreenshot(filePath);
    return result;
  }

  const buffer = await page.screenshot({ fullPage, path: filePath });
  await writeFile(filePath, buffer).catch(() => {
    // page.screenshot already wrote to filePath; this is just a defensive copy if Playwright
    // ever silently swallowed the write (e.g. against an in-memory page).
  });
  ctx.addScreenshot(filePath);
  return { path: filePath, diagnostics: [] };
};

export interface AnnotatePipelineOptions {
  fullPage: boolean;
  scope: string;
}

/**
 * Annotate-then-capture pipeline. Mirrors velvety-finding-beacon §B2 / swirly §B4.
 *
 * Order of operations is invariant:
 *   1. Capture ARIA + cursor-interactive snapshot in `annotateScope`.
 *   2. Resolve each entry's bbox via the kind-aware locator factory.
 *   3. If `fullPage`, project page-coords by adding `scrollY` once.
 *   4. Hide the cursor overlay (best-effort) so badges aren't covered by the synthetic cursor.
 *   5. Inject the Shadow-DOM-isolated badge host.
 *   6. Capture the screenshot.
 *   7. **In a `finally`**: remove the badge host AND restore the cursor overlay.
 *      Failure modes that must survive cleanup: screenshot throws, fs write throws,
 *      hardTimeout fires mid-capture. The host is always removed before the next step
 *      runs — otherwise it would corrupt subsequent screenshots / interactions.
 *
 * The `annotation-map` diagnostic deliberately omits the accessible `name` field
 * (PII safety — names can carry account/email/document data). The PNG itself
 * shows the page; the structured diagnostic stays text-free.
 */
export const captureAnnotatedScreenshot = async (
  page: Page,
  filePath: string,
  opts: AnnotatePipelineOptions,
): Promise<ScreenshotResult> => {
  const { fullPage, scope } = opts;
  const diagnostics: StepDiagnostic[] = [];
  const capture = await captureAriaSnapshot(page, scope, {
    viewport: false,
    includeCursorInteractive: true,
    extractLinkHrefs: false,
  });

  const scrollY = fullPage ? await readScrollY(page) : 0;

  const annotations: AnnotationMapEntry[] = [];
  const overlayItems: AnnotationOverlayItem[] = [];
  let nextLabel = 1;

  for (const entry of capture.entries.filter(isAnnotatableRefEntry)) {
    const box = await resolveBoundingBox(page, entry).catch(() => null);
    if (!box) continue; // off-screen / detached — skip, never add to the map
    const projected: AnnotationBox = {
      x: box.x,
      y: box.y + scrollY,
      width: box.width,
      height: box.height,
    };
    const label = nextLabel;
    nextLabel += 1;
    overlayItems.push({ label, boundingBox: projected });
    const mapEntry: AnnotationMapEntry = {
      label,
      ref: entry.ref,
      role: entry.role,
      boundingBox: projected,
    };
    if (entry.selectorHint) mapEntry.selectorHint = entry.selectorHint;
    annotations.push(mapEntry);
  }

  // Hide the cursor overlay before capture; ignore if not present (no `--video`).
  // String-evaluate so we don't have to widen tsconfig's `lib` to include `dom`.
  await page
    .evaluate(`(() => { try { window.__skepticCursor && window.__skepticCursor.hide && window.__skepticCursor.hide(); } catch {} })()`)
    .catch(() => {
      /* overlay not injected — fine */
    });

  let injected = false;
  try {
    if (overlayItems.length > 0) {
      await injectAnnotationOverlay(page, overlayItems);
      injected = true;
    }
    const buffer = await page.screenshot({ fullPage, path: filePath });
    await writeFile(filePath, buffer).catch(() => {
      // Defensive copy — page.screenshot already wrote to filePath.
    });
  } finally {
    // Always remove the host AND restore the cursor — even if injection or capture threw.
    if (injected) await removeAnnotationOverlay(page);
    await page
      .evaluate(`(() => { try { window.__skepticCursor && window.__skepticCursor.show && window.__skepticCursor.show(); } catch {} })()`)
      .catch(() => {
        /* overlay not injected — fine */
      });
  }

  diagnostics.push({
    kind: "annotation-map",
    message: `annotated ${annotations.length} ref${annotations.length === 1 ? "" : "s"}`,
    meta: { entries: annotations },
  });

  return { path: filePath, diagnostics, annotations };
};

const readScrollY = async (page: Page): Promise<number> => {
  try {
    const y = await page.evaluate(`(window.scrollY || 0)`);
    return typeof y === "number" && Number.isFinite(y) ? y : 0;
  } catch {
    return 0;
  }
};

/**
 * Kind-aware bbox resolver — mirrors the dispatch logic in `aria-ref-resolver.ts`
 * but specialized for the "fetch a boundingBox, never throw" path. ARIA refs route
 * through Playwright's `aria-ref=eN` selector (already valid because we just ran
 * `ariaSnapshot({mode:"ai"})`); cursor-interactive refs route through skeptic's
 * existing `resolveElement(...)` so the recorder-grammar selectorHints are honored.
 */
const resolveBoundingBox = async (
  page: Page,
  entry: AriaRefEntry,
): Promise<AnnotationBox | null> => {
  let locator: Locator | null = null;
  if (entry.kind === "cursor-interactive") {
    if (!entry.selectorHint) return null;
    try {
      locator = await resolveElement(page, entry.selectorHint);
    } catch {
      return null;
    }
  } else {
    locator = page.locator(`aria-ref=${entry.ref}`);
  }
  if (!locator) return null;
  const box = await locator.boundingBox({ timeout: 500 });
  if (!box) return null;
  return { x: box.x, y: box.y, width: box.width, height: box.height };
};
