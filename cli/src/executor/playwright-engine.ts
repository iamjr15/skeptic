import path, { join } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Browser, BrowserContext, Page } from "playwright";
import { loadPlaywright } from "../utils/playwright-loader.js";
import type {
  ArtifactRuntimeConfig,
  EngineOptions,
  TestInput,
  TestResult,
  StepResult,
  StepProgressCallback,
} from "./types.js";
import { ExecutionContext, DEFAULT_ARTIFACT_CONFIG } from "./context.js";
import { appendWarning } from "./types.js";
import { takeRedactedScreenshot } from "../ai/security.js";
import { logger } from "../utils/logger.js";
import { buildCollectors, type ObservabilityRuntimeConfig } from "../observability/registry.js";
import type {
  Collector,
  CollectorName,
} from "../observability/types.js";
import { AccessibilityCollector } from "../observability/collectors/accessibility-collector.js";
import { awaitVisualSettle } from "./visual-settle.js";
import { writeSidecars } from "./sidecars.js";
import { CURSOR_OVERLAY_SOURCE } from "./cursor-overlay.js";

/** Commands that target an element on the page. recordAction fires only for these
 *  (NOT for navigate, wait, assertVisible, observability snapshots, etc.). The set
 *  is derived from the YAML schema's COMMAND_KEYS — we keep it stable here so the
 *  TS-imperative engine and the proxy share one source of truth. */
const INTERACTION_TARGET_COMMANDS: ReadonlySet<string> = new Set([
  "click",
  "doubleClick",
  "hover",
  "type",
  "select",
  "clearInput",
  "copyTextFrom",
  "randomType",
  "randomEmail",
  "randomNumber",
  "randomPhone",
  "press",
  "scroll",
  "scrollUntilVisible",
]);

export const stepHasInteractionTarget = (command: string): boolean =>
  INTERACTION_TARGET_COMMANDS.has(command);

/** Best-effort target-coordinate lookup. Reads boundingBox with a tight timeout so a
 *  detached/offscreen target never blocks the side-channel. Returns null on any failure. */
export const tryGetTargetCoords = async (
  page: Page,
  step: { args?: unknown },
): Promise<{ x: number; y: number } | null> => {
  const args = step.args as { selector?: string } | undefined;
  const selector = args && typeof args.selector === "string" ? args.selector : null;
  if (!selector) return null;
  try {
    const locator = page.locator(selector);
    const box = await locator.boundingBox({ timeout: 250 }).catch(() => null);
    if (!box) return null;
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  } catch {
    return null;
  }
};

const fireSetCommandLabelOnPage = (page: Page, command: string): void => {
  page
    .evaluate(
      (cmd) => {
        const cursor = (globalThis as unknown as { __skepticCursor?: { setCommandLabel?: (c: string) => void } })
          .__skepticCursor;
        if (cursor && typeof cursor.setCommandLabel === "function") cursor.setCommandLabel(cmd);
      },
      command,
    )
    .catch(() => {
      /* overlay may not be loaded yet (pre-navigate); best-effort fire-and-forget */
    });
};

const fireRecordActionOnPage = (
  page: Page,
  command: string,
  coords: { x: number; y: number } | null,
): void => {
  page
    .evaluate(
      ({ cmd, x, y }) => {
        const cursor = (globalThis as unknown as { __skepticCursor?: { recordAction?: (c: string, x?: number, y?: number) => void } })
          .__skepticCursor;
        if (!cursor || typeof cursor.recordAction !== "function") return;
        if (typeof x === "number" && typeof y === "number") cursor.recordAction(cmd, x, y);
        else cursor.recordAction(cmd);
      },
      { cmd: command, x: coords?.x ?? null, y: coords?.y ?? null },
    )
    .catch(() => {
      /* swallow — page may be closing mid-step */
    });
};

const DEFAULT_OBSERVABILITY_CONFIG: ObservabilityRuntimeConfig = {
  collectors: [],
  networkCaptureLimit: 500,
  duplicateWindowMs: 500,
  accessibilityDualEngine: false,
  accessibilityHtmlSnippetLimit: 500,
  consoleCaptureLimit: 200,
  consoleRedaction: true,
  autoAccessibilityAudit: false,
  accessibilityStandard: "WCAG21AA",
};

export class PlaywrightEngine {
  private browser: Browser | null = null;
  private readonly options: EngineOptions;

  constructor(options: EngineOptions = {}) {
    this.options = options;
  }

  async launch(): Promise<void> {
    const engine = this.options.browserEngine ?? "chromium";
    const pw = await loadPlaywright();
    const launcher = ({ chromium: pw.chromium, firefox: pw.firefox, webkit: pw.webkit })[engine];
    try {
      this.browser = await launcher.launch({
        headless: !this.options.headed,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Executable doesn't exist") || msg.includes("browserType.launch")) {
        throw new Error(
          `Playwright browsers not found. Run: npx playwright install ${engine}`,
        );
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Run one test. The TS-pivot replaces the YAML step-loop with a single
   * `runFn(page, ctx)` invocation; the step-loop's invariants (abortReason,
   * inTeardown, hardTimeout via Promise.race) live on `runAction()` inside the
   * fixture builder. The engine still owns context creation, collector wiring,
   * artifact finalization, and trace/video lifecycle.
   *
   * Hooks: per-test beforeEach/afterEach run inside the runFn callback (the
   * runner orchestrates them). Workspace-wide hooks were removed in B0.5/B1.
   */
  async runTest(input: TestInput, onProgress?: StepProgressCallback): Promise<TestResult> {
    if (!this.browser) {
      throw new Error("Browser not launched. Call launch() first.");
    }

    const start = performance.now();
    const videoEnabled = this.options.video ?? false;
    const traceEnabled = this.options.trace ?? false;
    let traceStarted = false;

    const outputDir = this.options.outputDir ?? "./skeptic-output";
    await mkdir(outputDir, { recursive: true });

    const safeName = input.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const testIndex = input.testIndex ?? 0;
    const flowDir = join(outputDir, `${safeName}-${testIndex}`);
    await mkdir(flowDir, { recursive: true });

    const videoTmpDir = videoEnabled
      ? await mkdtemp(join(tmpdir(), `skeptic-video-${safeName}-`))
      : null;

    const viewport = input.viewport ??
      this.options.viewport ??
      (this.options.deviceProfile
        ? { width: this.options.deviceProfile.width, height: this.options.deviceProfile.height }
        : { width: 1280, height: 720 });

    const videoSize = this.options.videoSize ?? viewport;
    const artifactConfig: ArtifactRuntimeConfig =
      this.options.artifactConfig ?? DEFAULT_ARTIFACT_CONFIG;

    const result: TestResult = {
      name: input.name,
      file: input.file,
      status: "passed",
      duration_ms: 0,
      steps: [],
      artifacts: {},
      ...(this.options.shardId !== undefined ? { shardId: this.options.shardId } : {}),
    };
    let testStatus: TestResult["status"] = "passed";

    const contextOptions: Parameters<Browser["newContext"]>[0] = {
      viewport,
      ...(this.options.deviceProfile?.dpr ? { deviceScaleFactor: this.options.deviceProfile.dpr } : {}),
      ...(this.options.deviceProfile?.user_agent ? { userAgent: this.options.deviceProfile.user_agent } : {}),
      ...(videoEnabled && videoTmpDir ? { recordVideo: { dir: videoTmpDir, size: videoSize } } : {}),
    };

    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      context = await this.browser.newContext(contextOptions);

      if (traceEnabled) {
        await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
        traceStarted = true;
      }

      const effectiveTimeout = input.timeout ?? this.options.timeout ?? 30_000;
      context.setDefaultTimeout(effectiveTimeout);

      const useCookies = input.auth === "cookies" || (input.auth !== "none" && this.options.cookies?.enabled);
      if (__SKEPTIC_FEATURE_COOKIE_EXTRACTION__ && useCookies && input.url) {
        try {
          const { extractAndInjectCookies } = await import("../cookies/extractor.js");
          const domain = new URL(input.url).hostname;
          const count = await extractAndInjectCookies(context, domain, {
            browsers: this.options.cookies?.browser ? [this.options.cookies.browser] : undefined,
          });
          logger.debug(`Injected ${count} cookies for ${domain}`);
        } catch (err) {
          logger.warn(`Cookie extraction failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      page = await context.newPage();

      if (videoEnabled) {
        try {
          await context.addInitScript({ content: CURSOR_OVERLAY_SOURCE });
        } catch (err) {
          logger.debug(`Cursor overlay attach failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const observabilityConfig = this.options.observability ?? DEFAULT_OBSERVABILITY_CONFIG;
      const collectors: Collector[] = buildCollectors({
        required: input.requiredCollectors ?? new Set<CollectorName>(),
        configured: observabilityConfig.collectors,
        config: observabilityConfig,
      });

      const ctx = new ExecutionContext(
        page,
        input.url,
        flowDir,
        path.dirname(input.file),
        this.options.aiClient,
        this.options.aiProvider,
        effectiveTimeout,
        collectors,
        artifactConfig,
      );

      for (const collector of collectors) {
        try {
          await collector.attach(page, ctx);
        } catch (err) {
          logger.warn(
            `Collector "${collector.name}" attach failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          ctx.collectors.delete(collector.name);
        }
      }

      if (input.env) {
        for (const [key, value] of Object.entries(input.env)) {
          ctx.setVariable(key, value);
        }
      }

      (ctx as unknown as Record<string, string>).outputDir = flowDir;

      // The TS-pivot run model: invoke the runFn under the runAction boundary
      // (the runner threads it through fixture.runAction). Engine still emits
      // step:start / step:complete events when the runFn elects to instrument
      // its own actions via onProgress.
      if (input.runFn) {
        const startCommand = "test";
        onProgress?.({ type: "step:start", index: 0, total: 1, command: startCommand, args: { name: input.name } });
        // setCommandLabel side-channel — fire after step:start so the tooltip mirrors
        // the dispatched command name. Pass via evaluate argument (no interpolation),
        // .catch swallow inside helper, outside any timeout boundary.
        if (videoEnabled) fireSetCommandLabelOnPage(page, startCommand);
        try {
          await input.runFn(page, ctx);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const stepResult: StepResult = {
            command: "test",
            args: { name: input.name },
            status: "failed",
            duration_ms: Math.round(performance.now() - start),
            error: message,
          };
          appendWarning(stepResult, message);
          result.steps.push(stepResult);
          onProgress?.({ type: "step:complete", index: 0, total: 1, result: stepResult });
          if (this.options.screenshotOnFailure && page && !page.isClosed()) {
            try {
              const screenshotPath = join(flowDir, `failure.png`);
              const buffer = await takeRedactedScreenshot(page);
              await writeFile(screenshotPath, buffer);
              stepResult.screenshot = screenshotPath;
              ctx.addScreenshot(screenshotPath);
            } catch {
              /* best-effort */
            }
          }
          testStatus = "failed";
        }
        if (testStatus === "passed") {
          const stepResult: StepResult = {
            command: "test",
            args: { name: input.name },
            status: "passed",
            duration_ms: Math.round(performance.now() - start),
          };
          result.steps.push(stepResult);
          onProgress?.({ type: "step:complete", index: 0, total: 1, result: stepResult });
          // recordAction side-channel — fires only for interaction-target commands.
          // The synthetic "test" command is NOT in the set, so this is a no-op for
          // the current TS-imperative path; gated for future per-step instrumentation.
          if (
            videoEnabled &&
            stepResult.status === "passed" &&
            stepHasInteractionTarget(stepResult.command) &&
            page &&
            !page.isClosed()
          ) {
            const coords = await tryGetTargetCoords(page, stepResult);
            fireRecordActionOnPage(page, stepResult.command, coords);
          }
        }
      }

      // Auto a11y audit (kept from the YAML-engine path) — runs after runFn,
      // before collector teardown. Skipped if a user-driven audit already populated
      // lastSnapshot via observability.expectAccessible().
      const a11yCollector = ctx.collectors.get("accessibility");
      const autoAuditEnabled = observabilityConfig.autoAccessibilityAudit ?? false;
      if (
        a11yCollector instanceof AccessibilityCollector &&
        autoAuditEnabled &&
        ctx.abortReason === null &&
        page &&
        !page.isClosed()
      ) {
        const userAuditRan = (await a11yCollector.snapshot()) !== undefined;
        if (!userAuditRan) {
          try {
            await a11yCollector.audit({
              standard: observabilityConfig.accessibilityStandard ?? "WCAG21AA",
              ...(observabilityConfig.accessibilityImpacts
                ? { impacts: observabilityConfig.accessibilityImpacts }
                : {}),
            });
          } catch (err) {
            logger.warn(
              `Auto a11y audit failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      const metricsMap: Record<string, unknown> = {};
      ctx.inTeardown = true;
      try {
        for (const collector of ctx.collectors.values()) {
          try {
            const snap = await collector.snapshot();
            if (snap !== undefined && snap !== null) metricsMap[collector.name] = snap;
          } catch (err) {
            logger.warn(
              `Collector "${collector.name}" snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        for (const collector of ctx.collectors.values()) {
          try {
            await collector.detach();
          } catch (err) {
            logger.warn(
              `Collector "${collector.name}" detach failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } finally {
        ctx.inTeardown = false;
      }

      if (artifactConfig.visualSettle.enabled && page && !page.isClosed()) {
        try {
          await awaitVisualSettle(page, ctx, artifactConfig.visualSettle);
        } catch (err) {
          logger.debug(`Pre-video settle failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (ctx.screenshots.length > 0) {
        result.artifacts.screenshots = [...ctx.screenshots];
      }

      if (videoEnabled && page) {
        try {
          const video = page.video();
          if (video) {
            const destPath = join(flowDir, `${safeName}.webm`);
            await page.close();
            page = null;
            await video.saveAs(destPath);
            if (videoTmpDir) {
              await rm(videoTmpDir, { recursive: true, force: true }).catch(() => {});
            }
            result.artifacts.video = {
              path: destPath,
              width: videoSize.width,
              height: videoSize.height,
            };
            logger.info(`Video saved to ${destPath}`);
          }
        } catch (err) {
          logger.warn(`Video save failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (traceStarted && context) {
        try {
          const tracePath = join(flowDir, `${safeName}.trace.zip`);
          await context.tracing.stop({ path: tracePath });
          result.artifacts.trace = tracePath;
          traceStarted = false;
          logger.info(`Trace saved. View with: npx playwright show-trace ${tracePath}`);
        } catch (err) {
          logger.warn(`Trace save failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      result.status = testStatus;
      result.duration_ms = Math.round(performance.now() - start);
      if (Object.keys(metricsMap).length > 0) result.metrics = metricsMap;

      if (artifactConfig.writeSidecars) {
        await writeSidecars({
          flowDir,
          metrics: metricsMap,
          artifacts: result.artifacts,
        });
      }

      return result;
    } finally {
      if (traceStarted && context) {
        try {
          const fallbackPath = join(flowDir, `${safeName}.trace.zip`);
          await context.tracing.stop({ path: fallbackPath });
        } catch {
          /* best-effort cleanup */
        }
      }
      if (page && !page.isClosed()) {
        await page.close().catch(() => {});
      }
      if (context) {
        await context.close().catch(() => {});
      }
      if (videoTmpDir) {
        await rm(videoTmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
