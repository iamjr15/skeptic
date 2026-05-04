// Source: agent-browser/cli/src/native/element.rs:18-33 © Vercel Inc., Apache 2.0
// (RefEntry shape ported from Rust to TypeScript; cursor-interactive kind added.)

/**
 * ARIA snapshot-ref entry — one record per minted ref.
 *
 * Refs are sequential identifiers (e1, e2, …) produced by Playwright's
 * `Locator.ariaSnapshot({mode:"ai"})` plus a parallel cursor-interactive pass
 * (ported from agent-browser, Apache 2.0).
 *
 * Resolution is `kind`-discriminated:
 *   - `aria` → `getByRole(role, { name, exact: true }).nth(nth)` against `scopeSelector`.
 *   - `cursor-interactive` → `resolveElement(page, selectorHint)` (the existing
 *     skeptic-grammar resolver: `testid=…` / `role=…` / `css=…` / raw text).
 *
 * `selectorHint` is the **stable, cross-process artifact** an agent copies into a
 * `*.spec.ts` file. `@eN` refs are volatile — only valid inside one test run after a
 * `snapshot(page)` call.
 *
 * `matchCountAtSnapshot` records the size of the (role, name) candidate group at
 * capture time. The resolver re-counts the live group; if it changed AND the
 * recorded `nth === 0`, we emit a warning that an insertion may have silently
 * retargeted the ref.
 */
export type AriaRefKind = "aria" | "cursor-interactive";

export interface AriaRefEntry {
  ref: string;
  kind: AriaRefKind;
  role: string;
  name: string;
  nth: number;
  scopeSelector: string;
  /** Optional stable selector hint (skeptic grammar). Required for cursor-interactive. */
  selectorHint?: string;
  /** Optional href for link refs — extracted post-snapshot, first 50 link refs. */
  href?: string;
  /** Number of (role, name) candidates at snapshot time — used by the resolver
   *  to surface silent insertion-retargeting via a `[aria-ref] eN silently retargeted` log. */
  matchCountAtSnapshot: number;
}

const ACTIONABLE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

const STRUCTURAL_ROLES = new Set([
  "complementary",
  "contentinfo",
  "group",
  "heading",
  "main",
  "navigation",
  "region",
  "tabpanel",
]);

/**
 * Output-facing filter for snapshot rendering. Playwright's raw AI snapshot can
 * mint refs for structural implementation details (`generic`, `listitem`,
 * wrapper `list`s). Those refs are still kept in the registry for byRef()
 * parity, but compact/interactive output should surface the roles agents can
 * actually act on or reason about.
 */
export const isHighSignalRefEntry = (entry: AriaRefEntry): boolean => {
  if (entry.kind === "cursor-interactive") return true;
  if (ACTIONABLE_ROLES.has(entry.role)) return true;
  if (STRUCTURAL_ROLES.has(entry.role)) {
    return entry.role === "main" || entry.name.length > 0;
  }
  return false;
};

export const isInteractiveRefEntry = (entry: AriaRefEntry): boolean =>
  entry.kind === "cursor-interactive" || ACTIONABLE_ROLES.has(entry.role);

/** Refs worth labeling in annotated screenshots. Keep this action-oriented so
 * badges do not cover the page with labels for layout-only nodes. */
export const isAnnotatableRefEntry = (entry: AriaRefEntry): boolean =>
  isInteractiveRefEntry(entry);
