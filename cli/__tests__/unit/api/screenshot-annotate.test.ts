import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Heavy mocks: the unit test exercises the annotation pipeline without booting Chromium.
// We mock the ARIA capture so we can drive the entries deterministically, and the
// annotation-overlay so we can assert the inject/remove cycle and finally-block ordering.

const captureMock = vi.fn();
const injectMock = vi.fn();
const removeMock = vi.fn();
const resolveElementMock = vi.fn();

vi.mock("../../../src/executor/aria-snapshot-capture.js", () => ({
  captureAriaSnapshot: (...args: unknown[]) => captureMock(...args),
}));
vi.mock("../../../src/executor/annotation-overlay.js", () => ({
  injectAnnotationOverlay: (...args: unknown[]) => injectMock(...args),
  removeAnnotationOverlay: (...args: unknown[]) => removeMock(...args),
}));
vi.mock("../../../src/executor/element-resolver.js", () => ({
  resolveElement: (...args: unknown[]) => resolveElementMock(...args),
}));

import { takeScreenshot, captureAnnotatedScreenshot } from "../../../src/api/screenshot.js";
import { ExecutionContext } from "../../../src/executor/context.js";

interface MockBoxRet {
  boundingBox: { x: number; y: number; width: number; height: number } | null;
}

const buildPage = (
  refToBox: Record<string, MockBoxRet>,
  opts: { screenshotThrows?: boolean; scrollY?: number } = {},
) => {
  const evaluateCalls: string[] = [];
  const screenshotCalls: Array<{ fullPage?: boolean; path?: string }> = [];
  const locatorCalls: string[] = [];
  return {
    evaluateCalls,
    screenshotCalls,
    locatorCalls,
    page: {
      // Accepts string-form evaluate.
      evaluate: vi.fn(async (expr: string | (() => unknown)) => {
        const s = typeof expr === "string" ? expr : "(fn)";
        evaluateCalls.push(s);
        if (s.includes("scrollY")) return opts.scrollY ?? 0;
        return null;
      }),
      screenshot: vi.fn(async (callOpts: { fullPage?: boolean; path?: string }) => {
        screenshotCalls.push(callOpts);
        if (opts.screenshotThrows) throw new Error("boom");
        return Buffer.from("png-bytes");
      }),
      locator: vi.fn((sel: string) => {
        locatorCalls.push(sel);
        const m = /aria-ref=(e\d+)/.exec(sel);
        const ret = m ? refToBox[m[1]!] : null;
        return {
          boundingBox: vi.fn(async () => (ret ? ret.boundingBox : null)),
        };
      }),
    } as unknown as Parameters<typeof takeScreenshot>[0],
  };
};

describe("takeScreenshot — annotate path", () => {
  let tmp: string;
  let ctx: ExecutionContext;

  beforeEach(async () => {
    captureMock.mockReset();
    injectMock.mockReset();
    removeMock.mockReset();
    resolveElementMock.mockReset();
    tmp = await mkdtemp(join(tmpdir(), "skeptic-annot-"));
    ctx = new ExecutionContext({} as never, "http://x", tmp, tmp);
  });

  it("attaches annotation-map diagnostic with NO `name` field (PII safety)", async () => {
    captureMock.mockResolvedValue({
      yaml: "",
      entries: [
        { ref: "e1", kind: "aria", role: "link", name: "user@example.com", nth: 0, scopeSelector: "body", matchCountAtSnapshot: 1 },
        { ref: "e2", kind: "aria", role: "button", name: "Account: Jane Doe", nth: 0, scopeSelector: "body", matchCountAtSnapshot: 1 },
      ],
      truncated: false,
    });
    const { page } = buildPage({
      e1: { boundingBox: { x: 10, y: 20, width: 100, height: 30 } },
      e2: { boundingBox: { x: 50, y: 80, width: 60, height: 25 } },
    });

    const result = await takeScreenshot(page, ctx, "shot", { annotate: true });

    const diag = result.diagnostics.find((d) => d.kind === "annotation-map");
    expect(diag).toBeDefined();
    const entries = (diag?.meta?.entries ?? []) as Record<string, unknown>[];
    expect(entries).toHaveLength(2);
    // Each entry has the documented shape — and crucially NO `name` field.
    for (const e of entries) {
      expect(e).toHaveProperty("label");
      expect(e).toHaveProperty("ref");
      expect(e).toHaveProperty("role");
      expect(e).toHaveProperty("boundingBox");
      expect(Object.keys(e)).not.toContain("name");
    }
    // Sanity: labels are 1, 2 (monotonic, starting at 1).
    expect((entries[0] as { label: number }).label).toBe(1);
    expect((entries[1] as { label: number }).label).toBe(2);
    // Roles preserved (no PII risk — role names are accessibility-tree primitives).
    expect((entries[0] as { role: string }).role).toBe("link");
    expect((entries[1] as { role: string }).role).toBe("button");
  });

  it("invokes inject + remove around the screenshot capture", async () => {
    captureMock.mockResolvedValue({
      yaml: "",
      entries: [
        { ref: "e1", kind: "aria", role: "link", name: "x", nth: 0, scopeSelector: "body", matchCountAtSnapshot: 1 },
      ],
      truncated: false,
    });
    const { page, screenshotCalls } = buildPage({
      e1: { boundingBox: { x: 1, y: 2, width: 3, height: 4 } },
    });

    await takeScreenshot(page, ctx, "shot", { annotate: true });

    expect(injectMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(screenshotCalls).toHaveLength(1);
    // Order assertion: inject must happen before screenshot, remove after.
    const injectOrder = injectMock.mock.invocationCallOrder[0]!;
    const removeOrder = removeMock.mock.invocationCallOrder[0]!;
    const screenshotOrder = (page.screenshot as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0]!;
    expect(injectOrder).toBeLessThan(screenshotOrder);
    expect(screenshotOrder).toBeLessThan(removeOrder);
  });

  it("removes overlay AND restores cursor in finally even when screenshot throws", async () => {
    captureMock.mockResolvedValue({
      yaml: "",
      entries: [
        { ref: "e1", kind: "aria", role: "link", name: "x", nth: 0, scopeSelector: "body", matchCountAtSnapshot: 1 },
      ],
      truncated: false,
    });
    const { page, evaluateCalls } = buildPage(
      { e1: { boundingBox: { x: 1, y: 2, width: 3, height: 4 } } },
      { screenshotThrows: true },
    );

    await expect(takeScreenshot(page, ctx, "shot", { annotate: true })).rejects.toThrow("boom");

    // Cleanup must have happened even though capture threw.
    expect(removeMock).toHaveBeenCalledTimes(1);
    // Cursor `hide` was called before capture, `show` was called in finally.
    const hideCalls = evaluateCalls.filter((s) => s.includes(".hide()"));
    const showCalls = evaluateCalls.filter((s) => s.includes(".show()"));
    expect(hideCalls.length).toBeGreaterThanOrEqual(1);
    expect(showCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("skips refs whose bbox is null (off-screen / detached) — never adds to the map", async () => {
    captureMock.mockResolvedValue({
      yaml: "",
      entries: [
        { ref: "e1", kind: "aria", role: "link", name: "a", nth: 0, scopeSelector: "body", matchCountAtSnapshot: 1 },
        { ref: "e2", kind: "aria", role: "link", name: "b", nth: 0, scopeSelector: "body", matchCountAtSnapshot: 1 },
        { ref: "e3", kind: "aria", role: "button", name: "c", nth: 0, scopeSelector: "body", matchCountAtSnapshot: 1 },
      ],
      truncated: false,
    });
    const { page } = buildPage({
      e1: { boundingBox: { x: 1, y: 2, width: 3, height: 4 } },
      e2: { boundingBox: null }, // off-screen
      e3: { boundingBox: { x: 5, y: 6, width: 7, height: 8 } },
    });

    const result = await takeScreenshot(page, ctx, "shot", { annotate: true });
    const entries = result.annotations ?? [];
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.ref)).toEqual(["e1", "e3"]);
    // Labels are 1, 2 — the skipped ref doesn't burn a number.
    expect(entries.map((e) => e.label)).toEqual([1, 2]);
  });

  it("skips layout-only ARIA refs so annotated screenshots stay action-oriented", async () => {
    captureMock.mockResolvedValue({
      yaml: "",
      entries: [
        { ref: "e1", kind: "aria", role: "generic", name: "", nth: 0, scopeSelector: "body", matchCountAtSnapshot: 1 },
        { ref: "e2", kind: "aria", role: "listitem", name: "", nth: 0, scopeSelector: "body", matchCountAtSnapshot: 1 },
        { ref: "e3", kind: "aria", role: "link", name: "Store", nth: 0, scopeSelector: "body", matchCountAtSnapshot: 1 },
      ],
      truncated: false,
    });
    const { page } = buildPage({
      e1: { boundingBox: { x: 1, y: 2, width: 3, height: 4 } },
      e2: { boundingBox: { x: 5, y: 6, width: 7, height: 8 } },
      e3: { boundingBox: { x: 9, y: 10, width: 11, height: 12 } },
    });

    const result = await takeScreenshot(page, ctx, "shot", { annotate: true });

    expect(result.annotations?.map((e) => e.ref)).toEqual(["e3"]);
  });

  it("projects bbox.y by scrollY when fullPage is true", async () => {
    captureMock.mockResolvedValue({
      yaml: "",
      entries: [
        { ref: "e1", kind: "aria", role: "link", name: "x", nth: 0, scopeSelector: "body", matchCountAtSnapshot: 1 },
      ],
      truncated: false,
    });
    const { page } = buildPage(
      { e1: { boundingBox: { x: 10, y: 200, width: 50, height: 20 } } },
      { scrollY: 1500 },
    );

    const result = await captureAnnotatedScreenshot(page, join(tmp, "shot.png"), {
      fullPage: true,
      scope: "body",
    });

    const entry = result.annotations![0]!;
    expect(entry.boundingBox.y).toBe(200 + 1500);
    expect(entry.boundingBox.x).toBe(10);
  });

  it("non-annotate path stays untouched (regression guard)", async () => {
    const { page, screenshotCalls } = buildPage({});
    const result = await takeScreenshot(page, ctx, "shot", { fullPage: false });
    expect(screenshotCalls).toHaveLength(1);
    expect(result.diagnostics).toEqual([]);
    expect(captureMock).not.toHaveBeenCalled();
    expect(injectMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
    // Output file is in ctx.testDir; verify it lives under our tmp dir.
    expect(result.path.startsWith(tmp)).toBe(true);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });
});
