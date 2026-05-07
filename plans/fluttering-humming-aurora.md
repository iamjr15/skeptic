# Plan: Test Sharding (`--shard-split` / `--shard-all`)

## Context

Item #39 from `docs/competitive-analysis-maestro-expect.md:421-427` — the last unchecked feature in the Maestro competitive backlog (only #36 TypeScript SDK remains separately). Two new flags on `skeptic test`:

- `skeptic test --shard-split N` — distribute flows across N independent browser instances, each running a disjoint subset (modulo partitioning).
- `skeptic test --shard-all N` — run **every** flow on each of N independent browser instances (cross-engine parity check, flake-baseline collection).

Both spawn N `PlaywrightEngine` instances (each its own Chromium process) — true OS-level parallelism, distinct from the existing `--parallel <n>` flag (which runs N flows concurrently inside ONE engine via async dispatch).

**Why shipping this matters:** `--parallel` saturates at one Chromium's resources and shares state-leakage risk across flows in a single browser. Sharding gives true wall-clock speedup for CI runs (N×) and isolates flow state per process. `--shard-all` enables flake-rate measurement and cross-instance reproducibility checks that `--parallel` cannot offer.

**Maestro reference (Kotlin port — ideas, not code):**
- Flag wiring: `maestro-cli/src/main/java/maestro/cli/command/TestCommand.kt:104-121` — `--shard-split` / `--shard-all` declared via Picocli; `--shards` is a deprecated alias.
- Mutual exclusion: `TestCommand.kt:253-254` — `CliError("Options --shard-split and --shard-all are mutually exclusive.")`.
- Partition algorithm: `TestCommand.kt:646-660` — `makeChunkPlans` uses `flowsToRun.withIndex().groupBy { it.index % effectiveShards }` for split; `(0 until effectiveShards).reversed().map { plan.copy() }` for all.
- Coercion: `TestCommand.kt:400-402` — `--shard-split` clamps `requestedShards.coerceAtMost(plan.flowsToRun.size)`; warning at line 410.
- Execution: `TestCommand.kt:433-444` — `(0 until effectiveShards).map { async(Dispatchers.IO + CoroutineName("shard-$shardIndex")) { ... } }.awaitAll()`. Each shard owns one device (skeptic: one Chromium). No cross-shard abort signal.
- Result merge: `TestCommand.kt:698-705` — `mergeSummaries` reduces `passed = acc.passed && summary.passed`, `suites = acc.suites + summary.suites`, summed counts.
- Log prefix: `TestSuiteInteractor.kt:51, 181, 190` — `private val shardPrefix = shardIndex?.let { "[shard ${it + 1}] " }.orEmpty()` prepended to every progress log.
- Env var injection (Maestro's `Env.kt`): exposes `MAESTRO_SHARD_INDEX` / `MAESTRO_SHARD_ID` to flows. skeptic will mirror as `SKEPTIC_SHARD_INDEX` / `SKEPTIC_SHARD_COUNT` (zero-based / total).

**skeptic-side substrate (verified at plan time):**
- CLI flag declaration site: `cli/src/index.ts:73` (`--parallel`) — pattern + `parsePositiveInt` validator we'll reuse.
- Worker pool: `cli/src/commands/test.ts:347-389` — current `--parallel` queue/dispatch lives inside the `executeFlows` closure. Sharding will wrap that closure, not replace it.
- Engine lifecycle: `cli/src/executor/playwright-engine.ts:39-60` (`launch`), `:62-404` (`runFlow`), `:406-411` (`close`). Each shard gets its own `PlaywrightEngine`.
- Per-flow output dir: `playwright-engine.ts:75-82` — `join(outputDir, "${safeName}-${flowIndex}")`. We avoid collisions by giving each shard its own `outputDir` subtree, NOT by encoding the shard ID into `flowIndex` (zero engine changes needed).
- Reporter event surface: `cli/src/reporter/types.ts:17-24`. Stays untouched.
- File reporters all overwrite via `writeFileSync`: `json-reporter.ts:39`, `junit-reporter.ts:40`, `html-reporter.ts:114`. Sharding-time merge happens at the orchestrator level, not inside the reporter classes.
- `runFlows` in `cli/src/executor/runner.ts:4-23` is a tiny programmatic-API entry point (no internal callers — confirmed via grep). It stays as-is; sharding lives in `commands/test.ts` + a new `executor/shard.ts` helper.

**Goal for v1:** ship `--shard-split` and `--shard-all` for the common case (CI runs that today use `--parallel`), with deterministic partitioning, per-shard isolated artifacts, and a single canonical merged report at the top level. Defer cross-machine sharding, dynamic re-balancing, and TUI multi-shard support (Phase 5 anti-scope).

---

## Phase 1 — Partition function + per-shard worker

### 1.1 Create `cli/src/executor/shard.ts` — pure partition function only

**File (new):** `cli/src/executor/shard.ts`. **Single responsibility: pure partition logic.** No imports from `cli/src/commands/`. The shard-level worker (`runFlowsForShard`) lives in `commands/test.ts` (Phase 1.5) — that avoids a `executor → commands` circular import, since `flowToInput` (used by the worker) lives in `commands/test.ts:554` and is consumed by external tests at `cli/__tests__/unit/config/workspace-hooks.test.ts:3` and `cli/__tests__/integration/observability/bundle3-e2e.test.ts:10`. Moving `flowToInput` to `executor/` would ripple through those test imports for no architectural gain.

```ts
import type { ResolvedFlow } from "../parser/flow-schema.js";

export type ShardMode = "split" | "all";

/**
 * Returns one ordered slice of `flows` per shard.
 * - "split": modulo round-robin — flow at index i goes to shard (i % shardCount).
 *            Deterministic, identical to Maestro's `groupBy { it.index % effectiveShards }`.
 * - "all":   every shard gets a copy of the full ordered list.
 *
 * Caller is responsible for clamping shardCount before calling. This function asserts
 * `shardCount >= 1` and treats shardCount=1 as "one slice equal to the input" for both modes
 * (caller is expected to short-circuit shardCount=1 to the non-sharded path, but the function
 * is total).
 */
export function partitionFlows(
  flows: ResolvedFlow[],
  shardCount: number,
  mode: ShardMode,
): ResolvedFlow[][];
```

Implementation is ~15 lines. **Important property:** for `mode="split"` we preserve the relative order of flows within each shard (round-robin keeps `flowsOrder` intent — flow N in the user's ordered list lands at position floor(N/shardCount) inside shard `N % shardCount`).

### 1.2 Extend `EngineOptions` with `shardId`

**File:** `cli/src/executor/types.ts:68-87`

```ts
export interface EngineOptions {
  // ... existing fields
  /** Zero-based shard index when running under sharding. Reporters and observability
   *  collectors can consume it to disambiguate per-shard artifacts. Engine itself
   *  uses it only when present — single-shard runs leave it undefined. */
  shardId?: number;
}
```

The engine doesn't read `shardId` directly — it's surfaced to the env injected into flows (see 1.4) and threaded into `FlowResult.shardId` for reporter use. Adding the field now keeps the public surface stable; collectors can pick it up later without an `EngineOptions` migration.

### 1.3 Extend `FlowResult` with `shardId`

**File:** `cli/src/executor/types.ts:31-44`

```ts
export interface FlowResult {
  // ... existing fields
  /** Zero-based shard index this flow ran in. Set when EngineOptions.shardId is present. */
  shardId?: number;
}
```

Set inside `playwright-engine.ts` `runFlow` at the result-construction site (search for the `return { name, file, status, ... }` literal): inject `shardId: this.options.shardId`. One-line change. Keeps the merge-layer summarization simple — every flow result carries its origin.

### 1.4 Inject `SKEPTIC_SHARD_INDEX` / `SKEPTIC_SHARD_COUNT` env at `flowToInput`

**File:** `cli/src/commands/test.ts:554-597` (`flowToInput`)

Mirroring Maestro's `MAESTRO_SHARD_*` env vars. Lets flow scripts (and `runScript:` step) self-identify their shard. Optional in flow code, but useful for "skip on shard 0" / "log shard id in test output" patterns:

```ts
export function flowToInput(
  flow: ResolvedFlow,
  baseUrl: string | undefined,
  env: Record<string, string>,
  flowIndex: number = 0,
  configHooks?: { onFlowStart?: Step[]; onFlowComplete?: Step[] },
  shardCtx?: { shardId: number; shardCount: number },
): FlowInput {
  // ... existing logic
  const shardEnv: Record<string, string> = shardCtx
    ? {
        SKEPTIC_SHARD_INDEX: String(shardCtx.shardId),
        SKEPTIC_SHARD_COUNT: String(shardCtx.shardCount),
      }
    : {};
  return {
    // ...
    env: { ...env, ...flow.metadata.env, ...shardEnv },
    // ...
  };
}
```

Order matters: `shardEnv` last, so user env can't accidentally shadow `SKEPTIC_SHARD_INDEX`. Pre-existing values are blown away by design — this is a system-injected variable.

### 1.5 Extract `runFlowsForShard` helper inside `commands/test.ts`

**Location:** top-level export inside `cli/src/commands/test.ts`, alongside the existing `flowToInput` function. **NOT** in `executor/shard.ts` — keeping it here avoids the circular dep (1.1) and makes import-graph trivial: `commands/test.ts` imports `partitionFlows` from `executor/shard.ts`, and `executor/shard.ts` imports nothing from `commands/`.

The current `executeFlows` closure in `commands/test.ts:306-392` does serial-or-concurrent dispatch over a pre-bound `engine` and `reporters`. To make it shard-able, extract the body into a standalone function with explicit parameters — no shared mutable closure state. Signature:

```ts
export interface ShardRunContext {
  engine: PlaywrightEngine;            // shard-local
  reporters: Reporter[];                // shard-local (per-shard subset; merge reporters live elsewhere)
  flowsToRun: ResolvedFlow[];           // shard's slice
  baseUrl: string | undefined;
  envOverrides: Record<string, string>;
  configHooks?: { onFlowStart?: Step[]; onFlowComplete?: Step[] };
  concurrency: number;                  // intra-shard --parallel
  maxRetries: number;
  bailMode: "none" | "local" | "shared";
  abortSignal?: AbortSignal;            // present when bailMode === "shared"
  onLocalFailure?: () => void;          // called on first fail when bailMode === "shared"
  shardCtx?: { shardId: number; shardCount: number };
}

export async function runFlowsForShard(
  ctx: ShardRunContext,
): Promise<{ results: FlowResult[]; error?: Error }>;
```

**Reporter-lifecycle contract (locked, addresses Codex finding 1):**

`runFlowsForShard` emits `onRunStart` and the per-flow events (`onFlowStart`, `onStepStart`, `onStepComplete`, `onFlowComplete`) to `ctx.reporters`. **It does NOT emit `onRunComplete`.** The orchestrator owns `onRunComplete` dispatch — for both per-shard reporters and the merge reporter set. Rationale: `onRunComplete` is what triggers file writes (`json-reporter.ts:25`, `junit-reporter.ts:26`, `html-reporter.ts:23`); placing it inside the helper would either duplicate writes (helper writes per-shard, orchestrator writes again at merge) or hide ordering surprises (helper writes a per-shard `results.json` that gets clobbered if the user passes the same outputDir twice). Keeping the helper dispatch-only matches the existing `executeFlows` shape — it never called `onRunComplete` either (the call lives at `test.ts:446`).

**Return-type contract (locked, addresses Codex R2 finding P2.1 + R4 finding P1):** to preserve partial results when an unrecoverable engine error fires mid-run AND to ensure all sibling concurrent workers settle before the helper returns, `runFlowsForShard` returns `{ results, error? }` and **never throws**.

```ts
export async function runFlowsForShard(
  ctx: ShardRunContext,
): Promise<{ results: FlowResult[]; error?: Error }>;
```

Internally the helper maintains a closure-scoped `const results: FlowResult[] = []` and pushes each `FlowResult` (whether passed/failed/error) as the engine returns it. The try/catch is **inside each concurrent worker, not around the outer Promise.all** — that's the only structure that guarantees all workers settle before the helper returns. Why this matters under `--parallel > 1`: if a single worker's `engine.runFlow()` throws and the catch lives at the Promise.all layer, `Promise.all` rejects on the first worker exception while sibling workers continue running in the background. The helper's outer code reaches `finally`, the orchestrator closes the engine, and sibling workers are now mid-`engine.runFlow()` against a closed browser → race conditions and lost results.

**Helper for safe reporter dispatch.** Applied to **every** reporter call inside the helper — onRunStart, onFlowStart, onStepStart, onStepComplete, onFlowComplete — so a single misbehaving reporter cannot leak into any catch block and corrupt the helper's never-throw contract (addresses Codex R5 finding P3.1 + R6 finding P3):

```ts
const safeEmit = (label: string, fn: () => void): void => {
  try { fn(); }
  catch (rerr) { logger.warn(`reporter ${label} failed: ${rerr instanceof Error ? rerr.message : rerr}`); }
};
```

**`onRunStart` emission at the helper's entry** uses `safeEmit` too:

```ts
const manifest = {
  flows: ctx.flowsToRun.map((f) => ({ name: f.metadata.name, file: f.filePath, stepCount: f.steps.length })),
  totalFlows: ctx.flowsToRun.length,
};
for (const r of ctx.reporters) safeEmit("onRunStart", () => r.onRunStart?.(manifest));
```

**Worker structure (concurrent path):**

```ts
let firstError: Error | undefined;
const queue = ctx.flowsToRun.map((flow, idx) => ({ flow, idx }));
let bailTriggered = false;

const worker = async (): Promise<void> => {
  while (queue.length > 0 && !bailTriggered && !ctx.abortSignal?.aborted && !firstError) {
    const item = queue.shift()!;
    try {
      // Module-local flowToInput from cli/src/commands/test.ts:554. Note we pass
      // the closure-captured ctx fields explicitly — no `ctx.flowToInput`, since
      // ShardRunContext does not (and should not) carry the converter function;
      // it would over-couple the type to commands/test.ts internals.
      const input = flowToInput(item.flow, ctx.baseUrl, ctx.envOverrides, item.idx, ctx.configHooks, ctx.shardCtx);
      const flowId: FlowIdentifier = { name: input.name, file: input.file, flowIndex: item.idx };

      for (const r of ctx.reporters) safeEmit("onFlowStart", () => r.onFlowStart(flowId));
      const onProgress: StepProgressCallback = (event) => {
        if (event.type === "step:start") {
          for (const r of ctx.reporters) safeEmit("onStepStart", () => r.onStepStart?.({ command: event.command, args: event.args }, event.index, event.total, flowId));
        } else {
          for (const r of ctx.reporters) safeEmit("onStepComplete", () => r.onStepComplete(event.result, event.index, event.total, flowId));
        }
      };

      let result = await ctx.engine.runFlow(input, onProgress);
      if (result.status !== "passed" && ctx.maxRetries > 0) {
        for (let attempt = 1; attempt <= ctx.maxRetries; attempt++) {
          result = await ctx.engine.runFlow(input, onProgress);
          if (result.status === "passed") break;
        }
      }

      // results.push happens BEFORE reporter dispatch so a reporter throw
      // (defended against by safeEmit, but belt-and-suspenders) can't strand
      // a completed flow outside the accumulator.
      results.push(result);
      for (const r of ctx.reporters) safeEmit("onFlowComplete", () => r.onFlowComplete(result, flowId));

      if (result.status !== "passed") {
        if (ctx.bailMode === "local") { bailTriggered = true; break; }
        if (ctx.bailMode === "shared") { ctx.onLocalFailure?.(); break; }
      }
    } catch (err) {
      // Reporter throws are already absorbed by safeEmit, so anything reaching
      // here is a real engine failure (browser crash, Playwright bridge throw).
      // Capture firstError; sibling workers see it on next loop iteration.
      if (!firstError) firstError = err instanceof Error ? err : new Error(String(err));
      // Under shared bail, infra errors are also a failure that should abort
      // sibling shards — addresses Codex R6 finding P2. Under local/none bail
      // they only stop this shard's workers (via the firstError check above).
      if (ctx.bailMode === "shared") ctx.onLocalFailure?.();
      break;
    }
  }
};

// CRITICAL: Promise.allSettled, not Promise.all. If one worker throws (despite
// the inner try/catch — defensive), other workers still settle, and the engine
// close in the orchestrator's finally block fires only after all workers exit.
const workerCount = Math.min(ctx.concurrency, ctx.flowsToRun.length);
await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));

return { results, error: firstError };
```

For the **serial path** (concurrency <= 1), the structure is the simpler existing loop. Same `safeEmit` helper applied to all reporter dispatches; same module-local `flowToInput` call shape:

```ts
for (let fi = 0; fi < ctx.flowsToRun.length; fi++) {
  if (ctx.abortSignal?.aborted) break;
  try {
    const input = flowToInput(ctx.flowsToRun[fi]!, ctx.baseUrl, ctx.envOverrides, fi, ctx.configHooks, ctx.shardCtx);
    const flowId: FlowIdentifier = { name: input.name, file: input.file, flowIndex: fi };
    for (const r of ctx.reporters) safeEmit("onFlowStart", () => r.onFlowStart(flowId));
    // ... onProgress wiring identical to concurrent path above (uses safeEmit) ...
    let result = await ctx.engine.runFlow(input, onProgress);
    // ... retry loop ...
    results.push(result);
    for (const r of ctx.reporters) safeEmit("onFlowComplete", () => r.onFlowComplete(result, flowId));
    if (result.status !== "passed") {
      if (ctx.bailMode === "local") break;
      if (ctx.bailMode === "shared") { ctx.onLocalFailure?.(); break; }
    }
  } catch (err) {
    if (!firstError) firstError = err instanceof Error ? err : new Error(String(err));
    if (ctx.bailMode === "shared") ctx.onLocalFailure?.();   // signal sibling shards (R6 P2)
    break;     // serial path stops immediately — no sibling workers to drain
  }
}
return { results, error: firstError };
```

**Why this passes Codex R4 P1:** the only path out of `runFlowsForShard` is `Promise.allSettled(...).then(...)` (concurrent) or the natural for-loop exit (serial). Neither releases control while a worker is mid-flow. Any flow that started runs to completion (or to its own internal hardTimeout per CLAUDE.md `executor invariants`). The orchestrator's `finally { engine.close() }` only runs after every worker has exited.

A test for this is added at Phase 4.6.7 case 4: spawn `--parallel 3`, mock `engine.runFlow` to throw on the second call but resolve a 500ms-delayed result on the third, assert (a) the third result is in `outcome.results`, (b) `outcome.error` is set, (c) the global Timer measured at engine.close() time is >= 500ms (not the immediate-rejection time of ~1ms).

Per-flow handlers' ordering rule: `results.push(result)` first, then reporter dispatch. Reporter throws are caught per-call so a single reporter cannot strand the loop. Same hygiene as Phase 2.5's `emitRunComplete`.

Body is ~80 lines (lifted, near-verbatim, from current `executeFlows` lines 313-389). Behavioural deltas:

1. **Pre-flow abort check.** Both serial and concurrent dispatch loops check `ctx.abortSignal?.aborted` at the top of each iteration; if aborted, break. Existing bail handling becomes branch-by-bailMode in BOTH the serial loop and each concurrent worker:
   ```ts
   // Serial loop body (replaces test.ts:342-345):
   if (result.status !== "passed") {
     if (ctx.bailMode === "local") break;
     if (ctx.bailMode === "shared") {
       ctx.onLocalFailure?.();   // flips the cross-shard AbortController
       break;                     // and stop this shard's loop
     }
   }

   // Concurrent worker (replaces test.ts:380-382):
   const worker = async () => {
     while (queue.length > 0 && !bailTriggered && !ctx.abortSignal?.aborted) {
       const item = queue.shift()!;
       // ... build input + run flow + retry, exactly as today ...
       if (result.status !== "passed") {
         if (ctx.bailMode === "local") {
           bailTriggered = true;       // shard-local flag; sibling workers in this shard see it
           break;
         }
         if (ctx.bailMode === "shared") {
           ctx.onLocalFailure?.();     // flips the SHARED AbortController — visible to siblings AND
                                       // to this shard's other workers via abortSignal.aborted on next iter
           break;
         }
       }
     }
   };
   ```
   **Key invariant** (addresses Codex finding 3 R2): under `bailMode === "shared"`, the AbortController is a single shared object passed to every shard. When ANY worker in ANY shard calls `onLocalFailure` → `abortController.abort()`, every other worker (in this shard and sibling shards) observes `abortSignal.aborted === true` on their next loop check and stops pulling work. Combined with the "in-flight flow runs to completion" semantics from Phase 3.5, this makes `--shard-split N --parallel M --bail` reliable: the failing flow's worker triggers the abort, all `N×M − 1` other workers complete their current flow then halt.
2. **`flowToInput` call gets `shardCtx`** — passes the env injection through.
3. **`onAbort` from AbortSignal in concurrent mode:** the `worker()` loop checks `ctx.abortSignal?.aborted` *between* flows. An in-flight flow runs to completion (matches the user-prompt's "stop after their current flow" semantics).
4. **Worker-pool sizing uses `ctx.flowsToRun.length`, not a captured outer variable** (addresses Codex finding 7). The current code at `test.ts:386-388` has:
   ```ts
   await Promise.all(
     Array.from({ length: Math.min(concurrency, filtered.length) }, () => worker()),
   );
   ```
   `filtered` is the outer closure's full input list. After lifting, this MUST become `Math.min(ctx.concurrency, ctx.flowsToRun.length)` — otherwise a shard with 2 flows + `concurrency: 4` would spawn 4 workers (harmless waste under sharding because the queue empties fast, but the latent bug also affects the existing TUI failed-only rerun path at `test.ts:431`, where `failedFlows` is passed but `filtered.length` was used for worker count). Fixing during the lift kills both bugs.

Non-sharded run path (no `--shard-split`/`--shard-all`) calls `runFlowsForShard` exactly once with `shardCtx: undefined`, `bailMode: shouldBail ? "local" : "none"`, then the orchestrator emits `onRunComplete` to the same reporter set. The same code path serves both single-engine and per-shard-engine cases, eliminating duplicated dispatch logic.

### 1.6 Replace `executeFlows` in `commands/test.ts` with a thin orchestrator

**File:** `cli/src/commands/test.ts:306-392`

Replace the inline `executeFlows` closure with a call to the new helper. The TUI rerun callbacks (`onRerun`, `onRerunFailed` at lines 421-435) get a small wrapper closure that calls the helper with the standalone path's parameters.

---

## Phase 2 — Reporter multiplexing + merge

### 2.1 Per-shard `outputDir` strategy (collision avoidance, zero engine changes)

**Per shard:** `outputDir = join(rootOutputDir, "shard-${i + 1}")`. Each shard's `PlaywrightEngine` is constructed with this per-shard outputDir, which means:

- Per-flow `flowDir = join(rootOutputDir, "shard-${i + 1}", "${safeName}-${flowIndex}")` — collisions impossible even under `--shard-all` where every shard runs the same flows with the same `flowIndex`.
- Per-shard `results.json` / `junit.xml` / `report.html` land naturally in the shard's subdir because reporters use `outputDir` for path joining.
- No changes to `playwright-engine.ts` line 75-82 (the `safeName + flowIndex` derivation). No changes to file-reporter classes.

### 2.2 Top-level merge path

After all shards finish their `Promise.all`, the orchestrator constructs a merged `RunSummary` and writes the canonical top-level report files. Two distinct reporter sets:

| Reporter set | Output path | When called |
|---|---|---|
| **Per-shard reporters** (one set per shard) | `outputDir/shard-{i+1}/...` | All lifecycle methods — `onRunStart`, `onFlowStart`, `onStepComplete`, `onFlowComplete`, `onRunComplete` |
| **Merge reporters** (one set, top-level) | `outputDir/...` | `onRunComplete` ONLY, with merged summary across all shards |
| **Notification reporters** (Slack / Webhook) | network | `onRunComplete` ONLY, with merged summary; fire **once** total |

The `onRunComplete` order is: per-shard reporters first (in shard order), then merge reporters, then notification reporters. Notifications fire on the merged result so users get a single "X passed, Y failed" Slack message, not N per-shard ones.

### 2.3 ConsoleReporter shard prefix

**File:** `cli/src/reporter/console-reporter.ts:10-124`

Extend the constructor with two optional fields:

```ts
constructor(opts: {
  verbose?: boolean;
  concurrency?: number;
  shardLabel?: string;          // e.g. "[shard 1]". When set, every console.log line is prefixed.
  suppressFinalSummary?: boolean; // When true, onRunComplete is a no-op.
} = {}) { ... }
```

Behavior changes (each ~3 lines):
- A small `private write(line: string)` helper centralizes output: `console.log(this.shardLabel ? `${this.shardLabel} ${line}` : line)`. Existing `console.log(...)` calls inside the reporter (lines 28-32, 74-78, 102-106, 110-122) are redirected through `write()`. **Buffer flushing (lines 67-71, 91-99) goes through `write()` too.**
- `onRunComplete` early-returns if `this.suppressFinalSummary` is true.

Per-shard ConsoleReporter constructor: `{ shardLabel: "[shard ${i+1}]", suppressFinalSummary: true, verbose, concurrency }`.

Merge ConsoleReporter constructor: `{ verbose, concurrency: 1 }` (no shardLabel, no suppression). It receives only `onRunComplete`, so flow-event handlers are no-ops and the buffered-mode code paths never trigger.

### 2.4 Build merged `RunSummary` — superseded by Phase 3.7

The full merge logic — including synthetic shard-error entries (`buildShardErrorEntry`), deterministic `(originalFlowIndex, shardId)` sort, and the `passed + failed === total` invariant — lives inline in **Phase 3.7** because it requires access to `ShardOutcome[]` (timer + error + reporters per shard), which only exists at the orchestrator level. Reusing the existing `buildSummary` (test.ts:395) is not enough because it can't synthesize shard infrastructure-error entries or apply the deterministic sort.

This section is kept as a roadmark — a reader of Phase 2 might expect a "merge" subsection here. Implementation lives in Phase 3.7's Step 3 block. `buildSummary` is still reused by the non-sharded path (Phase 1.6 fall-through).

### 2.5 Notification-reporter wiring (all call sites enumerated — addresses Codex finding 6)

Currently in `test.ts:213-214`, notifications are appended to the `reporters[]` list alongside file/console reporters. There are **four** call sites that fire `onRunComplete` today, all at near-identical lines that pass the union list:

| Call site | Line | Path | Fix |
|---|---|---|---|
| Initial run | `test.ts:446` | `await Promise.all(reporters.map(r => Promise.resolve(r.onRunComplete(summary))))` | Replace with helper that takes `(perRunReporters, notificationReporters, summary)` — see below |
| TUI rerun | `test.ts:424` | `onRerun` callback inside `renderTUI` | Same helper |
| TUI rerun-failed | `test.ts:433` | `onRerunFailed` callback | Same helper |
| Watch mode rerun (TUI branch) | `test.ts:535` | inside `w.on("change", ...)` when `tui` is set | Same helper |
| Watch mode rerun (non-TUI branch) | `test.ts:538` | inside `w.on("change", ...)` recurses via `runTest(...)` | No change needed — recursion re-enters the orchestrator and notifications fire from the recursive call's initial-run path |

**Fix:** introduce a small helper in `test.ts`. The signature is built to handle three cases — a single non-sharded run (primary file reporters + notifications), per-shard completion (reporters only, no notifications), and the final merge (merge reporters + notifications). **Reporter throws are caught per-reporter so a single misbehaving reporter never aborts the orchestrator** (addresses Codex R3 finding P1.2 — without this, a per-shard HtmlReporter throw at Step 2 would skip the merge step and notifications):

```ts
async function emitRunComplete(
  primary: Reporter[],
  notifications: Reporter[],
  summary: RunSummary,
): Promise<void> {
  const safe = async (r: Reporter, label: string) => {
    try {
      await Promise.resolve(r.onRunComplete(summary));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`${label} reporter onRunComplete failed: ${msg}`);
    }
  };
  await Promise.all(primary.map((r) => safe(r, r.constructor.name)));
  if (notifications.length > 0) {
    await Promise.all(notifications.map((r) => safe(r, r.constructor.name)));
  }
}
```

Sequential dispatch (file reporters first, notifications second) so Slack/Webhook payloads see file outputs that already exist on disk — users clicking the link land on a written `results.json`. Per-reporter `try/catch` means a corrupted JSON write or an HtmlReporter template error is logged-and-skipped; downstream reporters and the merge step always run.

**Variable rename in `runTest`:** the existing `reporters: Reporter[]` (built at lines 197-214) becomes `perRunReporters: Reporter[]` (everything except notifications) and a separate `notificationReporters: Reporter[]` (returned by `createNotificationReporters`). All four single-run call sites change to call `emitRunComplete(perRunReporters, notificationReporters, summary)`.

**All `onRunComplete` dispatch goes through `emitRunComplete`** — this is the locked invariant. Per-shard call sites pass `[]` as `notifications` (no Slack per shard); the merge call site passes the real notification list (one Slack message per `skeptic test` invocation). See Phase 3.7 for the multi-shard wiring.

The notification-wiring integration test at `cli/__tests__/integration/notifications-wiring.test.ts` (which imports `createNotificationReporters` and `runTest`) must keep passing — verify after the refactor that it still asserts notifications fire on `onRunComplete` once per invocation.

### 2.6 What about `skeptic-output/shard-1/` for single-shard runs?

When `--shard-split 1` or `--shard-all 1` is given (or coerced down to 1 via the `min(N, flowCount)` clamp), the orchestrator short-circuits to the non-sharded path: no `shard-1/` subdir created, no merge step, identical output to running without the flag. **Implementation:** `if (effectiveShards <= 1) return runFlowsForShard({ shardCtx: undefined, ... })` before entering the shard-spawn loop.

### 2.7 Per-flow shard label in JUnit / HTML / Slack / Webhook reporters (addresses Codex finding 3 + R6 finding 3)

Under `--shard-all`, the merged `results.json` has N copies of each flow (one per shard) — distinguishable by `flow.shardId`. JUnit and HTML reporters today render a flow's name verbatim:
- `junit-reporter.ts:31, 45, 55, 58, 62` — `<testsuite name="${flow.name}">`, `<testcase classname="${flow.name}">`. Two `--shard-all` runs of "homepage" both render as `<testsuite name="homepage">`. Most CI dashboards (Jenkins, GitLab) collapse same-named suites — duplicate runs lost.
- `html-reporter.ts:175` — `<span class="name">${esc(flow.name)}...` — both runs visually identical to the user.

**Fix:** in both reporters, when `flow.shardId !== undefined`, suffix the visible name with ` [shard ${flow.shardId + 1}]`. One small helper:

```ts
// Place in cli/src/reporter/types.ts (or a new shared util)
export function formatFlowDisplayName(flow: { name: string; shardId?: number }): string {
  return flow.shardId === undefined ? flow.name : `${flow.name} [shard ${flow.shardId + 1}]`;
}
```

Used by:
- **JUnitReporter** (`buildTestSuite`, lines 45-62): replace every `flow.name` interpolation with `formatFlowDisplayName(flow)`. Both `<testsuite name="...">` and `<testcase classname="...">` get the suffix. Tests that hand-construct `FlowResult` literals without `shardId` are unaffected (suffix only fires when `shardId !== undefined`).
- **HtmlReporter** (`buildFlowSection`, line 175): replace `${esc(flow.name)}` with `${esc(formatFlowDisplayName(flow))}`.
- **SlackReporter** (`buildSlackPayload`, line 105 — `failedFlows.map((f) => `• ${f.name}`)`): replace `${f.name}` with `${formatFlowDisplayName(f)}`. Without this, `--shard-all` failures show two lines reading `• homepage` with no way to tell them apart in Slack — visually broken for cross-shard parity diagnostics, which is the whole point of `--shard-all`.
- **WebhookReporter** (`buildWebhookPayload`, line 69 — `name: f.name`): change to `name: formatFlowDisplayName(f)`. Also extend `WebhookPayloadFlow` (line 42-48) with an optional `shardId?: number` field so consumers can pivot/group programmatically without parsing the suffix back out of `name`. Both fields are populated together; `shardId` is omitted when not in a sharded run (back-compat).

ConsoleReporter doesn't need this change — its output is already prefixed at the line level via `shardLabel` (Phase 2.3), and the merge ConsoleReporter only fires `onRunComplete` (no per-flow output).

**Test impact:** existing JUnit / HTML / Slack / Webhook reporter tests keep passing because `flow.shardId` is undefined in their fixtures. Add new cases to:
- `cli/__tests__/unit/reporter/junit-reporter.test.ts` — shard-suffixed `<testsuite>` + `<testcase classname>`.
- `cli/__tests__/unit/reporter/html-reporter.test.ts` — shard-suffixed `.flow-header .name`.
- `cli/__tests__/unit/reporter/slack-reporter.test.ts` — shard-suffixed bullet line in failure block.
- `cli/__tests__/unit/reporter/webhook-reporter.test.ts` — payload `flows[i].name` carries suffix; `flows[i].shardId` populated when set.

---

## Phase 3 — CLI wiring + flag-conflict policy

### 3.1 Flag declarations + tightened validators (addresses Codex finding 4)

**Problem:** the current `parsePositiveInt` at `cli/src/index.ts:13-17` does:
```ts
const n = parseInt(value, 10);
if (isNaN(n) || n < 1) throw new Error(`--parallel must be a positive integer, got "${value}"`);
return n;
```
Two latent issues that become severe under `--shard-*`:
1. `parseInt("1.5", 10)` returns `1` silently. `--shard-all 1.5` would launch 1 Chromium instead of erroring out — confusing UX but not catastrophic.
2. **No upper bound.** `--shard-all 100000` would attempt to launch 100,000 Chromium processes — an effective denial-of-service-on-self with very little CLI surface to defend against the typo.

**Fix:** replace `parsePositiveInt` with two strict validators:

```ts
function parsePositiveInt(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`expected a positive integer, got "${value}"`);
  }
  return Number(value);
}

const SHARD_MAX = 64;
function parseShardCount(value: string): number {
  const n = parsePositiveInt(value);
  if (n > SHARD_MAX) {
    throw new Error(`--shard-* must be at most ${SHARD_MAX}, got ${n} (use a coordinator if you need more parallelism)`);
  }
  return n;
}
```

The integer-only regex is a small breaking change for anyone passing `--parallel 1.5` (silently truncated to 1 today; errors out after this change). Worth it — this is a usage error, not a meaningful contract.

`SHARD_MAX = 64` is conservative (typical CI runners have ≤16 cores and Chromium-per-shard hits ~500 MB RSS). Users wanting more than 64 likely want cross-machine sharding, which is anti-scope.

**Flag declarations in `cli/src/index.ts:46-80`** — add after `--parallel` (line 73):

```ts
.option("--shard-split <n>", "split flows across N browser instances (each runs disjoint subset)", parseShardCount)
.option("--shard-all <n>", "run all flows on each of N browser instances", parseShardCount)
```

`--parallel` keeps using `parsePositiveInt` (no shard cap; arbitrary high concurrency inside one engine is the user's call).

### 3.2 Extend `TestCommandOptions`

**File:** `cli/src/commands/test.ts:63-93`

```ts
export interface TestCommandOptions {
  // ... existing fields
  shardSplit?: number;
  shardAll?: number;
}
```

### 3.3 Conflict matrix (validation block at top of `runTest`)

**Validation runs in two stages.** Stage A is mutual exclusion + flag-shape (fires immediately, doesn't depend on flow count). Stage B is the cross-feature guards (`--watch`, TUI) — these are gated on **`effectiveShards > 1`**, not on whether the user passed the flag, so that `--shard-split 1` and `--shard-split 100` against 1 flow (clamped to 1) fall cleanly through to the non-sharded path without hitting irrelevant rejections.

**Stage A — immediately after `cmdOpts` arrive (right after line 110, before `loadConfig`):**

```ts
// Mutual exclusion is shape-only — always wrong combo, exit fast regardless of flow count.
if (opts.shardSplit !== undefined && opts.shardAll !== undefined) {
  console.error("--shard-split and --shard-all are mutually exclusive.");
  process.exit(2);
}
const shardMode: "split" | "all" | "none" =
  opts.shardSplit !== undefined ? "split"
  : opts.shardAll !== undefined ? "all"
  : "none";
const requestedShards = opts.shardSplit ?? opts.shardAll ?? 1;

// Stage B (TUI + watch guards) deferred — they require effectiveShards from Phase 3.6.
```

**Why the deferred path matters:** the user-prompt locked invariant (Phase 2.6) is "single-shard runs are indistinguishable from non-sharded runs." `skeptic test --shard-split 1` in an interactive terminal must take the same code path as plain `skeptic test`. If we ran the TUI guard on `shardMode !== "none"`, that user gets `exit 2` — wrong. Gating on `effectiveShards > 1` makes `--shard-split 1` (or any clamped-to-1 invocation) silently fall through.

### 3.4 TUI + watch rejection — gated on `effectiveShards > 1`

After Phase 3.6's clamp computes `effectiveShards`, AND after `useInteractiveTUI` is computed at `test.ts:195`, run Stage B:

```ts
const useInteractiveTUI = ciInfo.isInteractive && !opts.noTui && !hasExplicitNonConsoleReporter;

if (effectiveShards > 1 && opts.watch) {
  console.error("--shard-split / --shard-all cannot be combined with --watch. Watch mode is interactive; sharding is for CI.");
  process.exit(2);
}
if (effectiveShards > 1 && useInteractiveTUI) {
  console.error("--shard-split / --shard-all is incompatible with the interactive TUI. Pass --no-tui or run with a non-console reporter (e.g. --reporter junit).");
  process.exit(2);
}
```

CI runs are unaffected: `useInteractiveTUI` is already false in CI (`ciInfo.isInteractive === false`).

**Implementation ordering note:** since `effectiveShards` depends on `filtered.length` (from line 168), and `useInteractiveTUI` is computed at line 195, both Stage B guards land between roughly line 195 and line 200 in the post-revision `runTest`. The clamp itself (Phase 3.6) is bumped slightly earlier — runs immediately after `filtered` exists at line 168 — so `effectiveShards` is in scope by the time the Stage B block fires.

### 3.5 Bail-mode resolution — gated on `effectiveShards > 1`

The bail mode resolution **must run after Phase 3.6's `effectiveShards` clamp**, not before — otherwise `--shard-split 1 --bail` would resolve to `bailMode === "shared"` even though the orchestrator short-circuits to the single-engine path (where no `AbortController` is created and `onLocalFailure` is never wired). `runFlowsForShard` would then silently misbehave: under shared bail with no shared signal, concurrent workers never see `abortSignal.aborted` and keep draining the queue past the first failure. This breaks the locked single-shard-is-indistinguishable-from-non-sharded contract.

```ts
const shouldBail = opts.bail ?? config.execution.bail;
let bailMode: "none" | "local" | "shared" = "none";
if (shouldBail) {
  if (shardMode === "split" && effectiveShards > 1) {
    bailMode = "shared";   // first failure in any shard signals all sibling shards
  } else if (shardMode === "all" && effectiveShards > 1) {
    logger.warn("--bail is ignored under --shard-all (the whole point of --shard-all is to observe per-instance variance).");
    bailMode = "none";
  } else {
    // Covers: shardMode === "none", OR effectiveShards <= 1 (clamped or user-requested).
    // Both paths run a single engine, so local bail is the only mode that works correctly.
    bailMode = "local";
  }
}
```

The `--shard-all` warning is only emitted when actual multi-shard-all execution is happening (`effectiveShards > 1`); single-shard `--shard-all 1 --bail` falls through to local bail with no warning, indistinguishable from plain `skeptic test --bail`.

### 3.6 Effective shard count + clamp

```ts
let effectiveShards = requestedShards;
if (shardMode === "split") {
  effectiveShards = Math.min(requestedShards, filtered.length);
  if (requestedShards > filtered.length) {
    logger.warn(
      `--shard-split ${requestedShards} requested but only ${filtered.length} flow(s) — running ${effectiveShards} shard(s).`,
    );
  }
}
// --shard-all: no clamp. Run requested N regardless of flow count.
if (shardMode !== "none" && effectiveShards <= 1) {
  // Single-shard run is indistinguishable from non-sharded — fall through to existing path.
  // (effectiveShards = 0 is impossible because parsePositiveInt rejects it.)
}
```

`shardMode === "none"` falls through to the existing `runFlowsForShard({ shardCtx: undefined, ... })` call. `shardMode !== "none" && effectiveShards >= 2` enters the multi-shard orchestration block (3.7).

### 3.7 Multi-shard orchestration block (addresses Codex R2 findings 1 + 2)

**Locked contract:** `runFlowsForShard` returns `Promise<{ results, error? }>` (Phase 1.5). It does NOT call `onRunComplete`. The orchestrator owns ALL `onRunComplete` dispatch — emitted via `emitRunComplete` for both the per-shard reporter sets and the final merge set, in this order:

1. Each shard's `runFlowsForShard` runs to completion (`Promise.all`). Each shard's outcome is captured in a `ShardOutcome` (typed in the snippet below) carrying `results: FlowResult[]`, optional `error: Error`, the per-shard `reporters`, and `durationMs` (a frozen snapshot of that shard's wall-clock time, captured in its `finally` block).
2. For each shard (iterated in shard-id order, sequentially): build a per-shard `RunSummary` from that shard's `ShardOutcome.results` PLUS — when `outcome.error` is set — a synthetic `FlowResult` for the shard infrastructure error (so per-shard `results.json` accurately reports the crash; without it, a launch-failed shard's `results.json` would render `total: 0, passed: 0, failed: 0` and silently lie). Call `emitRunComplete(shardReporters, [], shardSummary)`. **Notifications get `[]` here so Slack/Webhook do not fire per shard.**
3. Build the merged `RunSummary` by concatenating every shard's `results` plus the synthetic error entries from Step 2 (de-duplicated — each error appears once, sourced from the same builder helper). Sort by `(originalFlowIndex, shardId)`. Call `emitRunComplete(mergeReporters, notificationReporters, mergedSummary)` — writes top-level files and fires Slack/Webhook exactly once.

Replaces the `await engine.launch(); const results = await executeFlows(filtered)` lines at 442-443:

```ts
// Step 0: pre-run cleanup of stale shard subdirs — manifest-gated for safety
// (addresses Codex R6 finding 2 + R2 finding P2.2).
//
// Naive regex cleanup would delete user-owned `shard-N/` directories if the user
// passes `--output .` or a shared artifact dir. Instead, only delete subdirs that
// the PREVIOUS sharded run wrote — tracked via a manifest file we own.
//
// File: ${outputDir}/.skeptic-shard-manifest.json — { version: 1, shards: ["shard-1", ...] }
// - First sharded run with no manifest: no cleanup (we don't own anything yet).
// - Subsequent sharded runs: read the manifest, delete ONLY those listed shards,
//   then write a fresh manifest listing this run's shards before any shard fires.
// - Non-sharded runs (effectiveShards <= 1) never read or write the manifest — the
//   short-circuit in Phase 1.6 fires before this orchestrator block.
await fs.promises.mkdir(outputDir, { recursive: true });
const manifestPath = path.join(outputDir, ".skeptic-shard-manifest.json");
const priorManifest: { version: number; shards: string[] } | null = await (async () => {
  try {
    const raw = await fs.promises.readFile(manifestPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && Array.isArray(parsed.shards)) return parsed;
    return null;
  } catch { return null; }
})();
if (priorManifest) {
  await Promise.all(
    priorManifest.shards
      .filter((name) => /^shard-\d+$/.test(name))   // belt-and-suspenders sanity check
      .map((name) => fs.promises.rm(path.join(outputDir, name), { recursive: true, force: true })),
  );
}
// Write the new manifest BEFORE shards fire so a crashed run still leaves an
// authoritative record of what to clean up next time.
const newShardNames = Array.from({ length: effectiveShards }, (_, i) => `shard-${i + 1}`);
await fs.promises.writeFile(
  manifestPath,
  JSON.stringify({ version: 1, shards: newShardNames }, null, 2),
  "utf-8",
);

const partitions = partitionFlows(filtered, effectiveShards, shardMode);
const abortController = bailMode === "shared" ? new AbortController() : undefined;

interface ShardOutcome {
  shardId: number;
  results: FlowResult[];
  reporters: Reporter[];
  outputDir: string;
  /** Wall-clock duration of THIS shard from start to engine-close.
   *  Snapshotted in the per-shard finally block (Codex R7 P2) so a fast shard
   *  doesn't accumulate idle time while waiting for slower sibling shards in
   *  Promise.all. Frozen value, not a live Timer reference. */
  durationMs: number;
  error?: Error;            // populated if shard launch/run threw — addresses R2 finding P1
}

// Use Promise.all with try/catch INSIDE each shard's body — covering reporter
// construction, engine.launch, runFlowsForShard, AND engine.close. (Addresses
// Codex R2 finding P1.2: creating reporters before the try meant a reporter
// constructor / dynamic import failure would reject the shard promise and skip
// the merge path. Now everything from "enter the partitions.map callback" through
// "engine fully closed" is inside the try — no shard can ever reject the outer
// Promise.all.)
const shardOutcomes: ShardOutcome[] = await Promise.all(
  partitions.map(async (slice, shardId): Promise<ShardOutcome> => {
    const shardOutputDir = path.join(outputDir, `shard-${shardId + 1}`);
    const shardTimer = new Timer();   // ticks from this shard's start, not the global run start

    let shardReporters: Reporter[] = [];
    let shardEngine: PlaywrightEngine | null = null;
    let results: FlowResult[] = [];
    let error: Error | undefined;

    try {
      // Reporter construction can throw on dynamic import / constructor errors
      // (e.g. corrupted node_modules). Now inside the try.
      shardReporters = await createReporters(reporterFormats, shardOutputDir, {
        verbose: opts.verbose ?? config.output.verbose,
        concurrency,
        shardLabel: `[shard ${shardId + 1}]`,
        suppressFinalSummary: true,    // ConsoleReporter only — file reporters still write
      });

      const shardEngineOpts: EngineOptions = { ...engineOpts, outputDir: shardOutputDir, shardId };
      shardEngine = new PlaywrightEngine(shardEngineOpts);
      await shardEngine.launch();

      // runFlowsForShard never throws (Phase 1.5 contract); returns { results, error? }
      const outcome = await runFlowsForShard({
        engine: shardEngine,
        reporters: shardReporters,
        flowsToRun: slice,
        baseUrl, envOverrides,
        configHooks: config.hooks,
        concurrency, maxRetries,
        bailMode,
        abortSignal: abortController?.signal,
        onLocalFailure: () => abortController?.abort(),
        shardCtx: { shardId, shardCount: effectiveShards },
      });
      results = outcome.results;       // partial-on-error preserved
      if (outcome.error) error = outcome.error;
    } catch (err) {
      // Setup failures (createReporters / launch) land here. runFlowsForShard does
      // not throw — its errors come back via outcome.error above. Catastrophic
      // path only.
      error = err instanceof Error ? err : new Error(String(err));
      logger.error(`[shard ${shardId + 1}] setup failed: ${error.message}`);
      // Shared-bail propagation for infra errors (Codex R6 P2). Without this,
      // sibling shards keep running on after a launch/setup crash here.
      if (bailMode === "shared") abortController?.abort();
    } finally {
      if (shardEngine) {
        await shardEngine.close().catch((closeErr) => {
          // Don't mask the original error with a close failure; log and move on.
          logger.warn(`[shard ${shardId + 1}] engine close failed: ${closeErr instanceof Error ? closeErr.message : closeErr}`);
        });
      }
    }
    // Snapshot duration AT THE END of this shard's work (after close() returns)
    // — addresses Codex R7 P2. If we read shardTimer.elapsedMs() after Promise.all
    // returns, every shard would report ~global wall-clock, masking how long this
    // particular shard actually took.
    const durationMs = Math.round(shardTimer.elapsedMs());
    return { shardId, results, reporters: shardReporters, outputDir: shardOutputDir, durationMs, error };
  }),
);

// Helper: build a synthetic FlowResult for a shard that crashed during setup
// or mid-run. Used by both per-shard summaries (Step 2) and the merged summary
// (Step 3) so the same crash entry appears in both — single source of truth.
// Reads from `o.durationMs` (snapshotted in the shard's finally block, NOT a
// live timer) so per-shard and merged renderings produce byte-identical entries
// even though they're constructed at different points in the orchestrator
// (addresses Codex R7 P2 second half).
const buildShardErrorEntry = (o: ShardOutcome): FlowResult | null => {
  if (!o.error) return null;
  return {
    name: `[shard ${o.shardId + 1}] infrastructure error`,
    file: `<shard-${o.shardId + 1}-error>`,
    status: "error" as const,
    duration_ms: o.durationMs,
    steps: [{
      command: "shardSetup",
      args: {},
      status: "error" as const,
      duration_ms: 0,
      error: o.error.message,
    }],
    shardId: o.shardId,
  };
};

// Step 2: per-shard onRunComplete. Iterate in shard-id order so log lines are
// interleaved in deterministic shard order at flush time. Notifications NOT fired
// per-shard. Per-shard summary reads `outcome.durationMs` (R6 finding 5 + R7 P2):
// a frozen snapshot of THAT shard's elapsed time, captured in its finally block,
// so a fast shard's results.json duration_ms is its own runtime, not the slowest
// sibling's wall-clock total.
// Crashed shards include the synthetic infra-error entry in their per-shard summary
// (addresses Codex R3 finding P2.2 — without it, a launch-failure shard would write
// a per-shard results.json with total=0, falsely implying "nothing to do" rather
// than "crashed before running").
for (const outcome of shardOutcomes) {
  const errorEntry = buildShardErrorEntry(outcome);
  const shardFlows = errorEntry ? [...outcome.results, errorEntry] : outcome.results;
  const shardSummary: RunSummary = {
    total: shardFlows.length,
    passed: shardFlows.filter((r) => r.status === "passed").length,
    failed: shardFlows.filter((r) => r.status !== "passed").length,
    duration_ms: outcome.durationMs,    // snapshot from finally block, not a live Timer
    flows: shardFlows,
  };
  await emitRunComplete(outcome.reporters, [], shardSummary);
}

// Step 3: build the merged-top-level result list with deterministic ordering
// (R6 finding 6). Reuses the same buildShardErrorEntry helper from Step 2 so the
// per-shard and merged synthetic-error entries are byte-identical. Addresses Codex
// R2 finding P1.1: errored shards are counted via `flows[]` membership so the
// invariant `passed + failed === total` holds at the merge layer too.
const syntheticShardErrors: FlowResult[] = shardOutcomes
  .map(buildShardErrorEntry)
  .filter((e): e is FlowResult => e !== null);

const originalIndexByFile = new Map(filtered.map((f, i) => [f.filePath, i]));
const allResults = [
  ...shardOutcomes.flatMap((o) => o.results),
  ...syntheticShardErrors,
].sort((a, b) => {
  const aIdx = originalIndexByFile.get(a.file) ?? Number.MAX_SAFE_INTEGER;
  const bIdx = originalIndexByFile.get(b.file) ?? Number.MAX_SAFE_INTEGER;
  if (aIdx !== bIdx) return aIdx - bIdx;
  return (a.shardId ?? 0) - (b.shardId ?? 0);
});
// Synthetic shard-error entries land at the end of `flows` (their `file` sentinel is
// not in originalIndexByFile, so they sort to MAX_SAFE_INTEGER — predictable trailing
// position, not interleaved with real flow results).

const mergedSummary: RunSummary = {
  total: allResults.length,
  passed: allResults.filter((r) => r.status === "passed").length,
  failed: allResults.filter((r) => r.status !== "passed").length,    // INCLUDES synthetic errors — invariant: passed + failed === total
  duration_ms: Math.round(timer.elapsedMs()),   // GLOBAL wall-clock here is correct — total run time
  flows: allResults,
};

const mergeReporters = await createReporters(reporterFormats, outputDir, {
  verbose: opts.verbose ?? config.output.verbose,
  concurrency: 1,
  // No shardLabel, no suppressFinalSummary — merge reporters render the canonical
  // top-level summary and write top-level files.
});
await emitRunComplete(mergeReporters, notificationReporters, mergedSummary);

// Exit code: 1 if any flow failed (synthetic shard-errors are now in mergedSummary.failed
// per the invariant above, so a single check covers both flow failures and shard
// infrastructure failures).
process.exitCode = mergedSummary.failed > 0 ? 1 : 0;
```

**Why try/catch instead of `Promise.allSettled`:** the `try`/`catch` shape lets us close the engine in `finally` per shard with `await`, and surface the error into a typed `ShardOutcome.error` field rather than relying on the union type `{status: 'fulfilled'|'rejected', ...}` from `allSettled`. Same outcome, easier downstream code, and engine cleanup is unconditional regardless of which promise rejects.

**`buildSummary` is no longer used in the orchestrator's per-shard or merged-summary blocks** — the inline construction lets us swap `duration_ms` to the frozen per-shard `outcome.durationMs` snapshot (R6 finding 5 + R7 P2) for shard summaries, and the global `timer.elapsedMs()` for the merged summary, which `buildSummary` couldn't do without a parameter. The non-sharded path (Phase 1.6 fall-through) keeps using `buildSummary` unchanged.

**`createReporters` extension** (test.ts:666-708) gains three optional fields in its `opts` arg: `shardLabel?: string`, `suppressFinalSummary?: boolean` (both forwarded verbatim to `new ConsoleReporter(...)`), plus the existing `verbose` and `concurrency`. JSON / JUnit / HTML reporters ignore the extra fields. One-line addition per case in the switch.

**`emitRunComplete` is now used at every onRunComplete dispatch site in the codebase** — the four single-run sites from Phase 2.5 plus the two multi-shard sites in this block. No raw `Promise.all(reporters.map(r => r.onRunComplete(...)))` remains anywhere in `commands/test.ts`.

### 3.8 `--analyze` interaction

`--analyze` (test.ts:449-497) currently runs after `executeFlows` against `summary.failed`. Under sharding it runs against `mergedSummary.failed` — same flow `results.json` data, just with `shardId` populated on each entry. AI failure analysis is per-flow, not per-shard, so the existing loop at line 473 (`for (const flow of failedFlows)`) handles sharded results unchanged.

### 3.9 Summary of compose semantics

| Combination | Behavior |
|---|---|
| `--shard-split N --parallel M` | N shards, each running M flows concurrently inside its engine (compose). Total max concurrency: N×M. |
| `--shard-all N --parallel M` | Same — each shard runs all flows with concurrency M. |
| `--shard-split N --bail` | First failure in any shard aborts all sibling shards (after their in-flight flow completes). Shared `AbortController`. |
| `--shard-all N --bail` | `--bail` ignored with warning. (`--shard-all` is for observing variance — early stop defeats the purpose.) |
| `--shard-* N --retries R` | Per flow within its shard. Same as `--parallel --retries`. |
| `--shard-* N --watch` | Rejected at startup (exit 2) with clear message. |
| `--shard-* N` + interactive TUI | Rejected at startup (exit 2) with clear message; `--no-tui` makes it work. |
| `--shard-split N` with N > flow count | Coerced to flow count, warning emitted. |
| `--shard-split 1` / `--shard-all 1` | Falls through to single-engine path (no `shard-1/` subdir created). |
| `--shard-split N --shard-all M` | Mutually exclusive — exit 2. |

---

## Phase 4 — Tests

### 4.1 Unit: `partitionFlows` determinism + edge cases

**File (new):** `cli/__tests__/unit/executor/shard-partition.test.ts`

Pure function, fast, no fixtures. Use a tiny stub for `ResolvedFlow` (existing tests like `cli/__tests__/unit/executor/relational-resolver.test.ts` show the stub idiom):

```ts
import { describe, it, expect } from "vitest";
import { partitionFlows } from "../../../src/executor/shard.js";

const make = (n: number) => Array.from({ length: n }, (_, i) => ({
  filePath: `/f${i}.yaml`,
  metadata: { name: `flow-${i}`, tags: [], env: {} },
  steps: [],
}) as unknown as import("../../../src/parser/flow-schema.js").ResolvedFlow);
```

Cases:
1. `split, 5 flows, 2 shards` → `[[flow-0, flow-2, flow-4], [flow-1, flow-3]]` — length-3 then length-2.
2. `split, 5 flows, 3 shards` → `[[flow-0, flow-3], [flow-1, flow-4], [flow-2]]`.
3. `split, 3 flows, 5 shards` (caller responsibility — function doesn't clamp; still produces 5 slices with 2 empty). Caller `runTest` clamps to 3 before calling, but the unit covers the raw behavior.
4. `split, 0 flows, 2 shards` → `[[], []]`. Same as above — unusual but total.
5. `all, 5 flows, 3 shards` → three identical copies of the full ordered list. Assert each slice deeply-equals `flows` and is a distinct array reference (`slice !== flows`, and `slice !== otherSlice` for any other shard's slice) so a future mutator doesn't cross-contaminate shards. (Comparing against `flows[0]` would be a typed-mismatch always-true check — slices are arrays, `flows[0]` is a flow object.)
6. `all, 5 flows, 1 shard` → `[[flow-0, ..., flow-4]]` (single slice, full list).
7. **Determinism:** same input twice → identical output (deep equal).
8. **Order preservation:** for split, within a single shard, flow order matches the input's relative order (asserts that `flowsOrder` carries through).

### 4.2 Unit: ConsoleReporter shard prefix + suppressFinalSummary

**File:** extend `cli/__tests__/unit/reporter/console-reporter.test.ts`

Use `vi.spyOn(console, "log")` and assert the captured calls. Three cases:

1. `shardLabel: "[shard 1]"`: every emitted line starts with `[shard 1] `. Buffered-mode (concurrency > 1) flushes also carry the prefix. Cover both the immediate `console.log` paths and the buffered flush at `onFlowComplete`.
2. `suppressFinalSummary: true`: `onRunComplete` produces zero `console.log` calls.
3. Default (no shardLabel, no suppress): existing behavior unchanged — regression check.

### 4.3 Unit: shard env injection in `flowToInput`

**File:** extend `cli/__tests__/unit/commands/test-command-flow-to-input.test.ts` (or create one if absent — check at implementation time; if absent, add to `cli/__tests__/unit/commands/`).

Cases:
1. `flowToInput(..., shardCtx: { shardId: 1, shardCount: 3 })` → `result.env.SKEPTIC_SHARD_INDEX === "1"`, `result.env.SKEPTIC_SHARD_COUNT === "3"`.
2. `flowToInput(..., shardCtx: undefined)` → result.env contains neither key (passthrough behavior unchanged).
3. User-defined `flow.metadata.env.SKEPTIC_SHARD_INDEX = "999"` → shard env wins (last-merge ordering).

### 4.4 Integration: `--shard-split` end-to-end

**File (new):** `cli/__tests__/integration/commands/test-command-shard.test.ts`

Pattern matches `test-command.test.ts:1-50` exactly: static `http.createServer` from `__tests__/fixtures/app/`, `execFileAsync("node", [CLI_BIN, ...])`, temp output dir.

Fixture: re-use the existing `fixtures/flows/minimal.yaml`, `valid-login.yaml`, `valid-navigation.yaml`. Need 3+ flows for meaningful sharding. If fewer than 3 viable fixture flows exist, add `cli/__tests__/fixtures/flows/shard-a.yaml`, `shard-b.yaml`, `shard-c.yaml`, `shard-d.yaml` — each with a single `navigate: /` step pointing at the existing `fixtures/app/index.html`. (The clamp test in 4.4 case 4 needs >2 flows.)

Cases:
1. `--shard-split 2` against 4 flows: assert `tmpDir/shard-1/results.json` and `tmpDir/shard-2/results.json` both exist; the union of their `flows[]` arrays equals the full input set; `tmpDir/results.json` exists at top level with all 4 flows merged; exit code 0 if all pass.
2. `--shard-split 2` with 1 deliberately-failing flow: top-level `results.json` reports the failing flow; exit code 1; both per-shard `results.json` files still exist.
3. `--shard-split 2 --bail` with deterministically-orchestrated timing (addresses Codex finding 5). The naive design — "fail in shard 0 and assert shard 1 has ≤1 flow" — is racy: if shard 1's first flow finishes faster than shard 0's failing flow, shard 1 picks up its second flow before the abort signal arrives. **Deterministic fix:** craft the fixture so:
   - Shard 0 (gets flows at indices 0, 2): index-0 fixture is `cli/__tests__/fixtures/flows/shard-fail-fast.yaml` — single step that resolves to a known failure (e.g. `assertVisible: "#nonexistent-element"` with low timeout, or `navigate:` to an unreachable URL with `timeout: 100`).
   - Shard 1 (gets flows at indices 1, 3): index-1 fixture is `cli/__tests__/fixtures/flows/shard-slow.yaml` — first step `wait: 3000`, ensuring shard 0's failure (sub-second) trips the abort signal long before shard 1's first flow finishes.
   - With 4 input flows total (indices 0-3) and `--shard-split 2`, shard 0 runs `[fail-fast, X]`, shard 1 runs `[slow, Y]`. Shard 0 fails on flow 0, calls `abortController.abort()`. Shard 1 is mid-`wait: 3000` on flow 1; once flow 1 completes, the worker loop sees `abortSignal.aborted === true` and skips flow 3.
   - **Assertion:** `shard-2/results.json` has exactly 1 flow (the slow one), not 2. This is deterministic given the timing gap (3000ms slow vs ~100ms fail).
4. `--shard-split 5` with 3 flows: assert clamp warning in stderr + only `shard-1/`, `shard-2/`, `shard-3/` directories exist.
5. `--shard-split 1` against 3 flows: top-level `results.json` exists; **no** `shard-1/` subdirectory created (single-shard short-circuit verified).

5a. **Single-shard contract regressions for bail (addresses Codex R4 finding).** Two cases — both must produce identical behavior to their non-sharded equivalents (proves the `effectiveShards > 1` gate on bail resolution from Phase 3.5 holds):
   - `--shard-split 1 --parallel 2 --bail` against `[failing, slow, slow]`: identical to `--parallel 2 --bail` against the same flows. The failing flow trips local bail; sibling worker completes its in-flight slow flow, then halts. Top-level `results.json` has 2 entries (failing + 1 slow), not 3. **No `shard-1/` subdir** created.
   - `--shard-all 1 --bail` against `[passing, failing, slow]`: identical to plain `--bail`. Sequential serial loop stops on the failing flow (status === "failed"). Top-level `results.json` has 2 entries. **No `--bail` ignored warning** in stderr (the warning fires only when `effectiveShards > 1`). **No `shard-1/` subdir** created.

   These cases lock down that the orchestrator's short-circuit (Phase 2.6) really does send single-shard runs through the same code path as non-sharded — including the bail mode. A regression that flipped the gate from `effectiveShards > 1` back to `shardMode !== "none"` would break case 5a immediately (queue drains past first failure under the wrong shared-bail wiring).
6. **`flowDir` collision check (the marquee test).** `--shard-all 2` against the same 3 flows: assert `tmpDir/shard-1/<safeName>-0/`, `tmpDir/shard-2/<safeName>-0/` both exist as separate directories (no engine collision); assert top-level merged `results.json` has 6 entries (3 flows × 2 shards) with appropriate `shardId` values; exit code reflects the union.

### 4.5 Integration: `--shard-split --shard-all` mutual-exclusion

Same file. Cases:
- `--shard-split 2 --shard-all 2` → exit 2, stderr contains "mutually exclusive".
- `--shard-split 2 --watch` → exit 2, stderr contains "cannot be combined with --watch".

These are usage-error cases; the test doesn't need a baseUrl or browser — fast checks. The existing `runCLI` helper at test-command.test.ts:52-67 is reused via `import.meta.dirname`.

### 4.6 Integration: TUI rejection under sharding

Hard to test cleanly because `ciInfo.isInteractive` is false in CI (the test's natural environment), so the TUI guard never triggers. Workaround: add an env-var override knob `SKEPTIC_FORCE_INTERACTIVE=1` that flips `ciInfo.isInteractive = true` for testing.

**Decision: skip this case in v1.** The TUI guard is exercised manually (verification step below) and covered by the existing TUI test at `cli/__tests__/integration/commands/test-command.test.ts` which uses `--no-tui`. Add a comment in the rejection block stating it's manually-verified.

### 4.6.5 Sharded notification firing — exactly once on merge (addresses Codex R6 finding 4)

**File (new):** `cli/__tests__/integration/notifications-wiring-sharded.test.ts` — sibling to the existing `cli/__tests__/integration/notifications-wiring.test.ts` (which already covers non-sharded firing). Reuse its mock-webhook-server pattern.

Two cases:
1. `--shard-split 2` with mocked Slack + Webhook endpoints: assert each endpoint receives **exactly 1** POST request, the payload's `total` reflects the merged count across both shards (not just one shard's), and the payload's `flows[]` contains entries from BOTH shards.
2. `--shard-all 2` with the same mocked endpoints + a deliberately failing flow: assert each endpoint receives **exactly 1** POST, the payload has `total: 2 * inputCount` (every flow ran twice), and failed-flow names carry the `[shard N]` suffix from `formatFlowDisplayName`.

This locks the Phase 2.5 + 3.7 split-and-merge invariant: notifications never fire per-shard. A regression that re-coupled them (e.g. accidentally adding `notificationReporters` to the per-shard set) would break case 1 immediately (server gets 2 POSTs, not 1).

### 4.6.6 Stale shard cleanup test (addresses Codex R6 finding 2 + R3 finding P1.1)

Two cases that together prove the manifest-gated cleanup model from Phase 3.7 Step 0:

**Case A — manifest-gated cleanup deletes prior-run shards.** This is the "previous run had 4 shards, current run has 2, kill the orphans" scenario. Pre-seed both the shard dir AND the manifest:
```ts
fs.writeFileSync(
  path.join(tmpDir, ".skeptic-shard-manifest.json"),
  JSON.stringify({ version: 1, shards: ["shard-9"] }),
  "utf-8",
);
fs.mkdirSync(path.join(tmpDir, "shard-9"), { recursive: true });
fs.writeFileSync(path.join(tmpDir, "shard-9", "marker.txt"), "stale", "utf-8");
fs.writeFileSync(path.join(tmpDir, "sentinel.json"), '{"user":"data"}', "utf-8");
```
Run `skeptic test --shard-split 2 --output ${tmpDir}`. Assert:
- `tmpDir/shard-9/` is gone (manifest listed it → cleanup deleted it).
- `tmpDir/shard-1/` and `tmpDir/shard-2/` exist (the new shards).
- `tmpDir/sentinel.json` UNCHANGED (cleanup only targets manifest-listed shards, not sibling files).
- `tmpDir/.skeptic-shard-manifest.json` now lists `["shard-1", "shard-2"]` (overwritten with the new run's shards).

**Case B — first-run safety: no manifest means no cleanup.** This is the "user pointed `--output` at a directory that already contains user-owned `shard-N/` from some unrelated tool" scenario. Pre-seed only the shard dir, NO manifest:
```ts
fs.mkdirSync(path.join(tmpDir, "shard-9"), { recursive: true });
fs.writeFileSync(path.join(tmpDir, "shard-9", "user.txt"), "user data", "utf-8");
```
Run `skeptic test --shard-split 2 --output ${tmpDir}`. Assert:
- `tmpDir/shard-9/user.txt` STILL EXISTS — manifest was absent, so cleanup didn't proceed.
- `tmpDir/shard-1/` and `tmpDir/shard-2/` exist (the new run's shards).
- `tmpDir/.skeptic-shard-manifest.json` now exists, listing `["shard-1", "shard-2"]` only.

The second case proves user data is safe under unconfigured `--output` paths (e.g., `skeptic test --shard-split 2 --output .`). A regression that switched back to regex-based cleanup (without the manifest gate) would fail Case B by deleting `shard-9/user.txt`.

### 4.6.7 Shard failure isolation (addresses Codex R6 finding 1 + R2 findings P1.1, P1.2, P2.1)

Extend the shard integration test. The cleanest way to deterministically inject shard failures is via `vi.mock` on `cli/src/executor/playwright-engine.js` to throw on `launch()` for shard 0 only (use a `vi.hoisted`-driven mock counter — same pattern as `cli/__tests__/unit/commands/test-command-trace.test.ts`).

Cases:
1. **Shard launch failure** — shard 0's engine throws on `launch()`; shard 1 runs normally.
   - `tmpDir/shard-2/results.json` exists with shard 1's flows.
   - `tmpDir/shard-1/results.json` either exists (with empty flows, since reporters were created before launch threw) or doesn't (if reporter creation also failed) — assert one of the two specifically based on the mock target.
   - Top-level `tmpDir/results.json`: `flows[]` includes shard 1's real results PLUS one synthetic entry with `name: "[shard 1] infrastructure error"`, `file: "<shard-1-error>"`, `status: "error"`, `shardId: 0`, `steps[0].command === "shardSetup"`, `steps[0].error` containing the thrown message.
   - Invariants: `total === flows.length`, `passed + failed === total`, `failed >= 1` (synthetic error counts).
   - Exit code 1.
   - No orphaned Chromium: assert `os.cpus().length`-style process check, OR verify the spy on `engine.close()` was called for shard 1's engine (the surviving one).
2. **Reporter construction failure** — mock `createReporters` to throw for shardId === 0. Same assertions as case 1, except `shardOutputDir/shard-1/` may or may not exist (reporter throw fires before any file write).
3a. **Shared-bail abort on infra error** (addresses Codex R6 P2 + R7 P3) — `--shard-split 2 --bail` against 4 fixture flows.

   **Naive design rejected by Codex R7 P3:** if shard 0 throws synchronously on `launch()` and we just assert `shard1.results.length <= 1`, the abort can fire before shard 1 starts any flow → the test passes with `results.length === 0`, which doesn't actually prove "in-flight work completes before stopping."

   **Deterministic barrier design.** Use a shared semaphore so we can observe shard 1's first flow IS in-flight when the abort fires:
   ```ts
   const barrier = { shard1Started: false, releaseShard0: () => {} };
   const releasePromise = new Promise<void>((resolve) => { barrier.releaseShard0 = resolve; });

   // Mock shard 0's engine.launch: wait for the barrier, THEN throw.
   vi.mocked(shard0Launch).mockImplementation(async () => { await releasePromise; throw new Error("simulated launch failure"); });

   // Mock shard 1's engine.runFlow: on first call, set barrier flag, release shard 0,
   // then sleep ~500ms before resolving as passed.
   let shard1FlowCount = 0;
   vi.mocked(shard1RunFlow).mockImplementation(async () => {
     shard1FlowCount++;
     if (shard1FlowCount === 1) {
       barrier.shard1Started = true;
       barrier.releaseShard0();   // shard 0 now throws → abort fires
       await new Promise((r) => setTimeout(r, 500));
       return { ...passingFlowResult };
     }
     return { ...passingFlowResult };  // shouldn't be reached
   });
   ```

   Assertions:
   - `barrier.shard1Started === true` — shard 1's first flow ENTERED runFlow before shard 0's abort fired (proves the barrier worked).
   - `shard1FlowCount === 1` (NOT `<= 1`) — exactly one flow ran; the second flow on shard 1 was prevented by the abort signal seen on the next worker iteration.
   - `outcome[0].error?.message` includes "simulated launch failure".
   - `outcome[1].results.length === 1` — the in-flight flow completed and is in results.
   - Top-level `mergedSummary.failed >= 1` (shard 0's synthetic infra-error counts).
   - `process.exitCode === 1`.

3. **runFlowsForShard partial-results** — mock the helper to push 2 successful FlowResults into its accumulator, then `return { results, error: new Error("simulated mid-run engine crash") }`. Assert:
   - `tmpDir/shard-1/results.json` has 2 flow entries (the successful ones).
   - Top-level `flows[]` includes those 2 + the synthetic error entry.
   - Even with partial results, the merge sort + invariants hold.

4. **Concurrent worker race — addresses Codex R4 P1.** Mock `engine.runFlow` so the 1st call resolves immediately (passed), the 2nd call throws after ~10ms ("simulated mid-flow crash"), and the 3rd call resolves after ~500ms (passed). Run with `--parallel 3` against 3 fixture flows. Assert:
   - `outcome.results.length === 2` — the immediate pass AND the 500ms-delayed pass are both retained, despite the 2nd flow throwing first.
   - `outcome.error?.message` contains "simulated mid-flow crash".
   - The 3rd flow's `result.duration_ms >= 400` — proves the slow flow ran to completion before the helper returned (i.e., we awaited Promise.allSettled, not Promise.all).
   - Engine.close() was called exactly once, AFTER the 500ms delay had elapsed (verifiable via a spy timestamp). If the helper had returned early on the throw, close would fire at ~10ms, not ~500ms.

If `vi.mock` on the executor module proves brittle (it's deeply imported), fall back to a smaller-scope dependency-injection knob: add a hidden `EngineOptions._injectLaunchFailure?: boolean` for tests-only and document it. Decide at implementation time; mock-first.

### 4.6.8 Merged-result determinism (addresses Codex R6 finding 6)

Extend the shard integration test:
- Run `--shard-split 3 --parallel 2` against 6 fixture flows TWICE.
- Read both top-level `results.json` files; assert `flows[].file` arrays are byte-identical (deterministic merge ordering by `originalFlowIndex`).
- Run `--shard-all 2` against 3 fixture flows; assert the merged `flows[]` ordering is `[(file0, shard0), (file0, shard1), (file1, shard0), (file1, shard1), ...]` — the secondary sort by `shardId` is observable.

### 4.7 Regression: worker-pool sizing fix (addresses Codex finding 7)

**File:** extend `cli/__tests__/unit/commands/test-command-trace.test.ts` or add a focused unit at `cli/__tests__/unit/commands/test-command-rerun.test.ts` (whichever is closer to the lift surface — pick at implementation time).

The `filtered.length` → `flowsToRun.length` fix in Phase 1.5 also closes a latent bug in TUI failed-only rerun. Test:
- Run `runFlowsForShard` with `flowsToRun.length === 2` and `concurrency: 4`.
- Spy on the `worker()` invocations (or count concurrent `engine.runFlow` calls via a stubbed engine).
- Assert at most `2` workers spawn (not `4`). If `Math.min(concurrency, flowsToRun.length)` is correct, this passes; if it captured `filtered.length` from the outer scope, it fails.

This is a small unit test (~30 lines) but it locks in the fix and prevents regression if a future refactor accidentally re-captures an outer length.

### 4.8 Audit: existing tests don't regress

Run `npm test` after implementation; expect 981 → 990+ tests (we add ~10 new ones across 3 files). No existing tests should fail — the partition function is new, ConsoleReporter changes are gated on the new constructor opts (default behavior unchanged), and the orchestrator block is gated on `shardMode !== "none"`.

---

## Phase 5 — Documentation, audit, and competitive-analysis update

### 5.1 README — flag table

**File:** `cli/README.md`

Find the existing `skeptic test` flag table (the format used by other flag-touch plans like `provider-aware-ci-scaffold.md` Phase 4.1a). Add two rows:

```markdown
| `--shard-split <n>` | Split flows across N independent browser instances (each runs a disjoint subset). |
| `--shard-all <n>` | Run all flows on each of N independent browser instances (parity / flake-rate baseline). |
```

Plus a short prose paragraph after the table: when to reach for which flag, and the composition rule with `--parallel`.

### 5.2 README — examples section

Add three short examples right after the flag table, mirroring the example block from the competitive-analysis doc:

```bash
# CI: 4× wall-clock speedup, disjoint subset per worker
skeptic test --shard-split 4

# Flake-rate baseline: run every flow 3× across 3 isolated processes
skeptic test --shard-all 3

# Compose with --parallel: 3 shards, each running 2 flows concurrently
skeptic test --shard-split 3 --parallel 2
```

### 5.3 Competitive-analysis update

**File:** `docs/competitive-analysis-maestro-expect.md:421-427`

Mark item #39 as ✅ Shipped, add an "skeptic implementation:" paragraph in the same style as items #37-38 (e.g. line 407). Cite the new shard partition file and the orchestrator location. Brief — under 150 words.

Also update the doc's tally header (search for "Maestro" + "shipped" near the top of the file — the existing claim "everything except #36 and #39 is shipped" needs to drop #39).

### 5.4 GitHub Action scaffold (optional follow-up)

`cli/src/commands/add.ts` writes `.github/workflows/skeptic-tests.yml`. Sharding is a natural fit for matrix builds — but adding `strategy.matrix.shard` to the scaffold is out of v1 scope (covered in Phase 5 anti-scope).

### 5.5 Implementation audit

After Phase 1-4 land, spawn an Explore agent against the Critical Files table to verify:
1. Every file in the table was actually modified.
2. The `effectiveShards <= 1` short-circuit at Section 3.6 actually fires (no `shard-1/` subdir for `--shard-split 1`).
3. The cross-shard abort really works — search for `AbortController` usage and confirm the `abortController.abort()` call site exists.
4. No regression: `executeFlows` closure was fully replaced (no dead code left over).
5. `runFlows` in `runner.ts` is unchanged.

---

## Critical Files to Modify

| File | Phase | Change |
|---|---|---|
| `cli/src/executor/shard.ts` | 1.1 | NEW — `partitionFlows` + `ShardMode` (pure, no `commands/` imports) |
| `cli/src/executor/types.ts` | 1.2, 1.3 | Add `shardId?: number` to `EngineOptions` and `FlowResult` |
| `cli/src/executor/playwright-engine.ts` | 1.3 | Set `result.shardId = this.options.shardId` at FlowResult construction |
| `cli/src/commands/test.ts` | 1.4, 1.5, 1.6, 2.5, 3.2-3.8 | Add shard env in `flowToInput`; export `runFlowsForShard` + `ShardRunContext`; add `shardSplit/shardAll` to options; conflict-validation block; replace `executeFlows` closure with shard orchestrator; split `notificationReporters` and add `emitRunComplete` helper used by all 4 onRunComplete call sites |
| `cli/src/index.ts` | 3.1 | Tighten `parsePositiveInt` to integer-only regex; add `parseShardCount` with `SHARD_MAX = 64`; add `--shard-split` / `--shard-all` options |
| `cli/src/reporter/console-reporter.ts` | 2.3 | Add `shardLabel`, `suppressFinalSummary` constructor opts; route output through `private write()` |
| `cli/src/reporter/types.ts` | 2.7 | Export `formatFlowDisplayName(flow)` helper |
| `cli/src/reporter/junit-reporter.ts` | 2.7 | Use `formatFlowDisplayName` in `<testsuite>` + `<testcase>` rendering |
| `cli/src/reporter/html-reporter.ts` | 2.7 | Use `formatFlowDisplayName` in `buildFlowSection` |
| `cli/src/reporter/slack-reporter.ts` | 2.7 | Use `formatFlowDisplayName` in failed-flow bullet block |
| `cli/src/reporter/webhook-reporter.ts` | 2.7 | Use `formatFlowDisplayName` in payload; extend `WebhookPayloadFlow` with optional `shardId` |
| `cli/__tests__/unit/executor/shard-partition.test.ts` | 4.1 | NEW — 8 cases on `partitionFlows` |
| `cli/__tests__/unit/reporter/console-reporter.test.ts` | 4.2 | Extend with shard-prefix + suppress-summary cases |
| `cli/__tests__/unit/reporter/junit-reporter.test.ts` | 4.2/2.7 | Extend with shard-suffix rendering case |
| `cli/__tests__/unit/reporter/html-reporter.test.ts` | 4.2/2.7 | Extend with shard-suffix rendering case |
| `cli/__tests__/unit/reporter/slack-reporter.test.ts` | 4.2/2.7 | Extend with shard-suffix in failed-flow block |
| `cli/__tests__/unit/reporter/webhook-reporter.test.ts` | 4.2/2.7 | Extend with shard-suffix + `shardId` in payload |
| `cli/__tests__/integration/notifications-wiring-sharded.test.ts` | 4.6.5 | NEW — Slack/Webhook fire exactly once under sharding |
| `cli/__tests__/unit/commands/test-command-flow-to-input.test.ts` | 4.3 | Extend (or create) — shard env injection |
| `cli/__tests__/unit/commands/test-command-rerun.test.ts` | 4.7 | NEW (or extend existing) — worker-pool sizing regression |
| `cli/__tests__/integration/commands/test-command-shard.test.ts` | 4.4, 4.5 | NEW — end-to-end shard scenarios + flag-conflict cases |
| `cli/__tests__/fixtures/flows/shard-fail-fast.yaml`, `shard-slow.yaml`, `shard-{a,b,c,d}.yaml` | 4.4 | NEW — fast-fail and slow-pass fixtures for bail timing test, plus 4 minimal flows for partition coverage |
| `cli/README.md` | 5.1, 5.2 | Add flag rows + examples |
| `docs/competitive-analysis-maestro-expect.md` | 5.3 | Mark #39 ✅ Shipped; add skeptic implementation paragraph; update tally header |

Plus new test files (`shard-partition.test.ts`, `test-command-shard.test.ts`, `test-command-rerun.test.ts`) and the `shard.ts` source helper. No new dependencies.

---

## Reused Utilities

- **`PlaywrightEngine`** — `cli/src/executor/playwright-engine.ts:31`. Reused per-shard with distinct `outputDir`. No engine-side changes besides 1-line `shardId` write.
- **`createReporters`** — `cli/src/commands/test.ts:666`. Reused twice per sharded run (once per shard, once for merge). Two new optional opts forwarded to `ConsoleReporter`.
- **`buildSummary`** — `cli/src/commands/test.ts:395`. Reused as-is **only by the non-sharded fall-through path** (Phase 1.6 short-circuit when `effectiveShards <= 1`). Per-shard and merged summaries are built inline in Phase 3.7's Step 2 + Step 3 because they need to inject `buildShardErrorEntry` synthetic entries and read `outcome.durationMs` (the per-shard frozen snapshot) — neither possible through the existing `buildSummary` signature.
- **`flowToInput`** — `cli/src/commands/test.ts:554`. Extended with optional `shardCtx` parameter; existing call sites unaffected.
- **`parsePositiveInt`** — `cli/src/index.ts:13`. Reused for both new flags after error-message generalization.
- **`Reporter` interface** — `cli/src/reporter/types.ts:17-24`. Untouched. Sharding adds no new interface methods.
- **Worker-pool dispatch loop** — currently `commands/test.ts:347-389`. Lifted verbatim into `runFlowsForShard`. No semantic changes for the non-sharded path.
- **`http.createServer` integration-test fixture pattern** — `cli/__tests__/integration/commands/test-command.test.ts:18-50`. Reused in `test-command-shard.test.ts`.
- **`flowsOrder` resolution** — `cli/src/commands/test.ts:144-160`. Runs **before** partitioning, so split shards inherit deterministic ordering.

---

## Verification

After each phase:

```bash
cd cli
npm run check        # strict TS compile
npm run build        # full build (sharding code is vanilla TS with no special build gates)
npm test             # all existing + new tests pass
```

**Manual smoke** (run after Phase 4 is green):

```bash
cd cli && npm run build

# Setup: ensure 3+ flows exist in your test config (or use a checkout with several flows)

# 1. --shard-split 2: two shards, disjoint flows
node dist/skeptic.mjs test --shard-split 2 --reporter json --output /tmp/skeptic-shard-test
ls /tmp/skeptic-shard-test/
# expect: shard-1/  shard-2/  results.json
diff <(jq -r '.flows[].name' /tmp/skeptic-shard-test/results.json | sort) \
     <(jq -r '.flows[].name' /tmp/skeptic-shard-test/shard-1/results.json /tmp/skeptic-shard-test/shard-2/results.json | sort)
# expect: no diff (merged == union)

# 2. --shard-all 2: every flow runs twice
node dist/skeptic.mjs test --shard-all 2 --reporter json --output /tmp/skeptic-all-test
jq '.flows | length' /tmp/skeptic-all-test/results.json
# expect: 2× flow count
jq -r '.flows[].shardId' /tmp/skeptic-all-test/results.json | sort -u
# expect: 0 and 1 both present

# 3. Compose with --parallel
node dist/skeptic.mjs test --shard-split 2 --parallel 2 --reporter json --output /tmp/skeptic-compose
# expect: clean run, 4× max in-flight flows

# 4. Mutual-exclusion error
node dist/skeptic.mjs test --shard-split 2 --shard-all 2; echo "exit=$?"
# expect: exit=2, stderr "mutually exclusive"

# 5. Watch + shard rejected
node dist/skeptic.mjs test --shard-split 2 --watch; echo "exit=$?"
# expect: exit=2, stderr "cannot be combined with --watch"

# 6. Bail propagation under split (use a deliberately-failing fixture)
node dist/skeptic.mjs test path/to/known-failing.yaml path/to/passing-1.yaml path/to/passing-2.yaml --shard-split 2 --bail
# expect: shard with the failing flow stops; sibling shard stops after its in-flight flow

# 7. Single-shard short-circuit
node dist/skeptic.mjs test --shard-split 1 --output /tmp/skeptic-1
ls /tmp/skeptic-1/
# expect: results.json (NO shard-1/ subdir)
```

**Phase 4 specific:** the integration test at 4.4 case 6 is the marquee correctness test — proves `flowDir` collisions are impossible under `--shard-all`. If it fails, sharding has a hard correctness bug regardless of unit-test coverage.

---

## Anti-scope (deliberately deferred)

Items explicitly **not** planned here, even as roadmap entries inside this plan. Each can be picked up as its own follow-up plan when there's user demand.

- **Distributed sharding across machines.** Maestro doesn't do this either; "shard" today means within-process coroutines (Maestro) or within-host Node processes (skeptic). Cross-machine sharding requires CI-tier coordination (artifact upload, result coalescence, run ID) — order of magnitude more design work.
- **Dynamic re-balancing / work-stealing.** A shard that finishes its slice early sits idle while a sibling churns through slow flows. Modulo round-robin gives a worst-case ±1 imbalance; for very uneven flow runtimes a hash-based or duration-aware partitioner would help. Out of v1.
- **TUI multi-shard view.** Single-process TUI today; sharded run with a unified live progress view is a fresh design (per-shard panes, lane status). Phase 3.4 rejects TUI under sharding with a clear error message; v2 would lift the rejection.
- **Per-shard browser engine.** `--shard-all` could in v2 take `--shard-browsers chromium,firefox,webkit` and assign one engine per shard for true cross-engine testing. v1 uses the same `browserEngine` for all shards.
- **GitHub Actions matrix-mode scaffold.** `skeptic add github-action` could generate a `strategy.matrix.shard` block. Out of scope here; clean follow-up since the scaffold layer is independent of the runner.
- **`SKEPTIC_TOTAL_SHARDS` / `SKEPTIC_SHARD_INDEX` formalization in flow YAML.** v1 ships the env var injection (Phase 1.4) but doesn't add YAML-level templating like `${SKEPTIC_SHARD_INDEX}`. Users can already read these in `runScript:` steps.
- **Cross-machine retry coordination.** Retry under sharding is per-flow within its assigned shard — same as today's `--retries`. A "stick the retry to the same shard ID across runs" feature is out of scope.
- **Distributed observability merge.** Each shard's `FlowResult.metrics` is preserved in the merged `results.json`. Cross-shard aggregation (e.g. "average LCP across all shards for flow X") is left to downstream tooling consuming `results.json`.

---

## Implementation order

1. **Phase 1.1** (`partitionFlows`) — pure function, ~15 LOC, fastest to land green.
2. **Phase 1.2-1.4** — type extensions + env injection. Type extensions first; env injection touches `flowToInput` which has many call sites, so do it before the orchestrator rewrite.
3. **Phase 1.5-1.6** — extract `runFlowsForShard`, replace closure. Run `npm test` here to confirm the lift was clean (existing tests must still pass).
4. **Phase 2.3** (ConsoleReporter prefix) — small, isolated change.
5. **Phase 2.7** (JUnit/HTML shard suffix) — small, isolated change; can be done before or after 2.3.
6. **Phase 3.1-3.7** — CLI flag wiring + orchestrator block. End-to-end shape works after this step.
7. **Phase 4** — tests. Run `npm test` until green.
8. **Phase 5.1-5.3** — README + competitive-analysis updates.
9. **Phase 5.5** — implementation audit via Explore agent.

Each step ends with `npm run check && npm run build && npm test` — all green before moving to the next.

**Code-ordering note** (Codex R5 minor): although the markdown section numbering is 3.3 (Stage A validation) → 3.4 (TUI/watch Stage B) → 3.5 (bail resolution) → 3.6 (effectiveShards clamp), the **actual code order inside `runTest`** is:

```
1. parse opts (line 95-110)
2. Stage A validation: mutual exclusion, shardMode, requestedShards   (Phase 3.3)
3. loadConfig (line 107)
4. resolve flows + apply flowsOrder + filter (line 142-168)
5. compute effectiveShards = clamp(requestedShards, filtered.length)  (Phase 3.6)
6. compute useInteractiveTUI (line 195)
7. Stage B validation: --watch + TUI guards (gated on effectiveShards > 1)  (Phase 3.4)
8. resolve bailMode (gated on shardMode === X && effectiveShards > 1)  (Phase 3.5)
9. build engine opts, allocate engines/reporters, dispatch              (Phase 3.7)
```

Sections in markdown stay numbered for narrative flow; the implementation must follow the data-flow order above. The plan notes this dependency at Phase 3.3 ("Stage B deferred — they require effectiveShards from Phase 3.6") and Phase 3.5 ("must run after Phase 3.6's clamp") so the implementer doesn't get caught by the textual ordering.
