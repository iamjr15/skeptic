// Source: agent-browser/cli/src/native/element.rs:124-214 © Vercel Inc., Apache 2.0
// (`@eN` parsing + kind-aware dispatch ported from Rust to TypeScript. The
//  cursor-interactive branch routes through skeptic's existing `resolveElement`
//  rather than CDP backend-node-id resolution.)

import type { Page, Locator } from "playwright";
import type { ExecutionContext } from "./context.js";
import { resolveElement } from "./element-resolver.js";
import { logger } from "../utils/logger.js";

const refError = (
  kind: "invalid_format" | "not_found" | "stale",
  meta: Record<string, unknown>,
): Error => {
  const error = new Error(`[ariaRef:${kind}] ${JSON.stringify(meta)}`);
  (error as Error & { kind?: string }).kind = kind;
  return error;
};

/**
 * Resolve an `@eN` selector against the ctx-scoped ref registry.
 *
 * Dispatch on `entry.kind`:
 *   - `aria` → `getByRole(role, { name, exact: true }).nth(nth)` against the snapshot
 *     scope. Always uses `.nth(N)` (even N=0) so duplicates pick the recorded position.
 *   - `cursor-interactive` → `resolveElement(page, selectorHint)` — the existing
 *     skeptic-grammar resolver handles `testid=…` / `role=…` / `css=…` / raw text.
 *
 * Insertion-retarget regression: every `aria` resolution re-counts the live (role, name)
 * candidate group. If the count differs from `matchCountAtSnapshot` and `nth === 0`,
 * we log a warning that the ref may have silently retargeted (the user inserted a
 * same-named element before the original). Does NOT fail — just surfaces the ambiguity.
 */
export async function resolveAriaRef(
  page: Page,
  ctx: ExecutionContext,
  selector: string,
): Promise<Locator> {
  const ref = selector.slice(1);

  if (!/^e\d+$/.test(ref)) {
    throw refError("invalid_format", { selector, ref });
  }

  const entry = ctx.ariaRefs.get(ref);
  if (!entry) {
    throw refError("not_found", {
      ref,
      available: [...ctx.ariaRefs.keys()],
      hasSnapshot: ctx.ariaSnapshotYaml !== null,
    });
  }

  if (entry.kind === "cursor-interactive") {
    if (!entry.selectorHint) {
      throw refError("invalid_format", {
        ref,
        reason: "cursor-interactive entry has no selectorHint",
      });
    }
    return resolveElement(page, entry.selectorHint);
  }

  // ARIA branch
  const scope = page.locator(entry.scopeSelector);
  const allMatches = scope.getByRole(
    entry.role as Parameters<Page["getByRole"]>[0],
    { name: entry.name, exact: true },
  );

  const liveCount = await allMatches.count();
  if (
    typeof entry.matchCountAtSnapshot === "number" &&
    entry.matchCountAtSnapshot > 0 &&
    liveCount !== entry.matchCountAtSnapshot &&
    entry.nth === 0
  ) {
    logger.warn(
      `[aria-ref] ${ref} silently retargeted: snapshot saw ${entry.matchCountAtSnapshot} ` +
        `candidate${entry.matchCountAtSnapshot === 1 ? "" : "s"}, live page has ${liveCount} — ` +
        `first match may differ.`,
    );
  }

  const candidate = allMatches.nth(entry.nth);

  if (liveCount === 0 || liveCount <= entry.nth) {
    throw refError("stale", {
      ref,
      role: entry.role,
      name: entry.name,
      expectedNth: entry.nth,
      actualMatches: liveCount,
    });
  }

  return candidate;
}
