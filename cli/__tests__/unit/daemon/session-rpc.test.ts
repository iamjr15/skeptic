import { describe, it, expect, vi } from "vitest";
import { dispatchSession } from "../../../src/daemon/session-rpc.js";
import type { SessionRegistry } from "../../../src/daemon/session-registry.js";
import type { DriverSession } from "../../../src/driver/types.js";

const makeSession = (overrides: Partial<DriverSession> = {}): DriverSession =>
  ({
    open: vi.fn(async () => {}),
    url: vi.fn(() => "https://example.com"),
    title: vi.fn(async () => "Example"),
    snapshot: vi.fn(async () => ({
      yaml: '- button "Go" [ref=e1]',
      entries: [{ ref: "e1", kind: "aria", role: "button", name: "Go", nth: 0, scopeSelector: "body", matchCountAtSnapshot: 1 }],
      truncated: false,
    })),
    resolveRef: vi.fn(async () => ({ click: vi.fn(async () => {}), textContent: vi.fn(async () => "Go") })),
    resolveSelector: vi.fn(),
    screenshot: vi.fn(async () => ({ path: "/tmp/s.png", diagnostics: [] })),
    scroll: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    collectEvidence: vi.fn(async () => ({ console: { messages: [{ type: "error", text: "boom" }, { type: "log", text: "ok" }] } })),
    attachCollectors: vi.fn(async () => {}),
    detachCollectors: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  }) as unknown as DriverSession;

const makeRegistry = (opts: { open?: boolean; session?: DriverSession } = {}) => {
  const session = opts.session ?? makeSession();
  let open = opts.open ?? false;
  const reg = {
    has: vi.fn(() => open),
    run: vi.fn(async (_name: string, fn: (s: DriverSession) => Promise<unknown>) => {
      open = true;
      return fn(session);
    }),
    close: vi.fn(async () => {
      open = false;
      return true;
    }),
    list: vi.fn(() => [{ name: "default", url: "https://example.com", ageMs: 10, idleMs: 5 }]),
  } as unknown as SessionRegistry;
  return { reg, session };
};

describe("dispatchSession", () => {
  it("session.open requires a url", async () => {
    const { reg } = makeRegistry();
    expect((await dispatchSession({ method: "session.open", params: {} }, reg)).error).toMatch(/url is required/);
  });

  it("session.open navigates and returns url+title", async () => {
    const { reg, session } = makeRegistry();
    const resp = await dispatchSession({ method: "session.open", params: { url: "https://x.com" } }, reg);
    expect(session.open).toHaveBeenCalledWith("https://x.com", expect.any(Object));
    expect(resp.result).toMatchObject({ session: "default", url: "https://example.com", title: "Example" });
  });

  it("session.snapshot refuses when no session is open", async () => {
    const { reg } = makeRegistry({ open: false });
    const resp = await dispatchSession({ method: "session.snapshot", params: {} }, reg);
    expect(resp.error).toMatch(/no open session/);
  });

  it("session.snapshot renders yaml + refs + selectorHints once open", async () => {
    const { reg } = makeRegistry({ open: true });
    const resp = await dispatchSession({ method: "session.snapshot", params: { interactive: true } }, reg);
    const data = resp.result as { yaml: string; refs: Array<{ ref: string; selectorHint: string }> };
    expect(data.yaml).toContain("[ref=e1]");
    expect(data.refs[0]).toMatchObject({ ref: "e1", selectorHint: "role=button:Go" });
  });

  it("session.act click resolves the ref and clicks", async () => {
    const { reg, session } = makeRegistry({ open: true });
    const resp = await dispatchSession({ method: "session.act", params: { verb: "click", ref: "e1" } }, reg);
    expect(session.resolveRef).toHaveBeenCalledWith("e1");
    expect(resp.result).toMatchObject({ ok: true, verb: "click" });
  });

  it("session.act fill passes the text", async () => {
    const fillEl = { fill: vi.fn(async () => {}) };
    const session = makeSession({ resolveRef: vi.fn(async () => fillEl) as never });
    const { reg } = makeRegistry({ open: true, session });
    await dispatchSession({ method: "session.act", params: { verb: "fill", ref: "e2", text: "hello" } }, reg);
    expect(fillEl.fill).toHaveBeenCalledWith("hello");
  });

  it("session.query text reads textContent", async () => {
    const { reg } = makeRegistry({ open: true });
    const resp = await dispatchSession({ method: "session.query", params: { query: "text", ref: "e1" } }, reg);
    expect(resp.result).toEqual({ value: "Go" });
  });

  it("session.observe errors filters console to error messages", async () => {
    const { reg } = makeRegistry({ open: true });
    const resp = await dispatchSession({ method: "session.observe", params: { collector: "errors" } }, reg);
    expect(resp.result).toMatchObject({ collector: "errors", count: 1 });
  });

  it("session.screenshot returns the artifact path", async () => {
    const { reg } = makeRegistry({ open: true });
    const resp = await dispatchSession({ method: "session.screenshot", params: { fullPage: true } }, reg);
    expect(resp.result).toMatchObject({ path: "/tmp/s.png" });
  });

  it("session.close and session.list work without an open guard", async () => {
    const { reg } = makeRegistry({ open: true });
    expect((await dispatchSession({ method: "session.close", params: {} }, reg)).result).toMatchObject({ closed: true });
    const list = await dispatchSession({ method: "session.list", params: {} }, reg);
    expect((list.result as { sessions: unknown[] }).sessions).toHaveLength(1);
  });

  it("unknown method errors cleanly", async () => {
    const { reg } = makeRegistry();
    expect((await dispatchSession({ method: "session.bogus", params: {} }, reg)).error).toMatch(/unknown session method/);
  });
});
