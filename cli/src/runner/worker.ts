import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import type { Browser, BrowserContext, Page } from "playwright";
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
  StepResult,
  TestResult,
} from "../executor/types.js";
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

const runOneTest = async (
  test: RegisteredTest,
  registry: FileRegistry,
  config: WorkerStartConfig,
  browser: Browser,
): Promise<TestResult> => {
  const start = performance.now();
  const safeName = sanitizeName(test.name || `test-${test.ordinal}`);
  const testDir = path.join(config.outputDir, `${safeName}-${test.ordinal}`);
  await mkdir(testDir, { recursive: true });

  const merged = { ...registry.fileUse, ...test.use };
  const viewport = merged.viewport ?? config.viewport ?? { width: 1280, height: 720 };
  const effectiveTimeout = merged.timeout ?? config.timeout;
  const effectiveHardTimeout =
    merged.hardTimeout ?? (merged.timeout !== undefined ? merged.timeout : config.hardTimeout);
  // Precedence: CLI flag > test.use override > viewport. Earlier draft had
  // the operands reversed — see velvety-finding-beacon.md §B8 / Codex round 1 #6.
  const videoSize = config.videoSize ?? merged.videoSize ?? viewport;

  const context: BrowserContext = await browser.newContext({
    viewport,
    ...(config.video ? { recordVideo: { dir: testDir, size: videoSize } } : {}),
  });
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

  const artifactConfig: ArtifactRuntimeConfig = {
    fullPageScreenshots: config.artifact.fullPageScreenshots,
    visualSettle: config.observability.forceAll ? OBSERVABILITY_SETTLE_PROFILE : DISABLED_SETTLE,
    blankFrameDetection: config.artifact.blankFrameDetection,
    writeSidecars: config.artifact.writeSidecars,
  };

  const ctx = new ExecutionContext(
    page,
    config.baseUrl ?? merged.url ?? "",
    testDir,
    path.dirname(registry.file),
    undefined,
    undefined,
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
    }
  } catch (err) {
    result.status = "failed";
    testError = err instanceof Error ? err.message : String(err);
  } finally {
    if (ceilingTimer) clearTimeout(ceilingTimer);
  }

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

  result.duration_ms = Math.round(performance.now() - start);
  if (testError) {
    result.status = "failed";
    result.steps.push({
      command: "test",
      args: { name: test.name },
      status: "failed",
      duration_ms: result.duration_ms,
      error: testError,
    });
  } else if (test.skip) {
    result.status = "passed";
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
