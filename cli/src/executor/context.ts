import type { Page, Locator } from "playwright";
import type { AIClient, AIProvider } from "../ai/ai-client.js";
import type { Collector, CollectorName } from "../observability/types.js";
import type { AriaRefEntry } from "./aria-ref-types.js";
import type { ArtifactRuntimeConfig } from "./types.js";
import { DISABLED_SETTLE } from "./visual-settle.js";

/** Default artifact config — disabled across the board. Engine overrides per flow. */
export const DEFAULT_ARTIFACT_CONFIG: ArtifactRuntimeConfig = {
  fullPageScreenshots: false,
  visualSettle: DISABLED_SETTLE,
  blankFrameDetection: "warn",
  writeSidecars: false,
};

export class ExecutionContext {
  readonly page: Page;
  readonly variables: Map<string, string> = new Map();
  readonly screenshots: string[] = [];
  private baseUrl: string;
  lastElement: Locator | null = null;
  readonly flowDir: string;
  readonly sourceDir: string;
  readonly aiClient?: AIClient;
  readonly aiProvider?: AIProvider;
  readonly defaultTimeout: number;
  activeTimeout: number;
  readonly collectors: Map<CollectorName, Collector>;
  /** Per-flow artifact runtime config — set by the engine when constructing the context.
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
   * Set when a hardTimeout fires. Every composite handler and dispatch loop must check this
   * before its next step and short-circuit unless `inTeardown` is set or `continueOnError` is
   * passed to `executeNestedSteps`. Non-fatal paths (`optional` downgrade, `onTestStart` warning)
   * clear it to null so the flow can keep running.
   */
  abortReason: string | null = null;
  /**
   * Set while dispatching `onTestComplete` hooks. Lives on the context so composite teardown hooks
   * (e.g. `retry:` inside `onTestComplete`) propagate the flag through their inner
   * `executeNestedSteps` calls without needing a dedicated parameter.
   */
  inTeardown: boolean = false;
  /**
   * Subflow recursion depth and ancestor-stack for `runFlow` cycle detection.
   *
   * `runFlowDepth` increments on entry to the file branch of `handleRunFlow` and decrements
   * in its `finally`. Capped at `MAX_RUN_FLOW_DEPTH` (10) to turn stack-overflow crashes
   * into a clean per-step failure with a cycle path.
   *
   * `runFlowStack` holds the realpath of every file currently being executed up the
   * ancestor chain. `handleRunFlow` rejects entry if the resolved path is already on the
   * stack, naming the full chain in the error.
   *
   * Cycle detection only applies to the file-loading branch; the inline `commands:` branch
   * doesn't read a file (the handler picks `commands` over `file` at run-flow.ts:57), so
   * pushing/popping the file identity for inline-only entries would falsely flag cycles.
   */
  runFlowDepth: number = 0;
  runFlowStack: string[] = [];

  constructor(
    page: Page,
    baseUrl: string,
    flowDir?: string,
    sourceDir?: string,
    aiClient?: AIClient,
    aiProvider?: AIProvider,
    defaultTimeout: number = 30_000,
    collectors: Collector[] = [],
    artifactConfig: ArtifactRuntimeConfig = DEFAULT_ARTIFACT_CONFIG,
  ) {
    this.page = page;
    this.baseUrl = baseUrl;
    this.flowDir = flowDir ?? ".";
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

  setVariable(key: string, value: string): void {
    this.variables.set(key, value);
  }

  getVariable(key: string): string | undefined {
    return this.variables.get(key);
  }

  /**
   * Used by `runFlow` to restore the parent's env when a subflow's env vars
   * were set on entry but the variable didn't exist before. Without this,
   * `setVariable(key, undefined)` would coerce to "undefined" string.
   */
  deleteVariable(key: string): void {
    this.variables.delete(key);
  }

  interpolate(text: string): string {
    return text.replace(/\$\{(\w+)\}/g, (_, key: string) => {
      return this.variables.get(key) ?? `\${${key}}`;
    });
  }
}
