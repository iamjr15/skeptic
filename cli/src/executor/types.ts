import type { Page } from "playwright";
import type { ExecutionContext } from "./context.js";
import type { AIClient, AIProvider } from "../ai/ai-client.js";
import type { CollectorName } from "../observability/types.js";
import type { ObservabilityRuntimeConfig } from "../observability/registry.js";
import type { VisualSettleConfig } from "./visual-settle.js";

export interface StepDiagnostic {
  kind:
    | "blank-screenshot"
    | "settle-timeout"
    | "path-rejected"
    | "auto-a11y-skipped"
    | string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface StepResult {
  command: string;
  args: unknown;
  status: "passed" | "failed" | "error" | "skipped";
  duration_ms: number;
  error?: string;
  screenshot?: string;
  baselinePath?: string;
  currentPath?: string;
  diffPath?: string;
  /** Non-fatal notices appended during step execution (soft-timeout, retryIfNoChange, etc.). */
  warnings?: string[];
  /** Structured diagnostics. Reporters render alongside `warnings`. */
  diagnostics?: StepDiagnostic[];
}

/** Append a warning to a StepResult, allocating the array on first use. Returns the same result for chaining. */
export const appendWarning = (result: StepResult, warning: string): StepResult => {
  if (!result.warnings) result.warnings = [];
  result.warnings.push(warning);
  return result;
};

/** Append a structured diagnostic to a StepResult. Reporters render these alongside warnings. */
export const appendDiagnostic = (
  result: StepResult,
  kind: StepDiagnostic["kind"],
  message: string,
  meta?: Record<string, unknown>,
): StepResult => {
  if (!result.diagnostics) result.diagnostics = [];
  result.diagnostics.push(meta !== undefined ? { kind, message, meta } : { kind, message });
  return result;
};

export interface TestArtifacts {
  /** Path to Playwright trace zip. Populated by the engine after `tracing.stop` runs in the
   *  ordered finalization block — between video save and sidecar writes, inside the try block.
   *  The `finally` is reserved for page/context cleanup. */
  trace?: string;
  /** WebM video plus its true (recorded) dimensions. No `durationMs` — Playwright's Video
   *  class exposes only `path()/saveAs()/delete()`. */
  video?: { path: string; width: number; height: number };
  /** Per-step screenshot files captured during the run, in order. Mirrors `ctx.screenshots`. */
  screenshots?: string[];
  /** Markdown sidecar emitted under `--observability-write-sidecars`. */
  perfTrace?: string;
  /** JSON sidecar of console messages (post-redaction). */
  consoleSnapshot?: string;
  /** JSON sidecar of network requests + computed issues. */
  networkSnapshot?: string;
  /** Per-test JSON file (a slice of results.json scoped to this test). */
  testJson?: string;
}

export interface TestResult {
  name: string;
  file: string;
  /** Stable registration ordinal within the file. Surfaced so reporters can append
   *  `#${testIndex}` when duplicate names collide (plan §4.0.1). */
  testIndex?: number;
  status: "passed" | "failed" | "error";
  duration_ms: number;
  steps: StepResult[];
  /**
   * Observability snapshots, keyed by collector name. Typed as `Record<string, unknown>`
   * at the boundary; collectors in cli/src/observability/collectors/ define their typed
   * snapshot shapes. Reporters narrow at consumption time. Absent when no collectors ran.
   */
  metrics?: Record<string, unknown>;
  /** Zero-based shard index this test ran in. Set when EngineOptions.shardId is present. */
  shardId?: number;
  /** All on-disk artifacts produced by this test. Always present; empty object when no artifacts captured. */
  artifacts: TestArtifacts;
}

/** Engine input for a single test. The TS-pivot replaces YAML-step lists with a
 *  `runFn` that the engine awaits inside the runAction boundary; everything else
 *  is metadata the engine reads to set up viewport, env, and collector wiring. */
export interface TestInput {
  url: string;
  name: string;
  file: string;
  /** The body the engine awaits — built by the runner from the user's `test()` callback. */
  runFn?: (page: Page, ctx: ExecutionContext) => Promise<void>;
  timeout?: number;
  viewport?: { width: number; height: number };
  device?: string;
  auth?: "cookies" | "none";
  env?: Record<string, string>;
  testIndex?: number;
  /** Collectors the test requires; the engine attaches the union of this and EngineOptions.observability.collectors. */
  requiredCollectors?: Set<CollectorName>;
}

export interface CookiesOption {
  enabled: boolean;
  browser?: string;
}

/**
 * Per-flow runtime config for the screenshot/settle/blank-frame pipeline. Resolved by the
 * engine once per flow from `EngineOptions` plus per-flow viewport, then frozen onto
 * `ExecutionContext.artifactConfig` so step handlers can read defaults without changing
 * the `(page, ctx, args)` handler signature.
 */
export interface ArtifactRuntimeConfig {
  fullPageScreenshots: boolean;
  visualSettle: VisualSettleConfig;
  blankFrameDetection: "off" | "warn" | "fail";
  writeSidecars: boolean;
}

export interface EngineOptions {
  headed?: boolean;
  timeout?: number;
  screenshotOnFailure?: boolean;
  outputDir?: string;
  browserEngine?: "chromium" | "firefox" | "webkit";
  viewport?: { width: number; height: number };
  deviceProfile?: {
    width: number;
    height: number;
    dpr: number;
    user_agent: string | null;
  };
  cookies?: CookiesOption;
  video?: boolean;
  /** Override video recording size; defaults to viewport. Closes the Playwright 800-cap default. */
  videoSize?: { width: number; height: number };
  aiClient?: AIClient;
  aiProvider?: AIProvider;
  trace?: boolean;
  observability?: ObservabilityRuntimeConfig;
  /** Resolved by the engine; flows into `ExecutionContext.artifactConfig`. */
  artifactConfig?: ArtifactRuntimeConfig;
  /** Zero-based shard index when running under sharding. Surfaced into TestResult.shardId
   *  for reporter disambiguation; the engine itself uses it only as passthrough metadata. */
  shardId?: number;
}

/** Per-action progress channel the engine emits during a test. The runner forwards
 *  these to reporters as `onStepStart` / `onStepComplete`. */
export type StepProgressEvent =
  | { type: "step:start"; index: number; total: number; command: string; args: unknown }
  | { type: "step:complete"; index: number; total: number; result: StepResult };

export type StepProgressCallback = (event: StepProgressEvent) => void;
