import type { Page, Locator } from "playwright";

/**
 * Smart element resolver that tries multiple locator strategies in priority order.
 * Supports explicit prefixes: "testid=...", "css=...", "role=ROLE:NAME"
 * Otherwise walks: role → text → label → placeholder → testid → css.
 */
export async function resolveElement(
  page: Page,
  selector: string,
): Promise<Locator> {
  // ARIA ref guard: `@eN` selectors require ctx-scoped registry lookup which lives in
  // resolveSelectorArg + resolveAriaRef. They must never reach this function — if they do, it's
  // because a caller bypassed resolveSelectorArg, which would otherwise trigger a confusing
  // "Could not find element" error from the auto-detect chain.
  if (selector.startsWith("@e")) {
    throw new Error(
      "Internal error: @-prefixed ARIA refs must go through resolveSelectorArg, not resolveElement",
    );
  }

  // Explicit testid prefix
  if (selector.startsWith("testid=")) {
    const id = selector.slice("testid=".length);
    const loc = page.getByTestId(id);
    if ((await loc.count()) > 0) return loc.first();
    throw new Error(`No element found with test-id "${id}"`);
  }

  // Explicit css prefix
  if (selector.startsWith("css=")) {
    const css = selector.slice("css=".length);
    const loc = page.locator(css);
    if ((await loc.count()) > 0) return loc.first();
    throw new Error(`No element found with CSS selector "${css}"`);
  }

  // Explicit role prefix: "role=button:Submit"
  if (selector.startsWith("role=")) {
    const rest = selector.slice("role=".length);
    const colonIdx = rest.indexOf(":");
    const role = colonIdx >= 0 ? rest.slice(0, colonIdx) : rest;
    const name = colonIdx >= 0 ? rest.slice(colonIdx + 1) : undefined;
    const loc = page.getByRole(role as Parameters<Page["getByRole"]>[0], {
      name,
    });
    if ((await loc.count()) > 0) return loc.first();
    throw new Error(
      `No element found with role "${role}"${name ? ` and name "${name}"` : ""}`,
    );
  }

  // Auto-detect chain: role buttons/links with that name → text → label → placeholder → testid → css
  const strategies: Array<() => Locator> = [
    () => page.getByRole("button", { name: selector }),
    () => page.getByRole("link", { name: selector }),
    () => page.getByRole("heading", { name: selector }),
    () => page.getByText(selector, { exact: true }),
    () => page.getByLabel(selector),
    () => page.getByPlaceholder(selector),
    () => page.getByTestId(selector),
    () => page.getByText(selector), // partial text match last
  ];

  for (const strategy of strategies) {
    const loc = strategy();
    if ((await loc.count()) > 0) return loc.first();
  }

  // Final fallback: try as CSS selector
  const cssLoc = page.locator(selector);
  if ((await cssLoc.count()) > 0) return cssLoc.first();

  throw new Error(
    `Could not find element matching "${selector}". Tried: role (button/link/heading), text, label, placeholder, testid, css.`,
  );
}
