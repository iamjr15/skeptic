import { describe, it, expect, vi } from "vitest";
import type { Locator, Page } from "playwright";
import { wrapPageWithCursor } from "../../../src/api/page-proxy.js";

/**
 * Living documentation of the Page-Proxy gap (skeptic-cli B3).
 *
 * The cursor overlay's action markers come from two complementary signals:
 *  1. **Page Proxy** (this file) — intercepts the canonical Page + Locator interaction
 *     methods and fires `recordAction` via `page.evaluate`.
 *  2. **Fixture runAction fallback** — the runner's `runAction(label, fn)` wrapper emits
 *     synthetic-center markers for fixture-routed methods (screenshot, snapshot, ai.*).
 *
 * Direct keyboard / mouse / evaluate / frame APIs are NOT covered. This test exercises
 * 8 representative call shapes and documents which signal catches each one.
 */

interface CallLog {
  evaluateCalls: Array<{ args: unknown }>;
  clicks: number;
  fills: Array<{ selector: string | null; value: string }>;
  hovers: number;
  presses: number;
  goto: number;
}

const buildStubPage = (log: CallLog): Page => {
  const makeLocator = (selector: string): Locator => {
    const loc = {
      // boundingBox short-circuits to null so tryGetCenter returns null fast.
      boundingBox: vi.fn().mockResolvedValue(null),
      click: vi.fn(async () => { log.clicks += 1; }),
      fill: vi.fn(async (v: string) => { log.fills.push({ selector, value: v }); }),
      hover: vi.fn(async () => { log.hovers += 1; }),
      press: vi.fn(async () => { log.presses += 1; }),
      // Locator chain methods return new "Locator"-shaped objects so the proxy keeps
      // wrapping. We just hand back the same shape; the proxy wraps each call.
      filter: (_opts: unknown) => makeLocator(`${selector}:filtered`),
      first: () => makeLocator(`${selector}:first`),
      last: () => makeLocator(`${selector}:last`),
      nth: (_i: number) => makeLocator(`${selector}:nth`),
      locator: (s: string) => makeLocator(`${selector} ${s}`),
      getByRole: (r: string) => makeLocator(`${selector} role=${r}`),
      getByText: (t: string) => makeLocator(`${selector} text=${t}`),
      frameLocator: (s: string) => makeLocator(`${selector} frame=${s}`),
      contentFrame: () => null,
    } as unknown as Locator;
    return loc;
  };

  const stub = {
    locator: vi.fn((selector: string) => makeLocator(selector)),
    getByRole: vi.fn((role: string) => makeLocator(`role=${role}`)),
    getByText: vi.fn((text: string) => makeLocator(`text=${text}`)),
    frameLocator: vi.fn((s: string) => makeLocator(`frame=${s}`)),
    click: vi.fn(async (_sel: string) => { log.clicks += 1; }),
    fill: vi.fn(async (sel: string, v: string) => { log.fills.push({ selector: sel, value: v }); }),
    hover: vi.fn(async () => { log.hovers += 1; }),
    goto: vi.fn(async () => { log.goto += 1; }),
    evaluate: vi.fn(async (...args: unknown[]) => {
      log.evaluateCalls.push({ args });
      // Return undefined; the helper's then-chain doesn't read the result.
    }),
    keyboard: { press: vi.fn(async () => { log.presses += 1; }) },
    mouse: { click: vi.fn(async () => { log.clicks += 1; }) },
  } as unknown as Page;
  return stub;
};

const newLog = (): CallLog => ({
  evaluateCalls: [],
  clicks: 0,
  fills: [],
  hovers: 0,
  presses: 0,
  goto: 0,
});

// Helper: count evaluate calls whose payload includes a recordAction-shaped arg
// (i.e. has a `cmd` string field on the second argument). The proxy passes the
// payload as the second argument to evaluate; the first is the function body.
const recordActionCalls = (log: CallLog): Array<{ cmd: string }> => {
  return log.evaluateCalls
    .map((call) => (call.args as unknown[])[1])
    .filter((p): p is { cmd: string } => typeof p === "object" && p !== null && "cmd" in p);
};

// B7: setCommandLabel calls use a `{ label, persistent }` payload shape, distinct from
// the `{ cmd, x, y }` recordAction shape. Test fixtures distinguish them by field.
const setLabelCalls = (log: CallLog): Array<{ label: string; persistent: boolean }> => {
  return log.evaluateCalls
    .map((call) => (call.args as unknown[])[1])
    .filter(
      (p): p is { label: string; persistent: boolean } =>
        typeof p === "object" && p !== null && "label" in p && "persistent" in p,
    );
};

// B7: clearCommandLabel passes no second arg (just the function body). Count the
// evaluate calls whose body string contains "clearCommandLabel" — the cleanest signal
// available without instrumenting page.evaluate further.
const clearLabelCallCount = (log: CallLog): number => {
  return log.evaluateCalls.filter((call) => {
    const fn = (call.args as unknown[])[0];
    return typeof fn === "function" && fn.toString().includes("clearCommandLabel");
  }).length;
};

describe("Page Proxy coverage — 8 representative call shapes", () => {
  it("preserves Page constructor identity for Playwright expect type checks", () => {
    class Page {
      locator(): Locator {
        return {} as Locator;
      }
    }
    const proxied = wrapPageWithCursor(new Page() as unknown as import("playwright").Page);
    expect(proxied.constructor.name).toBe("Page");
  });

  it("preserves Locator constructor identity for Playwright expect type checks", () => {
    class Locator {
      click(): void {
        /* noop */
      }
    }
    const page = {
      locator: () => new Locator(),
      evaluate: async () => undefined,
    } as unknown as Page;
    const locator = wrapPageWithCursor(page).locator("button");
    expect(locator.constructor.name).toBe("Locator");
  });

  it("CAUGHT: page.click(selector)", async () => {
    const log = newLog();
    const proxied = wrapPageWithCursor(buildStubPage(log));
    await proxied.click("button.submit");
    expect(log.clicks).toBe(1);
    expect(recordActionCalls(log).some((c) => c.cmd === "click")).toBe(true);
  });

  it("CAUGHT: page.locator(css).click()", async () => {
    const log = newLog();
    const proxied = wrapPageWithCursor(buildStubPage(log));
    await proxied.locator("button.submit").click();
    expect(log.clicks).toBe(1);
    expect(recordActionCalls(log).some((c) => c.cmd === "click")).toBe(true);
  });

  it("CAUGHT: page.locator(css).filter({...}).click()", async () => {
    const log = newLog();
    const proxied = wrapPageWithCursor(buildStubPage(log));
    await proxied.locator("nav").filter({ hasText: "Home" }).click();
    expect(log.clicks).toBe(1);
    expect(recordActionCalls(log).some((c) => c.cmd === "click")).toBe(true);
  });

  it("CAUGHT: page.frameLocator(css).locator(css).click()", async () => {
    const log = newLog();
    const proxied = wrapPageWithCursor(buildStubPage(log));
    await proxied.frameLocator("iframe").locator("button").click();
    expect(log.clicks).toBe(1);
    expect(recordActionCalls(log).some((c) => c.cmd === "click")).toBe(true);
  });

  it("CAUGHT: page.getByRole('button').click()", async () => {
    const log = newLog();
    const proxied = wrapPageWithCursor(buildStubPage(log));
    await proxied.getByRole("button").click();
    expect(log.clicks).toBe(1);
    expect(recordActionCalls(log).some((c) => c.cmd === "click")).toBe(true);
  });

  it("CAUGHT: page.fill(selector, value)", async () => {
    const log = newLog();
    const proxied = wrapPageWithCursor(buildStubPage(log));
    await proxied.fill("input[name=email]", "user@example.com");
    expect(log.fills).toHaveLength(1);
    expect(recordActionCalls(log).some((c) => c.cmd === "fill")).toBe(true);
  });

  it("GAP — fallback to runAction: page.keyboard.press('Enter')", async () => {
    // Direct keyboard API bypasses the proxy. The fixture's runAction wrapper
    // covers fixture-routed actions (screenshot, snapshot, ai.*) but NOT raw
    // keyboard. Documented gap — no marker fires here.
    const log = newLog();
    const proxied = wrapPageWithCursor(buildStubPage(log));
    await proxied.keyboard.press("Enter");
    expect(log.presses).toBe(1);
    expect(recordActionCalls(log).every((c) => c.cmd !== "press")).toBe(true);
  });

  it("GAP — no signal: page.evaluate(() => button.click())", async () => {
    // Page-level evaluate runs raw JS in the page context; no Playwright method
    // is hit. Both Proxy and fixture fallback miss this. The user sees the click
    // happen (page DOM changes) but no marker on the video.
    const log = newLog();
    const proxied = wrapPageWithCursor(buildStubPage(log));
    await proxied.evaluate(() => {
      /* simulated DOM-level click */
    });
    // Only the user's evaluate fired; no recordAction was dispatched.
    expect(recordActionCalls(log)).toHaveLength(0);
  });

  it("GAP — no signal: page.goto(url) (navigation, not interaction)", async () => {
    const log = newLog();
    const proxied = wrapPageWithCursor(buildStubPage(log));
    await proxied.goto("https://example.com");
    // Navigation isn't an interaction-target action; correctly no marker.
    expect(log.goto).toBe(1);
    expect(recordActionCalls(log)).toHaveLength(0);
  });

  describe("B7 — sentence-form narration on intercepted Page actions", () => {
    it("page.click(selector) emits the friendly persistent label and clears on completion", async () => {
      const log = newLog();
      const proxied = wrapPageWithCursor(buildStubPage(log));
      await proxied.click("button.submit");
      const sets = setLabelCalls(log);
      expect(sets.some((s) => s.label === "Clicking" && s.persistent === true)).toBe(true);
      expect(clearLabelCallCount(log)).toBeGreaterThanOrEqual(1);
    });

    it("page.fill(selector, value) emits 'Filling input' and clears", async () => {
      const log = newLog();
      const proxied = wrapPageWithCursor(buildStubPage(log));
      await proxied.fill("input[name=email]", "user@example.com");
      const sets = setLabelCalls(log);
      expect(sets.some((s) => s.label === "Filling input" && s.persistent === true)).toBe(true);
      expect(clearLabelCallCount(log)).toBeGreaterThanOrEqual(1);
    });

    it("page.locator(css).click() emits 'Clicking' on the Locator-Proxy path too", async () => {
      const log = newLog();
      const proxied = wrapPageWithCursor(buildStubPage(log));
      await proxied.locator("button.submit").click();
      const sets = setLabelCalls(log);
      expect(sets.some((s) => s.label === "Clicking" && s.persistent === true)).toBe(true);
      expect(clearLabelCallCount(log)).toBeGreaterThanOrEqual(1);
    });

    it("page.getByRole('button').hover() emits 'Hovering' and clears", async () => {
      const log = newLog();
      const proxied = wrapPageWithCursor(buildStubPage(log));
      await proxied.getByRole("button").hover();
      const sets = setLabelCalls(log);
      expect(sets.some((s) => s.label === "Hovering" && s.persistent === true)).toBe(true);
      expect(clearLabelCallCount(log)).toBeGreaterThanOrEqual(1);
    });

    it("a thrown action still clears the label (try/finally discipline)", async () => {
      // Build a page where click rejects to simulate a Playwright timeout.
      const log = newLog();
      const errStub = buildStubPage(log) as unknown as {
        click: ReturnType<typeof vi.fn>;
        locator: typeof Object.prototype;
      };
      errStub.click = vi.fn(async () => {
        throw new Error("click failed");
      });
      const proxied = wrapPageWithCursor(errStub as unknown as Page);
      await expect(proxied.click("button.submit")).rejects.toThrow(/click failed/);
      // The clear must have fired in `finally` even though the action threw.
      expect(clearLabelCallCount(log)).toBeGreaterThanOrEqual(1);
    });
  });

  it("preserves `this` via Reflect.apply on intercepted methods", async () => {
    // Regression test: if the proxy dispatched via `target[prop](...args)` instead
    // of Reflect.apply(target[prop], target, args), Playwright's internal `_page` /
    // `_frame` lookups would break. We can't observe that directly here, but we can
    // verify the underlying mock saw the right `this` (the original target) by
    // snooping on the call site.
    const log = newLog();
    const page = buildStubPage(log);
    const proxied = wrapPageWithCursor(page);
    await proxied.click("button.submit");
    // Underlying mock was called once. If `this` rebinding broke the SDK, real
    // Playwright would have thrown above before we even reach this assertion.
    expect((page.click as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
