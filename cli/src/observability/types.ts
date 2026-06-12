import type { Page } from "playwright";
import type { ExecutionContext } from "../executor/context.js";

export type CollectorName = "performance" | "network" | "accessibility" | "console";

export interface Collector {
  readonly name: CollectorName;
  attach(page: Page, ctx: ExecutionContext): Promise<void>;
  snapshot(): Promise<unknown>;
  detach(): Promise<void>;
}

export interface LongAnimationFrame {
  startTime: number;
  duration: number;
  blockingDuration: number;
  scripts: Array<{
    invoker: string;
    sourceURL: string;
    sourceFunctionName: string;
    duration: number;
    /**
     * Per-script forced style/layout time (ms). Per Chromium's LoAF spec this lives on
     * `PerformanceScriptTiming` entries (script-level), not on the frame itself.
     * Frame-level "forced layout" rendering is computed as
     * `Math.max(...scripts.map(s => s.forcedStyleAndLayoutDuration))`.
     */
    forcedStyleAndLayoutDuration: number;
  }>;
}

export interface NavigationTiming {
  /** ms from navigation start to first byte. */
  ttfb: number | null;
  /** ms from navigation start to DOMContentLoadedEventEnd. */
  domContentLoaded: number | null;
  /** ms from navigation start to loadEventEnd. */
  loadComplete: number | null;
  /**
   * `PerformanceServerTiming` entries from the navigation response, when the origin
   * sent a `Server-Timing` header. Most pages don't emit this; rendered only when present.
   */
  serverTiming?: Array<{ name: string; duration?: number; description?: string }>;
}

export interface ResourceTiming {
  name: string;
  initiatorType: string;
  /** ms — `responseEnd - startTime`. */
  duration: number;
  /** Bytes transferred over the wire (compressed). 0 when the entry was served from cache. */
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
}

export interface PerformanceSnapshot {
  fcp: number | null;
  lcp: number | null;
  cls: number | null;
  inp: number | null;
  ttfb: number | null;
  longAnimationFrames: LongAnimationFrame[];
  /** Best-effort navigation-timing read at snapshot. */
  navigationTiming?: NavigationTiming;
  /** PerformanceResourceTiming entries, captured once at snapshot. Optional. */
  resources?: ResourceTiming[];
}

export interface ConsoleMessage {
  /** Playwright console message type — log/warning/error/info/debug/trace etc. */
  type: string;
  /** Post-redacted text, truncated to 4 KB. */
  text: string;
  location?: { url?: string; lineNumber?: number; columnNumber?: number };
  timestamp: number;
  /**
   * Marks synthesized evidence entries that did NOT arrive via the page's
   * `console` event: a JS dialog skeptic captured then auto-dismissed
   * (`"dialog"`, recorded at warning level), or a renderer process crash
   * (`"crash"`, recorded at error level). Absent for ordinary console/pageerror
   * messages so existing consumers stay unaffected.
   */
  kind?: "dialog" | "crash";
  /** Present only when `kind === "dialog"` — the dialog's type and default value. */
  dialog?: { type: string; defaultValue?: string };
}

export interface ConsoleSnapshot {
  messages: ConsoleMessage[];
  summary: {
    total: number;
    errorCount: number;
    warningCount: number;
    infoCount: number;
    /** True when redaction was disabled via config (report should show a banner). */
    redactionDisabled: boolean;
  };
}

export interface NetworkRequest {
  url: string;
  method: string;
  status?: number;
  resourceType: string;
  duration?: number;
  timestamp: number;
  failure?: string;
  frameUrl?: string;
}

export interface NetworkSnapshot {
  requests: NetworkRequest[];
  issues: {
    failedRequests: Array<{ url: string; method: string; status: number }>;
    networkFailures: Array<{ url: string; method: string; reason: string }>;
    duplicates: Array<{ url: string; method: string; count: number; windowMs: number }>;
    mixedContent: string[];
    corsErrors: Array<{ url: string; method: string; reason: string }>;
  };
  summary?: {
    requestCount: number;
    failedRequestCount: number;
    networkFailureCount: number;
    duplicateGroupCount: number;
    mixedContentCount: number;
    corsErrorCount: number;
    issueCount: number;
    captureLimit: number;
    truncated: boolean;
    resourceTypes: Record<string, number>;
    methods: Record<string, number>;
    statusCodes: Record<string, number>;
  };
}

export interface AccessibilityViolation {
  ruleId: string;
  impact: "critical" | "serious" | "moderate" | "minor";
  engine: "axe" | "equal-access";
  help: string;
  helpUrl?: string;
  nodes: Array<{ target: string[]; html: string; failureSummary?: string }>;
}

export interface AccessibilitySnapshot {
  violations: AccessibilityViolation[];
  summary: {
    violations: number;
    passes: number;
    incomplete: number;
    dualEngine: boolean;
    /**
     * Engines the audit was configured to run. Always includes "axe"; includes
     * "equal-access" when dualEngine is true and the optional peer is installed.
     */
    enginesRequested?: Array<"axe" | "equal-access">;
    /**
     * Engines whose audit threw or otherwise failed to produce results.
     */
    enginesErrored?: Array<{ engine: "axe" | "equal-access"; reason: string }>;
  };
  standard: string;
}
