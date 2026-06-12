import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { OUTPUT_DIR_DEFAULT, PRODUCT_NAME } from "../constants.js";
import { loadConfig } from "../config/loader.js";
import type { skepticConfig } from "../config/schema.js";
import { getDeviceProfile } from "../config/device-profiles.js";
import { detectCI } from "../utils/ci-detect.js";
import { logger, setLogLevel } from "../utils/logger.js";
import type { Reporter, RunSummary } from "../reporter/types.js";
import { ConsoleReporter } from "../reporter/console-reporter.js";
import type { InkReporter } from "../reporter/ink-reporter.js";
import type { RunTuiHandle } from "../ui/render.js";
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
  /** `--platform android` drives an adb device instead of a browser. */
  platform?: "web" | "android";
  /** `--target <serial>` selects the device/emulator for --platform android. */
  target?: string;
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
  trace?: boolean;
  har?: boolean;
  observability?: boolean;
  fullPageScreenshot?: boolean;
  visualSettle?: boolean;
  blankFrameDetection?: "off" | "warn" | "fail";
  observabilityWriteSidecars?: boolean;
  /** Discover specs without running them. */
  list?: boolean;
  /** Tag filter — multiple `--tag foo --tag bar` accumulates. */
  tag?: string[];
  /** `-t/--grep <substring>` — run only tests whose name contains this substring. */
  grep?: string;
  env?: string[];
  /**
   * Internal flag used by `skeptic tui`: prefer Ink and inject the console
   * reporter even when config or CLI reporter flags only request file outputs.
   */
  forceTui?: boolean;
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

export const buildWorkerConfig = (
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
    // Soft per-action timeout and the hard per-test ceiling are INDEPENDENT. A soft
    // `--timeout` must NOT silently become the hard kill ceiling — hardTimeout falls back to
    // its own config default, never to the soft timeout. (Mirrors the per-test merge in worker.ts.)
    hardTimeout: opts.hardTimeout ?? defaults.browser.timeout,
    outputDir: opts.output ?? defaults.output.dir ?? OUTPUT_DIR_DEFAULT,
    envOverrides,
    observability: {
      forceAll: observabilityFlag,
      consoleRedaction: defaults.observability.consoleRedaction ?? true,
      networkCaptureLimit: defaults.observability.networkCaptureLimit,
      duplicateWindowMs: defaults.observability.duplicateWindowMs,
      consoleCaptureLimit: defaults.observability.consoleCaptureLimit ?? 200,
      // --observability assembles the richest profile available. When the
      // optional IBM engine is not installed, the collector emits one info
      // line and falls back to axe-only.
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
    // Full-page failure.png on test failure. Driven by config (default true); honor an explicit
    // `false` so `screenshotOnFailure: false` in skeptic.config suppresses the capture.
    screenshotOnFailure: defaults.execution.screenshotOnFailure,
    video: opts.video ?? false,
    trace: opts.trace ?? false,
    har: opts.har ?? false,
    headed: opts.headed ?? !defaults.browser.headless,
    browserEngine: defaults.browser.engine,
    viewport,
    retries: opts.retries ?? defaults.execution.retries,
  };

  // Concurrency: only forward `parallel` when the user explicitly passed `--parallel`. Left
  // undefined, the runner auto-picks min(specFileCount, ceil(cores/2)) so multi-file runs use
  // the machine without oversubscribing. An explicit `--parallel` always wins.
  if (typeof opts.parallel === "number") workerConfig.parallel = opts.parallel;

  // `--visual-settle` / `--no-visual-settle` drive the pre-screenshot settle pipeline
  // independently of `--observability`. When the flag is omitted (undefined) the worker falls
  // back to observability.forceAll, preserving prior behavior. An explicit `false` disables
  // settling even under `--observability`.
  if (typeof opts.visualSettle === "boolean") workerConfig.visualSettle = opts.visualSettle;

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
  if (opts.platform === "android") {
    workerConfig.platform = "android";
    if (opts.target) workerConfig.target = opts.target;
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
  opts: {
    verbose?: boolean;
    concurrency?: number;
    notifications?: skepticConfig["notifications"];
    runUrl?: string;
    useInkTui?: boolean;
  },
): Promise<{ reporters: Reporter[]; inkReporter?: InkReporter }> => {
  const reporters: Reporter[] = [];
  let inkReporter: InkReporter | undefined;
  const seen = new Set<string>();
  for (const fmt of formats) {
    if (seen.has(fmt)) continue;
    seen.add(fmt);
    switch (fmt) {
      case "console":
        if (opts.useInkTui) {
          const mod = await import("../reporter/ink-reporter.js");
          inkReporter = new mod.InkReporter();
          reporters.push(inkReporter);
        } else {
          reporters.push(
            new ConsoleReporter({
              verbose: opts.verbose ?? false,
              concurrency: opts.concurrency ?? 1,
            }),
          );
        }
        break;
      case "json": {
        const { JsonReporter } = await import("../reporter/json-reporter.js");
        reporters.push(new JsonReporter(outputDir, { silent: opts.useInkTui }));
        break;
      }
      case "junit": {
        const { JUnitReporter } = await import("../reporter/junit-reporter.js");
        reporters.push(new JUnitReporter(outputDir, { silent: opts.useInkTui }));
        break;
      }
      case "html": {
        const { HtmlReporter } = await import("../reporter/html-reporter.js");
        reporters.push(new HtmlReporter(outputDir, { silent: opts.useInkTui }));
        break;
      }
      default:
        logger.warn(`Unknown reporter format: ${fmt}`);
    }
  }
  if (reporters.length === 0) {
    if (opts.useInkTui) {
      const mod = await import("../reporter/ink-reporter.js");
      inkReporter = new mod.InkReporter();
      reporters.push(inkReporter);
    } else {
      reporters.push(new ConsoleReporter({ verbose: opts.verbose ?? false }));
    }
  }
  if (opts.notifications?.slack) {
    const { SlackReporter } = await import("../reporter/slack-reporter.js");
    reporters.push(new SlackReporter(opts.notifications.slack, opts.runUrl));
  }
  if (opts.notifications?.webhook) {
    const { WebhookReporter } = await import("../reporter/webhook-reporter.js");
    reporters.push(new WebhookReporter(opts.notifications.webhook, opts.runUrl));
  }
  return inkReporter ? { reporters, inkReporter } : { reporters };
};

const resolveRunUrl = (): string | undefined => {
  if (process.env["SKEPTIC_RUN_URL"]) return process.env["SKEPTIC_RUN_URL"];
  const server = process.env["GITHUB_SERVER_URL"];
  const repo = process.env["GITHUB_REPOSITORY"];
  const runId = process.env["GITHUB_RUN_ID"];
  if (server && repo && runId) return `${server}/${repo}/actions/runs/${runId}`;
  return undefined;
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

const printRunSummary = (summary: RunSummary): void => {
  logger.raw("");
  logger.raw(chalk.bold(`  ${PRODUCT_NAME} Results`));
  logger.raw(chalk.dim("  " + "-".repeat(40)));
  const parts: string[] = [];
  if (summary.passed > 0) parts.push(chalk.green(`${summary.passed} passed`));
  if (summary.failed > 0) parts.push(chalk.red(`${summary.failed} failed`));
  parts.push(`${summary.total} total`);
  logger.raw(`  ${parts.join(chalk.dim(", "))}`);
  logger.raw(`  ${chalk.dim(`Duration: ${formatDuration(summary.duration_ms)}`)}`);
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

const shouldUseInkTui = (
  formats: string[],
  opts: RunCommandOptions,
  isCI: boolean,
): boolean => {
  if (opts.watch || opts.ci) return false;
  if (!opts.forceTui) return false;
  if (isCI) return false;
  if (process.env["SKEPTIC_DISABLE_INK_TUI"] === "1") return false;
  if (process.env["TERM"] === "dumb") return false;
  if (!process.stdout.isTTY || !process.stdin.isTTY) return false;
  return formats.includes("console");
};

const ensureConsoleReporter = (formats: string[]): string[] =>
  formats.includes("console") ? formats : ["console", ...formats];

// `skeptic run` ALWAYS writes results.json — it's the core agent-loop contract (SKILL.md tells
// agents to read results.json after a run). If the resolved reporter set doesn't already include
// the json reporter, append it. Under the Ink TUI the json reporter is created `silent` so it
// still writes the file without printing.
export const ensureJsonReporter = (formats: string[]): string[] =>
  formats.includes("json") ? formats : [...formats, "json"];

/**
 * Process exit code for a `run`. Interrupt (Ctrl-C) → 130; a run that discovered/executed zero
 * tests → 1 (an empty suite must not read as success for CI/agents); otherwise 1 on any failure,
 * else 0.
 *
 * Sharding exception: a sharded run (`--shard-split`/`--shard-all`) whose OWN slice is empty
 * because the discovered tests were distributed to other shards is NOT a failure. CI matrices
 * routinely over-provision shards (e.g. `--shard-split 8` over 5 tests, or an out-of-range
 * `--shard-index`); the tail shards legitimately get nothing and must exit 0. Only a run that
 * discovered no tests at all still exits 1 — so `shard.active` alone is not enough, the suite
 * must have produced `discoveredTestCount > 0` before sharding partitioned them away.
 */
export const resolveRunExitCode = (
  interrupted: boolean,
  summary: { total: number; failed: number },
  shard?: { active: boolean; discoveredTestCount: number },
): number => {
  if (interrupted) return 130;
  if (summary.total === 0) {
    return shard?.active && shard.discoveredTestCount > 0 ? 0 : 1;
  }
  return summary.failed > 0 ? 1 : 0;
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
    let discoveryErrors = 0;
    let listedTests = 0;
    for (const m of manifests) {
      const rel = path.relative(process.cwd(), m.file);
      if (m.error) {
        discoveryErrors += 1;
        logger.warn(`  ${chalk.red("✗")} ${rel} — ${m.error.message}`);
        continue;
      }
      listedTests += m.tests.length;
      logger.raw(`  ${chalk.cyan(rel)} (${m.tests.length} test${m.tests.length === 1 ? "" : "s"})`);
      for (const t of m.tests) {
        const flag = t.skip ? chalk.yellow(" [skip]") : t.only ? chalk.green(" [only]") : "";
        logger.raw(`    ${chalk.dim(`#${t.ordinal}`)} ${t.name}${flag}`);
      }
    }
    // A `--list` that hit a discovery error (syntax error, top-level throw) or found nothing
    // must exit non-zero so CI and agents don't treat a broken/empty suite as success.
    if (discoveryErrors > 0) {
      logger.error(
        `${discoveryErrors} spec file${discoveryErrors === 1 ? "" : "s"} failed to load during discovery.`,
      );
      process.exitCode = 1;
    } else if (listedTests === 0) {
      logger.error(
        `No tests found matching ${Array.isArray(effectivePatterns) ? effectivePatterns.join(", ") : effectivePatterns}`,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (opts.shardSplit !== undefined && opts.shardAll !== undefined) {
    console.error("--shard-split and --shard-all are mutually exclusive.");
    process.exit(2);
  }

  const configuredReporterFormats = ensureJsonReporter(
    opts.reporter ?? config.output.reporters,
  );
  const reporterFormats = opts.forceTui
    ? ensureConsoleReporter(configuredReporterFormats)
    : configuredReporterFormats;
  const useInkTui = shouldUseInkTui(reporterFormats, opts, isCI);

  const workerConfig = buildWorkerConfig(opts, config, envOverrides);
  if (isCI) workerConfig.headed = false;

  // PERF: run the daemon pre-warm (a child-process spawn + socket handshake — often the slowest
  // fixed cost in a small run) concurrently with reporter setup (dynamic imports). The two are
  // independent: pre-warm only needs the already-built `workerConfig`, and reporters never touch
  // the daemon. `Promise.all` settles both before `runSpecs` launches workers that connect to the
  // BrowserServer.
  //
  // Pre-warm MUST run from the main process so `process.argv[1]` resolves to `dist/skeptic.mjs`.
  // Spawning from inside a worker_thread would resolve to `dist/worker.mjs` and the spawned
  // daemon would hang on a parentPort message that never arrives. When pre-warm fails
  // (spawn-timeout, version mismatch, etc.) it resolves `false` and we propagate `noDaemon: true`
  // so workers fall back to fresh launches.
  const [{ reporters, inkReporter }, prewarmed] = await Promise.all([
    createReporters(reporterFormats, outputDir, {
      verbose: opts.verbose ?? config.output.verbose,
      concurrency: opts.parallel ?? config.execution.parallel ?? 1,
      notifications: config.notifications,
      runUrl: resolveRunUrl(),
      useInkTui,
    }),
    // The Android path uses no browser, so skip the BrowserServer pre-warm entirely.
    opts.platform === "android"
      ? Promise.resolve(false)
      : prewarmDaemonIfNeeded(process.argv, {
          engine: workerConfig.browserEngine,
          headed: workerConfig.headed,
          cliVersion: __SKEPTIC_CLI_VERSION__,
          noDaemon: opts.daemon === false,
          ...(typeof opts.daemonIdleTimeout === "number"
            ? { idleTimeoutSeconds: opts.daemonIdleTimeout }
            : {}),
        }),
  ]);

  // Android runs never touch the browser daemon; keep workers off the connect path.
  if (opts.platform === "android") workerConfig.noDaemon = true;

  if (!prewarmed && opts.daemon !== false) {
    workerConfig.noDaemon = true;
  }

  // Ctrl-C handling for the non-TUI path: a single SIGINT aborts the run so in-flight workers
  // are terminated and the reporters still fire onRunComplete (partial results.json is written).
  // A second SIGINT force-exits. In TUI mode Ink consumes Ctrl-C as a keypress (raw mode), so
  // this process-level handler stays dormant and `onAbort` drives the exit instead.
  const abortController = new AbortController();
  let interrupted = false;
  const onInterrupt = (): void => {
    if (interrupted) {
      process.exit(130);
    }
    interrupted = true;
    logger.warn("\nInterrupted — stopping workers and writing partial results…");
    abortController.abort();
  };
  process.on("SIGINT", onInterrupt);

  const shardIndex = opts.shardIndex ?? Number(process.env["SKEPTIC_SHARD_INDEX"] ?? "");
  // A non-finite or non-positive index (unset env, garbage) falls back to shard 1. An index that
  // exceeds the shard count is left as-is on purpose: it produces a legitimately-empty slice that
  // the exit-code logic below treats as success, not the misleading "No tests found" failure.
  const resolvedShardIndex = Number.isFinite(shardIndex) && shardIndex > 0 ? shardIndex : 1;
  // Tag each result with its shard so the junit/webhook reporters and the TUI can
  // label `[shard N]`. Only the partitioning flags make this a sharded run; without
  // them the index is meaningless and must stay undefined.
  if (opts.shardSplit !== undefined || opts.shardAll !== undefined) {
    workerConfig.shardId = resolvedShardIndex;
  }
  const runOptions = {
    patterns: effectivePatterns,
    reporters,
    config: workerConfig,
    bail: opts.bail ?? config.execution.bail,
    signal: abortController.signal,
    ...(opts.tag ? { tagFilter: opts.tag } : {}),
    ...(opts.grep ? { nameFilter: [opts.grep] } : {}),
    ...(opts.shardSplit !== undefined
      ? { shardSplit: { count: opts.shardSplit, index: resolvedShardIndex } }
      : {}),
    ...(opts.shardAll !== undefined
      ? { shardAll: { count: opts.shardAll, index: resolvedShardIndex } }
      : {}),
  };

  let tui: RunTuiHandle | undefined;
  if (inkReporter) {
    const { renderRunTui } = await import("../ui/render.js");
    tui = renderRunTui(inkReporter, {
      onAbort: () => {
        tui?.unmount();
        process.exit(130);
      },
      onQuit: () => {
        tui?.unmount();
      },
      alternateScreen: process.env["SKEPTIC_TUI_ALT_SCREEN"] !== "0",
    });
  } else {
    logger.info(`${PRODUCT_NAME} — running ${chalk.cyan(Array.isArray(effectivePatterns) ? effectivePatterns.join(", ") : effectivePatterns)}`);
  }

  const outcome = await runSpecs(runOptions).finally(() => {
    process.removeListener("SIGINT", onInterrupt);
  });
  if (tui) {
    if (interrupted) {
      // Aborted mid-run — tear the TUI down immediately instead of waiting for `q`.
      tui.unmount();
    } else {
      // Interactive run: keep the ResultsScreen mounted so the user can read per-failure detail
      // and use its q/v/a keybindings. `onQuit` (pressing q) unmounts, which resolves
      // waitUntilExit. The old 120ms-then-unmount made the ResultsScreen unreachable.
      await tui.waitUntilExit();
    }
    printRunSummary(outcome.summary);
  }

  printArtifactPaths(outcome.summary, outputDir);

  // Only `--shard-split`/`--shard-all` actually partition the suite. `SKEPTIC_SHARD_INDEX` alone
  // supplies an index for those flags (CI matrices) and never round-robins on its own, so it can't
  // manufacture an empty slice — gating on the flags is the correct "is this a sharded run" signal.
  const isShardedRun = opts.shardSplit !== undefined || opts.shardAll !== undefined;
  // Tests that survived the tag/name filter, counted BEFORE sharding partitioned them. Lets us tell
  // a slice that is empty because sharding sent its tests elsewhere (discovered > 0) apart from a
  // genuinely empty / filtered-to-nothing suite (discovered === 0) — a `--tag` that matches nothing
  // therefore still exits 1 even under sharding, because the post-filter count is 0.
  const discoveredTestCount = outcome.discoveredCount;

  if (!interrupted && outcome.summary.total === 0) {
    if (isShardedRun && discoveredTestCount > 0) {
      // This shard's slice is legitimately empty: round-robin sharding sent every discovered test
      // to other shards (shards out-number tests, e.g. `--shard-split 8` over 5), or `--shard-index`
      // points past the populated shards. That is success, NOT the "No tests found" failure below.
      const shardCount = opts.shardSplit ?? opts.shardAll;
      const totalSuffix = `${discoveredTestCount} test${discoveredTestCount === 1 ? "" : "s"} total across shards`;
      if (shardCount !== undefined && resolvedShardIndex > shardCount) {
        logger.info(
          `shard index ${resolvedShardIndex} is out of range for ${shardCount} shard${shardCount === 1 ? "" : "s"}; nothing to run (${totalSuffix}).`,
        );
      } else {
        logger.info(`shard ${resolvedShardIndex}/${shardCount} has no tests (${totalSuffix}).`);
      }
    } else {
      // Zero discovered/executed tests is a failure for `run`: CI and agents must not read an
      // empty suite as success. results.json (total: 0) was still written by the json reporter.
      logger.error(
        `No tests found matching ${Array.isArray(effectivePatterns) ? effectivePatterns.join(", ") : effectivePatterns}`,
      );
    }
  }
  process.exitCode = resolveRunExitCode(interrupted, outcome.summary, {
    active: isShardedRun,
    discoveredTestCount,
  });

  if (opts.watch && !isCI && !interrupted) {
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
