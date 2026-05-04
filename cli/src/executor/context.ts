import type { Page, Locator } from "playwright";
import type { AIClient, AIProvider } from "../ai/ai-client.js";
import type { Collector, CollectorName } from "../observability/types.js";
import type { AriaRefEntry } from "./aria-ref-types.js";
import type { ArtifactRuntimeConfig } from "./types.js";
import { DISABLED_SETTLE } from "./visual-settle.js";

/** Default artifact config — disabled across the board. Engine overrides per test. */
export const DEFAULT_ARTIFACT_CONFIG: ArtifactRuntimeConfig = {
  fullPageScreenshots: false,
  visualSettle: DISABLED_SETTLE,
  blankFrameDetection: "warn",
  writeSidecars: false,
};

export class ExecutionContext {
  readonly page: Page;
  readonly screenshots: string[] = [];
  private baseUrl: string;
  lastElement: Locator | null = null;
  readonly testDir: string;
  readonly sourceDir: string;
  readonly aiClient?: AIClient;
  readonly aiProvider?: AIProvider;
  readonly defaultTimeout: number;
  activeTimeout: number;
  readonly collectors: Map<CollectorName, Collector>;
  /** Per-test artifact runtime config — set by the engine when constructing the context.
   *  Read by the screenshot handler and by the engine's pre-video-finalize settle hook. */
  readonly artifactConfig: ArtifactRuntimeConfig;
  /**
   * ARIA snapshot ref registry — populated by the `ariaSnapshot` step, consumed by
   * `resolveSelectorArg`'s `@`-prefix branch. Each `ariaSnapshot` step clears and refills the map;
   * refs do not persist across snapshots (matches Expect's ephemeral-ref design).
   */
  readonly ariaRefs: Map<string, AriaRefEntry> = new Map();
  /**
   * Last captured snapshot YAML (verbatim Playwright output). In-memory only — never logged or
   * serialized into StepResult, since snapshots may include user-typed PII. Used by error messages
   * to indicate whether a snapshot has run yet.
   */
  ariaSnapshotYaml: string | null = null;
  /**
   * Set when a hardTimeout fires. Fixture actions check this before each await
   * and short-circuit unless `inTeardown` is set.
   */
  abortReason: string | null = null;
  /**
   * Set while running teardown hooks so cleanup can still execute after an
   * aborted test body.
   */
  inTeardown: boolean = false;

  constructor(
    page: Page,
    baseUrl: string,
    testDir?: string,
    sourceDir?: string,
    aiClient?: AIClient,
    aiProvider?: AIProvider,
    defaultTimeout: number = 30_000,
    collectors: Collector[] = [],
    artifactConfig: ArtifactRuntimeConfig = DEFAULT_ARTIFACT_CONFIG,
  ) {
    this.page = page;
    this.baseUrl = baseUrl;
    this.testDir = testDir ?? ".";
    this.sourceDir = sourceDir ?? process.cwd();
    this.aiClient = aiClient;
    this.aiProvider = aiProvider;
    this.defaultTimeout = defaultTimeout;
    this.activeTimeout = defaultTimeout;
    this.collectors = new Map(collectors.map((c) => [c.name, c]));
    this.artifactConfig = artifactConfig;
  }

  resolveUrl(path: string): string {
    if (/^https?:\/\//.test(path)) return path;
    const base = this.baseUrl.replace(/\/+$/, "");
    const resolved = path.startsWith("/") ? path : `/${path}`;
    return `${base}${resolved}`;
  }

  addScreenshot(path: string): void {
    this.screenshots.push(path);
  }

}
