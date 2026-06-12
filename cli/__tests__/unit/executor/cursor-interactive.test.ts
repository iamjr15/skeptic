import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Page, Locator } from "playwright";
import { captureAriaSnapshot } from "../../../src/executor/aria-snapshot-capture.js";

/**
 * Cursor-interactive heuristic — verifies the second-pass behavior:
 *   1. ARIA refs are returned with `kind: "aria"` + `matchCountAtSnapshot`.
 *   2. Cursor-interactive refs are appended with `kind: "cursor-interactive"` +
 *      `selectorHint`, capped at 100, and assigned the next free `eN` slot.
 *   3. The `<button>` excluded-tags case stays out of the cursor pass — the
 *      heuristic mock returns no entries, simulating the in-browser filter.
 *
 * The DOM-walking part is mocked at the `page.evaluate` boundary; integration
 * coverage of the actual heuristic lives in `inspect-smoke.test.ts`.
 */

interface FakePage {
  _evaluateResults: unknown[];
  _yaml: string;
}

function createFakePage(opts: {
  yaml: string;
  cursorEval: Array<{
    index: number;
    text: string;
    tagName: string;
    hasOnClick: boolean;
    hasCursorPointer: boolean;
    hasTabIndex: boolean;
    ariaRoleHint: string | null;
    bbox?: [number, number, number, number];
  }>;
  selectorHints?: Record<number, string>;
}): Page {
  const ariaSnapshot = vi.fn().mockResolvedValue(opts.yaml);

  const makeNthLocator = (): Locator => ({
    boundingBox: vi.fn().mockResolvedValue({ x: 10, y: 10, width: 50, height: 30 }),
    getAttribute: vi.fn().mockResolvedValue(null),
  } as unknown as Locator);

  const makeRoleLocator = (): Locator => ({
    nth: vi.fn().mockReturnValue(makeNthLocator()),
  } as unknown as Locator);

  const scope: Locator = {
    ariaSnapshot,
    first: vi.fn().mockReturnValue({ ariaSnapshot }),
    getByRole: vi.fn().mockReturnValue(makeRoleLocator()),
  } as unknown as Locator;

  const page = {
    locator: vi.fn().mockReturnValue(scope),
    viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
    evaluate: vi.fn().mockImplementation(async (script: unknown) => {
      // Selector-hint generation is now batched into ONE evaluate that runs
      // `window.__skeptic_selector` over every stamped candidate.
      if (typeof script === "string" && script.includes("__skeptic_selector")) {
        return opts.selectorHints ?? {};
      }
      // The cursor-interactive DOM walk (also a string evaluate, no arg).
      return opts.cursorEval.map((entry) => ({
        bbox: [100, 100, 30, 20],
        ...entry,
      }));
    }),
    addScriptTag: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page & FakePage;
  return page;
}

const FIXTURE_YAML = `- generic [ref=e1]:
  - heading "Hello" [level=1] [ref=e2]
  - button "Real button" [ref=e3]
`;

describe("cursor-interactive pass", () => {
  beforeEach(() => {
    delete process.env["SKEPTIC_ARIA_SNAPSHOT_LIMIT_KB"];
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appends cursor-interactive refs with kind discriminator + selectorHint", async () => {
    const page = createFakePage({
      yaml: FIXTURE_YAML,
      cursorEval: [
        {
          index: 0,
          text: "Click me",
          tagName: "div",
          hasOnClick: true,
          hasCursorPointer: true,
          hasTabIndex: false,
          ariaRoleHint: null,
        },
      ],
      selectorHints: { 0: "css=div.click-target" },
    });

    const { entries } = await captureAriaSnapshot(page, "body", {
      includeCursorInteractive: true,
    });

    const cursor = entries.filter((e) => e.kind === "cursor-interactive");
    expect(cursor).toHaveLength(1);
    expect(cursor[0]).toMatchObject({
      kind: "cursor-interactive",
      role: "div",
      name: "Click me",
      selectorHint: "css=div.click-target",
    });
    // Should be e4 (e1/e2/e3 already used).
    expect(cursor[0]!.ref).toBe("e4");
  });

  it("falls back to data-__skeptic-ci attribute selector when generator returns empty", async () => {
    const page = createFakePage({
      yaml: FIXTURE_YAML,
      cursorEval: [
        {
          index: 0,
          text: "Hidden gen target",
          tagName: "span",
          hasOnClick: false,
          hasCursorPointer: false,
          hasTabIndex: true,
          ariaRoleHint: null,
        },
      ],
      // No selectorHints map — the inner page.evaluate returns "" for the handle.
    });

    const { entries } = await captureAriaSnapshot(page, "body", {
      includeCursorInteractive: true,
    });

    const cursor = entries.filter((e) => e.kind === "cursor-interactive");
    expect(cursor).toHaveLength(1);
    expect(cursor[0]!.selectorHint).toBe('css=[data-__skeptic-ci="0"]');
  });

  it("ARIA entries always carry kind:'aria' + matchCountAtSnapshot", async () => {
    const yaml = `- generic [ref=e1]:
  - button "Save" [ref=e2]
  - button "Save" [ref=e3]
`;
    const page = createFakePage({ yaml, cursorEval: [] });
    const { entries } = await captureAriaSnapshot(page, "body", {
      includeCursorInteractive: false,
    });

    const e2 = entries.find((e) => e.ref === "e2")!;
    const e3 = entries.find((e) => e.ref === "e3")!;
    expect(e2.kind).toBe("aria");
    expect(e3.kind).toBe("aria");
    // Both are in the same (button, "Save") group — count = 2.
    expect(e2.matchCountAtSnapshot).toBe(2);
    expect(e3.matchCountAtSnapshot).toBe(2);
  });

  it("does not run the cursor pass when includeCursorInteractive is false", async () => {
    const page = createFakePage({
      yaml: FIXTURE_YAML,
      cursorEval: [{
        index: 0,
        text: "ignored",
        tagName: "div",
        hasOnClick: true,
        hasCursorPointer: false,
        hasTabIndex: false,
        ariaRoleHint: null,
      }],
    });
    const { entries } = await captureAriaSnapshot(page, "body", {
      includeCursorInteractive: false,
    });
    expect(entries.every((e) => e.kind === "aria")).toBe(true);
  });
});
