// Source: agent-browser/cli/src/native/snapshot.rs:1060-1230 © Vercel Inc., Apache 2.0
// (Rendering modes — full / interactive / compact — ported from Rust to TypeScript.
//  Indent preservation, ref-aware filtering, and ancestor-keep semantics match
//  agent-browser's `render_tree` + `compact_tree`.)

import type { Locator, Page } from "playwright";
import type { ExecutionContext } from "../executor/context.js";
import { captureAriaSnapshot } from "../executor/aria-snapshot-capture.js";
import { resolveAriaRef } from "../executor/aria-ref-resolver.js";
import {
  isHighSignalRefEntry,
  isInteractiveRefEntry,
  type AriaRefEntry,
} from "../executor/aria-ref-types.js";

export interface SnapshotOptions {
  /** Match `agent-browser snapshot -i` — only nodes with refs. */
  interactive?: boolean;
  /** Match `agent-browser snapshot -c` — interactive + minimal ancestors. */
  compact?: boolean;
  /** Scope to a CSS selector. Defaults to `body` for full-page snapshots. */
  selector?: string;
  /** Emit "N items hidden above/below" markers. Default true on the public API. */
  viewportAware?: boolean;
  /** Run the cursor-interactive heuristic. Default true on the public API. */
  includeCursorInteractive?: boolean;
}

export interface ByRoleOptions {
  name?: string | RegExp;
  hrefIncludes?: string;
  /** When duplicates exist, pick this match (default 0). */
  index?: number;
}

export interface SnapshotTree {
  /** Rendered YAML matching agent-browser's format (full / interactive / compact). */
  yaml: string;
  /** Raw Playwright YAML before rendering — kept for diagnostics. */
  rawYaml: string;
  refs: Map<string, AriaRefEntry>;
  stats: SnapshotStats;
  /** Always async — `await tree.byRef("eN")` for every ref kind. */
  byRef(ref: string): Promise<Locator>;
  byRole(role: string, opts?: ByRoleOptions): Locator;
  byText(text: string | RegExp): Locator;
  byTestId(id: string): Locator;
  cursorInteractiveCount: number;
  ariaRefCount: number;
}

export interface SnapshotStats {
  /** Rendered YAML line count. Empty output follows Expect parity: one empty line. */
  lines: number;
  /** Rendered YAML character count. */
  characters: number;
  /** Rough model-token estimate using the common 4 chars/token heuristic. */
  estimatedTokens: number;
  /** All refs captured into the registry, including low-signal refs hidden from compact output. */
  totalRefs: number;
  /** Unique refs visible in the rendered YAML. */
  renderedRefs: number;
  /** Captured action-oriented refs. Cursor-interactive entries count as interactive. */
  interactiveRefs: number;
  /** Action-oriented refs visible in the rendered YAML. */
  renderedInteractiveRefs: number;
  ariaRefs: number;
  cursorInteractiveRefs: number;
}

const ESTIMATED_CHARS_PER_TOKEN = 4;

/**
 * Build a SnapshotTree backed by Playwright's native `Locator.ariaSnapshot({mode:"ai"})`,
 * extended with a cursor-interactive pass and per-link href extraction.
 *
 * `byRef("eN")` is `kind`-aware but UNIFORMLY async — always `await tree.byRef(...)`:
 *   - ARIA refs route through `getByRole(...).nth(n)`.
 *   - Cursor-interactive refs route through the existing skeptic resolver, which is
 *     itself async (it re-counts the live candidate group).
 *   Returning `Promise<Locator>` for both keeps `await tree.byRef("e1").then(l => l.click())`
 *   — and the chained `(await tree.byRef("e1")).click()` the skill teaches — well-typed
 *   and crash-free regardless of which kind a ref turns out to be.
 */
export const snapshot = async (
  target: Page | Locator,
  ctx: ExecutionContext,
  opts: SnapshotOptions = {},
): Promise<SnapshotTree> => {
  const page: Page = "context" in target && typeof (target as Page).context === "function"
    ? (target as Page)
    : (target as Locator).page();

  const scopeSelector = opts.selector ?? "body";
  const viewportAware = opts.viewportAware ?? true;
  const includeCursorInteractive = opts.includeCursorInteractive ?? true;

  const capture = await captureAriaSnapshot(page, scopeSelector, {
    viewport: viewportAware,
    includeCursorInteractive,
    extractLinkHrefs: true,
  });

  const refs = new Map<string, AriaRefEntry>();
  let ariaCount = 0;
  let cursorCount = 0;
  for (const entry of capture.entries) {
    refs.set(entry.ref, entry);
    ctx.ariaRefs.set(entry.ref, entry);
    if (entry.kind === "aria") ariaCount++;
    else cursorCount++;
  }
  ctx.ariaSnapshotYaml = capture.yaml;

  const renderedYaml = renderSnapshotYaml(capture.yaml, capture.entries, {
    interactive: opts.interactive ?? false,
    compact: opts.compact ?? false,
    offViewportRefs: capture.offViewportRefs,
  });
  const stats = computeSnapshotStats(renderedYaml, capture.entries);

  const byRef = async (ref: string): Promise<Locator> => {
    const entry = refs.get(ref);
    if (!entry) {
      throw new Error(
        `[skeptic] snapshot ref "${ref}" not found. Available: ${[...refs.keys()].join(", ") || "(none)"}`,
      );
    }
    if (entry.kind === "cursor-interactive") {
      return resolveAriaRef(page, ctx, `@${ref}`);
    }
    const scope = page.locator(entry.scopeSelector);
    return scope.getByRole(entry.role as Parameters<Locator["getByRole"]>[0], {
      name: entry.name.length > 0 ? entry.name : undefined,
      exact: true,
    }).nth(entry.nth);
  };

  const byRole = (role: string, byOpts: ByRoleOptions = {}): Locator => {
    const roleOpts: Parameters<Page["getByRole"]>[1] = {
      name: byOpts.name,
    };
    if (typeof byOpts.name === "string") {
      roleOpts.exact = true;
    }
    let resolved = page.getByRole(role as Parameters<Page["getByRole"]>[0], {
      ...roleOpts,
    });
    if (byOpts.hrefIncludes !== undefined) {
      // `.and(...)` matches the element's OWN attributes; `.filter({ has })` would
      // require a matching DESCENDANT, so a link's own `href` would never match.
      resolved = resolved.and(page.locator(`[href*="${byOpts.hrefIncludes}"]`));
    }
    return byOpts.index !== undefined ? resolved.nth(byOpts.index) : resolved;
  };

  const byText = (text: string | RegExp): Locator => page.getByText(text);
  const byTestId = (id: string): Locator => page.getByTestId(id);

  return {
    yaml: renderedYaml,
    rawYaml: capture.yaml,
    refs,
    stats,
    byRef,
    byRole,
    byText,
    byTestId,
    cursorInteractiveCount: cursorCount,
    ariaRefCount: ariaCount,
  };
};

export const computeSnapshotStats = (
  renderedYaml: string,
  entries: AriaRefEntry[],
): SnapshotStats => {
  const renderedRefSet = refsInText(renderedYaml);
  return {
    lines: renderedYaml.split("\n").length,
    characters: renderedYaml.length,
    estimatedTokens: Math.ceil(renderedYaml.length / ESTIMATED_CHARS_PER_TOKEN),
    totalRefs: entries.length,
    renderedRefs: renderedRefSet.size,
    interactiveRefs: entries.filter(isInteractiveRefEntry).length,
    renderedInteractiveRefs: entries.filter(
      (entry) => renderedRefSet.has(entry.ref) && isInteractiveRefEntry(entry),
    ).length,
    ariaRefs: entries.filter((entry) => entry.kind === "aria").length,
    cursorInteractiveRefs: entries.filter((entry) => entry.kind === "cursor-interactive").length,
  };
};

const refsInText = (text: string): Set<string> =>
  new Set([...text.matchAll(/\[ref=(e\d+)\]/g)].map((match) => match[1]!));

interface RenderOpts {
  interactive: boolean;
  compact: boolean;
  /**
   * Refs whose element is currently outside the viewport. They stay in the
   * registry (resolvable via `byRef`) and in the rendered tree, but each line is
   * annotated `[off-viewport]` so an agent knows it must scroll before acting —
   * rather than reading a ref the registry then reports "not found".
   */
  offViewportRefs?: ReadonlySet<string>;
}

/**
 * Post-process Playwright's `ariaSnapshot()` YAML into the agent-browser-compatible
 * rendering. We append per-link `/url:` markers and cursor-interactive entries
 * (Playwright's tree omits both), annotate off-viewport refs, then optionally filter
 * to interactive lines or flatten to interactive-first compact mode.
 */
export const renderSnapshotYaml = (
  rawYaml: string,
  entries: AriaRefEntry[],
  opts: RenderOpts,
): string => {
  const REF_LINE_RE = /\[ref=(e\d+)\]/;
  const offViewport = opts.offViewportRefs;
  const lines = rawYaml.split("\n");
  const result: string[] = [];
  const refToEntry = new Map(entries.map((e) => [e.ref, e]));

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? "";
    if (line.length === 0 && lines.length === 1) continue;
    const m = REF_LINE_RE.exec(line);
    if (m && offViewport?.has(m[1]!)) {
      line = line.replace(`[ref=${m[1]}]`, `[ref=${m[1]}] [off-viewport]`);
    }
    result.push(line);
    if (m) {
      const entry = refToEntry.get(m[1]!);
      const nextLine = lines[i + 1] ?? "";
      const rawAlreadyHasUrl =
        line.includes("/url:") || /^\s*-?\s*\/url:/.test(nextLine);
      if (entry?.role === "link" && entry.href && !rawAlreadyHasUrl) {
        // Match agent-browser's `/url: <href>` continuation line.
        const indent = line.match(/^\s*/)?.[0] ?? "";
        result.push(`${indent}  /url: ${entry.href}`);
      }
    }
  }

  // Append cursor-interactive entries (Playwright's tree doesn't include them).
  const cursorEntries = entries.filter((e) => e.kind === "cursor-interactive");
  if (cursorEntries.length > 0) {
    for (const ce of cursorEntries) {
      const namePart = ce.name ? ` "${escapeYamlString(ce.name)}"` : "";
      result.push(`- ${ce.role}${namePart} [ref=${ce.ref}] clickable`);
    }
  }

  let out = result.join("\n");
  const displayRefs = new Set(
    entries.filter(isHighSignalRefEntry).map((entry) => entry.ref),
  );
  if (opts.compact) {
    out = compactTree(out, displayRefs);
  } else if (opts.interactive) {
    out = interactiveTree(out, displayRefs);
  }
  return out;
};

const interactiveTree = (tree: string, displayRefs: ReadonlySet<string>): string => {
  const lines = tree.split("\n");
  const kept: string[] = [];
  let keepUrlContinuation = false;
  for (const line of lines) {
    const ref = extractRef(line);
    if (ref && displayRefs.has(ref)) {
      kept.push(line);
      keepUrlContinuation = true;
      continue;
    }
    if (keepUrlContinuation && /^\s*-?\s*\/url:/.test(line)) {
      kept.push(line);
      keepUrlContinuation = false;
      continue;
    }
    if (line.trim().length > 0) keepUrlContinuation = false;
  }
  return kept.join("\n");
};

const extractRef = (line: string): string | null => {
  const match = /\[ref=(e\d+)\]/.exec(line);
  return match?.[1] ?? null;
};

/**
 * Interactive-first compact mode. Keeps every high-signal ref line (and its
 * `/url:` continuation) and DROPS the pure-structural nesting lines — `generic`,
 * `group`, `list`, layout wrappers with no actionable ref — that the ancestor-keep
 * renderer previously retained just for indentation. Each kept line is flattened to
 * the left margin (its `/url:` continuation indented two spaces) so no signal is
 * lost — roles, names, refs, `[off-viewport]`/`clickable` markers, and urls all
 * survive — while structural noise and deep orphaned indentation are removed,
 * cutting both token count and the wall-clock cost of emitting them.
 */
const compactTree = (tree: string, displayRefs: ReadonlySet<string>): string => {
  const lines = tree.split("\n");
  if (lines.length === 0) return "";

  const kept: string[] = [];
  let keepUrlContinuation = false;
  for (const line of lines) {
    const ref = extractRef(line);
    if (ref && displayRefs.has(ref)) {
      kept.push(line.replace(/^\s+/, ""));
      keepUrlContinuation = true;
      continue;
    }
    if (keepUrlContinuation && /^\s*-?\s*\/url:/.test(line)) {
      kept.push(`  ${line.trim()}`);
      keepUrlContinuation = false;
      continue;
    }
    if (line.trim().length > 0) keepUrlContinuation = false;
  }

  const out = kept.join("\n").trim();
  return out.length === 0 ? "(no interactive elements)" : out;
};

const escapeYamlString = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
