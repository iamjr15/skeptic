import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Page } from "playwright";
import { snapshot } from "../../../src/api/snapshot.js";
import type { ExecutionContext } from "../../../src/executor/context.js";

/**
 * Public-API behavior for the SnapshotTree returned by `snapshot()`:
 *   1. `byRef` is UNIFORMLY async — `await tree.byRef("eN")` resolves a Locator for
 *      every ref kind (regression for the old `Locator | Promise<Locator>` union that
 *      crashed `await tree.byRef(...).click()` for ARIA refs).
 *   2. Off-viewport refs stay in the registry (resolvable) and are annotated
 *      `[off-viewport]` in the rendered YAML — the registry and the printed tree agree.
 *   3. `byRole({ hrefIncludes })` matches the element's OWN href via `.and(...)`,
 *      not a descendant via `.filter({ has })`.
 *
 * The Playwright surface is mocked at the locator boundary; integration coverage of
 * the live browser path lives in `inspect-smoke.test.ts`.
 */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MockCalls {
  getByRole: Array<{ role: string; ropts?: Record<string, unknown> }>;
  locator: string[];
  and: number;
  filter: number;
}

function createMockPage(
  yaml: string,
  opts: { bounds: Record<string, Box>; viewportSize?: { width: number; height: number } },
): Page & { _calls: MockCalls } {
  const calls: MockCalls = { getByRole: [], locator: [], and: 0, filter: 0 };
  const ariaSnapshot = vi.fn().mockResolvedValue(yaml);

  const leafLocator = (): unknown => ({
    nth: vi.fn().mockReturnThis(),
    and: vi.fn().mockImplementation(() => {
      calls.and += 1;
      return leafLocator();
    }),
    filter: vi.fn().mockImplementation(() => {
      calls.filter += 1;
      return leafLocator();
    }),
  });

  const scopeLocator: unknown = {
    first: vi.fn().mockReturnThis(),
    ariaSnapshot,
    getByRole: vi.fn().mockImplementation((role: string, ropts?: Record<string, unknown>) => {
      calls.getByRole.push({ role, ropts });
      return leafLocator();
    }),
  };

  const ariaRefLocator = (sel: string): unknown => ({
    elementHandle: vi.fn().mockResolvedValue({
      _ref: sel.slice("aria-ref=".length),
      dispose: vi.fn().mockResolvedValue(undefined),
    }),
    getAttribute: vi.fn().mockResolvedValue(null),
    boundingBox: vi.fn().mockResolvedValue(null),
  });

  const page = {
    context: vi.fn(), // makes `snapshot()` treat this target as a Page
    locator: vi.fn().mockImplementation((sel: string) => {
      calls.locator.push(sel);
      return sel.startsWith("aria-ref=") ? ariaRefLocator(sel) : scopeLocator;
    }),
    getByRole: vi.fn().mockImplementation((role: string, ropts?: Record<string, unknown>) => {
      calls.getByRole.push({ role, ropts });
      return leafLocator();
    }),
    getByText: vi.fn().mockReturnValue(leafLocator()),
    getByTestId: vi.fn().mockReturnValue(leafLocator()),
    viewportSize: vi.fn().mockReturnValue(opts.viewportSize ?? { width: 1000, height: 800 }),
    addScriptTag: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockImplementation((fn: unknown, arg: unknown) => {
      // Batched viewport visibility (function form, handle array as arg).
      if (typeof fn === "function" && arg && Array.isArray((arg as { els?: unknown }).els)) {
        const a = arg as { els: Array<{ _ref: string } | null>; vw: number; vh: number };
        return Promise.resolve(
          a.els.map((h) => {
            if (!h) return false;
            const box = opts.bounds[`aria-ref=${h._ref}`];
            if (!box) return false;
            const cx = box.x + box.width / 2;
            const cy = box.y + box.height / 2;
            return cx >= 0 && cx <= a.vw && cy >= 0 && cy <= a.vh;
          }),
        );
      }
      // Cursor-interactive DOM walk (string form) — no extra candidates here.
      return Promise.resolve([]);
    }),
    _calls: calls,
  } as unknown as Page & { _calls: MockCalls };

  return page;
}

const makeCtx = (): ExecutionContext =>
  ({ ariaRefs: new Map(), ariaSnapshotYaml: null } as unknown as ExecutionContext);

const YAML = `- button "Go" [ref=e1]\n- link "Docs" [ref=e2]\n`;

describe("snapshot() SnapshotTree", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("byRef returns a Promise for ARIA refs and resolves to a Locator", async () => {
    const page = createMockPage(YAML, {
      bounds: {
        "aria-ref=e1": { x: 10, y: 10, width: 20, height: 20 },
        "aria-ref=e2": { x: 10, y: 40, width: 20, height: 20 },
      },
    });
    const tree = await snapshot(page, makeCtx());

    const pending = tree.byRef("e1");
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toBeDefined();
  });

  it("byRef rejects (does not synchronously throw) for an unknown ref", async () => {
    const page = createMockPage(YAML, {
      bounds: { "aria-ref=e1": { x: 10, y: 10, width: 20, height: 20 } },
    });
    const tree = await snapshot(page, makeCtx());

    await expect(tree.byRef("e999")).rejects.toThrow(/not found/);
  });

  it("keeps off-viewport refs resolvable and annotates them in the rendered YAML", async () => {
    const page = createMockPage(YAML, {
      viewportSize: { width: 1000, height: 800 },
      bounds: {
        "aria-ref=e1": { x: 10, y: 10, width: 20, height: 20 }, // in viewport
        "aria-ref=e2": { x: 10, y: 5000, width: 20, height: 20 }, // below the fold
      },
    });
    const tree = await snapshot(page, makeCtx());

    // Registry parity: both refs resolvable even though e2 is off-screen.
    expect(tree.refs.has("e1")).toBe(true);
    expect(tree.refs.has("e2")).toBe(true);
    await expect(tree.byRef("e2")).resolves.toBeDefined();

    // Rendered YAML and registry agree — e2 is annotated, e1 is not.
    expect(tree.yaml).toContain("[ref=e2] [off-viewport]");
    expect(tree.yaml).toContain("[ref=e1]");
    expect(tree.yaml).not.toContain("[ref=e1] [off-viewport]");
  });

  it("byRole({ hrefIncludes }) matches the element's own href via .and(), not .filter({ has })", async () => {
    const page = createMockPage(YAML, {
      bounds: {
        "aria-ref=e1": { x: 10, y: 10, width: 20, height: 20 },
        "aria-ref=e2": { x: 10, y: 40, width: 20, height: 20 },
      },
    });
    const tree = await snapshot(page, makeCtx());

    tree.byRole("link", { hrefIncludes: "/docs" });

    expect(page._calls.and).toBe(1);
    expect(page._calls.filter).toBe(0);
    expect(page._calls.locator).toContain('[href*="/docs"]');
  });
});
