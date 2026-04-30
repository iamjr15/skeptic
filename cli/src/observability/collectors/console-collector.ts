import type { ConsoleMessage as PWConsoleMessage, Page } from "playwright";
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

    page.on("console", this.onConsole);
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
    logger.debug(`[console] detach — captured ${this.messages.length} message(s)`);
    this.page = null;
  }
}
