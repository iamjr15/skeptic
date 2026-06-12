import type { BrowserContext, Page } from "playwright";
import { ExecutionContext } from "../../executor/context.js";
import { captureAriaSnapshot } from "../../executor/aria-snapshot-capture.js";
import { resolveAriaRef } from "../../executor/aria-ref-resolver.js";
import { resolveElement } from "../../executor/element-resolver.js";
import { takeScreenshot, type ScreenshotOptions, type ScreenshotResult } from "../../api/screenshot.js";
import type { Collector } from "../../observability/types.js";
import type {
  CaptureOptions,
  CaptureResult,
  DriverElement,
  DriverOpenOptions,
  DriverSession,
} from "../types.js";
import { PlaywrightDriverElement } from "./playwright-element.js";

/**
 * Long-lived interactive session over one Playwright page. Owns an
 * `ExecutionContext` and delegates to the existing executor/api helpers verbatim,
 * so snapshot capture, ref resolution, screenshots, and collectors are reused
 * unchanged. This is the deleted MCP `BrowserMcpSession`, now a `DriverSession`.
 */
export class PlaywrightDriverSession implements DriverSession {
  private collectors: Collector[] = [];

  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly ctx: ExecutionContext,
  ) {}

  async open(url: string, opts?: DriverOpenOptions): Promise<void> {
    await this.page.goto(url, {
      waitUntil: opts?.waitUntil ?? "load",
      ...(opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    });
    this.invalidateRefs();
  }

  url(): string {
    return this.page.url();
  }

  title(): Promise<string> {
    return this.page.title();
  }

  async snapshot(opts?: CaptureOptions): Promise<CaptureResult> {
    const capture = await captureAriaSnapshot(this.page, "body", {
      viewport: opts?.viewport ?? true,
      includeCursorInteractive: opts?.includeCursorInteractive ?? true,
      extractLinkHrefs: opts?.extractLinkHrefs ?? true,
    });
    this.ctx.ariaRefs.clear();
    for (const entry of capture.entries) this.ctx.ariaRefs.set(entry.ref, entry);
    this.ctx.ariaSnapshotYaml = capture.yaml;
    return capture;
  }

  async resolveRef(ref: string): Promise<DriverElement> {
    const selector = ref.startsWith("@") ? ref : `@${ref}`;
    const locator = await resolveAriaRef(this.page, this.ctx, selector);
    return new PlaywrightDriverElement(locator);
  }

  async resolveSelector(selector: string): Promise<DriverElement> {
    const locator = await resolveElement(this.page, selector);
    return new PlaywrightDriverElement(locator);
  }

  screenshot(name: string, opts?: ScreenshotOptions): Promise<ScreenshotResult> {
    return takeScreenshot(this.page, this.ctx, name, opts);
  }

  async scroll(opts: { dx?: number; dy?: number }): Promise<void> {
    await this.page.mouse.wheel(opts.dx ?? 0, opts.dy ?? 0);
  }

  async wait(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  async attachCollectors(collectors: Collector[]): Promise<void> {
    this.collectors = collectors;
    for (const collector of collectors) {
      await collector.attach(this.page, this.ctx);
    }
  }

  async collectEvidence(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const collector of this.collectors) {
      try {
        const snap = await collector.snapshot();
        if (snap !== undefined) out[collector.name] = snap;
      } catch {
        // best-effort: a failing collector must not abort evidence collection
      }
    }
    return out;
  }

  async detachCollectors(): Promise<void> {
    for (const collector of this.collectors) {
      try {
        await collector.detach();
      } catch {
        // best-effort
      }
    }
    this.collectors = [];
  }

  async close(): Promise<void> {
    await this.detachCollectors();
    await this.context.close();
  }

  raw(): { page: Page; context: BrowserContext } {
    return { page: this.page, context: this.context };
  }

  private invalidateRefs(): void {
    this.ctx.ariaRefs.clear();
    this.ctx.ariaSnapshotYaml = null;
  }
}
