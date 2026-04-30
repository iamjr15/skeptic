import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { buildFixture, type ActionEvent } from "../../../src/api/fixture.js";
import { ExecutionContext } from "../../../src/executor/context.js";

const stubPage = (): Page => {
  const page = {
    waitForLoadState: async () => undefined,
    screenshot: async () => Buffer.alloc(0),
    locator: () => ({ ariaSnapshot: async () => "" }),
    context: () => ({ close: async () => undefined }),
    isClosed: () => false,
  };
  return page as unknown as Page;
};

const noopAction = (_event: ActionEvent): void => {};

describe("runAction boundary (abortReason re-check)", () => {
  it("throws on subsequent fixture call after a hard-timeout sets abortReason", async () => {
    const page = stubPage();
    const ctx = new ExecutionContext(page, "https://example.test", "/tmp", "/tmp");
    const fixture = buildFixture(page, ctx, { onAction: noopAction });

    ctx.abortReason = "test timeout exceeded (1000ms)";

    await expect(
      fixture.runAction("any", async () => "should not run"),
    ).rejects.toThrowError(/aborted: test timeout exceeded/);
  });

  it("bypasses abort when inTeardown is true (afterEach hooks)", async () => {
    const page = stubPage();
    const ctx = new ExecutionContext(page, "https://example.test", "/tmp", "/tmp");
    const fixture = buildFixture(page, ctx, { onAction: noopAction });

    ctx.abortReason = "test timeout exceeded (1000ms)";
    ctx.inTeardown = true;

    await expect(fixture.runAction("teardown", async () => "ok")).resolves.toBe("ok");
  });

  it("emits onAction events: started, completed, failed", async () => {
    const page = stubPage();
    const ctx = new ExecutionContext(page, "https://example.test", "/tmp", "/tmp");
    const events: ActionEvent[] = [];
    const fixture = buildFixture(page, ctx, { onAction: (e) => events.push(e) });

    await fixture.runAction("happy-path", async () => "ok");
    await expect(
      fixture.runAction("sad-path", async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow();

    expect(events.map((e) => `${e.label}:${e.status}`)).toEqual([
      "happy-path:started",
      "happy-path:completed",
      "sad-path:started",
      "sad-path:failed",
    ]);
  });
});
