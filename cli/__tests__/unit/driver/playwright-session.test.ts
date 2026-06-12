import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Locator, Page, BrowserContext } from "playwright";
import { PlaywrightDriverElement } from "../../../src/driver/playwright/playwright-element.js";
import { PlaywrightDriverSession } from "../../../src/driver/playwright/playwright-session.js";
import { ExecutionContext } from "../../../src/executor/context.js";
import type { Collector } from "../../../src/observability/types.js";

// Stub the executor/api helpers so we can test the session WIRING without a browser.
vi.mock("../../../src/executor/aria-snapshot-capture.js", () => ({
  captureAriaSnapshot: vi.fn(async () => ({
    yaml: "- button \"Go\" [ref=e1]",
    entries: [
      { ref: "e1", kind: "aria", role: "button", name: "Go", nth: 0, scopeSelector: "body", matchCountAtSnapshot: 1 },
      { ref: "e2", kind: "cursor-interactive", role: "link", name: "More", nth: 0, scopeSelector: "body", selectorHint: "text=More", matchCountAtSnapshot: 1 },
    ],
    truncated: false,
  })),
}));
vi.mock("../../../src/executor/aria-ref-resolver.js", () => ({
  resolveAriaRef: vi.fn(async () => ({ __kind: "locator", via: "aria-ref" }) as unknown as Locator),
}));
vi.mock("../../../src/executor/element-resolver.js", () => ({
  resolveElement: vi.fn(async () => ({ __kind: "locator", via: "selector" }) as unknown as Locator),
}));
vi.mock("../../../src/api/screenshot.js", () => ({
  takeScreenshot: vi.fn(async () => ({ path: "/tmp/shot.png", diagnostics: [] })),
}));

import { captureAriaSnapshot } from "../../../src/executor/aria-snapshot-capture.js";
import { resolveAriaRef } from "../../../src/executor/aria-ref-resolver.js";
import { resolveElement } from "../../../src/executor/element-resolver.js";

const makeLocator = () => {
  const calls: Record<string, unknown[]> = {};
  const rec = (name: string) =>
    vi.fn((...args: unknown[]) => {
      calls[name] = args;
      return name === "boundingBox"
        ? Promise.resolve({ x: 1, y: 2, width: 3, height: 4 })
        : name === "textContent"
          ? Promise.resolve("hi")
          : Promise.resolve();
    });
  const loc = {
    click: rec("click"),
    fill: rec("fill"),
    pressSequentially: rec("pressSequentially"),
    press: rec("press"),
    hover: rec("hover"),
    check: rec("check"),
    uncheck: rec("uncheck"),
    selectOption: rec("selectOption"),
    scrollIntoViewIfNeeded: rec("scrollIntoView"),
    waitFor: rec("waitFor"),
    boundingBox: rec("boundingBox"),
    textContent: rec("textContent"),
    __calls: calls,
  } as unknown as Locator & { __calls: Record<string, unknown[]> };
  return loc;
};

const makePage = () =>
  ({
    goto: vi.fn(async () => {}),
    url: vi.fn(() => "https://example.com/x"),
    title: vi.fn(async () => "Example"),
    waitForTimeout: vi.fn(async () => {}),
    mouse: { wheel: vi.fn(async () => {}) },
  }) as unknown as Page;

const makeContext = () => ({ close: vi.fn(async () => {}) }) as unknown as BrowserContext;

describe("PlaywrightDriverElement", () => {
  it("forwards every action to the underlying Locator (type → pressSequentially)", async () => {
    const loc = makeLocator();
    const el = new PlaywrightDriverElement(loc);
    await el.click();
    await el.fill("abc");
    await el.type("xyz");
    await el.press("Enter");
    await el.hover();
    await el.check();
    await el.uncheck();
    await el.selectOption("opt");
    await el.scrollIntoView();
    await el.waitFor({ state: "visible", timeoutMs: 100 });
    const c = (loc as unknown as { __calls: Record<string, unknown[]> }).__calls;
    expect(c.click).toBeDefined();
    expect(c.fill).toEqual(["abc"]);
    expect(c.pressSequentially).toEqual(["xyz"]);
    expect(c.press).toEqual(["Enter"]);
    expect(c.selectOption).toEqual(["opt"]);
    expect(c.scrollIntoView).toBeDefined();
    expect(c.waitFor).toEqual([{ state: "visible", timeout: 100 }]);
    expect(await el.boundingBox()).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(await el.textContent()).toBe("hi");
  });
});

describe("PlaywrightDriverSession", () => {
  let page: Page;
  let context: BrowserContext;
  let ctx: ExecutionContext;
  let session: PlaywrightDriverSession;

  beforeEach(() => {
    vi.clearAllMocks();
    page = makePage();
    context = makeContext();
    ctx = new ExecutionContext(page, "");
    session = new PlaywrightDriverSession(context, page, ctx);
  });

  it("snapshot() stores entries as the session RefMap and caches the yaml", async () => {
    const result = await session.snapshot();
    expect(captureAriaSnapshot).toHaveBeenCalledOnce();
    expect(result.entries).toHaveLength(2);
    expect([...ctx.ariaRefs.keys()]).toEqual(["e1", "e2"]);
    expect(ctx.ariaSnapshotYaml).toContain("[ref=e1]");
  });

  it("resolveRef wraps the resolved Locator and normalizes the @ prefix", async () => {
    const el = await session.resolveRef("e1");
    expect(resolveAriaRef).toHaveBeenCalledWith(page, ctx, "@e1");
    expect(el).toBeInstanceOf(PlaywrightDriverElement);
  });

  it("resolveSelector delegates to the element-resolver grammar", async () => {
    await session.resolveSelector("role=button:Go");
    expect(resolveElement).toHaveBeenCalledWith(page, "role=button:Go");
  });

  it("open() navigates and invalidates the RefMap", async () => {
    await session.snapshot();
    expect(ctx.ariaRefs.size).toBe(2);
    await session.open("https://example.com/next");
    expect(ctx.ariaRefs.size).toBe(0);
    expect(ctx.ariaSnapshotYaml).toBeNull();
  });

  it("runs the collector lifecycle: attach → collectEvidence → detach (fault-isolated)", async () => {
    const good: Collector = {
      name: "console",
      attach: vi.fn(async () => {}),
      snapshot: vi.fn(async () => ({ total: 0 })),
      detach: vi.fn(async () => {}),
    };
    const bad: Collector = {
      name: "network",
      attach: vi.fn(async () => {}),
      snapshot: vi.fn(async () => {
        throw new Error("boom");
      }),
      detach: vi.fn(async () => {}),
    };
    await session.attachCollectors([good, bad]);
    expect(good.attach).toHaveBeenCalledWith(page, ctx);
    const evidence = await session.collectEvidence();
    expect(evidence).toEqual({ console: { total: 0 } }); // bad collector's throw is swallowed
    await session.detachCollectors();
    expect(good.detach).toHaveBeenCalledOnce();
    expect(bad.detach).toHaveBeenCalledOnce();
  });

  it("close() detaches collectors and closes the context", async () => {
    const c: Collector = {
      name: "console",
      attach: vi.fn(async () => {}),
      snapshot: vi.fn(async () => ({})),
      detach: vi.fn(async () => {}),
    };
    await session.attachCollectors([c]);
    await session.close();
    expect(c.detach).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("url/title/wait/scroll forward to the page", async () => {
    expect(session.url()).toBe("https://example.com/x");
    expect(await session.title()).toBe("Example");
    await session.wait(5);
    await session.scroll({ dy: 200 });
    expect((page.mouse.wheel as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(0, 200);
  });
});
