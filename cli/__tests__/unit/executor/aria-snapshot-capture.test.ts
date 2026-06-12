import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Page, Locator } from "playwright";
import { captureAriaSnapshot } from "../../../src/executor/aria-snapshot-capture.js";

// Mock the Playwright `Locator.ariaSnapshot({ mode: "ai" })` call. Tests pass in YAML strings to
// drive the parse path; viewport-mode test exercises the per-entry boundingBox filter.

interface MockPage extends Page {
  _yaml: string;
  _viewportSize: { width: number; height: number } | null;
  _bounds: Map<string, { x: number; y: number; width: number; height: number } | null>;
  _calls: {
    locator: string[];
    getByRole: Array<{ role: string; opts?: Record<string, unknown> }>;
  };
}

function createMockPage(yaml: string, opts?: {
  viewportSize?: { width: number; height: number } | null;
  bounds?: Record<string, { x: number; y: number; width: number; height: number } | null>;
}): MockPage {
  const calls = { locator: [] as string[], getByRole: [] as Array<{ role: string; opts?: Record<string, unknown> }> };
  const bounds = new Map(Object.entries(opts?.bounds ?? {}));

  const ariaSnapshot = vi.fn().mockResolvedValue(yaml);
  const viewportSize = opts?.viewportSize ?? { width: 1280, height: 720 };

  const makeNthLocator = (key: string): Locator => ({
    boundingBox: vi.fn().mockResolvedValue(bounds.get(key) ?? null),
  } as unknown as Locator);

  // aria-ref locators now also resolve element handles — the viewport pass batches
  // bbox/visibility for all refs through a single page.evaluate over those handles.
  const makeRefLocator = (sel: string): Locator => ({
    boundingBox: vi.fn().mockResolvedValue(bounds.get(sel) ?? null),
    elementHandle: vi.fn().mockResolvedValue({
      _ref: sel.slice("aria-ref=".length),
      dispose: vi.fn().mockResolvedValue(undefined),
    }),
  } as unknown as Locator);

  const makeRoleLocator = (key: string): Locator => ({
    nth: vi.fn().mockReturnValue(makeNthLocator(key)),
  } as unknown as Locator);

  const scope: Locator = {
    first: vi.fn().mockReturnThis(),
    ariaSnapshot,
    getByRole: vi.fn().mockImplementation((role: string, ropts?: Record<string, unknown>) => {
      calls.getByRole.push({ role, opts: ropts });
      const key = `${role}|${(ropts?.["name"] as string | undefined) ?? ""}`;
      return makeRoleLocator(key);
    }),
  } as unknown as Locator;

  const page = {
    _yaml: yaml,
    _viewportSize: viewportSize,
    _bounds: bounds,
    _calls: calls,
    locator: vi.fn().mockImplementation((sel: string) => {
      calls.locator.push(sel);
      if (sel.startsWith("aria-ref=")) {
        return makeRefLocator(sel);
      }
      return scope;
    }),
    // Batched viewport visibility: production passes the resolved handle array into a
    // single evaluate; the mock maps each handle's `_ref` back to its bounds.
    evaluate: vi.fn().mockImplementation((fn: unknown, arg: unknown) => {
      if (typeof fn === "function" && arg && Array.isArray((arg as { els?: unknown }).els)) {
        const a = arg as { els: Array<{ _ref: string } | null>; vw: number; vh: number };
        return Promise.resolve(
          a.els.map((h) => {
            if (!h) return false;
            const box = bounds.get(`aria-ref=${h._ref}`);
            if (!box) return false;
            const cx = box.x + box.width / 2;
            const cy = box.y + box.height / 2;
            return cx >= 0 && cx <= a.vw && cy >= 0 && cy <= a.vh;
          }),
        );
      }
      return Promise.resolve([]);
    }),
    viewportSize: vi.fn().mockReturnValue(viewportSize),
  } as unknown as MockPage;
  return page;
}

const BASIC_YAML = `- generic [ref=e1]:
  - heading "Sign in" [level=1] [ref=e2]
  - textbox "Email" [ref=e3]
  - button "Sign in" [ref=e4]
`;

describe("captureAriaSnapshot", () => {
  beforeEach(() => {
    delete process.env["SKEPTIC_ARIA_SNAPSHOT_LIMIT_KB"];
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls Locator.ariaSnapshot({ mode: 'ai' }) on the scope and returns YAML verbatim", async () => {
    const page = createMockPage(BASIC_YAML);
    const result = await captureAriaSnapshot(page, "body", { viewport: false });

    expect(result.yaml).toBe(BASIC_YAML);
    expect(page.locator).toHaveBeenCalledWith("body");
    const scopeLocator = vi.mocked(page.locator).mock.results[0]?.value as Locator & {
      first: ReturnType<typeof vi.fn>;
    };
    expect(scopeLocator.first).toHaveBeenCalledOnce();
  });

  it("parses ref-annotated lines into entries with sequential refs and correct roles/names", async () => {
    const page = createMockPage(BASIC_YAML);
    const { entries } = await captureAriaSnapshot(page, "body", { viewport: false });

    expect(entries.map((e) => e.ref)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(entries[0]).toMatchObject({ ref: "e1", role: "generic", name: "" });
    expect(entries[1]).toMatchObject({ ref: "e2", role: "heading", name: "Sign in" });
    expect(entries[2]).toMatchObject({ ref: "e3", role: "textbox", name: "Email" });
    expect(entries[3]).toMatchObject({ ref: "e4", role: "button", name: "Sign in" });
  });

  it("computes nth=0,1 for two buttons with the same name", async () => {
    const yaml = `- generic [ref=e1]:
  - button "Save" [ref=e2]
  - button "Save" [ref=e3]
  - button "Cancel" [ref=e4]
`;
    const page = createMockPage(yaml);
    const { entries } = await captureAriaSnapshot(page, "body", { viewport: false });

    const e2 = entries.find((e) => e.ref === "e2")!;
    const e3 = entries.find((e) => e.ref === "e3")!;
    const e4 = entries.find((e) => e.ref === "e4")!;
    expect(e2.nth).toBe(0);
    expect(e3.nth).toBe(1);
    expect(e4.nth).toBe(0);
  });

  it("preserves the scopeSelector on each entry (so resolution scopes correctly)", async () => {
    const page = createMockPage(BASIC_YAML);
    const { entries } = await captureAriaSnapshot(page, "#main", { viewport: false });

    for (const e of entries) {
      expect(e.scopeSelector).toBe("#main");
    }
  });

  it("skips lines without a [ref=eN] tag", async () => {
    const yaml = `- generic [ref=e1]:
  - heading "No ref here":
  - textbox "Email" [ref=e2]
  - some text without anything
`;
    const page = createMockPage(yaml);
    const { entries } = await captureAriaSnapshot(page, "body", { viewport: false });
    expect(entries.map((e) => e.ref)).toEqual(["e1", "e2"]);
  });

  it("handles roles with extra bracket attrs like [level=1] before the ref tag", async () => {
    const yaml = `- heading "Title" [level=1] [ref=e1]\n`;
    const page = createMockPage(yaml);
    const { entries } = await captureAriaSnapshot(page, "body", { viewport: false });
    expect(entries[0]).toMatchObject({ ref: "e1", role: "heading", name: "Title" });
  });

  it("viewport=true marks off-viewport entries via offViewportRefs but keeps them in the registry", async () => {
    const yaml = `- button "InView" [ref=e1]
- button "OffScreen" [ref=e2]
`;
    const page = createMockPage(yaml, {
      viewportSize: { width: 1000, height: 800 },
      bounds: {
        "aria-ref=e1": { x: 100, y: 100, width: 50, height: 30 },
        "aria-ref=e2": { x: 100, y: 2000, width: 50, height: 30 }, // y > viewport
      },
    });
    const result = await captureAriaSnapshot(page, "body", { viewport: true });

    // Both refs stay resolvable (registry/byRef parity); only e2 is flagged off-screen.
    expect(result.entries.map((e) => e.ref)).toEqual(["e1", "e2"]);
    expect([...(result.offViewportRefs ?? [])]).toEqual(["e2"]);
    expect(result.offViewportRefs?.has("e1")).toBe(false);
  });

  it("viewport=true batches visibility into a single page.evaluate (one round-trip, not per-ref)", async () => {
    const yaml = `- button "A" [ref=e1]\n- button "B" [ref=e2]\n- button "C" [ref=e3]\n`;
    const page = createMockPage(yaml, {
      viewportSize: { width: 1000, height: 800 },
      bounds: {
        "aria-ref=e1": { x: 10, y: 10, width: 20, height: 20 },
        "aria-ref=e2": { x: 10, y: 50, width: 20, height: 20 },
        "aria-ref=e3": { x: 10, y: 90, width: 20, height: 20 },
      },
    });
    await captureAriaSnapshot(page, "body", { viewport: true });
    // One evaluate covers all three refs; no per-ref boundingBox round-trips.
    expect(vi.mocked(page.evaluate)).toHaveBeenCalledTimes(1);
  });

  it("viewport=true keeps the YAML field unchanged (snapshot is never trimmed)", async () => {
    const yaml = `- button "InView" [ref=e1]\n- button "OffScreen" [ref=e2]\n`;
    const page = createMockPage(yaml, {
      viewportSize: { width: 1000, height: 800 },
      bounds: {
        "aria-ref=e1": { x: 100, y: 100, width: 50, height: 30 },
        "aria-ref=e2": { x: 100, y: 2000, width: 50, height: 30 },
      },
    });
    const result = await captureAriaSnapshot(page, "body", { viewport: true });
    expect(result.yaml).toBe(yaml);
  });

  it("size cap: truncates registry past 256 KiB and logs a warning", async () => {
    const warnSpy = vi.spyOn(console, "warn");
    // Build a YAML with many ref lines until > 256 KiB.
    const lineFmt = (i: number) => `- button "B${i}" [ref=e${i}]\n`;
    const lines: string[] = [];
    let approxBytes = 0;
    for (let i = 1; approxBytes < 300 * 1024; i++) {
      const l = lineFmt(i);
      lines.push(l);
      approxBytes += l.length;
    }
    const yaml = lines.join("");

    const page = createMockPage(yaml);
    const result = await captureAriaSnapshot(page, "body", { viewport: false });

    expect(result.truncated).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/exceeds.*registry truncated/));
    // Registry must be smaller than the total ref count emitted in YAML.
    const totalEmitted = lines.length;
    expect(result.entries.length).toBeLessThan(totalEmitted);
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it("size cap: respects SKEPTIC_ARIA_SNAPSHOT_LIMIT_KB override", async () => {
    process.env["SKEPTIC_ARIA_SNAPSHOT_LIMIT_KB"] = "1"; // 1 KiB cap
    const lines: string[] = [];
    for (let i = 1; i <= 200; i++) lines.push(`- button "B${i}" [ref=e${i}]\n`);
    const yaml = lines.join("");

    const page = createMockPage(yaml);
    const result = await captureAriaSnapshot(page, "body", { viewport: false });

    expect(result.truncated).toBe(true);
    // With a 1 KiB cap and ~25-byte lines, we expect ~40 entries — strictly less than 200.
    expect(result.entries.length).toBeLessThan(200);
  });

  it("does not warn or truncate when YAML fits the budget", async () => {
    const warnSpy = vi.spyOn(console, "warn");
    const page = createMockPage(BASIC_YAML);
    const result = await captureAriaSnapshot(page, "body", { viewport: false });

    expect(result.truncated).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
