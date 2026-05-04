import * as fs from "node:fs";
import * as path from "node:path";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import chalk from "chalk";
import { OUTPUT_DIR_DEFAULT, PRODUCT_NAME } from "../constants.js";
import { loadConfig } from "../config/loader.js";
import { getDeviceProfile } from "../config/device-profiles.js";
import { PlaywrightEngine } from "../executor/playwright-engine.js";
import { DEFAULT_ARTIFACT_CONFIG } from "../executor/context.js";
import type { RunSummary, Reporter, TestIdentifier } from "../reporter/types.js";
import { ConsoleReporter } from "../reporter/console-reporter.js";
import { JsonReporter } from "../reporter/json-reporter.js";
import { HtmlReporter } from "../reporter/html-reporter.js";
import { snapshot } from "../api/snapshot.js";
import { takeScreenshot } from "../api/screenshot.js";
import { parseVideoSize } from "./run.js";
import { logger } from "../utils/logger.js";
import type { CollectorName } from "../observability/types.js";

export interface ObserveCommandOptions {
  config?: string;
  headed?: boolean;
  device?: string;
  output?: string;
  wait?: number;
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  fullPage?: boolean;
  video?: boolean;
  videoSize?: string;
  trace?: boolean;
  cookies?: boolean;
  cookiesFrom?: string;
  timeout?: number;
  noTui?: boolean;
}

const timestampSlug = (): string => new Date().toISOString().replace(/[:.]/g, "-");

const safeHost = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/[^a-zA-Z0-9_-]/g, "_") || "page";
  } catch {
    return "page";
  }
};

export const runObserve = async (
  url: string,
  opts: ObserveCommandOptions,
): Promise<void> => {
  const config = loadConfig({
    configPath: opts.config,
    overrides: {},
  });

  const outputDir = opts.output ?? path.join(config.output.dir ?? OUTPUT_DIR_DEFAULT, `observe-${timestampSlug()}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const deviceId = opts.device ?? config.browser.device;
  const deviceProfile = deviceId ? getDeviceProfile(deviceId) : undefined;
  const viewport = deviceProfile
    ? { width: deviceProfile.width, height: deviceProfile.height }
    : config.browser.viewport;
  const engineDeviceProfile = deviceProfile
    ? {
        width: deviceProfile.width,
        height: deviceProfile.height,
        dpr: deviceProfile.dpr,
        user_agent: deviceProfile.userAgent,
      }
    : undefined;

  const videoSize = opts.videoSize ? parseVideoSize(opts.videoSize) : viewport;
  const effectiveTimeout = opts.timeout ?? config.browser.timeout;
  const collectors = new Set<CollectorName>(["performance", "network", "console", "accessibility"]);
  const testName = `observe ${safeHost(url)}`;
  const testFile = `skeptic observe ${url}`;

  const reporters: Reporter[] = [
    ...(opts.noTui ? [] : [new ConsoleReporter()]),
    new JsonReporter(outputDir),
    new HtmlReporter(outputDir),
  ];
  const testIdentifier: TestIdentifier = { name: testName, file: testFile, testIndex: 0 };
  for (const reporter of reporters) {
    reporter.onRunStart?.({
      tests: [{ name: testName, file: testFile, stepCount: 1 }],
      totalTests: 1,
    });
    reporter.onTestStart(testIdentifier);
  }

  const engine = new PlaywrightEngine({
    headed: opts.headed ?? !config.browser.headless,
    timeout: effectiveTimeout,
    outputDir,
    browserEngine: config.browser.engine,
    viewport,
    deviceProfile: engineDeviceProfile,
    video: opts.video ?? true,
    videoSize,
    trace: opts.trace ?? true,
    screenshotOnFailure: true,
    cookies: (opts.cookies ?? config.auth.cookies)
      ? {
          enabled: opts.cookies ?? config.auth.cookies,
          ...(opts.cookiesFrom ? { browser: opts.cookiesFrom } : {}),
        }
      : undefined,
    observability: {
      collectors: [...collectors],
      networkCaptureLimit: config.observability.networkCaptureLimit,
      duplicateWindowMs: config.observability.duplicateWindowMs,
      accessibilityDualEngine: true,
      accessibilityHtmlSnippetLimit: config.observability.accessibilityHtmlSnippetLimit,
      consoleCaptureLimit: config.observability.consoleCaptureLimit,
      consoleRedaction: config.observability.consoleRedaction,
      autoAccessibilityAudit: true,
      accessibilityStandard: config.observability.accessibilityStandard,
      ...(config.observability.accessibilityImpacts
        ? { accessibilityImpacts: config.observability.accessibilityImpacts }
        : {}),
      accessibilityMaxRulesPerImpact: config.observability.accessibilityMaxRulesPerImpact,
    },
    artifactConfig: {
      ...DEFAULT_ARTIFACT_CONFIG,
      fullPageScreenshots: opts.fullPage ?? config.observability.fullPageScreenshots,
      blankFrameDetection: config.observability.blankFrameDetection,
      writeSidecars: true,
    },
  });

  const start = performance.now();
  try {
    await engine.launch();
    const result = await engine.runTest(
      {
        url,
        name: testName,
        file: testFile,
        timeout: effectiveTimeout,
        viewport,
        requiredCollectors: collectors,
        runFn: async (page, ctx) => {
          await page.goto(url, { waitUntil: opts.waitUntil ?? "domcontentloaded" });
          if (opts.wait && opts.wait > 0) await page.waitForTimeout(opts.wait);

          await takeScreenshot(page, ctx, "01-page", {
            fullPage: opts.fullPage ?? config.observability.fullPageScreenshots,
          });
          await takeScreenshot(page, ctx, "02-page-annotated", {
            annotate: true,
            fullPage: opts.fullPage ?? config.observability.fullPageScreenshots,
          });

          const tree = await snapshot(page, ctx, { compact: true });
          const snapshotJson = {
            url: page.url(),
            title: await page.title(),
            yaml: tree.yaml,
            stats: tree.stats,
            refs: [...tree.refs.values()],
          };
          await writeFile(path.join(ctx.testDir, "snapshot.txt"), tree.yaml, "utf-8");
          await writeFile(
            path.join(ctx.testDir, "snapshot.json"),
            JSON.stringify(snapshotJson, null, 2),
            "utf-8",
          );
        },
      },
      (event) => {
        if (event.type === "step:start") {
          for (const reporter of reporters) {
            reporter.onStepStart?.(
              { command: event.command, args: event.args },
              event.index,
              event.total,
              testIdentifier,
            );
          }
        } else {
          for (const reporter of reporters) {
            reporter.onStepComplete(event.result, event.index, event.total, testIdentifier);
          }
        }
      },
    );

    for (const reporter of reporters) reporter.onTestComplete(result, testIdentifier);
    const summary: RunSummary = {
      total: 1,
      passed: result.status === "passed" ? 1 : 0,
      failed: result.status === "passed" ? 0 : 1,
      duration_ms: Math.round(performance.now() - start),
      tests: [result],
    };
    for (const reporter of reporters) await reporter.onRunComplete(summary);

    logger.raw("");
    logger.raw(chalk.bold(`  ${PRODUCT_NAME} observe artifacts`));
    for (const [label, artifactPath] of [
      ["Report", path.join(outputDir, "report.html")],
      ["JSON", path.join(outputDir, "results.json")],
      ["Output", outputDir],
    ] as const) {
      logger.raw(`    ${chalk.dim(label.padEnd(8))} ${chalk.cyan(artifactPath)}`);
    }
    logger.raw("");
    process.exitCode = result.status === "passed" ? 0 : 1;
  } finally {
    await engine.close().catch(() => {});
  }
};
