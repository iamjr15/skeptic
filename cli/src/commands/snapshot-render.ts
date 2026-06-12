// Shared snapshot rendering for `skeptic inspect` (one-shot) and the persistent
// `skeptic snapshot` verb, so both produce byte-identical trees + selectorHint
// tables. Operates on the platform-agnostic `CaptureResult`.

import type { CaptureResult } from "../executor/aria-snapshot-capture.js";
import type { AriaRefEntry } from "../executor/aria-ref-types.js";
import { renderSnapshotYaml, computeSnapshotStats, type SnapshotStats } from "../api/snapshot.js";

/**
 * Build the per-ref `selectorHint` line. Priority:
 *   1. Cursor-interactive entries already carry one.
 *   2. ARIA entry with name → `role=<role>:<name>`
 *   3. ARIA link with href → `css=a[href*="<host>"]`
 *   4. Otherwise → `role=<role>`
 * All forms validate against `element-resolver.ts`'s skeptic-grammar parser.
 */
export const buildSelectorHint = (entry: AriaRefEntry): string => {
  if (entry.selectorHint && entry.selectorHint.length > 0) {
    return entry.selectorHint;
  }
  if (entry.kind === "aria") {
    if (entry.name && entry.name.length > 0 && entry.name.length < 60) {
      return `role=${entry.role}:${entry.name}`;
    }
    if (entry.role === "link" && entry.href) {
      const host = extractHrefHostFragment(entry.href);
      if (host) return `css=a[href*="${host}"]`;
    }
    return `role=${entry.role}`;
  }
  return "css=*";
};

const extractHrefHostFragment = (href: string): string | null => {
  try {
    const u = new URL(href, "http://dummy.invalid");
    if (u.host && u.host !== "dummy.invalid") {
      return u.host.replace(/^www\./, "");
    }
    const seg = u.pathname.split("/").filter(Boolean).pop();
    return seg ?? null;
  } catch {
    return null;
  }
};

export interface RenderedRef {
  ref: string;
  kind: AriaRefEntry["kind"];
  role: string;
  name: string;
  selectorHint: string;
  href?: string;
}

export interface RenderedSnapshot {
  /** Rendered YAML tree (interactive/compact filters applied, off-viewport annotated). */
  yaml: string;
  /** One entry per ref visible in the rendered tree, in document order. */
  refs: RenderedRef[];
  stats: SnapshotStats;
}

export const renderSnapshot = (
  capture: CaptureResult,
  opts: { interactive?: boolean; compact?: boolean } = {},
): RenderedSnapshot => {
  const yaml = renderSnapshotYaml(capture.yaml, capture.entries, {
    interactive: opts.interactive ?? false,
    compact: opts.compact ?? false,
    ...(capture.offViewportRefs ? { offViewportRefs: capture.offViewportRefs } : {}),
  });
  const stats = computeSnapshotStats(yaml, capture.entries);
  const renderedRefs = new Set([...yaml.matchAll(/\[ref=(e\d+)\]/g)].map((m) => m[1]!));
  const refs: RenderedRef[] = capture.entries
    .filter((e) => renderedRefs.has(e.ref))
    .map((e) => ({
      ref: e.ref,
      kind: e.kind,
      role: e.role,
      name: e.name,
      selectorHint: buildSelectorHint(e),
      ...(e.href ? { href: e.href } : {}),
    }));
  return { yaml, refs, stats };
};

/** Shared by the snapshot renderer and `inspect`'s stats footer (byte-identical). */
export const formatNumber = (value: number): string => new Intl.NumberFormat("en-US").format(value);

/**
 * Human-readable snapshot block: YAML tree + per-ref selectorHint/`/url` table +
 * a stats footer. `portabilityNote` differs between inspect (refs not portable
 * across calls) and the persistent session (refs persist until navigation).
 */
export const formatSnapshotText = (
  rendered: RenderedSnapshot,
  opts: { portabilityNote?: string } = {},
): string => {
  let out = rendered.yaml;
  if (!out.endsWith("\n")) out += "\n";

  if (rendered.refs.length > 0) {
    out += "\n";
    for (const r of rendered.refs) {
      out += `  ${r.ref} selectorHint: ${r.selectorHint}\n`;
      if (r.href) out += `  ${r.ref} /url: ${r.href}\n`;
    }
  }

  const note =
    opts.portabilityNote ??
    "Stable artifact: copy a selectorHint into your test — refs are NOT portable across snapshot calls.";
  out +=
    `\nStats: ${formatNumber(rendered.stats.lines)} lines, ${formatNumber(rendered.stats.characters)} chars, ` +
    `~${formatNumber(rendered.stats.estimatedTokens)} tokens; ` +
    `${formatNumber(rendered.stats.renderedRefs)} refs rendered / ${formatNumber(rendered.stats.totalRefs)} captured ` +
    `(${formatNumber(rendered.stats.ariaRefs)} ARIA, ${formatNumber(rendered.stats.cursorInteractiveRefs)} cursor-interactive), ` +
    `${formatNumber(rendered.stats.interactiveRefs)} interactive.\n${note}\n`;
  return out;
};
