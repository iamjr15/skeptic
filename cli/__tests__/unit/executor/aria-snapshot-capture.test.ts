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

  const makeNthLocator = (key: string): Locator => ({
    boundingBox: vi.fn().mockResolvedValue(bounds.get(key) ?? null),
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
    _viewportSize: opts?.viewportSize ?? { width: 1280, height: 720 },
    _bounds: bounds,
    _calls: calls,
    locator: vi.fn().mockImplementation((sel: string) => {
      calls.locator.push(sel);
      if (sel.startsWith("aria-ref=")) {
        return makeNthLocator(sel);
      }
      return scope;
    }),
    viewportSize: vi.fn().mockReturnValue(opts?.viewportSize ?? { width: 1280, height: 720 }),
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

  it("viewport=true filters out entries whose bounding box is outside the viewport", async () => {
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
    const { entries } = await captureAriaSnapshot(page, "body", { viewport: true });

    expect(entries.map((e) => e.ref)).toEqual(["e1"]);
  });

  it("viewport=true keeps the YAML field unchanged (registry shrinks, not the snapshot)", async () => {
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
