// Platform-agnostic driver seam. The web (Playwright) impl satisfies these by
// wrapping a BrowserContext+Page; future mobile drivers (adb / simctl+idb) will
// satisfy the same interfaces against a device. The snapshot→ref→act→evidence
// currency (`CaptureResult` / `AriaRefEntry`) is shared verbatim — only the
// functions that produce and consume it are platform-specific.

import type { Page, BrowserContext } from "playwright";
import type { CaptureResult, CaptureOptions } from "../executor/aria-snapshot-capture.js";
import type { AriaRefEntry } from "../executor/aria-ref-types.js";
import type { ScreenshotOptions, ScreenshotResult } from "../api/screenshot.js";
import type { Collector } from "../observability/types.js";

export type { CaptureResult, CaptureOptions, AriaRefEntry };

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DriverOpenOptions {
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  timeoutMs?: number;
}

export interface DriverElementWaitOptions {
  state?: "visible" | "hidden" | "attached" | "detached";
  timeoutMs?: number;
}

/**
 * An opaque action target resolved from a ref or selector. The web impl wraps a
 * lazy Playwright `Locator` (auto-waits, re-resolves each action); a mobile impl
 * wraps `{ ref, AriaRefEntry, lastKnownBounds }` and re-resolves coordinates at
 * action time. Keeping it opaque + all-async is what lets those lifetimes diverge.
 * `boundingBox`/`textContent` are best-effort and nullable so mobile can honor them.
 */
export interface DriverElement {
  click(): Promise<void>;
  fill(text: string): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string): Promise<void>;
  hover(): Promise<void>;
  check(): Promise<void>;
  uncheck(): Promise<void>;
  selectOption(value: string | string[]): Promise<void>;
  scrollIntoView(): Promise<void>;
  waitFor(opts?: DriverElementWaitOptions): Promise<void>;
  boundingBox(): Promise<Box | null>;
  textContent(): Promise<string | null>;
}

/**
 * A long-lived interactive session over one open page. Holds the RefMap (so refs
 * persist across calls) and the attached collectors. This is the deleted MCP
 * `BrowserMcpSession`, now typed platform-agnostically.
 */
export interface DriverSession {
  open(url: string, opts?: DriverOpenOptions): Promise<void>;
  url(): string;
  title(): Promise<string>;
  /** Capture the accessibility tree and store its entries as this session's RefMap. */
  snapshot(opts?: CaptureOptions): Promise<CaptureResult>;
  resolveRef(ref: string): Promise<DriverElement>;
  resolveSelector(selector: string): Promise<DriverElement>;
  screenshot(name: string, opts?: ScreenshotOptions): Promise<ScreenshotResult>;
  scroll(opts: { dx?: number; dy?: number }): Promise<void>;
  wait(ms: number): Promise<void>;
  attachCollectors(collectors: Collector[]): Promise<void>;
  collectEvidence(): Promise<Record<string, unknown>>;
  detachCollectors(): Promise<void>;
  close(): Promise<void>;
  /** Web-only escape hatch for callers that still need raw Playwright. Mobile leaves it undefined. */
  raw?(): { page: Page; context: BrowserContext };
}

export interface NewSessionOptions {
  baseUrl?: string;
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  userAgent?: string;
  /** Directory for this session's artifacts (screenshots, etc.). Defaults to cwd. */
  artifactDir?: string;
}

export interface Driver {
  newSession(opts?: NewSessionOptions): Promise<DriverSession>;
  close(): Promise<void>;
}
