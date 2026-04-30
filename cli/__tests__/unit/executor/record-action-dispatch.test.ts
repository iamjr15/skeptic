import { describe, it, expect } from "vitest";
import {
  INTERACTION_METHODS,
  wrapPageWithCursor,
} from "../../../src/api/page-proxy.js";
import { stepHasInteractionTarget } from "../../../src/executor/playwright-engine.js";

/**
 * Verifies the engine + proxy fire `recordAction` ONLY for the enumerated
 * interaction-target command set, and NOT for navigation / waits / observability
 * snapshots / fixture-internal helpers. The set is the contract between the
 * runner, the proxy, and the cursor overlay.
 */
describe("recordAction dispatch contract", () => {
  it("interaction-target command set covers user-driven page actions", () => {
    const positives = [
      "click",
      "doubleClick",
      "hover",
      "type",
      "select",
      "clearInput",
      "copyTextFrom",
      "randomType",
      "randomEmail",
      "randomNumber",
      "randomPhone",
      "press",
      "scroll",
      "scrollUntilVisible",
    ];
    for (const cmd of positives) expect(stepHasInteractionTarget(cmd)).toBe(true);
  });

  it("interaction-target command set excludes navigation / waits / assertions", () => {
    const negatives = [
      "navigate",
      "wait",
      "assertVisible",
      "assertNotVisible",
      "screenshot",
      "snapshot",
      "settle",
      "ai.assert",
      "test",
      "beforeEach",
      "afterEach",
      "observability.expectAccessible",
    ];
    for (const cmd of negatives) expect(stepHasInteractionTarget(cmd)).toBe(false);
  });

  it("page-proxy INTERACTION_METHODS lists Playwright Page+Locator interaction APIs only", () => {
    // These are the canonical Playwright methods we intercept. Checked here so a
    // contributor who edits the set has to update the test (and remember why).
    for (const m of [
      "click",
      "dblclick",
      "hover",
      "fill",
      "type",
      "press",
      "selectOption",
      "check",
      "uncheck",
    ]) {
      expect(INTERACTION_METHODS.has(m)).toBe(true);
    }
    // Non-interaction APIs that the proxy must NOT intercept.
    for (const m of ["goto", "waitForLoadState", "evaluate", "screenshot", "url"]) {
      expect(INTERACTION_METHODS.has(m)).toBe(false);
    }
  });

  it("proxy fires evaluate for click but NOT for goto", async () => {
    // Stub a Page that records evaluate dispatch calls. We use a simple flag rather
    // than the full proxy-coverage stub so the contract is read at a glance.
    let evaluateCalls = 0;
    const stubPage = {
      goto: async (_url: string) => "ok",
      click: async (_sel: string) => "ok",
      locator: (sel: string) => ({
        boundingBox: async () => null,
        click: async () => "ok",
      }),
      evaluate: async (..._args: unknown[]) => {
        evaluateCalls += 1;
      },
    } as unknown as Parameters<typeof wrapPageWithCursor>[0];
    const proxied = wrapPageWithCursor(stubPage);
    await proxied.goto("https://example.com");
    // goto must NOT trigger a side-channel evaluate.
    expect(evaluateCalls).toBe(0);
    await proxied.click("button");
    // Click DOES trigger one side-channel evaluate.
    expect(evaluateCalls).toBe(1);
  });
});
