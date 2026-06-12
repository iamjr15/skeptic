import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConsoleMessage as PWConsoleMessage, Page } from "playwright";
import { ConsoleCollector } from "../../../src/observability/collectors/console-collector.js";
import { ExecutionContext } from "../../../src/executor/context.js";

const makeMsg = (
  type: string,
  text: string,
  loc?: { url: string; lineNumber: number; columnNumber: number },
): PWConsoleMessage =>
  ({
    type: () => type,
    text: () => text,
    location: () => loc ?? { url: "", lineNumber: 0, columnNumber: 0 },
  }) as unknown as PWConsoleMessage;

type MockPage = Page & {
  __dispatch: (msg: PWConsoleMessage) => void;
  __dispatchPageError: (err: Error) => void;
};

const makePage = (): MockPage => {
  let listener: ((msg: PWConsoleMessage) => void) | undefined;
  let errListener: ((err: Error) => void) | undefined;
  return {
    on: vi.fn().mockImplementation((event: string, fn: (arg: never) => void) => {
      if (event === "console") listener = fn as (msg: PWConsoleMessage) => void;
      if (event === "pageerror") errListener = fn as (err: Error) => void;
    }),
    off: vi.fn().mockImplementation((event: string) => {
      if (event === "console") listener = undefined;
      if (event === "pageerror") errListener = undefined;
    }),
    __dispatch: (msg) => listener?.(msg),
    __dispatchPageError: (err) => errListener?.(err),
  } as unknown as MockPage;
};

describe("ConsoleCollector", () => {
  let page: ReturnType<typeof makePage>;
  let ctx: ExecutionContext;

  beforeEach(() => {
    page = makePage();
    ctx = new ExecutionContext(page, "https://example.com");
  });

  it("captures console messages and surfaces type counts", async () => {
    const collector = new ConsoleCollector({ captureLimit: 200, redact: true });
    await collector.attach(page, ctx);

    page.__dispatch(makeMsg("error", "boom"));
    page.__dispatch(makeMsg("warning", "uh oh"));
    page.__dispatch(makeMsg("info", "fyi"));
    page.__dispatch(makeMsg("log", "hello"));

    const snap = await collector.snapshot();
    expect(snap.summary.total).toBe(4);
    expect(snap.summary.errorCount).toBe(1);
    expect(snap.summary.warningCount).toBe(1);
    expect(snap.summary.infoCount).toBe(2); // info + log
    expect(snap.summary.redactionDisabled).toBe(false);
  });

  it("redacts captured text by default", async () => {
    const collector = new ConsoleCollector({ captureLimit: 200, redact: true });
    await collector.attach(page, ctx);

    page.__dispatch(makeMsg("log", "Authorization: Bearer abcdef0123456789xyzpqr"));

    const snap = await collector.snapshot();
    expect(snap.messages[0]!.text).toMatch(/Bearer \[REDACTED\]/);
  });

  it("preserves raw text when redaction is disabled", async () => {
    const collector = new ConsoleCollector({ captureLimit: 200, redact: false });
    await collector.attach(page, ctx);

    page.__dispatch(makeMsg("log", "Authorization: Bearer abcdef0123456789xyzpqr"));

    const snap = await collector.snapshot();
    expect(snap.messages[0]!.text).toContain("abcdef0123456789xyzpqr");
    expect(snap.summary.redactionDisabled).toBe(true);
  });

  it("respects captureLimit", async () => {
    const collector = new ConsoleCollector({ captureLimit: 3, redact: true });
    await collector.attach(page, ctx);

    for (let i = 0; i < 10; i++) {
      page.__dispatch(makeMsg("log", `msg-${i}`));
    }

    const snap = await collector.snapshot();
    expect(snap.summary.total).toBe(3);
  });

  it("captures location with URL redaction", async () => {
    const collector = new ConsoleCollector({ captureLimit: 200, redact: true });
    await collector.attach(page, ctx);

    page.__dispatch(
      makeMsg("warning", "deprecation", {
        url: "https://example.com/app.js?token=secret123",
        lineNumber: 42,
        columnNumber: 10,
      }),
    );

    const snap = await collector.snapshot();
    expect(snap.messages[0]!.location?.url).toContain("token=***");
    expect(snap.messages[0]!.location?.lineNumber).toBe(42);
  });

  it("captures uncaught page exceptions (pageerror) as errors", async () => {
    const collector = new ConsoleCollector({ captureLimit: 200, redact: true });
    await collector.attach(page, ctx);

    const err = new Error("Cannot read properties of undefined (reading 'foo')");
    err.stack = "TypeError: Cannot read properties of undefined (reading 'foo')\n    at app.js:10:5";
    page.__dispatchPageError(err);

    const snap = await collector.snapshot();
    expect(snap.summary.errorCount).toBe(1);
    expect(snap.messages[0]!.type).toBe("error");
    expect(snap.messages[0]!.text).toContain("Uncaught");
    expect(snap.messages[0]!.text).toContain("reading 'foo'");
  });

  it("removes both console and pageerror listeners on detach", async () => {
    const collector = new ConsoleCollector({ captureLimit: 200, redact: true });
    await collector.attach(page, ctx);
    await collector.detach();
    expect(page.off).toHaveBeenCalledWith("console", expect.any(Function));
    expect(page.off).toHaveBeenCalledWith("pageerror", expect.any(Function));
  });
});
