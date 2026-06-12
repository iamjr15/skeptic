import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConsoleMessage as PWConsoleMessage, Dialog, Page } from "playwright";
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

const makeDialog = (
  type: string,
  message: string,
  defaultValue = "",
): Dialog & { accept: ReturnType<typeof vi.fn>; dismiss: ReturnType<typeof vi.fn> } =>
  ({
    type: () => type,
    message: () => message,
    defaultValue: () => defaultValue,
    accept: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
  }) as unknown as Dialog & {
    accept: ReturnType<typeof vi.fn>;
    dismiss: ReturnType<typeof vi.fn>;
  };

type MockPage = Page & {
  __dispatch: (msg: PWConsoleMessage) => void;
  __dispatchPageError: (err: Error) => void;
  __dispatchDialog: (dialog: Dialog) => void;
  __dispatchCrash: () => void;
};

const makePage = (): MockPage => {
  let listener: ((msg: PWConsoleMessage) => void) | undefined;
  let errListener: ((err: Error) => void) | undefined;
  let dialogListener: ((dialog: Dialog) => void) | undefined;
  let crashListener: ((page: Page) => void) | undefined;
  const page = {
    on: vi.fn().mockImplementation((event: string, fn: (arg: never) => void) => {
      if (event === "console") listener = fn as (msg: PWConsoleMessage) => void;
      if (event === "pageerror") errListener = fn as (err: Error) => void;
      if (event === "dialog") dialogListener = fn as (dialog: Dialog) => void;
      if (event === "crash") crashListener = fn as (page: Page) => void;
    }),
    off: vi.fn().mockImplementation((event: string) => {
      if (event === "console") listener = undefined;
      if (event === "pageerror") errListener = undefined;
      if (event === "dialog") dialogListener = undefined;
      if (event === "crash") crashListener = undefined;
    }),
    __dispatch: (msg) => listener?.(msg),
    __dispatchPageError: (err) => errListener?.(err),
    __dispatchDialog: (dialog) => dialogListener?.(dialog),
    __dispatchCrash: () => crashListener?.(page as unknown as Page),
  } as unknown as MockPage;
  return page;
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

  it("captures a JS dialog as a warning and dismisses it", async () => {
    const collector = new ConsoleCollector({ captureLimit: 200, redact: true });
    await collector.attach(page, ctx);

    const dialog = makeDialog("confirm", "Are you sure?");
    page.__dispatchDialog(dialog);
    // Dismissal is async (fire-and-forget inside the handler); let it settle.
    await Promise.resolve();

    const snap = await collector.snapshot();
    expect(snap.summary.warningCount).toBe(1);
    expect(snap.summary.errorCount).toBe(0); // a dialog must not trip error assertions
    const entry = snap.messages[0]!;
    expect(entry.type).toBe("warning");
    expect(entry.kind).toBe("dialog");
    expect(entry.dialog?.type).toBe("confirm");
    expect(entry.text).toContain("Are you sure?");
    expect(dialog.dismiss).toHaveBeenCalledTimes(1);
    expect(dialog.accept).not.toHaveBeenCalled();
  });

  it("accepts a beforeunload dialog so unload is not blocked", async () => {
    const collector = new ConsoleCollector({ captureLimit: 200, redact: true });
    await collector.attach(page, ctx);

    const dialog = makeDialog("beforeunload", "");
    page.__dispatchDialog(dialog);
    await Promise.resolve();

    const snap = await collector.snapshot();
    expect(snap.messages[0]!.dialog?.type).toBe("beforeunload");
    expect(dialog.accept).toHaveBeenCalledTimes(1);
    expect(dialog.dismiss).not.toHaveBeenCalled();
  });

  it("records the dialog default value with redaction applied", async () => {
    const collector = new ConsoleCollector({ captureLimit: 200, redact: true });
    await collector.attach(page, ctx);

    const dialog = makeDialog("prompt", "Enter token", "Authorization: Bearer abcdef0123456789xyzpqr");
    page.__dispatchDialog(dialog);
    await Promise.resolve();

    const snap = await collector.snapshot();
    expect(snap.messages[0]!.dialog?.defaultValue).toMatch(/Bearer \[REDACTED\]/);
    expect(dialog.dismiss).toHaveBeenCalledTimes(1);
  });

  it("still dismisses dialogs once the capture limit is reached", async () => {
    const collector = new ConsoleCollector({ captureLimit: 1, redact: true });
    await collector.attach(page, ctx);

    page.__dispatch(makeMsg("log", "fills the single slot"));
    const dialog = makeDialog("alert", "too late to record");
    page.__dispatchDialog(dialog);
    await Promise.resolve();

    const snap = await collector.snapshot();
    expect(snap.summary.total).toBe(1); // dialog not recorded past the limit
    expect(dialog.dismiss).toHaveBeenCalledTimes(1); // but still settled, never left open
  });

  it("records a renderer crash as an error", async () => {
    const collector = new ConsoleCollector({ captureLimit: 200, redact: true });
    await collector.attach(page, ctx);

    page.__dispatchCrash();

    const snap = await collector.snapshot();
    expect(snap.summary.errorCount).toBe(1);
    const entry = snap.messages[0]!;
    expect(entry.type).toBe("error");
    expect(entry.kind).toBe("crash");
    expect(entry.text).toContain("crashed");
  });

  it("removes console, pageerror, dialog and crash listeners on detach", async () => {
    const collector = new ConsoleCollector({ captureLimit: 200, redact: true });
    await collector.attach(page, ctx);
    await collector.detach();
    expect(page.off).toHaveBeenCalledWith("console", expect.any(Function));
    expect(page.off).toHaveBeenCalledWith("pageerror", expect.any(Function));
    expect(page.off).toHaveBeenCalledWith("dialog", expect.any(Function));
    expect(page.off).toHaveBeenCalledWith("crash", expect.any(Function));
  });
});
