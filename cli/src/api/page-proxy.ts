import type { Locator, Page } from "playwright";

/**
 * Page + Locator proxy wrappers that surface action-marker side-channels into the cursor
 * overlay. Implementation discipline:
 *
 * 1. **Reflect.apply** — every intercepted method dispatches via `Reflect.apply(target[prop],
 *    target, args)` so Playwright's internal `this` references are preserved. Direct
 *    `target[prop](...args)` would re-bind `this` to the Proxy object and break things like
 *    `_page` / `_frame` lookups inside the SDK.
 * 2. **Best-effort, side-channel-only** — every `recordAction` call goes through
 *    `.catch(() => {})` and runs OUTSIDE any abort-aware boundary. If the page closes
 *    mid-action, the rejection is swallowed; the underlying action is unaffected.
 * 3. **Documented gap** — direct `page.keyboard.press(...)`, `page.mouse.click(...)`,
 *    `page.evaluate(() => button.click())`, and frame APIs are NOT intercepted. The
 *    fixture's `runAction` fallback covers fixture-routed actions (screenshot, snapshot,
 *    ai.assert, etc.) but raw CDP / keyboard / evaluate are uncovered. See
 *    `__tests__/integration/cursor/proxy-coverage.test.ts` for the living gap report.
 */

/** Methods on Page + Locator that count as user-driven interactions (markers fire). */
export const INTERACTION_METHODS: ReadonlySet<string> = new Set([
  "click",
  "dblclick",
  "hover",
  "fill",
  "type",
  "press",
  "selectOption",
  "check",
  "uncheck",
  "tap",
  "setChecked",
]);

/** Locator chain methods that return new Locators — wrap the result so the chain
 *  stays proxy-decorated all the way to the action call. */
const LOCATOR_CHAIN_METHODS: ReadonlySet<string> = new Set([
  "locator",
  "getByRole",
  "getByText",
  "getByLabel",
  "getByPlaceholder",
  "getByTestId",
  "getByAltText",
  "getByTitle",
  "filter",
  "and",
  "or",
  "first",
  "last",
  "nth",
  "frameLocator",
  "contentFrame",
]);

/** Page methods that return Locators — same wrapping treatment. */
const PAGE_LOCATOR_FACTORIES: ReadonlySet<string> = new Set([
  "locator",
  "getByRole",
  "getByText",
  "getByLabel",
  "getByPlaceholder",
  "getByTestId",
  "getByAltText",
  "getByTitle",
  "frameLocator",
]);

interface ActionMarker {
  command: string;
  x: number | null;
  y: number | null;
}

const recordOnPage = (page: Page, marker: ActionMarker): void => {
  // Best-effort. Page may be closed, overlay may not be installed, evaluate may reject.
  page
    .evaluate(
      ({ cmd, x, y }) => {
        const cursor = (
          globalThis as unknown as {
            __skepticCursor?: { recordAction?: (c: string, x?: number, y?: number) => void };
          }
        ).__skepticCursor;
        if (!cursor || typeof cursor.recordAction !== "function") return;
        if (typeof x === "number" && typeof y === "number") cursor.recordAction(cmd, x, y);
        else cursor.recordAction(cmd);
      },
      { cmd: marker.command, x: marker.x, y: marker.y },
    )
    .catch(() => {
      /* swallow — overlay not loaded, page closed, etc. */
    });
};

const tryGetCenter = async (
  locator: Locator | undefined,
): Promise<{ x: number; y: number } | null> => {
  if (!locator) return null;
  try {
    const box = await locator.boundingBox({ timeout: 250 }).catch(() => null);
    if (!box) return null;
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  } catch {
    return null;
  }
};

const wrapLocator = (locator: Locator, page: Page): Locator => {
  return new Proxy(locator, {
    get(target, prop, receiver): unknown {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      const name = typeof prop === "string" ? prop : "";

      if (LOCATOR_CHAIN_METHODS.has(name)) {
        return (...args: unknown[]): unknown => {
          const result = Reflect.apply(value, target, args);
          if (result && typeof (result as { click?: unknown }).click === "function") {
            return wrapLocator(result as Locator, page);
          }
          return result;
        };
      }

      if (INTERACTION_METHODS.has(name)) {
        return async (...args: unknown[]): Promise<unknown> => {
          const center = await tryGetCenter(target);
          recordOnPage(page, {
            command: name,
            x: center?.x ?? null,
            y: center?.y ?? null,
          });
          return Reflect.apply(value, target, args);
        };
      }

      // Pass-through with `this` bound to the original target so SDK internals work.
      return (...args: unknown[]): unknown => Reflect.apply(value, target, args);
    },
  });
};

/**
 * Wrap a Page so calls to interaction methods + locator factories thread through the
 * cursor side-channel. Non-interactive methods (goto, evaluate, waitForLoadState, etc.)
 * pass through untouched, with `this` re-bound via Reflect.apply.
 */
export const wrapPageWithCursor = (page: Page): Page => {
  return new Proxy(page, {
    get(target, prop, receiver): unknown {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      const name = typeof prop === "string" ? prop : "";

      if (PAGE_LOCATOR_FACTORIES.has(name)) {
        return (...args: unknown[]): unknown => {
          const result = Reflect.apply(value, target, args);
          if (result && typeof (result as { click?: unknown }).click === "function") {
            return wrapLocator(result as Locator, target);
          }
          return result;
        };
      }

      if (INTERACTION_METHODS.has(name)) {
        return async (...args: unknown[]): Promise<unknown> => {
          // page.click(selector, ...) — synthesize a center via the locator we'd build.
          let coords: { x: number; y: number } | null = null;
          const selector = typeof args[0] === "string" ? args[0] : null;
          if (selector) {
            try {
              const loc = target.locator(selector);
              coords = await tryGetCenter(loc);
            } catch {
              /* ignore */
            }
          }
          recordOnPage(target, {
            command: name,
            x: coords?.x ?? null,
            y: coords?.y ?? null,
          });
          return Reflect.apply(value, target, args);
        };
      }

      return (...args: unknown[]): unknown => Reflect.apply(value, target, args);
    },
  });
};

/**
 * Best-effort `page.evaluate` wrapper that fires `setCommandLabel` on the overlay. Used
 * by the fixture's `runAction` boundary so internally-routed actions (screenshot,
 * snapshot, ai.*, settle, beforeEach/afterEach hooks) update the tooltip too. Pass the
 * command NAME only — never args, never an interpolated string.
 */
export const fireSetCommandLabel = (page: Page, commandName: string): void => {
  page
    .evaluate(
      (cmd) => {
        const cursor = (
          globalThis as unknown as {
            __skepticCursor?: { setCommandLabel?: (c: string) => void };
          }
        ).__skepticCursor;
        if (cursor && typeof cursor.setCommandLabel === "function") cursor.setCommandLabel(cmd);
      },
      commandName,
    )
    .catch(() => {
      /* swallow — overlay may not be loaded yet on first navigate */
    });
};

/**
 * Best-effort `recordAction` for fixture-routed actions (no DOM target → page center).
 * Used by `runAction` after a fixture method completes successfully.
 */
export const fireRecordAction = (page: Page, commandName: string): void => {
  recordOnPage(page, { command: commandName, x: null, y: null });
};
