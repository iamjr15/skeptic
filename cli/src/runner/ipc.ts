import type { TestResult, StepResult } from "../executor/types.js";

/**
 * Typed message protocol between the runner main process and per-file workers.
 *
 * Worker → main:
 *   - "ready"               : worker booted, awaiting `start`
 *   - "test:start"          : per-test lifecycle event
 *   - "test:complete"       : per-test final result + artifacts
 *   - "test:action"         : best-effort action marker (snapshot/screenshot/etc.)
 *   - "file:complete"       : worker finished its allowlist
 *   - "fatal"               : worker crashed (uncaught throw or import failure)
 *   - "log"                 : pass-through stdout/stderr line for the reporter
 *
 * Main → worker:
 *   - "start"               : ship spec path + allowlist + config; worker imports + runs
 */

export interface WorkerStartConfig {
  /** Per-action default timeout, applied via Playwright `setDefaultTimeout`. */
  timeout: number;
  /** Hard ceiling per test. The main process enforces this via `worker.terminate()`
   *  + a Node-side `setTimeout`; the worker also tries Promise.race for fast-path
   *  failures so afterEach gets a chance to run before the kill. */
  hardTimeout: number;
  outputDir: string;
  baseUrl?: string;
  envOverrides: Record<string, string>;
  observability: {
    /** When true, the worker forces all four collectors regardless of `test.use`. */
    forceAll: boolean;
    consoleRedaction: boolean;
    networkCaptureLimit: number;
    duplicateWindowMs: number;
    consoleCaptureLimit: number;
    accessibilityDualEngine: boolean;
    accessibilityHtmlSnippetLimit: number;
    accessibilityStandard: "WCAG2A" | "WCAG2AA" | "WCAG21A" | "WCAG21AA" | "WCAG22AA";
    autoAccessibilityAudit: boolean;
    /** Per-impact-bucket cap for `perf-trace.md`; full list lives in `audit.md`. */
    accessibilityMaxRulesPerImpact: number;
  };
  artifact: {
    fullPageScreenshots: boolean;
    blankFrameDetection: "off" | "warn" | "fail";
    writeSidecars: boolean;
  };
  /**
   * When a test fails, capture a full-page `failure.png` into the test's artifact dir and
   * attach its path to the failing step. Defaults to `true` when omitted (mirrors the config
   * default `execution.screenshotOnFailure`). Set to `false` to suppress.
   */
  screenshotOnFailure?: boolean;
  /**
   * Drives the pre-screenshot visual-settle pipeline (networkidle + double-RAF) independently
   * of `--observability`. When omitted, the worker falls back to `observability.forceAll` so
   * existing behavior is preserved. The CLI `--visual-settle` flag should set this.
   */
  visualSettle?: boolean;
  video: boolean;
  trace: boolean;
  /** Capture a HAR (HTTP archive) of all network traffic to `<test>.har`. */
  har?: boolean;
  headed: boolean;
  browserEngine: "chromium" | "firefox" | "webkit";
  /**
   * Execution platform. "web" (default) runs the Playwright page path; "android"
   * (adb) and "ios-sim" (simctl+axe) drive a device session and pass the spec a
   * `device` fixture instead of a `page`. The runner/discovery/reporting/evidence
   * pipeline is shared across all three.
   */
  platform?: "web" | "android" | "ios-sim";
  /** Device/emulator serial or simulator UDID for `--platform android|ios-sim`
   *  (defaults to the only attached device / booted simulator). */
  target?: string;
  viewport?: { width: number; height: number };
  /**
   * CLI `--video-size <WxH>` override. Wins over `test.use({ videoSize })`
   * which in turn wins over the viewport default. Only applied when
   * `video: true` (otherwise video isn't recorded at all).
   */
  videoSize?: { width: number; height: number };
  device?: string;
  cookies?: { enabled: boolean; browser?: string };
  retries: number;
  /**
   * Number of spec-file workers the main runner may execute concurrently. Optional: when the
   * user does NOT pass `--parallel`, leave this `undefined` so the runner auto-picks a safe
   * default from `os.availableParallelism()`. An explicit value always wins.
   */
  parallel?: number;
  shardId?: number;
  /**
   * `--no-daemon` opt-out. When true, the worker launches a fresh browser.
   * When false, the worker connects to the persistent daemon BrowserServer.
   */
  noDaemon?: boolean;
  /**
   * Forwarded to a daemon spawned by this worker when no daemon is already
   * running. Default 300 s. `0` disables idle timeout.
   */
  daemonIdleTimeoutSeconds?: number;
}

export interface WorkerStartMessage {
  type: "start";
  file: string;
  /** Stable test ids — `${file}#${ordinal}`. The worker only runs tests whose id is in this set. */
  allowlist: string[];
  config: WorkerStartConfig;
}

export interface ReadyMessage {
  type: "ready";
}

export interface TestStartMessage {
  type: "test:start";
  testId: string;
  ordinal: number;
  name: string;
  file: string;
  shardId?: number;
}

export interface TestCompleteMessage {
  type: "test:complete";
  testId: string;
  ordinal: number;
  result: TestResult;
}

export interface StepCompleteMessage {
  type: "step:complete";
  testId: string;
  index: number;
  total: number;
  step: StepResult;
}

export interface TestActionMessage {
  type: "test:action";
  testId: string;
  label: string;
  status: "started" | "completed" | "failed";
  durationMs?: number;
  error?: string;
}

export interface FileCompleteMessage {
  type: "file:complete";
  file: string;
  /** Test ids that finished (passed, failed, or errored) inside this worker run. Used by
   *  the main process to compute which allowlist entries still need a requeue. */
  finished: string[];
}

export interface FatalMessage {
  type: "fatal";
  message: string;
  stack?: string;
}

export interface LogMessage {
  type: "log";
  level: "info" | "warn" | "error" | "debug";
  message: string;
}

export type MainToWorker = WorkerStartMessage;
export type WorkerToMain =
  | ReadyMessage
  | TestStartMessage
  | TestCompleteMessage
  | StepCompleteMessage
  | TestActionMessage
  | FileCompleteMessage
  | FatalMessage
  | LogMessage;
