import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import type { Browser, BrowserContext, Page } from "playwright";
import { getDeviceProfile } from "../config/device-profiles.js";
import type {
  WorkerStartMessage,
  WorkerStartConfig,
  WorkerToMain,
} from "./ipc.js";
import {
  beginRegistration,
  endRegistration,
  type FileRegistry,
  type RegisteredTest,
} from "../api/test.js";
import { buildFixture, type ActionEvent } from "../api/fixture.js";
import { ExecutionContext } from "../executor/context.js";
import { loadPlaywright } from "../utils/playwright-loader.js";
import { buildCollectors } from "../observability/registry.js";
import { AccessibilityCollector } from "../observability/collectors/accessibility-collector.js";
import type { Collector, CollectorName } from "../observability/types.js";
import type {
  ArtifactRuntimeConfig,
  HealingInfo,
  StepResult,
  TestResult,
} from "../executor/types.js";
import { captureAriaSnapshot } from "../executor/aria-snapshot-capture.js";
import { renderSnapshot } from "../commands/snapshot-render.js";
import { writeSidecars } from "../executor/sidecars.js";
import { DEFAULT_ARTIFACT_CONFIG } from "../executor/context.js";
import { OBSERVABILITY_SETTLE_PROFILE, DISABLED_SETTLE } from "../executor/visual-settle.js";
import { CURSOR_OVERLAY_SOURCE } from "../executor/cursor-overlay.js";
import type { ManifestEntry, FileManifest } from "./discover.js";

const post = (msg: WorkerToMain): void => {
  parentPort?.postMessage(msg);
};

const importSpec = async (file: string): Promise<FileRegistry> => {
  const registry = beginRegistration(file);
  try {
    await tsImport(pathToFileURL(file).href, import.meta.url);
  } finally {
    endRegistration();
  }
  return registry;
};

const buildManifestFromRegistry = (registry: FileRegistry): FileManifest => {
  const tests: ManifestEntry[] = registry.tests.map((t) => ({
    id: t.id,
    file: t.file,
    ordinal: t.ordinal,
    name: t.name,
    skip: t.skip,
    only: t.only,
    use: { ...registry.fileUse, ...t.use },
  }));
  return {
    file: registry.file,
    fileUse: { ...registry.fileUse },
    hookCount: {
      beforeEach: registry.beforeEach.length,
      afterEach: registry.afterEach.length,
    },
    tests,
  };
};

const handleDiscover = async (file: string): Promise<void> => {
  try {
    const registry = await importSpec(file);
    const manifest = buildManifestFromRegistry(registry);
    parentPort?.postMessage({ type: "manifest", manifest });
  } catch (err) {
    parentPort?.postMessage({
      type: "error",
      error: {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack ?? "" : "",
      },
    });
  } finally {
    process.exit(0);
  }
};

const sanitizeName = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, "_");

/**
 * Per-file artifact slug. Keying the test directory only by `<sanitizedTestName>-<ordinal>`
 * collides when two spec files each register a test with the same name (e.g. "login") — under
 * `--parallel` they race to write the same dir and overwrite each other. We prefix a slug
 * derived from the spec path: a readable basename plus a short hash of the full absolute path
 * so distinct files never collide, even when basenames match across directories. Deterministic
 * per file, so reporters get stable paths.
 */
const fileSlug = (file: string): string => {
  const base = sanitizeName(path.basename(file).replace(/\.[^./\\]+$/, "")) || "spec";
  const hash = createHash("sha1").update(file).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
};

/**
 * Best-effort full-page failure screenshot. Mirrors the legacy engine: guarded by
 * `screenshotOnFailure` (default on) and a live page. Returns the written path or undefined.
 */
const captureFailureScreenshot = async (
  page: Page,
  testDir: string,
  config: WorkerStartConfig,
): Promise<string | undefined> => {
  if (config.screenshotOnFailure === false) return undefined;
  if (!page || page.isClosed()) return undefined;
  try {
    const screenshotPath = path.join(testDir, "failure.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return screenshotPath;
  } catch {
    return undefined;
  }
};

/** On failure, snapshot the live page's interactive elements + stable
 *  selectorHints so the agent can heal the broken locator. Best-effort. */
const captureHealing = async (page: Page): Promise<HealingInfo | undefined> => {
  if (!page || page.isClosed()) return undefined;
  try {
    const capture = await captureAriaSnapshot(page, "body", {
      viewport: true,
      includeCursorInteractive: true,
      extractLinkHrefs: true,
    });
    const rendered = renderSnapshot(capture, { interactive: true });
    if (rendered.refs.length === 0) return undefined;
    return {
      url: page.url(),
      yaml: rendered.yaml,
      candidates: rendered.refs.slice(0, 25).map((r) => ({
        ref: r.ref,
        role: r.role,
        name: r.name,
        selectorHint: r.selectorHint,
      })),
    };
  } catch {
    return undefined;
  }
};

const runOneTest = async (
  test: RegisteredTest,
  registry: FileRegistry,
  config: WorkerStartConfig,
  browser: Browser,
): Promise<TestResult> => {
  const start = performance.now();

  // Per-run env overrides (--env / config.env) applied to process.env before the test body runs
  // so `process.env.FOO` reads inside the test see them.
  for (const [key, value] of Object.entries(config.envOverrides)) {
    process.env[key] = value;
  }

  const safeName = sanitizeName(test.name || `test-${test.ordinal}`);
  // File-unique dir: prevents same-named tests in different spec files from racing to the same
  // path (and overwriting each other) under --parallel. See `fileSlug`.
  const testDir = path.join(
    config.outputDir,
    `${fileSlug(registry.file)}-${safeName}-${test.ordinal}`,
  );
  await mkdir(testDir, { recursive: true });

  const merged = { ...registry.fileUse, ...test.use };

  // Device profile — per-test `test.use({ device })` overrides the CLI/config device. Supplies the
  // viewport fallback plus userAgent + deviceScaleFactor for the browser context.
  const deviceId = merged.device ?? config.device;
  const deviceProfile = deviceId ? getDeviceProfile(deviceId) : undefined;
  const viewport =
    merged.viewport ??
    (deviceProfile ? { width: deviceProfile.width, height: deviceProfile.height } : undefined) ??
    config.viewport ??
    { width: 1280, height: 720 };

  const effectiveTimeout = merged.timeout ?? config.timeout;
  // Soft per-action timeout (setDefaultTimeout) and the hard kill ceiling are INDEPENDENT. A
  // spec's soft `timeout` must not silently become the hard ceiling — hardTimeout falls back to
  // the run-level config.hardTimeout, never to the soft timeout.
  const effectiveHardTimeout = merged.hardTimeout ?? config.hardTimeout;
  // Precedence: CLI flag > test.use override > viewport. Earlier draft had
  // the operands reversed — see velvety-finding-beacon.md §B8 / Codex round 1 #6.
  const videoSize = config.videoSize ?? merged.videoSize ?? viewport;

  // Base URL so relative `page.goto('/x')` resolves; mirrors the ExecutionContext.baseUrl below.
  const resolvedUrl = config.baseUrl ?? merged.url;

  const harPath = path.join(testDir, `${safeName}.har`);
  const context: BrowserContext = await browser.newContext({
    viewport,
    ...(resolvedUrl ? { baseURL: resolvedUrl } : {}),
    ...(deviceProfile?.dpr ? { deviceScaleFactor: deviceProfile.dpr } : {}),
    ...(deviceProfile?.userAgent ? { userAgent: deviceProfile.userAgent } : {}),
    ...(config.video ? { recordVideo: { dir: testDir, size: videoSize } } : {}),
    ...(config.har ? { recordHar: { path: harPath, content: "embed" } } : {}),
  });

  // Cookie extraction (opt-in). Mirrors the legacy engine: gated behind the build feature flag,
  // needs a resolvable URL to derive the domain, and is best-effort (failures warn, never fail).
  const perTestCookies = merged.cookies;
  const cookiesEnabled =
    config.cookies?.enabled === true ||
    perTestCookies === true ||
    typeof perTestCookies === "object";
  if (__SKEPTIC_FEATURE_COOKIE_EXTRACTION__ && cookiesEnabled && resolvedUrl) {
    try {
      const { extractAndInjectCookies } = await import("../cookies/extractor.js");
      const domain = new URL(resolvedUrl).hostname;
      const browserName =
        typeof perTestCookies === "object" ? perTestCookies.browser : config.cookies?.browser;
      await extractAndInjectCookies(context, domain, {
        ...(browserName ? { browsers: [browserName] } : {}),
      });
    } catch (err) {
      post({
        type: "log",
        level: "warn",
        message: `[skeptic] cookie extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  if (config.trace) {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  }
  if (config.video) {
    // Inject the cursor overlay before the first navigation so it's available the moment
    // the page exists. Failures here are non-fatal (the run continues without overlay).
    try {
      await context.addInitScript({ content: CURSOR_OVERLAY_SOURCE });
    } catch (err) {
      post({
        type: "log",
        level: "warn",
        message: `[skeptic] cursor overlay init script failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  context.setDefaultTimeout(effectiveTimeout);
  const page: Page = await context.newPage();

  // Resolve which collectors to attach: --observability forces all four; otherwise
  // honor `test.use({ collectors: [...] })` (per-test overrides file-level).
  const declared: CollectorName[] = merged.collectors ?? [];
  const required = new Set<CollectorName>();
  if (config.observability.forceAll) {
    required.add("performance");
    required.add("network");
    required.add("console");
    required.add("accessibility");
  }
  for (const c of declared) required.add(c);

  const observabilityConfig = {
    collectors: [...required],
    networkCaptureLimit: config.observability.networkCaptureLimit,
    duplicateWindowMs: config.observability.duplicateWindowMs,
    accessibilityDualEngine: config.observability.accessibilityDualEngine,
    accessibilityHtmlSnippetLimit: config.observability.accessibilityHtmlSnippetLimit,
    consoleCaptureLimit: config.observability.consoleCaptureLimit,
    consoleRedaction: config.observability.consoleRedaction,
    autoAccessibilityAudit: config.observability.autoAccessibilityAudit,
    accessibilityStandard: config.observability.accessibilityStandard,
    accessibilityMaxRulesPerImpact: config.observability.accessibilityMaxRulesPerImpact,
  };

  const collectors: Collector[] = buildCollectors({
    required,
    configured: [],
    config: observabilityConfig,
  });

  // Visual-settle is driven by `--visual-settle` (config.visualSettle) independently of
  // `--observability`. When the flag is unset we fall back to observability.forceAll so the
  // prior behavior is preserved.
  const settleEnabled = config.visualSettle ?? config.observability.forceAll;
  const artifactConfig: ArtifactRuntimeConfig = {
    fullPageScreenshots: config.artifact.fullPageScreenshots,
    visualSettle: settleEnabled ? OBSERVABILITY_SETTLE_PROFILE : DISABLED_SETTLE,
    blankFrameDetection: config.artifact.blankFrameDetection,
    writeSidecars: config.artifact.writeSidecars,
  };

  const ctx = new ExecutionContext(
    page,
    config.baseUrl ?? merged.url ?? "",
    testDir,
    path.dirname(registry.file),
    effectiveTimeout,
    collectors,
    artifactConfig,
  );

  for (const collector of collectors) {
    try {
      await collector.attach(page, ctx);
    } catch (err) {
      post({
        type: "log",
        level: "warn",
        message: `[skeptic] collector ${collector.name} attach failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      ctx.collectors.delete(collector.name);
    }
  }

  const stepResults: StepResult[] = [];
  const onAction = (event: ActionEvent): void => {
    if (event.status === "completed") {
      stepResults.push({
        command: event.label,
        args: {},
        status: "passed",
        duration_ms: event.durationMs ?? 0,
      });
    } else if (event.status === "failed") {
      stepResults.push({
        command: event.label,
        args: {},
        status: "failed",
        duration_ms: event.durationMs ?? 0,
        error: event.error,
      });
    }
    post({
      type: "test:action",
      testId: test.id,
      label: event.label,
      status: event.status,
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.error !== undefined ? { error: event.error } : {}),
    });
  };

  const fixture = buildFixture(page, ctx, { onAction, enableCursorProxy: config.video });

  const result: TestResult = {
    name: test.name,
    file: registry.file,
    testIndex: test.ordinal,
    status: "passed",
    duration_ms: 0,
    steps: stepResults,
    artifacts: {},
    ...(config.shardId !== undefined ? { shardId: config.shardId } : {}),
  };

  // Hard-timeout ceiling — Promise.race against a Node-side timer. Hard-kill via
  // worker.terminate() lives in the main process; this race is the soft ceiling
  // that gives afterEach a chance to run before the kill.
  let ceilingTimer: NodeJS.Timeout | undefined;
  const ceiling = new Promise<"hard-timeout">((resolve) => {
    ceilingTimer = setTimeout(() => {
      ctx.abortReason = `test timeout exceeded (${effectiveHardTimeout}ms)`;
      page.context().close().catch(() => {});
      resolve("hard-timeout");
    }, effectiveHardTimeout);
  });

  let testError: string | undefined;
  let failureScreenshot: string | undefined;
  try {
    for (const hook of registry.beforeEach) {
      await fixture.runAction("beforeEach", () => Promise.resolve(hook.fn(fixture)));
    }
    const outcome = await Promise.race([
      Promise.resolve(test.skip ? undefined : registry.tests[test.ordinal]?.fn(fixture)).then(() => "ok" as const),
      ceiling,
    ]);
    if (outcome === "hard-timeout") {
      result.status = "failed";
      testError = ctx.abortReason ?? `test timeout exceeded (${effectiveHardTimeout}ms)`;
      // The ceiling already closed the context, so this usually no-ops — but it's the right
      // place to try in case the page is still live.
      failureScreenshot = await captureFailureScreenshot(page, testDir, config);
    }
  } catch (err) {
    result.status = "failed";
    testError = err instanceof Error ? err.message : String(err);
    // Capture before teardown closes the context — the page is still live here.
    failureScreenshot = await captureFailureScreenshot(page, testDir, config);
    const healing = await captureHealing(page);
    if (healing) result.healing = healing;
  } finally {
    if (ceilingTimer) clearTimeout(ceilingTimer);
  }
  if (failureScreenshot) ctx.addScreenshot(failureScreenshot);

  // afterEach with inTeardown=true so the abort gate doesn't short-circuit teardown
  ctx.inTeardown = true;
  try {
    for (const hook of registry.afterEach) {
      try {
        await fixture.runAction("afterEach", () => Promise.resolve(hook.fn(fixture)));
      } catch (err) {
        post({
          type: "log",
          level: "warn",
          message: `[skeptic] afterEach failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  } finally {
    ctx.inTeardown = false;
  }

  // Auto a11y audit before collector snapshots. `--observability` yields an
  // accessibility metric even when the spec did not explicitly call
  // observability.expectAccessible().
  const a11yCollector = ctx.collectors.get("accessibility");
  if (
    a11yCollector instanceof AccessibilityCollector &&
    observabilityConfig.autoAccessibilityAudit &&
    ctx.abortReason === null &&
    !page.isClosed()
  ) {
    const userAuditRan = (await a11yCollector.snapshot()) !== undefined;
    if (!userAuditRan) {
      try {
        await a11yCollector.audit({
          standard: observabilityConfig.accessibilityStandard,
        });
      } catch (err) {
        post({
          type: "log",
          level: "warn",
          message: `[skeptic] auto a11y audit failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  // Snapshot collectors before context close — collectors lose their wiring once the page goes.
  const metricsMap: Record<string, unknown> = {};
  for (const collector of ctx.collectors.values()) {
    try {
      const snap = await collector.snapshot();
      if (snap !== undefined && snap !== null) metricsMap[collector.name] = snap;
    } catch (err) {
      post({
        type: "log",
        level: "warn",
        message: `[skeptic] collector ${collector.name} snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  for (const collector of ctx.collectors.values()) {
    try {
      await collector.detach();
    } catch {
      /* best-effort */
    }
  }

  if (config.trace) {
    try {
      const tracePath = path.join(testDir, `${safeName}.trace.zip`);
      await context.tracing.stop({ path: tracePath });
      result.artifacts.trace = tracePath;
    } catch {
      /* best-effort */
    }
  }
  if (Object.keys(metricsMap).length > 0) result.metrics = metricsMap;
  if (ctx.screenshots.length > 0) result.artifacts.screenshots = [...ctx.screenshots];

  if (artifactConfig.writeSidecars && Object.keys(metricsMap).length > 0) {
    await writeSidecars({
      testDir,
      metrics: metricsMap,
      artifacts: result.artifacts,
      observabilityConfig,
    });
  }

  // Flush the video before closing the context. Playwright's `connect()` path
  // (daemon mode) records server-side and does NOT automatically flush to the
  // client-supplied `recordVideo.dir` absolute path. Closing the page first
  // forces the BrowserServer to finalize the stream; `video.saveAs(...)` then
  // copies the file to `testDir/<safeName>.webm` which the test reporter
  // expects. The `--no-daemon` path also benefits — saveAs is idempotent.
  if (config.video) {
    try {
      const video = page.video();
      if (video) {
        const destPath = path.join(testDir, `${safeName}.webm`);
        await page.close().catch(() => {});
        await video.saveAs(destPath);
        result.artifacts.video = {
          path: destPath,
          width: videoSize.width,
          height: videoSize.height,
        };
      }
    } catch (err) {
      post({
        type: "log",
        level: "warn",
        message: `[skeptic] video save failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  await context.close().catch(() => {});

  // HAR is flushed to disk by `context.close()`; attach it once the file exists.
  if (config.har) {
    try {
      if (existsSync(harPath)) result.artifacts.har = harPath;
    } catch {
      /* best-effort */
    }
  }

  result.duration_ms = Math.round(performance.now() - start);
  if (testError) {
    result.status = "failed";
    result.steps.push({
      command: "test",
      args: { name: test.name },
      status: "failed",
      duration_ms: result.duration_ms,
      error: testError,
      ...(failureScreenshot ? { screenshot: failureScreenshot } : {}),
    });
  } else if (test.skip) {
    result.status = "passed";
    result.skipped = true;
    result.steps.push({
      command: "test",
      args: { name: test.name },
      status: "skipped",
      duration_ms: 0,
    });
  } else {
    result.steps.push({
      command: "test",
      args: { name: test.name },
      status: "passed",
      duration_ms: result.duration_ms,
    });
  }
  return result;
};

const handleExecute = async (start: WorkerStartMessage): Promise<void> => {
  let registry: FileRegistry | null = null;
  try {
    registry = await importSpec(start.file);
  } catch (err) {
    post({
      type: "fatal",
      message: err instanceof Error ? err.message : String(err),
      ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
    });
    process.exit(0);
    return;
  }

  const allowSet = new Set(start.allowlist);
  const finished: string[] = [];

  let pw: Awaited<ReturnType<typeof loadPlaywright>>;
  try {
    pw = await loadPlaywright();
  } catch (err) {
    post({
      type: "fatal",
      message: `playwright load failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(0);
    return;
  }
  const launcher = pw[start.config.browserEngine];
  let browser: Browser;
  let daemonDisconnect: (() => Promise<void>) | null = null;
  try {
    if (start.config.noDaemon) {
      // --no-daemon path: fresh browser launch per worker.
      browser = await launcher.launch({ headless: !start.config.headed });
    } else {
      // Daemon path: connect to (or auto-spawn) the persistent BrowserServer.
      // The worker still owns its own BrowserContext (via newContext below) so
      // refs/cookies/storage stay isolated per test (plan §B10 invariants 1-2).
      const { connectDaemon } = await import("../daemon/client.js");
      const conn = await connectDaemon({
        engine: start.config.browserEngine,
        headed: start.config.headed,
        cliVersion: __SKEPTIC_CLI_VERSION__,
        ...(typeof start.config.daemonIdleTimeoutSeconds === "number"
          ? { idleTimeoutSeconds: start.config.daemonIdleTimeoutSeconds }
          : {}),
      });
      browser = conn.browser;
      daemonDisconnect = conn.disconnect;
    }
  } catch (err) {
    post({
      type: "fatal",
      message: `browser launch failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(0);
    return;
  }

  try {
    for (const test of registry.tests) {
      if (!allowSet.has(test.id)) continue;
      post({
        type: "test:start",
        testId: test.id,
        ordinal: test.ordinal,
        name: test.name,
        file: registry.file,
        ...(start.config.shardId !== undefined ? { shardId: start.config.shardId } : {}),
      });
      let result: TestResult;
      try {
        result = await runOneTest(test, registry, start.config, browser);
      } catch (err) {
        result = {
          name: test.name,
          file: registry.file,
          status: "failed",
          duration_ms: 0,
          steps: [
            {
              command: "test",
              args: { name: test.name },
              status: "error",
              duration_ms: 0,
              error: err instanceof Error ? err.message : String(err),
            },
          ],
          artifacts: {},
          ...(start.config.shardId !== undefined ? { shardId: start.config.shardId } : {}),
        };
      }
      finished.push(test.id);
      post({
        type: "test:complete",
        testId: test.id,
        ordinal: test.ordinal,
        result,
      });
    }
  } finally {
    // Closing the daemon-connected Browser severs the WebSocket; Playwright's
    // server-side cleans up any contexts we created (plan §B10 invariant 10).
    // For the --no-daemon path, this still closes the locally-launched browser.
    if (daemonDisconnect) {
      await daemonDisconnect().catch(() => {});
    } else {
      await browser.close().catch(() => {});
    }
    post({ type: "file:complete", file: registry.file, finished });
    process.exit(0);
  }
};

const handleStart = async (msg: WorkerStartMessage): Promise<void> => {
  await handleExecute(msg);
};

if (!isMainThread && parentPort) {
  if (workerData?.mode === "discover" && typeof workerData?.file === "string") {
    void handleDiscover(workerData.file as string);
  } else {
    parentPort.on("message", (msg: WorkerStartMessage) => {
      if (msg.type === "start") void handleStart(msg);
    });
    post({ type: "ready" });
  }
}

export { handleDiscover, handleStart, runOneTest };
