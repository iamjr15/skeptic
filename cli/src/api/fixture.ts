import type { Locator, Page } from "playwright";
import type { ExecutionContext } from "../executor/context.js";
import type {
  AccessibilitySnapshot,
  ConsoleSnapshot,
  NetworkSnapshot,
  PerformanceSnapshot,
} from "../observability/types.js";
import { AccessibilityCollector } from "../observability/collectors/accessibility-collector.js";
import { ConsoleCollector } from "../observability/collectors/console-collector.js";
import { NetworkCollector } from "../observability/collectors/network-collector.js";
import { PerformanceCollector } from "../observability/collectors/performance-collector.js";
import { takeScreenshot, type ScreenshotOptions, type ScreenshotResult } from "./screenshot.js";
import { snapshot, type SnapshotOptions, type SnapshotTree } from "./snapshot.js";
import {
  buildAiFixture,
  type AiFixture,
} from "./ai.js";
import {
  buildObservabilityFixture,
  type ObservabilityFixture,
} from "./observability.js";
import {
  fireRecordAction,
  fireSetCommandLabel,
  wrapPageWithCursor,
} from "./page-proxy.js";

export interface SkepticFixture {
  page: Page;
  ctx: ExecutionContext;
  /** Wraps a fixture-method body in the abort-aware boundary. Re-checks ctx.abortReason
   *  before each await, surfaces a clean error after a hard-timeout, and emits a
   *  `runner:action` marker the runner uses for video/cursor sidechannels. */
  runAction: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  snapshot: (target?: Page | Locator, opts?: SnapshotOptions) => Promise<SnapshotTree>;
  screenshot: (name: string, opts?: ScreenshotOptions) => Promise<ScreenshotResult>;
  settle: () => Promise<void>;
  observability: ObservabilityFixture;
  ai: AiFixture;
}

export interface FixtureBuildOptions {
  /** Per-action recorder — runner subscribes to feed cursor markers + structured logs.
   *  Best-effort: fixture-routed actions emit through here; raw `await page.click()` does not. */
  onAction?: (event: ActionEvent) => void;
  /** When true, the `page` field on the returned fixture is wrapped in a Proxy that
   *  fires cursor-overlay action markers for intercepted Page + Locator interaction
   *  methods. Off by default; runner enables when `--video` is set. */
  enableCursorProxy?: boolean;
}

export interface ActionEvent {
  label: string;
  status: "started" | "completed" | "failed";
  durationMs?: number;
  error?: string;
}

const defaultOnAction = (_event: ActionEvent): void => {
  /* no-op */
};

/**
 * Build the SkepticFixture for one test. Wires snapshot/screenshot/settle/observability/ai
 * onto the per-test page + ExecutionContext, threading every helper through `runAction`
 * so the four executor invariants survive: abortReason short-circuit, inTeardown bypass,
 * Promise.race ceiling (set up by the runner), and per-await re-check inside the body.
 */
export const buildFixture = (
  page: Page,
  ctx: ExecutionContext,
  options: FixtureBuildOptions = {},
): SkepticFixture => {
  const onAction = options.onAction ?? defaultOnAction;
  const cursorEnabled = options.enableCursorProxy === true;
  // The fixture exposes a (possibly Proxy-wrapped) page so user code that calls
  // `fixture.page.click(...)` threads through the cursor overlay's action markers.
  // The raw page is kept for fixture-internal helpers (screenshot, snapshot) that
  // would otherwise re-trigger the proxy's interception path.
  const exposedPage: Page = cursorEnabled ? wrapPageWithCursor(page) : page;

  const runAction = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    if (ctx.abortReason !== null && !ctx.inTeardown) {
      const message = `[skeptic] aborted: ${ctx.abortReason}`;
      onAction({ label, status: "failed", error: message });
      throw new Error(message);
    }
    const started = performance.now();
    onAction({ label, status: "started" });
    // Side-channel: tooltip + synthetic action marker for fixture-routed methods.
    // Best-effort, fire-and-forget. Outside any abort/timeout boundary; the
    // `.catch(() => {})` inside fireSetCommandLabel/fireRecordAction is the only
    // guard. Pass label as evaluate argument inside fire*; never interpolate.
    if (cursorEnabled) fireSetCommandLabel(page, label);
    try {
      const result = await fn();
      onAction({
        label,
        status: "completed",
        durationMs: Math.round(performance.now() - started),
      });
      if (cursorEnabled) fireRecordAction(page, label);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onAction({
        label,
        status: "failed",
        durationMs: Math.round(performance.now() - started),
        error: message,
      });
      throw err;
    }
  };

  const fixtureSnapshot: SkepticFixture["snapshot"] = (target, opts) =>
    runAction("snapshot", () => snapshot(target ?? page, ctx, opts));

  const fixtureScreenshot: SkepticFixture["screenshot"] = (name, opts) =>
    runAction("screenshot", () => takeScreenshot(page, ctx, name, opts));

  const fixtureSettle: SkepticFixture["settle"] = () =>
    runAction("settle", async () => {
      // visual-settle is wired in B5; the placeholder here keeps the API stable.
      // We still wait for `networkidle` so callers get a meaningful settle baseline.
      try {
        await page.waitForLoadState("networkidle", { timeout: 5_000 });
      } catch {
        // networkidle is a heuristic — don't fail the test if it never quiesces.
      }
    });

  const collectorRefs = {
    performance: ctx.collectors.get("performance") as PerformanceCollector | undefined,
    network: ctx.collectors.get("network") as NetworkCollector | undefined,
    console: ctx.collectors.get("console") as ConsoleCollector | undefined,
    accessibility: ctx.collectors.get("accessibility") as AccessibilityCollector | undefined,
  };

  const observability = buildObservabilityFixture({
    runAction,
    collectors: collectorRefs,
  });

  const ai = buildAiFixture({
    runAction,
    page,
    ctx,
  });

  return {
    page: exposedPage,
    ctx,
    runAction,
    snapshot: fixtureSnapshot,
    screenshot: fixtureScreenshot,
    settle: fixtureSettle,
    observability,
    ai,
  };
};

/** Re-export so collectors typed snapshots are addressable from the fixture's surface. */
export type {
  AccessibilitySnapshot,
  ConsoleSnapshot,
  NetworkSnapshot,
  PerformanceSnapshot,
};
