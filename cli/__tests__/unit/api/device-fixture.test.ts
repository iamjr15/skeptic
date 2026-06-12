import { describe, it, expect, vi } from "vitest";
import { buildDeviceFixture } from "../../../src/api/device-fixture.js";
import type { DriverSession } from "../../../src/driver/types.js";
import type { ExecutionContext } from "../../../src/executor/context.js";

const stubCtx = (over: Partial<ExecutionContext> = {}): ExecutionContext =>
  ({ abortReason: null, inTeardown: false, addScreenshot: vi.fn(), ...over }) as unknown as ExecutionContext;

const stubSession = (over: Partial<DriverSession> = {}): DriverSession =>
  ({
    open: vi.fn(async () => {}),
    snapshot: vi.fn(async () => ({
      yaml: '- button "OK" [ref=e1]',
      entries: [
        { ref: "e1", role: "button", name: "OK", selectorHint: "text=OK" },
        { ref: "e2", role: "button", name: "Search sessions", selectorHint: "desc=Search sessions" },
      ],
    })),
    resolveRef: vi.fn(async () => ({ click: vi.fn(async () => {}), isEnabled: vi.fn(async () => true) })),
    resolveSelector: vi.fn(async () => ({ click: vi.fn(async () => {}) })),
    screenshot: vi.fn(async () => ({ path: "/tmp/x.png", diagnostics: [] })),
    scroll: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    ...over,
  }) as unknown as DriverSession;

describe("device fixture", () => {
  it("snapshot exposes refs + has/ref matchers (exact selectorHint, name substring)", async () => {
    const f = buildDeviceFixture(stubSession(), stubCtx());
    const snap = await f.device.snapshot();
    expect(snap.refs).toHaveLength(2);
    expect(snap.has("text=OK")).toBe(true); // exact selectorHint
    expect(snap.has("Search sessions")).toBe(true); // accessible-name substring
    expect(snap.has("button:OK")).toBe(true); // role:name
    expect(snap.has("nope")).toBe(false);
    expect(snap.ref("text=OK")).toBe("@e1");
    expect(() => snap.ref("nope")).toThrow(/no ref matches/);
  });

  it("click routes @eN to resolveRef and a selectorHint to resolveSelector", async () => {
    const session = stubSession();
    const f = buildDeviceFixture(session, stubCtx());
    await f.device.click("@e1");
    expect(session.resolveRef).toHaveBeenCalledWith("e1");
    await f.device.click("text=OK");
    expect(session.resolveSelector).toHaveBeenCalledWith("text=OK");
  });

  it("screenshot returns the path and registers it on the ExecutionContext", async () => {
    const ctx = stubCtx();
    const f = buildDeviceFixture(stubSession(), ctx);
    expect(await f.device.screenshot("s")).toBe("/tmp/x.png");
    expect(ctx.addScreenshot).toHaveBeenCalledWith("/tmp/x.png");
  });

  it("scroll(@ref) scrolls into view; scroll({dy}) pans the viewport", async () => {
    const session = stubSession();
    const el = { scrollIntoView: vi.fn(async () => {}) };
    (session.resolveRef as ReturnType<typeof vi.fn>).mockResolvedValue(el);
    const f = buildDeviceFixture(session, stubCtx());
    await f.device.scroll("@e2");
    expect(el.scrollIntoView).toHaveBeenCalled();
    await f.device.scroll({ dy: 400 });
    expect(session.scroll).toHaveBeenCalledWith({ dy: 400 });
  });

  it("web-only fixture fields throw a clear, actionable error under android", () => {
    const f = buildDeviceFixture(stubSession(), stubCtx());
    expect(() => (f.page as unknown as { goto: unknown }).goto).toThrow(/only available under --platform web/);
    expect(() => (f.snapshot as unknown as { call: unknown }).call).toThrow(/only available under --platform web/);
  });

  it("runAction short-circuits with the abort reason when ctx is aborted", async () => {
    const f = buildDeviceFixture(stubSession(), stubCtx({ abortReason: "test timeout" } as Partial<ExecutionContext>));
    await expect(f.device.click("@e1")).rejects.toThrow(/aborted: test timeout/);
  });
});
