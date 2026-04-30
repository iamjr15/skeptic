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

const makePage = (): Page & { __dispatch: (msg: PWConsoleMessage) => void } => {
  let listener: ((msg: PWConsoleMessage) => void) | undefined;
  return {
    on: vi.fn().mockImplementation((event: string, fn: (msg: PWConsoleMessage) => void) => {
      if (event === "console") listener = fn;
    }),
    off: vi.fn().mockImplementation((event: string) => {
      if (event === "console") listener = undefined;
    }),
    __dispatch: (msg) => listener?.(msg),
  } as unknown as Page & { __dispatch: (msg: PWConsoleMessage) => void };
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

  it("removes the listener on detach", async () => {
    const collector = new ConsoleCollector({ captureLimit: 200, redact: true });
    await collector.attach(page, ctx);
    await collector.detach();
    expect(page.off).toHaveBeenCalledWith("console", expect.any(Function));
  });
});
