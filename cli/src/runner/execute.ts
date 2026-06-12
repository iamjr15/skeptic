import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import type { Reporter, RunSummary, TestIdentifier } from "../reporter/types.js";
import type { StepResult, TestResult } from "../executor/types.js";
import type { FileManifest, ManifestEntry } from "./discover.js";
import type {
  WorkerStartConfig,
  WorkerStartMessage,
  WorkerToMain,
} from "./ipc.js";

export interface RunnerExecuteOptions {
  config: WorkerStartConfig;
  reporters: Reporter[];
  /** Tests partitioned by file. Stable test ids form the per-file allowlist. */
  partition: Map<string, ManifestEntry[]>;
  /** Map from file → manifest (used for skip/only short-circuiting in the main process). */
  manifests: Map<string, FileManifest>;
  bail: boolean;
  /** Maximum number of spec-file workers to run at once. When undefined, the runner auto-picks. */
  concurrency?: number;
  /** Resolves the worker entry URL — abstracted so tests can pass in a fake. */
  workerEntry?: URL;
  /** Hard-kill grace after Promise.race ceiling — gives afterEach a chance to run. */
  killGraceMs?: number;
  /**
   * Optional cancellation. On abort the runner terminates in-flight workers and stops scheduling
   * new partitions. Threaded from `runSpecs`; `run.ts` wires it to SIGINT/Ctrl-C.
   */
  signal?: AbortSignal;
}

export interface RunnerExecuteOutcome {
  results: TestResult[];
  summary: RunSummary;
}

const DEFAULT_KILL_GRACE_MS = 2_000;

const safeEmit = (label: string, fn: () => void): void => {
  try {
    fn();
  } catch (err) {
    // Reporters never abort the run.
    process.stderr.write(
      `[skeptic] reporter ${label} threw: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
};

const safeEmitAsync = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try {
    await fn();
  } catch (err) {
    // Reporters never abort the run.
    process.stderr.write(
      `[skeptic] reporter ${label} threw: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
};

/** Probe `worker.mjs` (production dist) before falling back to `worker.ts` (vitest dev). */
const resolveDefaultWorkerEntry = (): URL => {
  const mjs = new URL("./worker.mjs", import.meta.url);
  try {
    if (existsSync(fileURLToPath(mjs))) return mjs;
  } catch {
    /* fall through */
  }
  return new URL("./worker.ts", import.meta.url);
};

const partitionToAllowlist = (entries: ManifestEntry[]): string[] =>
  entries.map((e) => e.id);

const identifierForEntry = (entry: ManifestEntry): TestIdentifier => ({
  name: entry.name,
  file: entry.file,
  testIndex: entry.ordinal,
});

interface FileRunResult {
  file: string;
  results: TestResult[];
  remaining: ManifestEntry[];
  /** True when the worker terminated (timeout, crash) and tests didn't finish. */
  workerTerminated: boolean;
  /** Effective hard-timeout that triggered the worker kill, when known. */
  killTimeoutMs?: number;
  /** Set when the runner already requeued the unfinished tests. */
  requeueAttempted: boolean;
  /**
   * True when the worker exited unexpectedly (uncaught throw / unhandled rejection / non-zero
   * exit) with tests still unfinished — distinct from an intentional hard-timeout kill, bail, or
   * abort. The caller synthesizes error results for the unfinished tests so they aren't silently
   * dropped and the run fails.
   */
  crashed?: boolean;
  /** Crash error message when the worker emitted an 'error' event. */
  crashError?: string;
  /** True when the run was aborted via AbortSignal — stop, do not requeue or synthesize. */
  aborted?: boolean;
}

// Soft per-action timeout and the hard kill ceiling are independent: a per-test soft `timeout`
// must NOT become the hard ceiling. hardTimeout falls back to the run-level config value only.
const effectiveHardTimeoutForEntry = (
  entry: ManifestEntry | undefined,
  fallback: number,
): number => entry?.use.hardTimeout ?? fallback;

const availableParallelism = (): number => {
  try {
    if (typeof os.availableParallelism === "function") return os.availableParallelism();
  } catch {
    /* fall through to cpus() */
  }
  const cpus = os.cpus?.().length ?? 1;
  return cpus > 0 ? cpus : 1;
};

/**
 * Resolve worker concurrency. An explicit `--parallel` value (options.concurrency) always wins.
 * When the user did not pass it (undefined), auto-pick `min(specFileCount, ceil(cores/2))` so
 * multi-file runs use the machine without oversubscribing — per-test contexts + the daemon make
 * this safe. Bail and single-file runs force serial.
 */
export const resolveConcurrency = (
  options: RunnerExecuteOptions,
  partitionCount: number,
): number => {
  if (options.bail) return 1;
  if (partitionCount <= 1) return 1;
  const explicit = options.concurrency;
  if (explicit !== undefined && explicit >= 1) {
    return Math.min(Math.max(1, Math.floor(explicit)), partitionCount);
  }
  const auto = Math.max(1, Math.ceil(availableParallelism() / 2));
  return Math.min(auto, partitionCount);
};

const runWorkerForFile = async (
  file: string,
  entries: ManifestEntry[],
  options: RunnerExecuteOptions,
): Promise<FileRunResult> => {
  const allowlist = partitionToAllowlist(entries);
  const workerEntry = options.workerEntry ?? resolveDefaultWorkerEntry();

  const worker = new Worker(workerEntry, {
    stderr: false,
    stdout: false,
  });

  const results: TestResult[] = [];
  const finishedIds = new Set<string>();
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const actionCountsByTestId = new Map<string, number>();
  const killGrace = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const signal = options.signal;
  let workerTerminated = false;
  let killTimeoutMs: number | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  // Distinguish an unexpected crash from intentional terminations (hard-timeout kill, bail, abort)
  // so the exit handler only synthesizes error results for genuine crashes.
  let workerError: Error | null = null;
  let bailTerminated = false;

  const armKillTimer = (hardTimeoutMs: number = options.config.hardTimeout): void => {
    if (killTimer) clearTimeout(killTimer);
    killTimer = setTimeout(() => {
      workerTerminated = true;
      killTimeoutMs = hardTimeoutMs;
      worker.terminate().catch(() => {
        process.stderr.write(`[skeptic] worker.terminate() rejected for ${file}\n`);
      });
    }, hardTimeoutMs + killGrace);
  };

  return new Promise<FileRunResult>((resolve) => {
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      worker.terminate().catch(() => {});
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    armKillTimer();
    worker.on("message", (msg: WorkerToMain) => {
      switch (msg.type) {
        case "ready": {
          const startMessage: WorkerStartMessage = {
            type: "start",
            file,
            allowlist,
            config: options.config,
          };
          worker.postMessage(startMessage);
          return;
        }
        case "test:start": {
          const entry = entries.find((e) => e.id === msg.testId);
          const ident: TestIdentifier = {
            name: msg.name,
            file: msg.file,
            testIndex: msg.ordinal,
          };
          for (const r of options.reporters) {
            safeEmit("onTestStart", () => r.onTestStart(ident));
          }
          armKillTimer(effectiveHardTimeoutForEntry(entry, options.config.hardTimeout));
          return;
        }
        case "test:action": {
          const entry = entriesById.get(msg.testId);
          if (!entry) return;
          const ident = identifierForEntry(entry);
          const currentCount = actionCountsByTestId.get(msg.testId) ?? 0;
          if (msg.status === "started") {
            const index = currentCount;
            const total = index + 1;
            actionCountsByTestId.set(msg.testId, total);
            for (const r of options.reporters) {
              safeEmit("onStepStart", () =>
                r.onStepStart?.({ command: msg.label, args: {} }, index, total, ident),
              );
            }
            return;
          }

          const index = currentCount > 0 ? currentCount - 1 : 0;
          const total = Math.max(currentCount, index + 1);
          actionCountsByTestId.set(msg.testId, total);
          const step: StepResult = {
            command: msg.label,
            args: {},
            status: msg.status === "completed" ? "passed" : "failed",
            duration_ms: msg.durationMs ?? 0,
            ...(msg.error !== undefined ? { error: msg.error } : {}),
          };
          for (const r of options.reporters) {
            safeEmit("onStepComplete", () => r.onStepComplete(step, index, total, ident));
          }
          return;
        }
        case "test:complete": {
          finishedIds.add(msg.testId);
          results.push(msg.result);
          const ident: TestIdentifier = {
            name: msg.result.name,
            file: msg.result.file,
            testIndex: msg.ordinal,
          };
          for (const r of options.reporters) {
            safeEmit("onTestComplete", () => r.onTestComplete(msg.result, ident));
          }
          armKillTimer();
          if (options.bail && msg.result.status !== "passed") {
            bailTerminated = true;
            worker.terminate().catch(() => {});
          }
          return;
        }
        case "step:complete": {
          const entry = entriesById.get(msg.testId);
          const ident: TestIdentifier = entry
            ? identifierForEntry(entry)
            : {
                name: "(step)",
                file,
                testIndex: 0,
              };
          for (const r of options.reporters) {
            safeEmit("onStepComplete", () =>
              r.onStepComplete(msg.step, msg.index, msg.total, ident),
            );
          }
          return;
        }
        case "log":
          // Action markers + log lines are forwarded for B3+ instrumentation; the
          // console reporter doesn't render them today but a future addition can.
          return;
        case "fatal": {
          const failedResult: TestResult = {
            name: file,
            file,
            status: "error",
            duration_ms: 0,
            steps: [
              {
                command: "spec:import",
                args: { file },
                status: "error",
                duration_ms: 0,
                error: msg.message,
              },
            ],
            artifacts: {},
          };
          results.push(failedResult);
          return;
        }
        case "file:complete":
          // Worker is about to exit; let the exit handler resolve.
          return;
      }
    });
    worker.on("error", (err) => {
      // An uncaught throw / unhandled rejection in the worker thread surfaces here; 'exit'
      // follows. Stash the error so the exit handler can synthesize results for unfinished tests.
      workerError = err;
      process.stderr.write(`[skeptic] worker error for ${file}: ${err.message}\n`);
    });
    worker.on("exit", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
      const remaining = entries.filter((e) => !finishedIds.has(e.id));
      // Crash = errored or exited non-zero, with tests still unfinished, and NOT an intentional
      // termination (hard-timeout kill, bail, or abort). A normal worker calls process.exit(0).
      const crashed =
        !workerTerminated &&
        !bailTerminated &&
        !aborted &&
        remaining.length > 0 &&
        (workerError !== null || code !== 0);
      resolve({
        file,
        results,
        remaining,
        // Treat a crash like a termination so the retry path is skipped and the unfinished
        // tests are handled (synthesized) by runFilePartition instead of silently dropped.
        workerTerminated: workerTerminated || crashed,
        ...(killTimeoutMs !== undefined ? { killTimeoutMs } : {}),
        requeueAttempted: false,
        crashed,
        ...(workerError ? { crashError: (workerError as Error).message } : {}),
        aborted,
      });
    });
  });
};

const requeueOnce = async (
  file: string,
  remaining: ManifestEntry[],
  options: RunnerExecuteOptions,
): Promise<FileRunResult> => {
  if (remaining.length === 0) {
    return { file, results: [], remaining: [], workerTerminated: false, requeueAttempted: true };
  }
  const requeueResult = await runWorkerForFile(file, remaining, options);
  return { ...requeueResult, requeueAttempted: true };
};

const buildSkippedResult = (file: string, entry: ManifestEntry, reason: string): TestResult => ({
  name: entry.name,
  file,
  status: "error",
  duration_ms: 0,
  steps: [
    {
      command: "test",
      args: { name: entry.name },
      status: "error",
      duration_ms: 0,
      error: reason,
    },
  ],
  artifacts: {},
});

const runFilePartition = async (
  file: string,
  entries: ManifestEntry[],
  options: RunnerExecuteOptions,
): Promise<TestResult[]> => {
  if (entries.length === 0) return [];

  const initial = await runWorkerForFile(file, entries, options);
  const fileResults = [...initial.results];

  const retryBudget = options.config.retries;
  if (retryBudget > 0 && !initial.workerTerminated && !initial.aborted) {
    const failedEntries = entries.filter((entry) => {
      const r = fileResults.find((x) => x.file === entry.file && x.name === entry.name);
      return r && r.status !== "passed";
    });
    for (const entry of failedEntries) {
      for (let attempt = 1; attempt <= retryBudget; attempt++) {
        const retryRun = await runWorkerForFile(entry.file, [entry], options);
        const retried = retryRun.results.find(
          (r) => r.file === entry.file && r.name === entry.name,
        );
        if (!retried) break;
        if (retried.steps[0]) {
          retried.steps[0].warnings ??= [];
          retried.steps[0].warnings.push(`retry attempt ${attempt}/${retryBudget}`);
        }
        const idx = fileResults.findIndex(
          (r) => r.file === entry.file && r.name === entry.name,
        );
        if (idx >= 0) fileResults[idx] = retried;
        if (retried.status === "passed") {
          // Failed first, then went green on retry — preserve the "was flaky" signal.
          retried.flaky = true;
          break;
        }
      }
    }
  }

  if (initial.crashed) {
    // The worker died with tests still unfinished — synthesize an error result for each so the
    // tests aren't silently dropped and the run exit code goes non-zero.
    for (const entry of initial.remaining) {
      fileResults.push(
        buildSkippedResult(
          file,
          entry,
          `worker crashed before this test completed${initial.crashError ? `: ${initial.crashError}` : ""}`,
        ),
      );
    }
  } else if (initial.workerTerminated && initial.remaining.length > 0) {
    const first = initial.remaining[0]!;
    fileResults.push(
      buildSkippedResult(
        file,
        first,
        `test killed worker (${initial.killTimeoutMs ?? options.config.hardTimeout}ms hard ceiling)`,
      ),
    );
    const requeueRemaining = initial.remaining.slice(1);
    if (requeueRemaining.length > 0) {
      const requeue = await requeueOnce(file, requeueRemaining, options);
      fileResults.push(...requeue.results);
      if (requeue.workerTerminated && requeue.remaining.length > 0) {
        const offender = requeue.remaining[0]!;
        fileResults.push(buildSkippedResult(file, offender, "test killed worker twice"));
        for (const e of requeue.remaining.slice(1)) {
          fileResults.push(
            buildSkippedResult(file, e, "skipped due to upstream worker kill"),
          );
        }
      }
    }
  }

  return fileResults;
};

const runPartitionsInParallel = async (
  partitions: Array<[string, ManifestEntry[]]>,
  options: RunnerExecuteOptions,
  concurrency: number,
): Promise<TestResult[]> => {
  const resultsByPartition = new Array<TestResult[]>(partitions.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      if (options.signal?.aborted) return;
      const index = nextIndex;
      nextIndex += 1;
      const item = partitions[index];
      if (!item) return;
      const [file, entries] = item;
      resultsByPartition[index] = await runFilePartition(file, entries, options);
    }
  };

  const workerCount = Math.min(Math.max(1, concurrency), partitions.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return resultsByPartition.flat();
};

export const executeRun = async (
  options: RunnerExecuteOptions,
): Promise<RunnerExecuteOutcome> => {
  const start = performance.now();
  const allResults: TestResult[] = [];

  // Build the onRunStart manifest payload for reporters. The reporter contract uses
  // {tests, totalTests}; we feed it the cross-file ordering the partition iteration
  // gives us, which mirrors the serial execution order.
  const allEntries = [...options.partition.values()].flat();
  const onRunStartManifest = {
    tests: allEntries.map((e) => ({
      name: e.name,
      file: e.file,
      stepCount: 0,
      testIndex: e.ordinal,
    })),
    totalTests: allEntries.length,
  };
  for (const r of options.reporters) {
    safeEmit("onRunStart", () => r.onRunStart?.(onRunStartManifest));
  }

  const partitions = [...options.partition.entries()].filter(([, entries]) => entries.length > 0);
  const concurrency = resolveConcurrency(options, partitions.length);

  if (concurrency > 1 && partitions.length > 1) {
    allResults.push(...await runPartitionsInParallel(partitions, options, concurrency));
  } else {
    for (const [file, entries] of partitions) {
      if (options.signal?.aborted) break;
      const fileResults = await runFilePartition(file, entries, options);
      allResults.push(...fileResults);
      if (options.bail && allResults.some((r) => r.status !== "passed")) break;
    }
  }

  const summary: RunSummary = {
    total: allResults.length,
    passed: allResults.filter((r) => r.status === "passed" && !r.skipped).length,
    failed: allResults.filter((r) => r.status !== "passed").length,
    skipped: allResults.filter((r) => r.skipped === true).length,
    duration_ms: Math.round(performance.now() - start),
    tests: allResults,
  };
  await Promise.all(
    options.reporters.map((r) =>
      safeEmitAsync("onRunComplete", () => r.onRunComplete(summary)),
    ),
  );

  return { results: allResults, summary };
};
