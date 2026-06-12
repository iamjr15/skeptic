import type { ConsoleMessage as PWConsoleMessage, Dialog, Page } from "playwright";
import type {
  Collector,
  CollectorName,
  ConsoleMessage,
  ConsoleSnapshot,
} from "../types.js";
import type { ExecutionContext } from "../../executor/context.js";
import { logger } from "../../utils/logger.js";
import { redactConsoleText, redactUrl } from "../url-redact.js";

export interface ConsoleCollectorOptions {
  captureLimit: number;
  redact: boolean;
}

export class ConsoleCollector implements Collector {
  readonly name: CollectorName = "console";
  private page: Page | null = null;
  private readonly messages: ConsoleMessage[] = [];
  private readonly options: ConsoleCollectorOptions;
  private onConsole?: (msg: PWConsoleMessage) => void;
  private onPageError?: (error: Error) => void;
  private onDialog?: (dialog: Dialog) => void;
  private onCrash?: (page: Page) => void;

  constructor(options: ConsoleCollectorOptions) {
    this.options = options;
  }

  async attach(page: Page, _ctx: ExecutionContext): Promise<void> {
    this.page = page;

    this.onConsole = (msg) => {
      if (this.messages.length >= this.options.captureLimit) return;
      const rawText = msg.text();
      const text = this.options.redact ? redactConsoleText(rawText) : rawText;

      let location: ConsoleMessage["location"] | undefined;
      try {
        const loc = msg.location();
        if (loc && loc.url) {
          location = {
            url: this.options.redact ? redactUrl(loc.url) : loc.url,
            lineNumber: loc.lineNumber,
            columnNumber: loc.columnNumber,
          };
        }
      } catch {
        // location() can throw on torn-down frames — best-effort
      }

      this.messages.push({
        type: msg.type(),
        text,
        ...(location ? { location } : {}),
        timestamp: Date.now(),
      });
    };

    // Uncaught in-page exceptions and unhandled promise rejections arrive via
    // the separate `pageerror` event, NOT `console`. For a QA tool this is the
    // highest-signal failure event — a page that throws on load otherwise
    // produces an empty console log. Record it as a type:"error" message so it
    // feeds errorCount and observability.expectNoConsoleErrors().
    this.onPageError = (error) => {
      if (this.messages.length >= this.options.captureLimit) return;
      const rawText = `Uncaught ${error.stack || `${error.name}: ${error.message}`}`;
      this.messages.push({
        type: "error",
        text: this.options.redact ? redactConsoleText(rawText) : rawText,
        timestamp: Date.now(),
      });
    };

    // A JS dialog (alert/confirm/prompt/beforeunload) is invisible in headless
    // QA but can gate the page's flow. Capture it as evidence, then settle it
    // ourselves: registering this handler means Playwright no longer
    // auto-dismisses, so we now own dismissal and MUST always settle or the
    // page hangs. Recorded at warning level so it surfaces without tripping
    // expectNoConsoleErrors().
    this.onDialog = (dialog) => {
      const dialogType = dialog.type();
      if (this.messages.length < this.options.captureLimit) {
        const rawDefault = dialog.defaultValue();
        const rawText = `Dialog (${dialogType}): ${dialog.message()}${rawDefault ? ` [default: ${rawDefault}]` : ""}`;
        this.messages.push({
          type: "warning",
          kind: "dialog",
          text: this.options.redact ? redactConsoleText(rawText) : rawText,
          dialog: {
            type: dialogType,
            ...(rawDefault
              ? { defaultValue: this.options.redact ? redactConsoleText(rawDefault) : rawDefault }
              : {}),
          },
          timestamp: Date.now(),
        });
      }
      // Accept beforeunload so navigation/unload proceeds; dismiss the rest so
      // behavior stays non-blocking and deterministic. Always runs, even past
      // the capture limit, so we never leave a dialog open.
      const settle = dialogType === "beforeunload" ? dialog.accept() : dialog.dismiss();
      settle.catch(() => {
        // Dialog already handled or page torn down — best-effort.
      });
    };

    // A renderer crash otherwise surfaces only as a downstream action timeout.
    // Record it at error level so the crash itself is the visible evidence and
    // feeds errorCount / expectNoConsoleErrors().
    this.onCrash = () => {
      if (this.messages.length >= this.options.captureLimit) return;
      this.messages.push({
        type: "error",
        kind: "crash",
        text: "Renderer process crashed (page crash event) — the page became unresponsive",
        timestamp: Date.now(),
      });
    };

    page.on("console", this.onConsole);
    page.on("pageerror", this.onPageError);
    page.on("dialog", this.onDialog);
    page.on("crash", this.onCrash);
  }

  async snapshot(): Promise<ConsoleSnapshot> {
    let errorCount = 0;
    let warningCount = 0;
    let infoCount = 0;
    for (const m of this.messages) {
      if (m.type === "error") errorCount++;
      else if (m.type === "warning") warningCount++;
      else if (m.type === "info" || m.type === "log") infoCount++;
    }

    return {
      messages: this.messages.slice(),
      summary: {
        total: this.messages.length,
        errorCount,
        warningCount,
        infoCount,
        redactionDisabled: !this.options.redact,
      },
    };
  }

  async detach(): Promise<void> {
    if (this.page && this.onConsole) {
      this.page.off("console", this.onConsole);
    }
    if (this.page && this.onPageError) {
      this.page.off("pageerror", this.onPageError);
    }
    if (this.page && this.onDialog) {
      this.page.off("dialog", this.onDialog);
    }
    if (this.page && this.onCrash) {
      this.page.off("crash", this.onCrash);
    }
    logger.debug(`[console] detach — captured ${this.messages.length} message(s)`);
    this.page = null;
  }
}
