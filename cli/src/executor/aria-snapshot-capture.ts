// Source: agent-browser/cli/src/native/snapshot.rs:609-720 © Vercel Inc., Apache 2.0
// (Cursor-interactive heuristic ported from CDP/Rust to Playwright/TS. Per-link href
//  extraction pattern from snapshot.rs:416. The viewport-aware "N items hidden" markers
//  are an original implementation per the velvety-finding-beacon spec — NOT copied from
//  expect/runtime/lib/scroll-detection.ts.)

import type { Page } from "playwright";
import type { AriaRefEntry } from "./aria-ref-types.js";
import { ensureSelectorHelper } from "../utils/selector-generator.js";

export interface CaptureResult {
  yaml: string;
  entries: AriaRefEntry[];
  truncated: boolean;
  /**
   * Refs whose element is currently outside the viewport (viewport mode only).
   * These entries STAY in `entries` (and therefore in the byRef registry) so an
   * agent can still resolve them after scrolling — the renderer annotates their
   * lines `[off-viewport]` rather than dropping the refs and desyncing the
   * registry from the printed tree.
   */
  offViewportRefs?: Set<string>;
  /** Optional viewport-aware hidden-item markers for snapshot rendering. */
  hiddenAbove?: number;
  hiddenBelow?: number;
}

const DEFAULT_LIMIT_KB = 256;
const MAX_CURSOR_INTERACTIVE_ELEMENTS = 100;
const MAX_LINK_HREF_EXTRACTIONS = 50;

/**
 * Match a YAML line that names a role + optional accessible name + a `[ref=eN]` tag.
 *
 * Capture groups: 1=role, 2=name (may be empty), 3=ref ("eN"). Trailing optional bracket
 * sequences (e.g. `[level=1]`) are skipped before the ref tag.
 */
const REF_LINE_RE = /-\s+(\w+)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s+\[(?!ref=)[^\]]*\])*\s+\[ref=(e\d+)\]/;

const resolveLimitBytes = (): number => {
  const envVal = process.env["SKEPTIC_ARIA_SNAPSHOT_LIMIT_KB"];
  const kb = envVal ? Number.parseInt(envVal, 10) : NaN;
  const safeKb = Number.isFinite(kb) && kb > 0 ? kb : DEFAULT_LIMIT_KB;
  return safeKb * 1024;
};

export interface CaptureOptions {
  viewport?: boolean;
  /** Run the cursor-interactive pass + selector-hint generation. Off by default. */
  includeCursorInteractive?: boolean;
  /** Extract per-link `href` for the first N link refs. Off by default to keep
   *  parity with the existing test mocks. */
  extractLinkHrefs?: boolean;
}

export async function captureAriaSnapshot(
  page: Page,
  scopeSelector: string,
  opts: CaptureOptions,
): Promise<CaptureResult> {
  const yaml = await page.locator(scopeSelector).first().ariaSnapshot({ mode: "ai" });

  const limitBytes = resolveLimitBytes();
  const truncated = Buffer.byteLength(yaml, "utf8") > limitBytes;
  if (truncated) {
    console.warn(
      `[ariaSnapshot] captured YAML exceeds ${limitBytes} bytes — registry truncated. ` +
        `Tunable via SKEPTIC_ARIA_SNAPSHOT_LIMIT_KB.`,
    );
  }

  const entries = parseEntries(yaml, scopeSelector, limitBytes);

  let offViewportRefs: Set<string> | undefined;
  if (opts.viewport) {
    // Keep every ref in the registry; just record which ones are off-screen so the
    // renderer can annotate them. Dropping them desynced byRef from the printed tree.
    offViewportRefs = await computeOffViewportRefs(page, entries);
  }

  if (opts.extractLinkHrefs) {
    await populateLinkHrefs(page, entries);
  }

  if (opts.includeCursorInteractive) {
    const cursorEntries = await captureCursorInteractive(page, scopeSelector, entries);
    for (const ce of cursorEntries) entries.push(ce);
  }

  return { yaml, entries, truncated, offViewportRefs };
}

/**
 * Parse the ref-annotated YAML into structured entries with `nth` disambiguation.
 *
 * Also records `matchCountAtSnapshot` per (role, name) group — used by the resolver
 * to detect silent insertion-retargeting at action time.
 */
function parseEntries(
  yaml: string,
  scopeSelector: string,
  limitBytes: number,
): AriaRefEntry[] {
  const counts = new Map<string, number>();
  const entries: AriaRefEntry[] = [];
  let bytesSeen = 0;

  const lines = yaml.split("\n");
  for (const line of lines) {
    bytesSeen += Buffer.byteLength(line, "utf8") + 1;
    if (bytesSeen > limitBytes) break;

    const m = REF_LINE_RE.exec(line);
    if (!m) continue;
    const role = m[1]!;
    const name = m[2] ?? "";
    const ref = m[3]!;
    const key = `${role} ${name}`;
    const nth = counts.get(key) ?? 0;
    counts.set(key, nth + 1);

    entries.push({
      ref,
      kind: "aria",
      role,
      name,
      nth,
      scopeSelector,
      matchCountAtSnapshot: 0, // backfilled below
    });
  }

  // Backfill matchCountAtSnapshot once we know the final group sizes.
  for (const entry of entries) {
    if (entry.kind !== "aria") continue;
    const key = `${entry.role} ${entry.name}`;
    entry.matchCountAtSnapshot = counts.get(key) ?? 1;
  }

  return entries;
}

/**
 * Compute which ARIA refs sit outside the current viewport.
 *
 * Performance (P7): the heavy work — reading every element's box and testing its
 * centre against the viewport — happens in ONE `page.evaluate`, instead of one
 * `boundingBox()` protocol round-trip per ref (hundreds on a large page). We resolve
 * each `aria-ref=eN` to an element handle (cheap selector resolution, no layout/
 * actionability wait), then pass the whole handle array into a single evaluate that
 * returns one boolean per ref. A null handle or an evaluate failure is treated as
 * in-viewport — we never hide a ref we couldn't measure.
 */
async function computeOffViewportRefs(
  page: Page,
  entries: AriaRefEntry[],
): Promise<Set<string>> {
  const offViewport = new Set<string>();
  const viewport = page.viewportSize();
  if (!viewport) return offViewport;

  const ariaEntries = entries.filter((e) => e.kind === "aria");
  if (ariaEntries.length === 0) return offViewport;

  const handles = await Promise.all(
    ariaEntries.map((entry) =>
      page
        .locator(`aria-ref=${entry.ref}`)
        .elementHandle({ timeout: 250 })
        .catch(() => null),
    ),
  );

  // String-free function form is required so Playwright deserializes the handle
  // array into live DOM nodes; cast through `unknown` so DOM globals stay out of
  // tsconfig's lib. Returns one boolean per handle in input order.
  const evalInViewport = (arg: unknown): boolean[] => {
    const a = arg as {
      els: Array<{
        getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
      } | null>;
      vw: number;
      vh: number;
    };
    return a.els.map((el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      return cx >= 0 && cx <= a.vw && cy >= 0 && cy <= a.vh;
    });
  };

  let inView: boolean[];
  try {
    inView = await (page.evaluate as unknown as (
      fn: (arg: unknown) => boolean[],
      arg: unknown,
    ) => Promise<boolean[]>)(evalInViewport, {
      els: handles,
      vw: viewport.width,
      vh: viewport.height,
    });
  } catch {
    inView = ariaEntries.map(() => true); // best-effort: keep all refs visible
  } finally {
    await Promise.all(handles.map((h) => h?.dispose().catch(() => {})));
  }

  ariaEntries.forEach((entry, i) => {
    if (inView[i] === false) offViewport.add(entry.ref);
  });
  return offViewport;
}

/**
 * Per-link `href` extraction. Playwright's `ariaSnapshot()` does not include hrefs;
 * we fetch them via `getAttribute("href")` for the first 50 link refs in parallel
 * (~30ms budget at the cap). Source: agent-browser/cli/src/native/snapshot.rs:416.
 */
async function populateLinkHrefs(
  page: Page,
  entries: AriaRefEntry[],
): Promise<void> {
  const linkEntries = entries
    .filter((e) => e.kind === "aria" && e.role === "link")
    .slice(0, MAX_LINK_HREF_EXTRACTIONS);

  await Promise.all(
    linkEntries.map(async (entry) => {
      try {
        const href = await page
          .locator(`aria-ref=${entry.ref}`)
          .getAttribute("href", { timeout: 250 });
        if (href) entry.href = href;
      } catch {
        // best-effort
      }
    }),
  );
}

interface CursorInteractiveRaw {
  index: number;
  text: string;
  tagName: string;
  bbox: [number, number, number, number];
  hasOnClick: boolean;
  hasCursorPointer: boolean;
  hasTabIndex: boolean;
  ariaRoleHint: string | null;
}

/**
 * Walk the DOM via `page.evaluate` and return elements that match the
 * cursor-interactive heuristic but are NOT already covered by the ARIA snapshot.
 * Source: agent-browser/cli/src/native/snapshot.rs:609-720 — same heuristic, no CDP.
 */
async function captureCursorInteractive(
  page: Page,
  scopeSelector: string,
  ariaEntries: AriaRefEntry[],
): Promise<AriaRefEntry[]> {
  const SELECTION_ATTR = "data-__skeptic-ci";
  const cap = MAX_CURSOR_INTERACTIVE_ELEMENTS;

  // Use a JS-string evaluate so DOM globals don't need to be in tsconfig's lib.
  // Source pattern: src/observability/collectors/performance-collector.ts:117.
  const evalScript = `((scopeSel, attrName, maxCap) => {
    var interactiveTags = { a:1, button:1, input:1, select:1, textarea:1, details:1, summary:1 };
    var interactiveRoles = {
      button:1, link:1, textbox:1, checkbox:1, radio:1, combobox:1, listbox:1,
      menuitem:1, menuitemcheckbox:1, menuitemradio:1, option:1, searchbox:1,
      slider:1, spinbutton:1, switch:1, tab:1, treeitem:1
    };
    var scope = document.querySelector(scopeSel) || document.body;
    if (!scope) return [];
    var results = [];
    var all = scope.querySelectorAll("*");
    for (var i = 0; i < all.length && results.length < maxCap; i++) {
      var el = all[i];
      if (el.closest && el.closest('[hidden], [aria-hidden="true"]')) continue;
      var tagName = el.tagName.toLowerCase();
      if (interactiveTags[tagName]) continue;
      var role = el.getAttribute("role");
      if (role && interactiveRoles[role.toLowerCase()]) continue;
      var computed = getComputedStyle(el);
      var hasCursorPointer = computed.cursor === "pointer";
      var hasOnClick = el.hasAttribute("onclick") || el.onclick !== null;
      var tabIndex = el.getAttribute("tabindex");
      var hasTabIndex = tabIndex !== null && tabIndex !== "-1";
      if (!hasCursorPointer && !hasOnClick && !hasTabIndex) continue;
      if (hasCursorPointer && !hasOnClick && !hasTabIndex) {
        var parent = el.parentElement;
        if (parent && getComputedStyle(parent).cursor === "pointer") continue;
      }
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      var text = (el.textContent || "").trim().slice(0, 100);
      if (!text && hasCursorPointer && !hasOnClick && !hasTabIndex) continue;
      el.setAttribute(attrName, String(results.length));
      results.push({
        index: results.length,
        text: text,
        tagName: tagName,
        bbox: [rect.x, rect.y, rect.width, rect.height],
        hasOnClick: hasOnClick,
        hasCursorPointer: hasCursorPointer,
        hasTabIndex: hasTabIndex,
        ariaRoleHint: role
      });
    }
    return results;
  })(${JSON.stringify(scopeSelector)}, ${JSON.stringify(SELECTION_ATTR)}, ${cap})`;

  let raws = (await page.evaluate<CursorInteractiveRaw[]>(evalScript)) ?? [];

  if (raws.length === 0) return [];

  // Dedupe against ARIA only after the cheap DOM pass proves there are
  // cursor-only candidates. This avoids hundreds of aria-ref boundingBox calls
  // on pages whose actionable controls are already represented as links/buttons.
  const ariaBboxes = await collectAriaBboxes(page, dedupeCandidates(ariaEntries, raws));
  raws = raws.filter((raw) => !bboxMatchesAny(raw.bbox, ariaBboxes));
  if (raws.length === 0) return [];

  const usedRefs = new Set<number>();
  for (const e of ariaEntries) {
    const m = /^e(\d+)$/.exec(e.ref);
    if (m) usedRefs.add(Number(m[1]));
  }
  let nextRefNum = 1;
  while (usedRefs.has(nextRefNum)) nextRefNum++;

  // Generate every selectorHint in ONE round-trip (P6): the surviving candidates are
  // already stamped with `data-__skeptic-ci="<index>"`, so a single `page.evaluate`
  // can run `window.__skeptic_selector(el)` over all of them — instead of one
  // `elementHandle()` + one `evaluate()` per candidate (up to ~100 round-trips).
  const hints = await generateSelectorHints(page, SELECTION_ATTR, raws.map((r) => r.index));

  const newEntries: AriaRefEntry[] = [];
  for (const raw of raws) {
    const refNum = nextRefNum;
    nextRefNum++;
    while (usedRefs.has(nextRefNum)) nextRefNum++;
    const ref = `e${refNum}`;

    const generated = hints[String(raw.index)] ?? "";
    const selectorHint = generated.length > 0
      ? generated
      : `css=[${SELECTION_ATTR}="${raw.index}"]`;

    newEntries.push({
      ref,
      kind: "cursor-interactive",
      role: raw.tagName, // surrogate role — used in YAML rendering ("div", "span", etc.)
      name: raw.text,
      nth: 0,
      scopeSelector,
      selectorHint,
      matchCountAtSnapshot: 1,
    });
  }

  return newEntries;
}

/**
 * Batch selectorHint generation for stamped cursor candidates. Injects the shared
 * recorder helper once, then evaluates `window.__skeptic_selector(el)` for every
 * `data-__skeptic-ci="<index>"` element in a single in-page pass. Returns a map of
 * `index -> selector` (string keys, since object keys stringify); a missing or empty
 * value tells the caller to fall back to the attribute selector. Best-effort: any
 * failure yields an empty map so every candidate falls back gracefully.
 */
async function generateSelectorHints(
  page: Page,
  selectionAttr: string,
  indices: number[],
): Promise<Record<string, string>> {
  if (indices.length === 0) return {};
  try {
    await ensureSelectorHelper(page);
    const script = `((attrName, indices) => {
      var fn = (typeof window !== "undefined") ? window.__skeptic_selector : null;
      var out = {};
      for (var i = 0; i < indices.length; i++) {
        var idx = indices[i];
        var el = document.querySelector('[' + attrName + '="' + idx + '"]');
        out[idx] = (el && typeof fn === "function") ? (fn(el) || "") : "";
      }
      return out;
    })(${JSON.stringify(selectionAttr)}, ${JSON.stringify(indices)})`;
    return (await page.evaluate<Record<string, string>>(script)) ?? {};
  } catch {
    return {};
  }
}

const bboxMatchesAny = (
  bbox: [number, number, number, number],
  candidates: Array<[number, number, number, number]>,
): boolean => candidates.some((b) =>
  Math.abs(b[0] - bbox[0]) <= 1 &&
  Math.abs(b[1] - bbox[1]) <= 1 &&
  Math.abs(b[2] - bbox[2]) <= 1 &&
  Math.abs(b[3] - bbox[3]) <= 1,
);

const dedupeCandidates = (
  entries: AriaRefEntry[],
  raws: CursorInteractiveRaw[],
): AriaRefEntry[] => {
  if (raws.length <= 10) {
    return entries.filter((entry) => entry.kind === "aria" && entry.role === "generic");
  }
  const rawTexts = raws.map((raw) => raw.text).filter((text) => text.length > 0);
  if (rawTexts.length === 0) return [];
  return entries.filter((entry) => {
    if (entry.kind !== "aria" || entry.role !== "generic" || entry.name.length === 0) {
      return false;
    }
    return rawTexts.some(
      (text) => text === entry.name || text.includes(entry.name) || entry.name.includes(text),
    );
  });
};

/**
 * Best-effort bbox collection for the dedupe pass. Uses Playwright's `aria-ref=eN`
 * locator (available after `ariaSnapshot({mode:"ai"})`) to resolve every ARIA entry
 * back to its source DOM node — including `generic` and other roles that
 * `getByRole` filters out. Reads `boundingBox()` in parallel; failures are skipped
 * (a missing bbox just means that ARIA entry won't dedupe a cursor candidate —
 * the candidate gets emitted, the safe direction).
 */
async function collectAriaBboxes(
  page: Page,
  ariaEntries: AriaRefEntry[],
): Promise<Array<[number, number, number, number]>> {
  const out: Array<[number, number, number, number]> = [];
  await Promise.all(
    ariaEntries.map(async (entry) => {
      if (entry.kind !== "aria") return;
      try {
        const box = await page
          .locator(`aria-ref=${entry.ref}`)
          .boundingBox({ timeout: 300 });
        if (box) out.push([box.x, box.y, box.width, box.height]);
      } catch {
        // best-effort
      }
    }),
  );
  return out;
}
