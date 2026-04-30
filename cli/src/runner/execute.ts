import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Reporter, RunSummary, TestIdentifier } from "../reporter/types.js";
import type { TestResult } from "../executor/types.js";
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
  /** Resolves the worker entry URL — abstracted so tests can pass in a fake. */
  workerEntry?: URL;
  /** Hard-kill grace after Promise.race ceiling — gives afterEach a chance to run. */
  killGraceMs?: number;
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

interface FileRunResult {
  file: string;
  results: TestResult[];
  remaining: ManifestEntry[];
  /** True when the worker terminated (timeout, crash) and tests didn't finish. */
  workerTerminated: boolean;
  /** Set when the runner already requeued the unfinished tests. */
  requeueAttempted: boolean;
}

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
  const killGrace = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  let workerTerminated = false;
  let killTimer: NodeJS.Timeout | undefined;

  const armKillTimer = (): void => {
    if (killTimer) clearTimeout(killTimer);
    killTimer = setTimeout(() => {
      workerTerminated = true;
      worker.terminate().catch(() => {
        process.stderr.write(`[skeptic] worker.terminate() rejected for ${file}\n`);
      });
    }, options.config.hardTimeout + killGrace);
  };

  return new Promise<FileRunResult>((resolve) => {
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
          const ident: TestIdentifier = {
            name: msg.name,
            file: msg.file,
            testIndex: msg.ordinal,
          };
          for (const r of options.reporters) {
            safeEmit("onTestStart", () => r.onTestStart(ident));
          }
          armKillTimer();
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
            worker.terminate().catch(() => {});
          }
          return;
        }
        case "step:complete": {
          const ident: TestIdentifier = {
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
        case "test:action":
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
      process.stderr.write(`[skeptic] worker error for ${file}: ${err.message}\n`);
    });
    worker.on("exit", () => {
      if (killTimer) clearTimeout(killTimer);
      const remaining = entries.filter((e) => !finishedIds.has(e.id));
      resolve({
        file,
        results,
        remaining,
        workerTerminated,
        requeueAttempted: false,
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
    tests: allEntries.map((e) => ({ name: e.name, file: e.file, stepCount: 0 })),
    totalTests: allEntries.length,
  };
  for (const r of options.reporters) {
    safeEmit("onRunStart", () => r.onRunStart?.(onRunStartManifest));
  }

  // Run files sequentially in the MVP. Per-file parallelism (worker pool) lands
  // when concurrent execution lands in a future bundle.
  outer: for (const [file, entries] of options.partition) {
    if (entries.length === 0) continue;
    const initial = await runWorkerForFile(file, entries, options);
    const fileResults = [...initial.results];

    // Per-test retries: every failing test that wasn't killed by the worker gets
    // re-spawned in a fresh worker against an allowlist of just that test, up to
    // `config.retries` times. We replace the originally-failing entry's result
    // with the last attempt and stamp the retry count on the StepResult so
    // reporters can surface it without changing their wire shape.
    const retryBudget = options.config.retries;
    if (retryBudget > 0 && !initial.workerTerminated) {
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
          if (retried.status === "passed") break;
        }
      }
    }
    allResults.push(...fileResults);

    if (initial.workerTerminated && initial.remaining.length > 0) {
      // Plan §4.0: mark the offending test as the killed-once entry, requeue the
      // remaining allowlist in a fresh worker once. If the second worker also
      // dies on the next test, that test is `test killed worker twice` and
      // everything after it is `skipped due to upstream worker kill`.
      const first = initial.remaining[0]!;
      allResults.push(
        buildSkippedResult(
          file,
          first,
          `test killed worker (${options.config.hardTimeout}ms hard ceiling)`,
        ),
      );
      const requeueRemaining = initial.remaining.slice(1);
      if (requeueRemaining.length > 0) {
        const requeue = await requeueOnce(file, requeueRemaining, options);
        allResults.push(...requeue.results);
        if (requeue.workerTerminated && requeue.remaining.length > 0) {
          const offender = requeue.remaining[0]!;
          allResults.push(buildSkippedResult(file, offender, "test killed worker twice"));
          for (const e of requeue.remaining.slice(1)) {
            allResults.push(
              buildSkippedResult(file, e, "skipped due to upstream worker kill"),
            );
          }
        }
      }
    }

    if (options.bail && allResults.some((r) => r.status !== "passed")) {
      break outer;
    }
  }

  const summary: RunSummary = {
    total: allResults.length,
    passed: allResults.filter((r) => r.status === "passed").length,
    failed: allResults.filter((r) => r.status !== "passed").length,
    duration_ms: Math.round(performance.now() - start),
    tests: allResults,
  };
  for (const r of options.reporters) {
    safeEmit("onRunComplete", () => {
      void Promise.resolve(r.onRunComplete(summary)).catch(() => {});
    });
  }

  return { results: allResults, summary };
};
