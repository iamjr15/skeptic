// Source: agent-browser/cli/src/native/snapshot.rs:1060-1230 © Vercel Inc., Apache 2.0
// (Rendering modes — full / interactive / compact — ported from Rust to TypeScript.
//  Indent preservation, ref-aware filtering, and ancestor-keep semantics match
//  agent-browser's `render_tree` + `compact_tree`.)

import type { Locator, Page } from "playwright";
import type { ExecutionContext } from "../executor/context.js";
import { captureAriaSnapshot } from "../executor/aria-snapshot-capture.js";
import { resolveAriaRef } from "../executor/aria-ref-resolver.js";
import type { AriaRefEntry } from "../executor/aria-ref-types.js";

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
  byRef(ref: string): Locator | Promise<Locator>;
  byRole(role: string, opts?: ByRoleOptions): Locator;
  byText(text: string | RegExp): Locator;
  byTestId(id: string): Locator;
  cursorInteractiveCount: number;
  ariaRefCount: number;
}

/**
 * Build a SnapshotTree backed by Playwright's native `Locator.ariaSnapshot({mode:"ai"})`,
 * extended with a cursor-interactive pass and per-link href extraction.
 *
 * `byRef("eN")` is `kind`-aware:
 *   - ARIA refs route through `getByRole(...).nth(n)` (sync, returns a Locator).
 *   - Cursor-interactive refs route through the existing skeptic resolver (async,
 *     so `byRef` returns a `Promise<Locator>` for those entries — callers should
 *     `await` it). Tests for the common ARIA path stay synchronous-feeling.
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
  });

  const byRef = (ref: string): Locator | Promise<Locator> => {
    const entry = refs.get(ref);
    if (!entry) {
      throw new Error(
        `[skeptic] snapshot ref "${ref}" not found. Available: ${[...refs.keys()].join(", ") || "(none)"}`,
      );
    }
    if (entry.kind === "cursor-interactive") {
      // Async path — caller must await.
      return resolveAriaRef(page, ctx, `@${ref}`);
    }
    const scope = page.locator(entry.scopeSelector);
    return scope.getByRole(entry.role as Parameters<Locator["getByRole"]>[0], {
      name: entry.name.length > 0 ? entry.name : undefined,
      exact: true,
    }).nth(entry.nth);
  };

  const byRole = (role: string, byOpts: ByRoleOptions = {}): Locator => {
    let resolved = page.getByRole(role as Parameters<Page["getByRole"]>[0], {
      name: byOpts.name,
    });
    if (byOpts.hrefIncludes !== undefined) {
      resolved = resolved.filter({ has: page.locator(`[href*="${byOpts.hrefIncludes}"]`) });
    }
    return byOpts.index !== undefined ? resolved.nth(byOpts.index) : resolved;
  };

  const byText = (text: string | RegExp): Locator => page.getByText(text);
  const byTestId = (id: string): Locator => page.getByTestId(id);

  return {
    yaml: renderedYaml,
    rawYaml: capture.yaml,
    refs,
    byRef,
    byRole,
    byText,
    byTestId,
    cursorInteractiveCount: cursorCount,
    ariaRefCount: ariaCount,
  };
};

interface RenderOpts {
  interactive: boolean;
  compact: boolean;
}

/**
 * Post-process Playwright's `ariaSnapshot()` YAML into the agent-browser-compatible
 * rendering. We append per-link `/url:` markers and cursor-interactive entries
 * (Playwright's tree omits both); then optionally filter to interactive lines and
 * prune to minimal ancestors for compact mode.
 */
export const renderSnapshotYaml = (
  rawYaml: string,
  entries: AriaRefEntry[],
  opts: RenderOpts,
): string => {
  const REF_LINE_RE = /\[ref=(e\d+)\]/;
  const lines = rawYaml.split("\n");
  const result: string[] = [];
  const refToEntry = new Map(entries.map((e) => [e.ref, e]));

  for (const line of lines) {
    if (line.length === 0 && lines.length === 1) continue;
    result.push(line);
    const m = REF_LINE_RE.exec(line);
    if (m) {
      const entry = refToEntry.get(m[1]!);
      if (entry?.role === "link" && entry.href) {
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
  if (opts.compact) {
    out = compactTree(out);
  } else if (opts.interactive) {
    out = interactiveTree(out);
  }
  return out;
};

const interactiveTree = (tree: string): string => {
  const lines = tree.split("\n");
  return lines.filter((l) => l.includes("[ref=") || l.startsWith("  /url:")).join("\n");
};

const countIndent = (line: string): number => {
  let i = 0;
  while (i < line.length && line[i] === " ") i++;
  return i;
};

/**
 * Mark every line carrying `ref=` (or a trailing `/url:`) as kept, then walk
 * upward to mark ancestor lines (lower indent) so the kept lines retain context.
 */
const compactTree = (tree: string): string => {
  const lines = tree.split("\n");
  if (lines.length === 0) return "";

  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.includes("[ref=") || line.includes("/url:")) {
      keep[i] = true;
      const myIndent = countIndent(line);
      for (let j = i - 1; j >= 0; j--) {
        const ancestorIndent = countIndent(lines[j] ?? "");
        if (ancestorIndent < myIndent) {
          keep[j] = true;
          if (ancestorIndent === 0) break;
        }
      }
    }
  }

  const kept = lines.filter((_, i) => keep[i]);
  const out = kept.join("\n").trim();
  return out.length === 0 ? "(no interactive elements)" : out;
};

const escapeYamlString = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
