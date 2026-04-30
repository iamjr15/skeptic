import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Page, Locator } from "playwright";
import { resolveAriaRef } from "../../../src/executor/aria-ref-resolver.js";
import type { ExecutionContext } from "../../../src/executor/context.js";
import type { AriaRefEntry } from "../../../src/executor/aria-ref-types.js";

/**
 * Insertion-retarget regression — when a same-named element is inserted before
 * the original between snapshot and resolution, `nth=0` silently picks the new
 * element. The resolver must emit a warning (NOT fail) so debugging is possible.
 */

function makeCtx(refs: Map<string, AriaRefEntry>): ExecutionContext {
  return {
    ariaRefs: refs,
    ariaSnapshotYaml: "(yaml)",
  } as unknown as ExecutionContext;
}

interface MockSetup {
  liveCount: number;
  scopeName?: string;
}

function createMockPage(setup: MockSetup): Page {
  const nthLocator: Locator = {
    count: vi.fn().mockResolvedValue(1),
  } as unknown as Locator;

  const allMatches: Locator = {
    nth: vi.fn().mockReturnValue(nthLocator),
    count: vi.fn().mockResolvedValue(setup.liveCount),
  } as unknown as Locator;

  const scope: Locator = {
    getByRole: vi.fn().mockReturnValue(allMatches),
  } as unknown as Locator;

  return {
    locator: vi.fn().mockReturnValue(scope),
  } as unknown as Page;
}

describe("resolveAriaRef — insertion-retarget warning", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns when liveCount > matchCountAtSnapshot AND nth === 0", async () => {
    const refs = new Map<string, AriaRefEntry>([
      [
        "e1",
        {
          ref: "e1",
          kind: "aria",
          role: "button",
          name: "Save",
          nth: 0,
          scopeSelector: "body",
          matchCountAtSnapshot: 1,
        },
      ],
    ]);
    const ctx = makeCtx(refs);
    const page = createMockPage({ liveCount: 2 }); // someone inserted another "Save" button

    await resolveAriaRef(page, ctx, "@e1");

    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls.flat().join(" ");
    expect(msg).toMatch(/silently retargeted/);
    expect(msg).toMatch(/snapshot saw 1 candidate/);
    expect(msg).toMatch(/live page has 2/);
  });

  it("does NOT warn when liveCount equals matchCountAtSnapshot", async () => {
    const refs = new Map<string, AriaRefEntry>([
      [
        "e1",
        {
          ref: "e1",
          kind: "aria",
          role: "button",
          name: "Save",
          nth: 0,
          scopeSelector: "body",
          matchCountAtSnapshot: 1,
        },
      ],
    ]);
    const ctx = makeCtx(refs);
    const page = createMockPage({ liveCount: 1 });

    await resolveAriaRef(page, ctx, "@e1");

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does NOT warn when nth > 0 (subsequent matches retain ordering semantics)", async () => {
    const refs = new Map<string, AriaRefEntry>([
      [
        "e2",
        {
          ref: "e2",
          kind: "aria",
          role: "button",
          name: "Save",
          nth: 1,
          scopeSelector: "body",
          matchCountAtSnapshot: 2,
        },
      ],
    ]);
    const ctx = makeCtx(refs);
    const page = createMockPage({ liveCount: 3 }); // count changed but our nth=1 isn't first match

    await resolveAriaRef(page, ctx, "@e2");

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("still throws stale when liveCount is below recorded nth", async () => {
    const refs = new Map<string, AriaRefEntry>([
      [
        "e3",
        {
          ref: "e3",
          kind: "aria",
          role: "button",
          name: "Save",
          nth: 2,
          scopeSelector: "body",
          matchCountAtSnapshot: 3,
        },
      ],
    ]);
    const ctx = makeCtx(refs);
    const page = createMockPage({ liveCount: 1 });

    await expect(resolveAriaRef(page, ctx, "@e3")).rejects.toThrow(/stale/);
  });
});
