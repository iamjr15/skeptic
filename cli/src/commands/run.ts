import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { OUTPUT_DIR_DEFAULT, PRODUCT_NAME } from "../constants.js";
import { loadConfig } from "../config/loader.js";
import { getDeviceProfile } from "../config/device-profiles.js";
import { detectCI } from "../utils/ci-detect.js";
import { logger, setLogLevel } from "../utils/logger.js";
import type { Reporter, RunSummary } from "../reporter/types.js";
import { ConsoleReporter } from "../reporter/console-reporter.js";
import { runSpecs, listSpecs, type WorkerStartConfig } from "../runner/index.js";
import { prewarmDaemonIfNeeded } from "../daemon/auto-spawn.js";

export interface RunCommandOptions {
  config?: string;
  headed?: boolean;
  verbose?: boolean;
  ci?: boolean;
  bail?: boolean;
  retries?: number;
  timeout?: number;
  hardTimeout?: number;
  device?: string;
  reporter?: string[];
  output?: string;
  cookies?: boolean;
  cookiesFrom?: string;
  video?: boolean;
  /** CLI `--video-size <WxH>` — parsed by `parseVideoSize` into a `{width,height}` pair. */
  videoSize?: string;
  watch?: boolean;
  url?: string;
  parallel?: number;
  shardSplit?: number;
  shardAll?: number;
  shardIndex?: number;
  noTui?: boolean;
  trace?: boolean;
  observability?: boolean;
  fullPageScreenshot?: boolean;
  visualSettle?: boolean;
  blankFrameDetection?: "off" | "warn" | "fail";
  observabilityWriteSidecars?: boolean;
  /** Discover specs without running them. */
  list?: boolean;
  /** Tag filter — multiple `--tag foo --tag bar` accumulates. */
  tag?: string[];
  /** Connect to an existing browser over CDP. */
  connect?: string;
  env?: string[];
  /** Best-effort post-run AI failure analysis. */
  analyze?: boolean;
  /**
   * Commander surfaces `--no-daemon` as `daemon: false`. When false,
   * the worker bypasses the persistent BrowserServer daemon and launches a
   * fresh Playwright Browser per worker. When undefined or true, daemon mode is used.
   */
  daemon?: boolean;
  /**
   * Override the spawned-daemon idle timeout in seconds. `0` disables.
   * Default 300 (5 min). Plan §B10 invariant 4.
   */
  daemonIdleTimeout?: number;
}

/**
 * Parse a `--video-size <WxH>` argument into `{ width, height }`. Accepts
 * only `\d+x\d+` (case-insensitive on the separator) with both dimensions
 * positive integers in `[1, 3840]`. Rejects `0x0`, negative values (the
 * regex already excludes the sign character), and oversized resolutions.
 */
export const parseVideoSize = (input: string): { width: number; height: number } => {
  const match = /^(\d+)[xX](\d+)$/.exec(input);
  if (!match) {
    throw new Error(
      `--video-size: expected "<width>x<height>" (e.g. 1920x1080), got "${input}"`,
    );
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  const MAX = 3840;
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error(`--video-size: dimensions must be integers, got "${input}"`);
  }
  if (width < 1 || height < 1 || width > MAX || height > MAX) {
    throw new Error(
      `--video-size: width and height must be within [1, ${MAX}], got ${width}x${height}`,
    );
  }
  return { width, height };
};

const buildWorkerConfig = (
  opts: RunCommandOptions,
  defaults: ReturnType<typeof loadConfig>,
  envOverrides: Record<string, string>,
): WorkerStartConfig => {
  const observabilityFlag = opts.observability ?? false;
  const writeSidecarsFlag = opts.observabilityWriteSidecars ?? false;
  const sidecarsActive =
    writeSidecarsFlag ||
    (observabilityFlag && defaults.observability.defaultsForReports !== "none");

  const deviceId = opts.device ?? defaults.browser.device;
  const deviceProfile = deviceId ? getDeviceProfile(deviceId) : undefined;
  const viewport = deviceProfile
    ? { width: deviceProfile.width, height: deviceProfile.height }
    : defaults.browser.viewport;

  const workerConfig: WorkerStartConfig = {
    timeout: opts.timeout ?? defaults.browser.timeout,
    hardTimeout: opts.hardTimeout ?? opts.timeout ?? defaults.browser.timeout,
    outputDir: opts.output ?? defaults.output.dir ?? OUTPUT_DIR_DEFAULT,
    envOverrides,
    observability: {
      forceAll: observabilityFlag,
      consoleRedaction: defaults.observability.consoleRedaction ?? true,
      networkCaptureLimit: defaults.observability.networkCaptureLimit,
      duplicateWindowMs: defaults.observability.duplicateWindowMs,
      consoleCaptureLimit: defaults.observability.consoleCaptureLimit ?? 200,
      // --observability assembles the richest profile we can run; on the npm install path
      // the `accessibility-checker-engine` optional peer is present and the collector
      // dual-runs axe + IBM. On slim binaries the peer can't be loaded — the collector
      // emits a single info line and falls back to axe-only.
      accessibilityDualEngine:
        observabilityFlag || defaults.observability.accessibilityDualEngine,
      accessibilityHtmlSnippetLimit: defaults.observability.accessibilityHtmlSnippetLimit,
      accessibilityStandard: defaults.observability.accessibilityStandard ?? "WCAG21AA",
      autoAccessibilityAudit:
        observabilityFlag || (defaults.observability.autoAccessibilityAudit ?? false),
      accessibilityMaxRulesPerImpact:
        defaults.observability.accessibilityMaxRulesPerImpact ?? 100,
    },
    artifact: {
      fullPageScreenshots:
        opts.fullPageScreenshot ?? observabilityFlag ?? defaults.observability.fullPageScreenshots,
      blankFrameDetection:
        opts.blankFrameDetection ??
        (observabilityFlag ? "fail" : defaults.observability.blankFrameDetection ?? "warn"),
      writeSidecars: sidecarsActive,
    },
    video: opts.video ?? false,
    trace: opts.trace ?? false,
    headed: opts.headed ?? !defaults.browser.headless,
    browserEngine: defaults.browser.engine,
    viewport,
    retries: opts.retries ?? defaults.execution.retries,
    parallel: opts.parallel ?? defaults.execution.parallel ?? 1,
  };

  if (opts.url ?? defaults.url) {
    workerConfig.baseUrl = opts.url ?? defaults.url;
  }
  if (deviceId) workerConfig.device = deviceId;
  if (opts.videoSize) {
    workerConfig.videoSize = parseVideoSize(opts.videoSize);
  }
  if (opts.cookies ?? defaults.auth.cookies) {
    workerConfig.cookies = {
      enabled: opts.cookies ?? defaults.auth.cookies,
      ...(opts.cookiesFrom ? { browser: opts.cookiesFrom } : {}),
    };
  }
  // Daemon plumbing. Commander parses `--no-daemon` as `daemon: false`.
  // When the user passed `--no-daemon`, flip the worker into the direct-launch
  // branch. `--daemon-idle-timeout` is forwarded to a freshly auto-spawned
  // daemon (no effect when daemon is already running).
  if (opts.daemon === false) workerConfig.noDaemon = true;
  if (typeof opts.daemonIdleTimeout === "number") {
    workerConfig.daemonIdleTimeoutSeconds = opts.daemonIdleTimeout;
  }
  return workerConfig;
};

const buildEnvOverrides = (
  opts: RunCommandOptions,
  defaults: ReturnType<typeof loadConfig>,
): Record<string, string> => {
  const env: Record<string, string> = { ...defaults.env };
  if (opts.env) {
    for (const pair of opts.env) {
      const eq = pair.indexOf("=");
      if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return env;
};

const createReporters = async (
  formats: string[],
  outputDir: string,
  opts: { verbose?: boolean; concurrency?: number },
): Promise<Reporter[]> => {
  const reporters: Reporter[] = [];
  const seen = new Set<string>();
  for (const fmt of formats) {
    if (seen.has(fmt)) continue;
    seen.add(fmt);
    switch (fmt) {
      case "console":
        reporters.push(
          new ConsoleReporter({
            verbose: opts.verbose ?? false,
            concurrency: opts.concurrency ?? 1,
          }),
        );
        break;
      case "json": {
        const { JsonReporter } = await import("../reporter/json-reporter.js");
        reporters.push(new JsonReporter(outputDir));
        break;
      }
      case "junit": {
        const { JUnitReporter } = await import("../reporter/junit-reporter.js");
        reporters.push(new JUnitReporter(outputDir));
        break;
      }
      case "html": {
        const { HtmlReporter } = await import("../reporter/html-reporter.js");
        reporters.push(new HtmlReporter(outputDir));
        break;
      }
      default:
        logger.warn(`Unknown reporter format: ${fmt}`);
    }
  }
  if (reporters.length === 0) {
    reporters.push(new ConsoleReporter({ verbose: opts.verbose ?? false }));
  }
  return reporters;
};

const printArtifactPaths = (summary: RunSummary, outputDir: string): void => {
  const tests = summary.tests.filter((t) => {
    const a = t.artifacts ?? {};
    return (
      a.video ||
      a.trace ||
      a.perfTrace ||
      a.accessibilityAudit ||
      (a.screenshots && a.screenshots.length > 0)
    );
  });
  if (tests.length === 0) return;
  logger.raw("");
  logger.raw(chalk.bold("  Artifacts"));
  for (const [label, p] of [
    ["Report", path.join(outputDir, "report.html")],
    ["JSON", path.join(outputDir, "results.json")],
    ["JUnit", path.join(outputDir, "junit.xml")],
  ] as const) {
    if (fs.existsSync(p)) {
      logger.raw(`    ${chalk.dim(label.padEnd(11))} ${chalk.cyan(p)}`);
    }
  }
};

export const runRun = async (
  patterns: string[] | undefined,
  opts: RunCommandOptions,
): Promise<void> => {
  if (opts.verbose) setLogLevel("debug");
  const ciInfo = detectCI();
  const isCI = opts.ci ?? ciInfo.isCI;

  const config = loadConfig({
    configPath: opts.config,
    overrides: {},
  });

  const envOverrides = buildEnvOverrides(opts, config);
  const effectivePatterns = patterns && patterns.length > 0 ? patterns : config.tests;
  const outputDir = opts.output ?? config.output.dir ?? OUTPUT_DIR_DEFAULT;

  if (opts.list) {
    const { manifests } = await listSpecs(effectivePatterns);
    for (const m of manifests) {
      const rel = path.relative(process.cwd(), m.file);
      if (m.error) {
        logger.warn(`  ${chalk.red("✗")} ${rel} — ${m.error.message}`);
        continue;
      }
      logger.raw(`  ${chalk.cyan(rel)} (${m.tests.length} test${m.tests.length === 1 ? "" : "s"})`);
      for (const t of m.tests) {
        const flag = t.skip ? chalk.yellow(" [skip]") : t.only ? chalk.green(" [only]") : "";
        logger.raw(`    ${chalk.dim(`#${t.ordinal}`)} ${t.name}${flag}`);
      }
    }
    return;
  }

  if (opts.shardSplit !== undefined && opts.shardAll !== undefined) {
    console.error("--shard-split and --shard-all are mutually exclusive.");
    process.exit(2);
  }

  const reporterFormats = opts.reporter ?? config.output.reporters;
  const reporters = await createReporters(reporterFormats, outputDir, {
    verbose: opts.verbose ?? config.output.verbose,
    concurrency: opts.parallel ?? config.execution.parallel ?? 1,
  });

  const workerConfig = buildWorkerConfig(opts, config, envOverrides);
  if (isCI) workerConfig.headed = false;

  // Pre-warm the daemon from the main process so
  // `process.argv[1]` resolves to `dist/skeptic.mjs`. Spawning from inside a
  // worker_thread would resolve to `dist/worker.mjs` and the spawned daemon
  // would hang on a parentPort message that never arrives. After this gate,
  // the worker-side `connectDaemon` call hits the socket-connectable fast
  // path and never spawns.
  //
  // When pre-warm fails (spawn-timeout, version mismatch, etc.) we propagate
  // `noDaemon: true` to workers so they actually fall back to fresh launches.
  const prewarmed = await prewarmDaemonIfNeeded(process.argv, {
    engine: workerConfig.browserEngine,
    headed: workerConfig.headed,
    cliVersion: __SKEPTIC_CLI_VERSION__,
    noDaemon: opts.daemon === false,
    ...(typeof opts.daemonIdleTimeout === "number"
      ? { idleTimeoutSeconds: opts.daemonIdleTimeout }
      : {}),
  });
  if (!prewarmed && opts.daemon !== false) {
    workerConfig.noDaemon = true;
  }

  const shardIndex = opts.shardIndex ?? Number(process.env["SKEPTIC_SHARD_INDEX"] ?? "");
  const runOptions = {
    patterns: effectivePatterns,
    reporters,
    config: workerConfig,
    bail: opts.bail ?? config.execution.bail,
    ...(opts.tag ? { tagFilter: opts.tag } : {}),
    ...(opts.shardSplit !== undefined
      ? {
          shardSplit: {
            count: opts.shardSplit,
            index: Number.isFinite(shardIndex) && shardIndex > 0 ? shardIndex : 1,
          },
        }
      : {}),
    ...(opts.shardAll !== undefined
      ? {
          shardAll: {
            count: opts.shardAll,
            index: Number.isFinite(shardIndex) && shardIndex > 0 ? shardIndex : 1,
          },
        }
      : {}),
  };

  logger.info(`${PRODUCT_NAME} — running ${chalk.cyan(Array.isArray(effectivePatterns) ? effectivePatterns.join(", ") : effectivePatterns)}`);
  const outcome = await runSpecs(runOptions);

  if (!opts.noTui) {
    printArtifactPaths(outcome.summary, outputDir);
  }

  // --analyze: best-effort post-run AI failure summary. AI client load is gated
  // behind the flag so non-AI runs don't pay the SDK init cost.
  if (opts.analyze && outcome.summary.failed > 0) {
    try {
      const { createAIClient, AIFeatureNotBuiltError } = await import("../ai/client-factory.js");
      const { analyzeFailure } = await import("../ai/assertion-evaluator.js");
      const aiClient = await createAIClient(config.ai);
      if (!aiClient) {
        throw new Error("[analyze] no AI client available — set GEMINI_API_KEY (or your provider equivalent)");
      }
      const failures = outcome.summary.tests.filter((t) => t.status !== "passed");
      for (const test of failures) {
        const failedStep = test.steps.find((s) => s.status !== "passed");
        if (!failedStep?.error) continue;
        try {
          const screenshotBuf = failedStep.screenshot
            ? fs.readFileSync(failedStep.screenshot)
            : undefined;
          if (!screenshotBuf) {
            logger.info(chalk.dim(`[analyze] ${test.name}: ${failedStep.error}`));
            continue;
          }
          const analysis = await analyzeFailure(
            aiClient,
            screenshotBuf,
            failedStep.command,
            failedStep.error,
          );
          logger.info(chalk.cyan(`\n  ${chalk.red("FAIL")} ${test.name}`));
          logger.info(chalk.dim(`  ${analysis}`));
        } catch (err) {
          logger.warn(`[analyze] ${test.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // AIFeatureNotBuiltError comes from slim-build gates — soft-fail with a clear note.
      const code = (err as { name?: string } | undefined)?.name;
      if (code === "AIFeatureNotBuiltError") {
        logger.warn(`[analyze] ${message}`);
      } else {
        logger.warn(`[analyze] AI failure analysis skipped: ${message}`);
      }
    }
  }

  process.exitCode = outcome.summary.failed > 0 ? 1 : 0;

  if (opts.watch && !isCI) {
    const { startWatching } = await import("../runner/watch.js");
    const patternList = Array.isArray(effectivePatterns) ? effectivePatterns : [effectivePatterns];
    logger.info(chalk.dim("Watching for changes... (Ctrl+C to exit)"));
    let inFlight: Promise<unknown> = Promise.resolve();
    const watcher = await startWatching({
      patterns: patternList,
      onChange: async (file) => {
        logger.info(`File changed: ${chalk.cyan(file)}`);
        await inFlight;
        inFlight = runSpecs(runOptions).then((next) => {
          process.exitCode = next.summary.failed > 0 ? 1 : 0;
        });
      },
    });
    process.on("SIGINT", () => {
      void watcher.close();
      process.exit(process.exitCode ?? 0);
    });
    await new Promise(() => {});
  }
};
