import type { Browser } from "playwright";
import { ExecutionContext } from "../../executor/context.js";
import type { Driver, DriverSession, NewSessionOptions } from "../types.js";
import { PlaywrightDriverSession } from "./playwright-session.js";

/**
 * Web `Driver` over a Playwright `Browser`. Each session is an isolated
 * `BrowserContext`. The browser typically comes from the daemon (Change A) or a
 * `--no-daemon` launch; this class is agnostic to how it was obtained.
 */
export class PlaywrightDriver implements Driver {
  constructor(
    private readonly browser: Browser,
    private readonly ownsBrowser: boolean,
  ) {}

  /** Wrap an already-obtained Browser. `ownsBrowser` controls whether `close()` closes it. */
  static fromBrowser(browser: Browser, ownsBrowser = false): PlaywrightDriver {
    return new PlaywrightDriver(browser, ownsBrowser);
  }

  async newSession(opts?: NewSessionOptions): Promise<DriverSession> {
    const context = await this.browser.newContext({
      ...(opts?.viewport ? { viewport: opts.viewport } : {}),
      ...(opts?.deviceScaleFactor !== undefined ? { deviceScaleFactor: opts.deviceScaleFactor } : {}),
      ...(opts?.userAgent ? { userAgent: opts.userAgent } : {}),
      ...(opts?.baseUrl ? { baseURL: opts.baseUrl } : {}),
    });
    const page = await context.newPage();
    const ctx = new ExecutionContext(
      page,
      opts?.baseUrl ?? "",
      opts?.artifactDir,
    );
    return new PlaywrightDriverSession(context, page, ctx);
  }

  async close(): Promise<void> {
    if (this.ownsBrowser) await this.browser.close();
  }
}
