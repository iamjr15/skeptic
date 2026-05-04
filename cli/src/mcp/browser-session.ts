import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type {
  Browser,
  BrowserContext,
  BrowserType,
  Locator,
  Page,
} from "playwright";
import type { skepticConfig } from "../config/schema.js";
import { loadConfig } from "../config/loader.js";
import { ExecutionContext } from "../executor/context.js";
import { DISABLED_SETTLE } from "../executor/visual-settle.js";
import { snapshot, type SnapshotTree } from "../api/snapshot.js";
import { captureAnnotatedScreenshot } from "../api/screenshot.js";
import { ConsoleCollector } from "../observability/collectors/console-collector.js";
import { NetworkCollector } from "../observability/collectors/network-collector.js";
import { PerformanceCollector } from "../observability/collectors/performance-collector.js";
import { AccessibilityCollector } from "../observability/collectors/accessibility-collector.js";
import type {
  AccessibilitySnapshot,
  ConsoleSnapshot,
  NetworkSnapshot,
  PerformanceSnapshot,
} from "../observability/types.js";
import { formatPerfTraceMarkdown } from "../reporter/perf-trace-md.js";
import { extractAndInjectCookies } from "../cookies/extractor.js";
import { loadPlaywright } from "../utils/playwright-loader.js";
import { writeJsonResultFile } from "../utils/safe-json.js";
import {
  assertActionAllowed,
  assertUrlAllowed,
  installDomainSafety,
  loadSafetyRuntime,
  type SafetyRuntime,
} from "../safety/policy.js";

export type BrowserWaitUntil = "load" | "domcontentloaded" | "networkidle" | "commit";

type BrowserEngine = "chromium" | "firefox" | "webkit";

export interface BrowserOpenOptions {
  url: string;
  browser?: BrowserEngine;
  headed?: boolean;
  waitUntil?: BrowserWaitUntil;
  cookies?: boolean;
}

export interface BrowserSnapshotOptions {
  interactive?: boolean;
  compact?: boolean;
  selector?: string;
  fullPage?: boolean;
}

export interface BrowserScreenshotOptions {
  mode?: "screenshot" | "annotated" | "snapshot";
  fullPage?: boolean;
  selector?: string;
}

export interface BrowserPlaywrightOptions {
  code: string;
  snapshotAfter?: boolean;
}

export interface BrowserSessionInfo {
  url: string;
  title: string;
  browser: string;
  headed: boolean;
  cookiesInjected: number;
}

interface AttachedCollectors {
  console: ConsoleCollector;
  network: NetworkCollector;
  performance: PerformanceCollector;
  accessibility: AccessibilityCollector;
}

const isEngine = (value: string): value is BrowserEngine =>
  value === "chromium" || value === "firefox" || value === "webkit";

const mkArtifactDir = (cwd: string, cfg: skepticConfig): string =>
  path.resolve(
    cwd,
    cfg.output.dir,
    "mcp-browser",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );

const AsyncFunction = Object.getPrototypeOf(async function () {
  return undefined;
}).constructor as new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>;

export class BrowserMcpSession {
  private readonly cwd: string;
  private cfg: skepticConfig;
  private safetyRuntime: SafetyRuntime;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private executionContext: ExecutionContext | null = null;
  private collectors: AttachedCollectors | null = null;
  private lastSnapshot: SnapshotTree | null = null;
  private artifactDir: string | null = null;
  private consoleOffset = 0;
  private networkOffset = 0;
  private engine: BrowserEngine;
  private headed: boolean;
  private cookiesInjected = 0;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.cfg = loadConfig({ searchCwd: cwd });
    this.safetyRuntime = loadSafetyRuntime(cwd, this.cfg.safety);
    this.engine = this.cfg.browser.engine;
    this.headed = !this.cfg.browser.headless;
  }

  get safety() {
    return this.cfg.safety;
  }

  async open(opts: BrowserOpenOptions): Promise<BrowserSessionInfo> {
    assertActionAllowed(this.safetyRuntime, "browser_open");
    assertUrlAllowed(opts.url, this.safetyRuntime.allowedDomains);
    const requestedEngine: BrowserEngine = opts.browser ?? this.engine;
    if (!isEngine(requestedEngine)) {
      throw new Error(`unsupported browser engine: ${requestedEngine}`);
    }
    const requestedHeaded = opts.headed ?? this.headed;

    if (
      this.page === null ||
      this.context === null ||
      this.browser === null ||
      requestedEngine !== this.engine ||
      requestedHeaded !== this.headed
    ) {
      await this.close();
      await this.launch(requestedEngine, requestedHeaded);
    }

    if (!this.page) throw new Error("browser page was not initialized");

    const shouldInjectCookies = opts.cookies ?? this.cfg.auth.cookies;
    if (shouldInjectCookies) {
      const hostname = new URL(opts.url).hostname;
      this.cookiesInjected = await extractAndInjectCookies(this.context!, hostname, {
        browsers: this.cfg.auth.browsers,
      });
    }

    await this.page.goto(opts.url, {
      waitUntil: opts.waitUntil ?? "load",
      timeout: this.cfg.browser.timeout,
    });
    this.lastSnapshot = null;

    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => ""),
      browser: this.engine,
      headed: this.headed,
      cookiesInjected: this.cookiesInjected,
    };
  }

  async runPlaywright(opts: BrowserPlaywrightOptions): Promise<Record<string, unknown>> {
    assertActionAllowed(this.safetyRuntime, "browser_playwright");
    const page = this.requirePage();
    const context = this.requireContext();
    const browser = this.requireBrowser();
    const fn = new AsyncFunction(
      "page",
      "context",
      "browser",
      "ref",
      `"use strict";\n${opts.code}`,
    );
    const result = await fn(page, context, browser, async (id: string): Promise<Locator> => {
      const rawRef = id.startsWith("@") ? id.slice(1) : id;
      const snap = this.lastSnapshot ?? (await this.captureSnapshot({ interactive: true }));
      return await snap.byRef(rawRef);
    });
    const resultFile = await writeJsonResultFile(result, {
      prefix: "playwright",
      maxStringLength: this.safety.maxOutputChars,
    });
    const out: Record<string, unknown> = { result, resultFile };
    if (opts.snapshotAfter) {
      const snap = await this.captureSnapshot({ interactive: true, compact: true });
      out["snapshot"] = this.publicSnapshot(snap);
    }
    return out;
  }

  async snapshot(opts: BrowserSnapshotOptions = {}): Promise<Record<string, unknown>> {
    const snap = await this.captureSnapshot(opts);
    return this.publicSnapshot(snap);
  }

  async screenshot(opts: BrowserScreenshotOptions): Promise<Record<string, unknown>> {
    assertActionAllowed(this.safetyRuntime, "browser_screenshot");
    if (opts.mode === "snapshot") {
      const snap = await this.captureSnapshot({
        interactive: true,
        compact: true,
        selector: opts.selector,
        fullPage: opts.fullPage,
      });
      return this.publicSnapshot(snap);
    }

    const page = this.requirePage();
    const artifactDir = await this.ensureArtifactDir();
    const fileName = `${opts.mode === "annotated" ? "annotated" : "screenshot"}-${Date.now()}.png`;
    const filePath = path.join(artifactDir, fileName);
    if (opts.mode === "annotated") {
      const result = await captureAnnotatedScreenshot(page, filePath, {
        fullPage: opts.fullPage ?? this.cfg.observability.fullPageScreenshots,
        scope: opts.selector ?? "body",
      });
      return {
        path: filePath,
        annotations: result.annotations ?? [],
        diagnostics: result.diagnostics,
      };
    }
    await page.screenshot({
      path: filePath,
      fullPage: opts.fullPage ?? this.cfg.observability.fullPageScreenshots,
    });
    return { path: filePath };
  }

  async consoleLogs(opts: {
    type?: string;
    clear?: boolean;
  }): Promise<ConsoleSnapshot> {
    assertActionAllowed(this.safetyRuntime, "browser_console_logs");
    const snapshot = await this.requireCollectors().console.snapshot();
    let messages = snapshot.messages.slice(this.consoleOffset);
    if (opts.type) {
      messages = messages.filter((m) => m.type === opts.type);
    }
    if (opts.clear) {
      this.consoleOffset = snapshot.messages.length;
    }
    return {
      messages,
      summary: {
        total: messages.length,
        errorCount: messages.filter((m) => m.type === "error").length,
        warningCount: messages.filter((m) => m.type === "warning").length,
        infoCount: messages.filter((m) => m.type === "info" || m.type === "log").length,
        redactionDisabled: snapshot.summary.redactionDisabled,
      },
    };
  }

  async networkRequests(opts: {
    method?: string;
    url?: string;
    resourceType?: string;
    clear?: boolean;
  }): Promise<NetworkSnapshot> {
    assertActionAllowed(this.safetyRuntime, "browser_network_requests");
    const snapshot = await this.requireCollectors().network.snapshot();
    let requests = snapshot.requests.slice(this.networkOffset);
    if (opts.method) {
      requests = requests.filter((r) => r.method.toUpperCase() === opts.method!.toUpperCase());
    }
    if (opts.url) {
      requests = requests.filter((r) => r.url.includes(opts.url!));
    }
    if (opts.resourceType) {
      requests = requests.filter((r) => r.resourceType === opts.resourceType);
    }
    if (opts.clear) {
      this.networkOffset = snapshot.requests.length;
    }
    return {
      requests,
      issues: snapshot.issues,
    };
  }

  async performanceMetrics(): Promise<Record<string, unknown>> {
    assertActionAllowed(this.safetyRuntime, "browser_performance_metrics");
    const collectors = this.requireCollectors();
    const performance = await collectors.performance.snapshot() as PerformanceSnapshot;
    const network = await collectors.network.snapshot();
    const consoleSnapshot = await collectors.console.snapshot();
    const accessibility = await collectors.accessibility.snapshot() as
      | AccessibilitySnapshot
      | undefined;
    const markdown = formatPerfTraceMarkdown({
      performance,
      network,
      console: consoleSnapshot,
      ...(accessibility ? { accessibility } : {}),
    }, {
      accessibilityMaxRulesPerImpact:
        this.cfg.observability.accessibilityMaxRulesPerImpact,
    });
    const artifactDir = await this.ensureArtifactDir();
    const reportPath = path.join(artifactDir, "perf-trace.md");
    await fs.writeFile(reportPath, markdown, "utf-8");
    return { performance, network, console: consoleSnapshot, accessibility, reportPath };
  }

  async accessibilityAudit(opts: {
    selector?: string;
    exclude?: string[];
    standard?: "WCAG2A" | "WCAG2AA" | "WCAG21A" | "WCAG21AA" | "WCAG22AA";
    impacts?: Array<"critical" | "serious" | "moderate" | "minor">;
  }): Promise<AccessibilitySnapshot> {
    assertActionAllowed(this.safetyRuntime, "browser_accessibility_audit");
    const collectors = this.requireCollectors();
    return await collectors.accessibility.audit({
      standard: opts.standard ?? this.cfg.observability.accessibilityStandard,
      ...(opts.selector ? { include: [opts.selector] } : {}),
      ...(opts.exclude ? { exclude: opts.exclude } : {}),
      ...(opts.impacts ? { impacts: opts.impacts } : {}),
    });
  }

  async close(): Promise<{ closed: true }> {
    if (this.collectors) {
      await Promise.allSettled(Object.values(this.collectors).map((c) => c.detach()));
      this.collectors = null;
    }
    if (this.context) {
      await this.context.close().catch(() => {});
    } else if (this.browser) {
      await this.browser.close().catch(() => {});
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.executionContext = null;
    this.lastSnapshot = null;
    this.artifactDir = null;
    this.cookiesInjected = 0;
    this.consoleOffset = 0;
    this.networkOffset = 0;
    return { closed: true };
  }

  private async launch(
    engine: BrowserEngine,
    headed: boolean,
  ): Promise<void> {
    this.cfg = loadConfig({ searchCwd: this.cwd });
    this.safetyRuntime = loadSafetyRuntime(this.cwd, this.cfg.safety);
    const pw = await loadPlaywright();
    const launcher = pw[engine] as BrowserType;
    this.browser = await launcher.launch({
      headless: !headed,
      slowMo: this.cfg.browser.slowMo,
    });
    this.context = await this.browser.newContext({
      viewport: this.cfg.browser.viewport,
    });
    await installDomainSafety(this.context, this.safetyRuntime.allowedDomains);
    this.page = await this.context.newPage();
    const artifactDir = await this.ensureArtifactDir();
    const collectors = {
      console: new ConsoleCollector({
        captureLimit: this.cfg.observability.consoleCaptureLimit,
        redact: this.cfg.observability.consoleRedaction,
      }),
      network: new NetworkCollector({
        captureLimit: this.cfg.observability.networkCaptureLimit,
        duplicateWindowMs: this.cfg.observability.duplicateWindowMs,
      }),
      performance: new PerformanceCollector(),
      accessibility: new AccessibilityCollector({
        dualEngine: this.cfg.observability.accessibilityDualEngine,
        htmlSnippetLimit: this.cfg.observability.accessibilityHtmlSnippetLimit,
      }),
    };
    this.executionContext = new ExecutionContext(
      this.page,
      this.cfg.url ?? "",
      artifactDir,
      this.cwd,
      undefined,
      undefined,
      this.cfg.browser.timeout,
      Object.values(collectors),
      {
        fullPageScreenshots: this.cfg.observability.fullPageScreenshots,
        visualSettle: DISABLED_SETTLE,
        blankFrameDetection: this.cfg.observability.blankFrameDetection,
        writeSidecars: false,
      },
    );
    await collectors.performance.attach(this.page, this.executionContext);
    await collectors.network.attach(this.page, this.executionContext);
    await collectors.console.attach(this.page, this.executionContext);
    await collectors.accessibility.attach(this.page, this.executionContext);
    this.collectors = collectors;
    this.engine = engine;
    this.headed = headed;
  }

  private async captureSnapshot(opts: BrowserSnapshotOptions): Promise<SnapshotTree> {
    assertActionAllowed(this.safetyRuntime, "browser_snapshot");
    const page = this.requirePage();
    const ctx = this.requireExecutionContext();
    const snap = await snapshot(page, ctx, {
      interactive: opts.compact ? true : opts.interactive,
      compact: opts.compact,
      selector: opts.selector,
      viewportAware: !(opts.fullPage ?? false),
      includeCursorInteractive: true,
    });
    this.lastSnapshot = snap;
    return snap;
  }

  private publicSnapshot(snap: SnapshotTree): Record<string, unknown> {
    return {
      yaml: snap.yaml,
      rawYaml: snap.rawYaml,
      stats: snap.stats,
      refs: Array.from(snap.refs.values()).map((entry) => ({
        ref: entry.ref,
        role: entry.role,
        name: entry.name,
        kind: entry.kind,
        ...(entry.href ? { href: entry.href } : {}),
        ...(entry.selectorHint ? { selectorHint: entry.selectorHint } : {}),
      })),
    };
  }

  private requireBrowser(): Browser {
    if (!this.browser) throw new Error("browser session is not open; call browser_open first");
    return this.browser;
  }

  private requireContext(): BrowserContext {
    if (!this.context) throw new Error("browser session is not open; call browser_open first");
    return this.context;
  }

  private requirePage(): Page {
    if (!this.page || this.page.isClosed()) {
      throw new Error("browser session is not open; call browser_open first");
    }
    return this.page;
  }

  private requireExecutionContext(): ExecutionContext {
    if (!this.executionContext) {
      throw new Error("browser session is not open; call browser_open first");
    }
    return this.executionContext;
  }

  private requireCollectors(): AttachedCollectors {
    if (!this.collectors) {
      throw new Error("browser session is not open; call browser_open first");
    }
    return this.collectors;
  }

  private async ensureArtifactDir(): Promise<string> {
    if (!this.artifactDir) {
      this.artifactDir = mkArtifactDir(this.cwd, this.cfg);
    }
    await fs.mkdir(this.artifactDir, { recursive: true });
    return this.artifactDir;
  }
}

export const defaultBrowserArtifactRoot = (): string =>
  path.join(os.tmpdir(), "skeptic-artifacts", "browser");
