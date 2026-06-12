import { describe, it, expect, vi } from "vitest";
import { SessionRegistry } from "../../../src/daemon/session-registry.js";
import type { Driver, DriverSession } from "../../../src/driver/types.js";

const makeSession = (): DriverSession & { closed: boolean } => {
  const s = {
    closed: false,
    open: vi.fn(async () => {}),
    url: vi.fn(() => "https://example.com"),
    title: vi.fn(async () => "T"),
    snapshot: vi.fn(async () => ({ yaml: "", entries: [], truncated: false })),
    resolveRef: vi.fn(),
    resolveSelector: vi.fn(),
    screenshot: vi.fn(),
    scroll: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    attachCollectors: vi.fn(async () => {}),
    collectEvidence: vi.fn(async () => ({})),
    detachCollectors: vi.fn(async () => {}),
    close: vi.fn(async () => {
      s.closed = true;
    }),
  } as unknown as DriverSession & { closed: boolean };
  return s;
};

const makeDriver = () => {
  const sessions: ReturnType<typeof makeSession>[] = [];
  const driver = {
    closed: false,
    newSession: vi.fn(async () => {
      const s = makeSession();
      sessions.push(s);
      return s;
    }),
    close: vi.fn(async () => {
      driver.closed = true;
    }),
  } as unknown as Driver & { closed: boolean; newSession: ReturnType<typeof vi.fn> };
  return { driver, sessions };
};

describe("SessionRegistry", () => {
  it("lazily launches the driver only on first use, then reuses one session per name", async () => {
    const { driver } = makeDriver();
    const reg = new SessionRegistry({ engine: "chromium", headed: true, sessionIdleSeconds: 0, createDriver: async () => driver });
    expect(driver.newSession).not.toHaveBeenCalled();

    await reg.run("default", async (s) => s.open("https://a.com"));
    await reg.run("default", async (s) => s.snapshot());
    expect(driver.newSession).toHaveBeenCalledOnce(); // same session reused
    expect(reg.size).toBe(1);

    await reg.run("other", async (s) => s.open("https://b.com"));
    expect(driver.newSession).toHaveBeenCalledTimes(2);
    expect(reg.size).toBe(2);
  });

  it("serializes concurrent ops against the same session (mutex)", async () => {
    const { driver } = makeDriver();
    const reg = new SessionRegistry({ engine: "chromium", headed: true, sessionIdleSeconds: 0, createDriver: async () => driver });
    const order: string[] = [];
    const slow = reg.run("default", async () => {
      order.push("start-A");
      await new Promise((r) => setTimeout(r, 20));
      order.push("end-A");
    });
    const fast = reg.run("default", async () => {
      order.push("start-B");
      order.push("end-B");
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["start-A", "end-A", "start-B", "end-B"]);
  });

  it("close() closes the session and removes it; closeAll() also closes the driver", async () => {
    const { driver, sessions } = makeDriver();
    const reg = new SessionRegistry({ engine: "chromium", headed: true, sessionIdleSeconds: 0, createDriver: async () => driver });
    await reg.run("a", async (s) => s.open("x"));
    await reg.run("b", async (s) => s.open("y"));
    expect(await reg.close("a")).toBe(true);
    expect(reg.size).toBe(1);
    expect(sessions[0]!.closed).toBe(true);
    await reg.closeAll();
    expect(reg.size).toBe(0);
    expect(driver.closed).toBe(true);
  });

  it("list() reports name/url/age using the injected clock", async () => {
    const { driver } = makeDriver();
    let t = 1000;
    const reg = new SessionRegistry({ engine: "chromium", headed: true, sessionIdleSeconds: 0, createDriver: async () => driver, now: () => t });
    await reg.run("default", async (s) => s.open("https://example.com"));
    t = 1500;
    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("default");
    expect(list[0]!.url).toBe("https://example.com");
    expect(list[0]!.ageMs).toBe(500);
  });

  it("reaps an idle session after the idle window", async () => {
    vi.useFakeTimers();
    try {
      const { driver } = makeDriver();
      const reg = new SessionRegistry({ engine: "chromium", headed: true, sessionIdleSeconds: 1, createDriver: async () => driver });
      await reg.run("default", async (s) => s.open("x"));
      expect(reg.size).toBe(1);
      await vi.advanceTimersByTimeAsync(1100);
      expect(reg.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
