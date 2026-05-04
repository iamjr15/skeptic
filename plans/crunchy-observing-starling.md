# Plan: Bundle 3 — Observability Collectors

## Context

Bundle 3 lands three Expect-sourced features that share one collector architecture: **performance metrics** (#28), **network request monitoring** (#29), and **accessibility auditing** (#30). All three attach to a Playwright `Page` at flow start, observe passively or run on-demand, and contribute a snapshot to a new `FlowResult.metrics` field consumed by reporters.

The skeptic CLI is at `cli/`. The executor (`cli/src/executor/playwright-engine.ts`) already has clean flow-setup and teardown points: page creation at line 117, `onFlowComplete` hook execution at line 272–283, video finalization at line 285–301. Abort/teardown semantics are encoded in `ctx.abortReason` and `ctx.inTeardown` per `CLAUDE.md` executor invariants; collectors must respect both.

### Expect prior art

All three features are in Expect (`/Users/iamjr15/Desktop/skeptic-refs/expect`) at varying completeness. We match Expect's collection surface where sound and close its gaps.

**Performance (`packages/browser/src/runtime/lib/performance.ts:96-193`, `packages/browser/src/mcp/server.ts:559-626`)** — Expect wrote a custom `PerformanceObserver` runtime, attached four observers (`paint`, `largest-contentful-paint`, `layout-shift`, `event`), and added a LoAF observer with script attribution (lines 162-193, 50-frame buffer). Metrics pulled on-demand via `page.evaluate`. Hardcoded "good/needs-improvement/poor" thresholds match the Core Web Vitals spec (FCP <1800ms good, LCP <2500ms good, CLS <0.1 good, INP <200ms good). **No step-level assertion DSL exists** — it's a manual MCP tool only. We'll build the DSL.

**Network (`packages/browser/src/mcp/mcp-session.ts:92-133`, `packages/browser/src/mcp/server.ts:471-557`)** — `page.on("request")` + `page.on("response")`; record shape `{ url, method, status, resourceType, timestamp }`; unbounded buffer. Duplicate window 500ms (`packages/browser/src/mcp/constants.ts:8`); mixed-content via `https` doc + `http` resource; **no `requestfailed` hook, no CORS detection**, no cap. We'll close all three gaps.

**A11y (`packages/browser/src/accessibility.ts:65-193`, `packages/browser/package.json:26,33`)** — Dual engines as **core deps**: `@axe-core/playwright@^4.11.1` + `accessibility-checker-engine@^4.0.16` (IBM Equal Access). Bundle hit ~6.7MB. Parallel via `Effect.all({ concurrency: 2 })`. Dedup by `ruleId` (axe kept, IBM filtered to exclude rules axe already reported). IBM WCAG standard hardcoded to `WCAG_2_2` (line 113); only axe honors `tags`. IBM severity mapped `VIOLATION→serious`, `RECOMMENDATION→moderate`, `INFORMATION→minor` (lines 57-61). **No baseline/allowlist.** We'll adopt the dedup + mapping, expose WCAG standard symmetrically, and make Equal Access a **runtime-optional peer** (bundle-size rationale below).

### skeptic integration surface (from codebase audit)

- **Attach point:** `cli/src/executor/playwright-engine.ts:117` — immediately after `page = await context.newPage()`, **before** hooks run (so hooks observe a fully-instrumented page).
- **Snapshot + detach point:** `cli/src/executor/playwright-engine.ts:283` — **after** `onFlowComplete` finishes, **before** video finalization at line 285 (video closes the page; detach still works post-close but snapshot may race with teardown).
- **Result field:** `FlowResult` in `cli/src/executor/types.ts:29-36` — one new optional `metrics?: Record<string, unknown>` field, populated at line 303-310.
- **Config block:** `cli/src/config/schema.ts` — new `observability` block mirroring `browser`/`execution`/`output`/`ai`/`hooks`. Default disabled; **two-way opt-in (config ∪ step inference)**. No CLI flag in v1 — step inference covers the common case (writing `assertPerformance` auto-enables the performance collector).
- **Step handlers:** `cli/src/executor/step-handlers/assert-performance.ts`, `assert-no-network-errors.ts`, `accessibility-audit.ts`. Registered in `stepHandlers` map (`step-handlers/index.ts:43`).
- **Schema:** add three command keys to `COMMAND_KEYS` + `Step` + `StepSchema` in `cli/src/parser/flow-schema.ts` (lines 13-54, 68-134, 155-360).
- **Reporter integration:** existing `Reporter.onFlowComplete(result)` already receives `FlowResult`. Console reporter prints compact metrics line; HTML reporter adds a collapsible metrics section; JSON reporter auto-serializes.

### Bundle-size decision: axe-core core vs. Equal Access optional peer

skeptic's `cli/package.json` today pulls ~40MB via `playwright` alone (browsers are peer-installed via `npx playwright install`). Published `cli/` tarball is currently ~2MB.

- **`@axe-core/playwright` (^4.11.0)**: ~250KB unpacked (axe-core itself ~200KB). Standard, well-maintained, no telemetry. **Core dep.**
- **`accessibility-checker-engine` (^4.0.16, IBM Equal Access)**: ~2-3MB unpacked. Pulls `@ibm/telemetry-js` transitive dep that phones home by default. Overlap with axe is ~70% (per Expect's dedup outcome, IBM contributes ~30% additional findings).

Core-only pairs poorly with skeptic's "zero-config except AI" design. Decision: **`@axe-core/playwright` as core dep; `accessibility-checker-engine` as optional, loaded at runtime via dynamic `import()` with graceful degradation.** Users who want dual-engine install it themselves (`npm i accessibility-checker-engine`); the collector detects presence and enables both engines. Single-engine axe-only is the default. This matches the skeptic pattern for optional heavy deps (we don't bundle AI SDKs by default either — they're all dynamic imports gated on `config.ai.provider`).

### Goal and non-goals

**Goal:** The three step-level assertions (`assertPerformance`, `assertNoNetworkErrors`, `accessibilityAudit`) work end-to-end against a real page. Collectors share one interface, attach once per flow, and contribute to a typed-but-generic `FlowResult.metrics` map. No feature regresses the existing 280-test suite.

**Out of scope** (tracked as follow-ups):
- A dedicated `A11yReporter` — HTML report's inline section is sufficient for v1.
- Baseline/allowlist for a11y violations (Expect also lacks this; feature gap).
- LoAF-level assertions (`assertPerformance: { blockingDuration: "<200ms" }`) — LoAF data flows into `metrics` but only the four Core Web Vitals are assertable in v1.
- CDP-based network monitoring (HAR export, request bodies). Playwright event API is sufficient for v1; HAR is a bigger feature.
- Request-body capture, response-body capture, or `route()`-based request mocking via the collector. Out of scope.

---

## Phase 0 — Dependencies and shared types

### 0.1 New runtime dependencies

**File:** `cli/package.json`

Add to `dependencies`:
```json
"web-vitals": "^4.2.4",
"@axe-core/playwright": "^4.11.1"
```

Add to `peerDependenciesMeta` (new top-level section — skeptic doesn't currently use peer deps, but this is the right idiom for optional dual-engine a11y):
```json
"peerDependencies": {
  "accessibility-checker-engine": "^4.0.0"
},
"peerDependenciesMeta": {
  "accessibility-checker-engine": { "optional": true }
}
```

Regenerate `package-lock.json` via `npm install`. Verify no transitive CVEs via `npm audit --omit=dev`.

**`web-vitals` v4 API surface we use:** `onFCP`, `onLCP`, `onCLS`, `onINP`, `onTTFB` (all take a callback receiving `{ value, rating, id, delta, ... }`). Bundle: ~3KB gzipped. `dist/web-vitals.iife.js` exposes a global `webVitals`.

**`@axe-core/playwright` v4 API:** `new AxeBuilder({ page }).withTags([...]).analyze()` returns `{ violations, passes, incomplete, inapplicable }`. Each violation: `{ id, impact, tags, nodes: [{ html, target, failureSummary }], help, helpUrl }`.

### 0.2 Flat-file layout

New directory `cli/src/observability/`:

```
cli/src/observability/
  types.ts                       # Collector interface + snapshot types
  registry.ts                    # buildCollectors({ required, configured })
  collectors/
    performance-collector.ts     # PerformanceCollector class
    network-collector.ts         # NetworkCollector class
    accessibility-collector.ts   # AccessibilityCollector class
  assert-parser.ts               # parseThreshold("<2.5s") → { op, value, unit }
```

Tests mirror under `cli/__tests__/unit/observability/`.

Rationale: keeping collectors in their own subsystem rather than alongside `step-handlers/` makes the boundary explicit. Step handlers **consume** collectors (via `ctx.collectors.get("performance")`); they don't own collector lifecycle.

### 0.3 `Collector` interface (the shared abstraction)

**File:** `cli/src/observability/types.ts`

```ts
import type { Page } from "playwright";
import type { ExecutionContext } from "../executor/context.js";

export type CollectorName = "performance" | "network" | "accessibility";

export interface Collector {
  readonly name: CollectorName;

  /** Called once after page creation, before any step runs. Idempotent. */
  attach(page: Page, ctx: ExecutionContext): Promise<void>;

  /**
   * Returns the current snapshot. Safe to call multiple times during a flow
   * (step handlers use this to query live state for assertions). Must not
   * throw — return empty/default shape on error and log.
   */
  snapshot(): Promise<unknown>;

  /** Called once at flow end, after snapshot. Removes listeners; swallows errors. */
  detach(): Promise<void>;
}

/** Per-collector snapshot shapes — reporters narrow at consumption time. */
export interface PerformanceSnapshot {
  fcp: number | null;
  lcp: number | null;
  cls: number | null;
  inp: number | null;
  ttfb: number | null;
  longAnimationFrames: LongAnimationFrame[];
}

export interface LongAnimationFrame {
  startTime: number;
  duration: number;
  blockingDuration: number;
  scripts: Array<{
    invoker: string;
    sourceURL: string;
    sourceFunctionName: string;
    duration: number;
  }>;
}

export interface NetworkRequest {
  url: string;
  method: string;
  status?: number;
  resourceType: string;
  duration?: number;         // undefined if request didn't finish
  timestamp: number;
  failure?: string;          // populated from page.on("requestfailed")
  /**
   * Frame URL at the time the request fired. Used for mixed-content classification —
   * the mix check is "was the initiating context HTTPS?" not "is the page HTTPS right now?".
   * Without this, a flow that navigates between http↔https schemes misclassifies resources.
   */
  frameUrl?: string;
}

export interface NetworkSnapshot {
  requests: NetworkRequest[];
  issues: {
    /** HTTP 4xx/5xx responses. */
    failedRequests: Array<{ url: string; method: string; status: number }>;
    /** Network-level failures (DNS, TCP, aborted, blocked) — no HTTP status available. */
    networkFailures: Array<{ url: string; method: string; reason: string }>;
    duplicates: Array<{ url: string; method: string; count: number; windowMs: number }>;
    mixedContent: string[];
    corsErrors: Array<{ url: string; method: string; reason: string }>;
  };
}

export interface AccessibilityViolation {
  ruleId: string;
  impact: "critical" | "serious" | "moderate" | "minor";
  engine: "axe" | "equal-access";
  help: string;
  helpUrl?: string;
  nodes: Array<{ target: string[]; html: string; failureSummary?: string }>;
}

export interface AccessibilitySnapshot {
  violations: AccessibilityViolation[];
  summary: {
    violations: number;
    passes: number;
    incomplete: number;
    dualEngine: boolean;       // true when IBM Equal Access also ran
  };
  standard: string;            // "WCAG2AA" | "WCAG2A" | ...
}
```

Export `Record<CollectorName, unknown>` contract via JSDoc comment in `FlowResult`: the `metrics` field is `{ performance?: PerformanceSnapshot, network?: NetworkSnapshot, accessibility?: AccessibilitySnapshot }` but typed as `Record<string, unknown>` at the boundary per the user spec.

### 0.4 Shared threshold parser

**File:** `cli/src/observability/assert-parser.ts`

Used only by `assertPerformance` today, but structured for reuse if future collectors want threshold-style assertions.

```ts
export interface Threshold {
  operator: "<" | "<=" | ">" | ">=" | "=";
  value: number;      // always normalized to the metric's canonical unit (ms for time, unitless for CLS)
  raw: string;        // original string for error messages
}

const THRESHOLD_RE = /^(<=|>=|<|>|=)\s*(\d+(?:\.\d+)?)\s*(ms|s)?$/;

export function parseThreshold(expr: string, unit: "ms" | "unitless"): Threshold {
  const trimmed = expr.trim();
  const m = THRESHOLD_RE.exec(trimmed);
  if (!m) {
    throw new Error(
      `Invalid threshold expression: "${expr}". Expected format: "<value[unit]", e.g. "<2.5s", "<=200ms", "<0.1".`,
    );
  }
  const [, op, numStr, parsedUnit] = m;
  let value = parseFloat(numStr!);
  if (unit === "ms") {
    if (parsedUnit === "s") value = value * 1000;
    else if (parsedUnit === "ms" || parsedUnit === undefined) { /* already ms */ }
    else throw new Error(`Time metric cannot use unit "${parsedUnit}"`);
  } else {
    if (parsedUnit !== undefined) {
      throw new Error(`Unitless metric "${expr}" should not have a unit suffix`);
    }
  }
  return { operator: op as Threshold["operator"], value, raw: trimmed };
}

export function checkThreshold(actual: number, threshold: Threshold): boolean {
  switch (threshold.operator) {
    case "<":  return actual < threshold.value;
    case "<=": return actual <= threshold.value;
    case ">":  return actual > threshold.value;
    case ">=": return actual >= threshold.value;
    case "=":  return actual === threshold.value;
  }
}
```

**Tests (`cli/__tests__/unit/observability/assert-parser.test.ts`):**
- `parseThreshold("<2.5s", "ms")` → `{ operator: "<", value: 2500, raw: "<2.5s" }`.
- `parseThreshold("<200ms", "ms")` → `{ operator: "<", value: 200, raw: "<200ms" }`.
- `parseThreshold("<0.1", "unitless")` → `{ operator: "<", value: 0.1, raw: "<0.1" }`.
- `parseThreshold("<=500", "ms")` → unit defaults to ms, value unchanged.
- `parseThreshold("<0.1", "ms")` → value 0.1 stays 0.1 (no unit suffix, parsed as ms).
- `parseThreshold("foo", "ms")` → throws with clear message.
- `parseThreshold("<0.1ms", "unitless")` → throws (CLS can't have units).
- `parseThreshold("<2.5min", "ms")` → throws (unsupported unit).
- `checkThreshold(2499, { operator: "<", value: 2500, raw: "<2.5s" })` → `true`.
- `checkThreshold(2500, { operator: "<", value: 2500, raw: "<2.5s" })` → `false`.

---

## Phase 1 — Engine integration, FlowResult.metrics, config block

### 1.1 Extend `FlowResult`

**File:** `cli/src/executor/types.ts:29-36`

```ts
export interface FlowResult {
  name: string;
  file: string;
  status: "passed" | "failed" | "error";
  duration_ms: number;
  steps: StepResult[];
  videoPath?: string;
  /**
   * Observability snapshots, keyed by collector name. Typed as `Record<string, unknown>`
   * at the boundary; individual collectors define their own typed snapshot shapes
   * (see cli/src/observability/types.ts). Reporters narrow at consumption time.
   * Absent when no collectors ran for the flow.
   */
  metrics?: Record<string, unknown>;
}
```

No other changes to `types.ts`.

### 1.2 Add config block

**File:** `cli/src/config/schema.ts`

After `HooksConfigSchema` (line 57), before `AIConfigSchema` (line 60):

```ts
/** Observability configuration — collectors attached to every flow. */
const ObservabilityConfigSchema = z.object({
  /**
   * Collectors to attach regardless of whether any step references them.
   * Step-level assertions (assertPerformance, assertNoNetworkErrors,
   * accessibilityAudit) also auto-enable their collector via `inferRequiredCollectors`
   * at FlowInput construction — the active set for a flow is the union of this list
   * and the inferred set. No CLI flag is exposed in v1; users opt in via config or
   * by writing the assertion step.
   */
  collectors: z
    .array(z.enum(["performance", "network", "accessibility"]))
    .default([]),
  /** Cap network capture to prevent OOM on long flows. 0 = unlimited. */
  networkCaptureLimit: z.number().int().min(0).default(500),
  /** Override duplicate-request detection window (ms). */
  duplicateWindowMs: z.number().int().positive().default(500),
  /** Try to load IBM Equal Access as a second a11y engine. No-op if not installed. */
  accessibilityDualEngine: z.boolean().default(false),
  /** Cap HTML snippet size in a11y violations before storing in FlowResult.metrics. */
  accessibilityHtmlSnippetLimit: z.number().int().min(0).default(500),
});
```

Add to `skepticConfigSchema` (line 72-82), sorted alphabetically with existing blocks:

```ts
export const skepticConfigSchema = z.object({
  url: z.string().optional(),
  tests: z.union([z.string(), z.array(z.string())]).default("tests/**/*.yaml"),
  browser: BrowserConfigSchema.default({}),
  auth: AuthConfigSchema.default({}),
  execution: ExecutionConfigSchema.default({}),
  output: OutputConfigSchema.default({}),
  ai: AIConfigSchema.default({}),
  hooks: HooksConfigSchema.default({}),
  observability: ObservabilityConfigSchema.default({}),     // NEW
  env: z.record(z.string()).default({}),
});
```

Export the inferred type alongside others (line 84-90):
```ts
export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;
```

### 1.3 Collector registry

**File:** `cli/src/observability/registry.ts`

```ts
import type { Collector, CollectorName } from "./types.js";
import type { ObservabilityConfig } from "../config/schema.js";
import { PerformanceCollector } from "./collectors/performance-collector.js";
import { NetworkCollector } from "./collectors/network-collector.js";
import { AccessibilityCollector } from "./collectors/accessibility-collector.js";

export interface BuildCollectorsInput {
  /** Collectors inferred from the flow's step list (assertPerformance → "performance", etc.). */
  required: Set<CollectorName>;
  /** Collectors from skeptic.config.yaml `observability.collectors`. */
  configured: readonly CollectorName[];
  /** Full observability config (thread-through for per-collector settings). */
  config: ObservabilityConfig;
}

export function buildCollectors(input: BuildCollectorsInput): Collector[] {
  const active = new Set<CollectorName>([...input.required, ...input.configured]);
  const collectors: Collector[] = [];
  if (active.has("performance")) collectors.push(new PerformanceCollector());
  if (active.has("network")) {
    collectors.push(new NetworkCollector({
      captureLimit: input.config.networkCaptureLimit,
      duplicateWindowMs: input.config.duplicateWindowMs,
    }));
  }
  if (active.has("accessibility")) {
    collectors.push(new AccessibilityCollector({
      dualEngine: input.config.accessibilityDualEngine,
      htmlSnippetLimit: input.config.accessibilityHtmlSnippetLimit,
    }));
  }
  return collectors;
}
```

### 1.4 Infer required collectors from the step list (with external-flow recursion)

**File:** `cli/src/observability/registry.ts` (same file — co-located with `buildCollectors`)

```ts
import type { NormalizedStep } from "../parser/step-normalizer.js";
import { parseFlowFile } from "../parser/flow-parser.js";
import * as path from "node:path";
import { logger } from "../utils/logger.js";

const STEP_TO_COLLECTOR: Record<string, CollectorName> = {
  assertPerformance: "performance",
  "assert-performance": "performance",
  assertNoNetworkErrors: "network",
  "assert-no-network-errors": "network",
  accessibilityAudit: "accessibility",
  "accessibility-audit": "accessibility",
};

export interface InferInput {
  steps: NormalizedStep[];
  hooks?: { onFlowStart?: NormalizedStep[]; onFlowComplete?: NormalizedStep[] };
  /** Directory the top-level flow's file lives in — used to resolve relative `runFlow.file` paths. */
  sourceDir: string;
}

/**
 * Walk a flow's steps (including hooks + nested retry/repeat/runFlow bodies) and return
 * the set of collectors they require. Recurses into `runFlow: { file: "..." }` children
 * at plan time so external subflows are covered without requiring manual config.
 *
 * Cycle detection: `visited` set keyed on resolved absolute file paths. Memoized results
 * aren't needed (we fold into one accumulator) but cycles must not loop forever.
 *
 * Failure mode: if a child file can't be parsed (missing, syntax error, or path uses
 * variable interpolation like `${slug}/child.yaml` that can't be resolved without
 * runtime state), log a debug message and skip. The runtime `handleRunFlow` will surface
 * the same error at step-execution time if the file really is broken, so we never mask
 * bugs — we just can't pre-attach a collector for that subflow. Users should set
 * `observability.collectors: [...]` in config when they use variable-interpolated paths.
 */
export function inferRequiredCollectors(input: InferInput): Set<CollectorName> {
  const required = new Set<CollectorName>();
  const visited = new Set<string>();

  const visit = (list: NormalizedStep[] | undefined, baseDir: string): void => {
    if (!list) return;
    for (const step of list) {
      const collector = STEP_TO_COLLECTOR[step.command];
      if (collector) required.add(collector);

      // runFlow shorthand: `runFlow: "./child.yaml"` normalizes to args as a plain string.
      // Handle BEFORE the object guard so shorthand doesn't get skipped.
      if (step.command === "runFlow" || step.command === "run-flow") {
        if (typeof step.args === "string") {
          scanExternalFile(step.args, baseDir, required, visited);
          continue;
        }
      }

      // Composite handlers — retry/repeat/runFlow args carry un-normalized Step[] in
      // `args.commands`. runFlow object-form additionally carries `args.file`.
      const args = step.args as Record<string, unknown> | undefined;
      if (!args || typeof args !== "object") continue;

      if (Array.isArray(args.commands)) {
        scanRawSteps(args.commands as unknown[], required, visited, baseDir);
      }

      if (step.command === "runFlow" || step.command === "run-flow") {
        scanExternalFile(args.file, baseDir, required, visited);
      }
    }
  };

  visit(input.steps, input.sourceDir);
  visit(input.hooks?.onFlowStart, input.sourceDir);
  visit(input.hooks?.onFlowComplete, input.sourceDir);
  return required;
}

function scanRawSteps(
  list: unknown[],
  acc: Set<CollectorName>,
  visited: Set<string>,
  baseDir: string,
): void {
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const rawObj = raw as Record<string, unknown>;

    for (const [key, collector] of Object.entries(STEP_TO_COLLECTOR)) {
      if (key in rawObj) acc.add(collector);
    }

    // Recurse into composite-body `commands` arrays.
    const nested = rawObj.commands;
    if (Array.isArray(nested)) scanRawSteps(nested, acc, visited, baseDir);

    for (const composite of ["retry", "repeat", "runFlow"] as const) {
      const body = rawObj[composite];
      if (body && typeof body === "object") {
        const bodyObj = body as Record<string, unknown>;
        if (Array.isArray(bodyObj.commands)) {
          scanRawSteps(bodyObj.commands as unknown[], acc, visited, baseDir);
        }
        if (composite === "runFlow") {
          // Shorthand `runFlow: "./child.yaml"` is a string; object form is `{ file, ... }`.
          scanExternalFile(
            typeof body === "string" ? body : bodyObj.file,
            baseDir,
            acc,
            visited,
          );
        }
      } else if (typeof body === "string" && composite === "runFlow") {
        scanExternalFile(body, baseDir, acc, visited);
      }
    }
  }
}

function scanExternalFile(
  filePathRaw: unknown,
  baseDir: string,
  acc: Set<CollectorName>,
  visited: Set<string>,
): void {
  if (typeof filePathRaw !== "string" || filePathRaw.length === 0) return;
  // Variable-interpolated paths (e.g. "${slug}/child.yaml") can't be resolved statically.
  // Skip — users in that case must use config. Runtime parse will still error normally.
  if (filePathRaw.includes("${")) return;

  const resolved = path.resolve(baseDir, filePathRaw);
  if (visited.has(resolved)) return;   // cycle guard
  visited.add(resolved);

  try {
    const childFlow = parseFlowFile(resolved);
    // childFlow.steps is Step[] (un-normalized); walk raw.
    scanRawSteps(childFlow.steps as unknown[], acc, visited, path.dirname(resolved));
    if (childFlow.metadata.onFlowStart) {
      scanRawSteps(childFlow.metadata.onFlowStart as unknown[], acc, visited, path.dirname(resolved));
    }
    if (childFlow.metadata.onFlowComplete) {
      scanRawSteps(childFlow.metadata.onFlowComplete as unknown[], acc, visited, path.dirname(resolved));
    }
  } catch (err) {
    logger.debug(
      `[observability] could not pre-scan runFlow child "${filePathRaw}" (resolved ${resolved}): ${err instanceof Error ? err.message : String(err)}. Falling back to config. Step-execution error (if any) will still surface normally.`,
    );
  }
}
```

**Design notes:**
- **External-file recursion is best-effort.** If parsing fails, we log and move on. The runtime `handleRunFlow` handler (`cli/src/executor/step-handlers/run-flow.ts:63`) will still surface the real parse error at execution time — we just can't preemptively attach the collector for that subflow. Users with unusual setups (variable-interpolated paths, dynamically-generated flows) must set `observability.collectors: [...]` in config.
- **Cycle detection** uses absolute resolved paths, so `a.yaml → b.yaml → a.yaml` terminates after the first revisit.
- **No memoization of results** — we fold into one shared accumulator, so revisiting a file is a no-op (cycle-guarded). Memoization would only matter for the rare O(n²) case of a wide DAG; complexity is not the bottleneck here.
- **Inference for composites inside composites** (retry containing runFlow) works naturally because `scanRawSteps` recurses through composite bodies before scanning external files.

### 1.5 Wire into `FlowInput`

**File:** `cli/src/executor/types.ts:38-51`

```ts
export interface FlowInput {
  url: string;
  name: string;
  file: string;
  steps: NormalizedStep[];
  timeout?: number;
  viewport?: { width: number; height: number };
  device?: string;
  auth?: "cookies" | "none";
  env?: Record<string, string>;
  onFlowStart?: NormalizedStep[];
  onFlowComplete?: NormalizedStep[];
  flowIndex?: number;
  /** Collectors the flow requires based on its step list. Computed by callers before handing off. */
  requiredCollectors?: Set<CollectorName>;
}
```

Import `CollectorName` from `../observability/types.js`.

**File:** `cli/src/commands/test.ts` — where `FlowInput` is built at line 462:

```ts
import { inferRequiredCollectors } from "../observability/registry.js";
import * as path from "node:path";

// ...inside flowToInput or equivalent, after normalizing steps + hooks:
const requiredCollectors = inferRequiredCollectors({
  steps,
  hooks: {
    onFlowStart: normalizedOnFlowStart,
    onFlowComplete: normalizedOnFlowComplete,
  },
  sourceDir: path.dirname(flow.filePath),
});
```

Pass `requiredCollectors` into `FlowInput`. Same change in `cli/src/commands/mcp.ts` `flowToInput` at line 316 — signature additions are backwards-compatible (new field defaults to empty set when absent).

### 1.6 Engine: attach, snapshot, detach

**File:** `cli/src/executor/playwright-engine.ts`

Three integration points. **Keep the existing try/finally skeleton intact** — collectors' errors must not mask flow status.

Imports (top of file):
```ts
import type { Collector } from "../observability/types.js";
import { buildCollectors } from "../observability/registry.js";
```

Engine options (`cli/src/executor/types.ts:58-76`):
```ts
export interface EngineOptions {
  // ...existing fields...
  observability?: ObservabilityConfig;
}
```
Import `ObservabilityConfig` from `../config/schema.js`.

**Attach** — after `page = await context.newPage()` at line 117, before the `ExecutionContext` constructor:

```ts
page = await context.newPage();

// Build and attach collectors BEFORE creating ExecutionContext — so that ctx.collectors is populated.
const observabilityConfig = this.options.observability ?? {
  collectors: [],
  networkCaptureLimit: 500,
  duplicateWindowMs: 500,
  accessibilityDualEngine: false,
  accessibilityHtmlSnippetLimit: 500,
};
const collectors: Collector[] = buildCollectors({
  required: input.requiredCollectors ?? new Set(),
  configured: observabilityConfig.collectors,
  config: observabilityConfig,
});

const ctx = new ExecutionContext(
  page,
  input.url,
  flowDir,
  path.dirname(input.file),
  this.options.aiClient,
  this.options.aiProvider,
  effectiveTimeout,
  collectors,    // new positional arg
);

// Attach AFTER ctx so collectors can reference it (e.g. flowDir for artifact writes).
for (const collector of collectors) {
  try {
    await collector.attach(page, ctx);
  } catch (err) {
    logger.warn(`Collector "${collector.name}" attach failed: ${err instanceof Error ? err.message : String(err)}`);
    // If attach fails, drop the collector from ctx so step handlers see its absence.
    ctx.collectors.delete(collector.name);
  }
}
```

**Snapshot + detach** — at line 283, **after** the `onFlowComplete` block, **before** video finalization at line 285:

```ts
// Collector snapshots + detach — after onFlowComplete (hooks may trigger a11y audits),
// before video finalization (which closes the page). Per-collector try/catch ensures
// no collector error masks flow status; the outer try/finally guarantees inTeardown is
// restored even if something unexpected throws outside the inner catches.
const metricsMap: Record<string, unknown> = {};
ctx.inTeardown = true;
try {
  for (const collector of ctx.collectors.values()) {
    try {
      const snap = await collector.snapshot();
      if (snap !== undefined && snap !== null) metricsMap[collector.name] = snap;
    } catch (err) {
      logger.warn(`Collector "${collector.name}" snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const collector of ctx.collectors.values()) {
    try {
      await collector.detach();
    } catch (err) {
      logger.warn(`Collector "${collector.name}" detach failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
} finally {
  ctx.inTeardown = false;
}
```

**Merge into result** — replace the existing `return { ... }` at line 303-310:

```ts
return {
  name: input.name,
  file: input.file,
  status: flowStatus,
  duration_ms: Math.round(performance.now() - start),
  steps,
  videoPath,
  metrics: Object.keys(metricsMap).length > 0 ? metricsMap : undefined,
};
```

**Abort semantics note:** per CLAUDE.md executor invariants, `ctx.abortReason` halts nested step dispatch in `executeNestedSteps`; `ctx.inTeardown` bypasses that. We set `inTeardown = true` here for symmetry with the `onFlowComplete` pattern — **collectors don't dispatch further steps, so this is primarily about consistency with surrounding teardown code**. The flag does **not** protect `page.evaluate()` or Playwright event callbacks from throwing if navigation is in flight or the page closed; that protection comes from the per-collector try/catch on `snapshot()`/`detach()`. Every collector implementation must assume `this.page?.isClosed()` can be true at any moment and short-circuit gracefully (see the performance-collector snapshot guard in 2.1).

**Handler-throw note for collector-backed step handlers:** `cli/src/executor/playwright-engine.ts:225-236` wraps each top-level handler dispatch in `try/finally` (not `try/catch`) — a handler throw at the top level **does** escape `runFlow()` via the outer `try/finally` at line 92-329. By contrast, `executeNestedSteps` at `cli/src/executor/step-handlers/nested-executor.ts:220-233` **does** wrap dispatch in `try/catch` and converts throws to `status: "error"` StepResults. This asymmetry is pre-existing skeptic behavior we don't change. **New collector-backed step handlers (`assertPerformance`, `assertNoNetworkErrors`, `accessibilityAudit`) must return `StepResult` with `status: "error"` rather than throwing**, so they behave identically at both dispatch sites. The implementations in sections 2.2, 3.2, 4.2 all follow this rule.

### 1.7 `ExecutionContext.collectors`

**File:** `cli/src/executor/context.ts`

```ts
import type { Collector, CollectorName } from "../observability/types.js";

export class ExecutionContext {
  // ...existing fields...
  readonly collectors: Map<CollectorName, Collector>;

  constructor(
    page: Page,
    baseUrl: string,
    flowDir?: string,
    sourceDir?: string,
    aiClient?: AIClient,
    aiProvider?: AIProvider,
    defaultTimeout: number = 30_000,
    collectors: Collector[] = [],     // new optional positional
  ) {
    // ...existing assignments...
    this.collectors = new Map(collectors.map((c) => [c.name, c]));
  }
}
```

Passing an array and converting to a Map inside the constructor keeps the call-site ergonomics close to today's (positional args, one per concern) and lets step handlers do `ctx.collectors.get("performance")`.

**Note on positional args:** `ExecutionContext`'s constructor already has 7 positional params (`page`, `baseUrl`, `flowDir`, `sourceDir`, `aiClient`, `aiProvider`, `defaultTimeout`). Adding an 8th is stylistically awkward but matches the existing pattern. **Do not refactor to an options object** for this change — it would ripple into every test that constructs an `ExecutionContext` (confirmed 6 test files today via `grep -r "new ExecutionContext"`). Keep the positional signature; add `collectors` as the last arg with a safe default.

### 1.8 Engine options wiring

**Files:** `cli/src/commands/test.ts`, `cli/src/commands/mcp.ts`

Where `engineOpts` is built, add:
```ts
observability: config.observability,
```

The config is already loaded (`const config = loadConfig(...)`). One-liner per file.

### 1.9 Tests

**File:** `cli/__tests__/unit/observability/registry.test.ts`

- `buildCollectors` with `required = new Set(["performance"])` → returns `[PerformanceCollector]`.
- `buildCollectors` with union of required and configured → deduplicates.
- `inferRequiredCollectors` on a step list containing `{ command: "assertPerformance", ... }` → `Set(["performance"])`.
- `inferRequiredCollectors` on a step list containing `{ command: "retry", args: { commands: [{ assertNoNetworkErrors: true }] } }` → `Set(["network"])` (nested scan works).
- `inferRequiredCollectors` on a step list with no observability steps → empty set.
- Three observability steps nested under `repeat` + `retry` → all three collectors inferred.
- External-file recursion: parent flow `{ runFlow: "./child.yaml" }` where `child.yaml` contains `assertPerformance` → returns `Set(["performance"])`. Fixtures under `cli/__tests__/fixtures/observability/external/`.
- Cycle detection: `a.yaml → b.yaml → a.yaml` → no infinite loop, returns whatever collectors are inferred once.
- Unreadable child file (path doesn't exist) → logs debug, returns empty set; does not throw.
- Variable-interpolated runFlow path (`"${slug}/child.yaml"`) → skipped, debug-logged; returns empty set.

**File:** `cli/__tests__/unit/config/observability-config.test.ts`

- `skepticConfigSchema.safeParse({ observability: { collectors: ["performance"] } })` → success.
- Invalid collector name → zod error.
- Defaults: `{ collectors: [], networkCaptureLimit: 500, duplicateWindowMs: 500, accessibilityDualEngine: false, accessibilityHtmlSnippetLimit: 500 }` when block absent.
- `networkCaptureLimit: -1` → zod error.
- `accessibilityHtmlSnippetLimit: -5` → zod error (min 0).
- `accessibilityHtmlSnippetLimit: 0` → accepted (means "suppress snippets entirely").

**File:** `cli/__tests__/unit/executor/observability-integration.test.ts`

Mock `Page` and a stub `Collector`; run a minimal flow through `PlaywrightEngine.runFlow`:
- `attach` called with `(page, ctx)` before the first step.
- `snapshot` called before `detach`.
- `detach` called once.
- Returned `FlowResult.metrics[name]` matches the stub's snapshot.
- Stub collector that throws in `attach` → flow still runs, collector removed from `ctx.collectors`, warning logged.
- Stub collector that throws in `snapshot` → `metrics` omitted for that collector, other collectors still populate.
- Stub collector that throws in `detach` → flow status unchanged (no mask), warning logged.

Idiom: match `cli/__tests__/unit/executor/step-handlers.test.ts:7-33` for the `mockLocator`/`createMockPage` pattern.

---

## Phase 2 — Performance collector + `assertPerformance`

### 2.1 `PerformanceCollector` class

**File:** `cli/src/observability/collectors/performance-collector.ts`

```ts
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import type { Page } from "playwright";
import type { Collector, CollectorName, PerformanceSnapshot } from "../types.js";
import type { ExecutionContext } from "../../executor/context.js";
import { logger } from "../../utils/logger.js";

const require_ = createRequire(import.meta.url);
const WEB_VITALS_IIFE_PATH = require_.resolve("web-vitals/dist/web-vitals.iife.js");
const LOAF_BUFFER_LIMIT = 50;

let cachedWebVitalsSource: string | null = null;

const loadWebVitalsSource = async (): Promise<string> => {
  if (cachedWebVitalsSource !== null) return cachedWebVitalsSource;
  cachedWebVitalsSource = await readFile(WEB_VITALS_IIFE_PATH, "utf-8");
  return cachedWebVitalsSource;
};

const buildInitScript = (webVitalsSource: string): string => `
${webVitalsSource}
;(() => {
  if (window.__skepticMetrics) return;   // idempotent — handle re-injection on navigation
  window.__skepticMetrics = { fcp: null, lcp: null, cls: null, inp: null, ttfb: null, longAnimationFrames: [] };
  if (typeof webVitals === 'undefined') return;   // IIFE failed to define global; no-op
  const { onFCP, onLCP, onCLS, onINP, onTTFB } = webVitals;
  onFCP((v) => window.__skepticMetrics.fcp = v.value);
  onLCP((v) => window.__skepticMetrics.lcp = v.value);
  onCLS((v) => window.__skepticMetrics.cls = v.value);
  onINP((v) => window.__skepticMetrics.inp = v.value);
  onTTFB((v) => window.__skepticMetrics.ttfb = v.value);
  if (typeof PerformanceObserver !== 'undefined' &&
      PerformanceObserver.supportedEntryTypes &&
      PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) {
    try {
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (window.__skepticMetrics.longAnimationFrames.length >= ${LOAF_BUFFER_LIMIT}) return;
          window.__skepticMetrics.longAnimationFrames.push({
            startTime: e.startTime,
            duration: e.duration,
            blockingDuration: e.blockingDuration || 0,
            scripts: (e.scripts || []).map((s) => ({
              invoker: s.invoker || '',
              sourceURL: s.sourceURL || '',
              sourceFunctionName: s.sourceFunctionName || '',
              duration: s.duration || 0,
            })),
          });
        }
      });
      obs.observe({ type: 'long-animation-frame', buffered: true });
    } catch (_err) { /* LoAF unsupported in this browser — silent no-op */ }
  }
})();
`;

export class PerformanceCollector implements Collector {
  readonly name: CollectorName = "performance";
  private page: Page | null = null;

  async attach(page: Page, _ctx: ExecutionContext): Promise<void> {
    this.page = page;
    // Single combined init script: web-vitals IIFE concatenated with our wrapper.
    // One addInitScript call removes any ordering ambiguity vs. registering two separate
    // scripts (Playwright processes init scripts in registration order today, but a single
    // script eliminates the dependency on that guarantee entirely).
    const webVitalsSource = await loadWebVitalsSource();
    await page.addInitScript({ content: buildInitScript(webVitalsSource) });
  }

  async snapshot(): Promise<PerformanceSnapshot> {
    const empty: PerformanceSnapshot = {
      fcp: null, lcp: null, cls: null, inp: null, ttfb: null, longAnimationFrames: [],
    };
    if (!this.page || this.page.isClosed()) return empty;
    try {
      const result = await this.page.evaluate<PerformanceSnapshot>(
        "window.__skepticMetrics || { fcp: null, lcp: null, cls: null, inp: null, ttfb: null, longAnimationFrames: [] }",
      );
      return {
        fcp: result.fcp,
        lcp: result.lcp,
        cls: result.cls === null ? null : Math.round((result.cls ?? 0) * 1000) / 1000,
        inp: result.inp === null ? null : Math.round(result.inp ?? 0),
        ttfb: result.ttfb === null ? null : Math.round(result.ttfb ?? 0),
        longAnimationFrames: (result.longAnimationFrames ?? []).slice(0, LOAF_BUFFER_LIMIT),
      };
    } catch (err) {
      logger.debug(`[performance] snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
      return empty;
    }
  }

  async detach(): Promise<void> {
    this.page = null;     // nothing to unsubscribe — init scripts are page-lifecycle bound
  }
}
```

**Why a single combined init script:** Playwright's `page.addInitScript` runs **every** registered script before any page scripts on every navigation (including redirects and child frames). Concatenating `web-vitals` IIFE source with our wrapper into one `addInitScript({ content })` call produces a single monolithic init script per frame — no dependency on registration-order semantics between two separate calls. The IIFE establishes `globalThis.webVitals`; the wrapper (running in the same script, immediately after) destructures from it. The wrapper's idempotency guard (`if (window.__skepticMetrics) return`) handles re-injection on subsequent navigations — fresh observers are intentional because `web-vitals` requires page-lifecycle-bound listeners.

**Caching:** `cachedWebVitalsSource` is module-level, so the ~3KB file is read from disk once per process, not per flow. Tests can reset via `vi.resetModules()` if needed.

**LoAF rounding decision:** Expect rounds LoAF durations to integers at snapshot time. We don't — we hand raw floats to reporters, let them format. Raw fidelity matters for analysis.

**CLS rounding:** 3 decimals (matches Expect and the spec).

### 2.2 `assertPerformance` step handler

**File:** `cli/src/executor/step-handlers/assert-performance.ts`

Spec: `assertPerformance: { lcp: "<2.5s", cls: "<0.1", inp: "<200ms", fcp?: "<1.8s", ttfb?: "<600ms" }`.

```ts
import type { Page } from "playwright";
import type { ExecutionContext } from "../context.js";
import type { StepResult } from "../types.js";
import type { PerformanceSnapshot, Collector } from "../../observability/types.js";
import { parseThreshold, checkThreshold, type Threshold } from "../../observability/assert-parser.js";

type MetricName = "fcp" | "lcp" | "cls" | "inp" | "ttfb";

const TIME_METRICS: ReadonlySet<MetricName> = new Set(["fcp", "lcp", "inp", "ttfb"]);

interface AssertPerformanceArgs {
  fcp?: string;
  lcp?: string;
  cls?: string;
  inp?: string;
  ttfb?: string;
}

export const handleAssertPerformance = async (
  _page: Page,
  ctx: ExecutionContext,
  args: unknown,
): Promise<StepResult> => {
  const start = performance.now();
  const parsed = args as AssertPerformanceArgs;
  if (!parsed || typeof parsed !== "object") {
    return {
      command: "assertPerformance",
      args,
      status: "error",
      duration_ms: Math.round(performance.now() - start),
      error: `assertPerformance requires an object, got ${typeof parsed}`,
    };
  }

  const collector = ctx.collectors.get("performance") as Collector | undefined;
  if (!collector) {
    return {
      command: "assertPerformance",
      args,
      status: "error",
      duration_ms: Math.round(performance.now() - start),
      error: `Performance collector not attached. Add "performance" to observability.collectors in skeptic.config.yaml, or ensure the flow parser discovered this step (check flow path).`,
    };
  }

  const snapshot = (await collector.snapshot()) as PerformanceSnapshot;
  const failures: string[] = [];

  for (const metric of ["fcp", "lcp", "cls", "inp", "ttfb"] as const) {
    const expr = parsed[metric];
    if (expr === undefined) continue;

    let threshold: Threshold;
    try {
      threshold = parseThreshold(expr, TIME_METRICS.has(metric) ? "ms" : "unitless");
    } catch (err) {
      return {
        command: "assertPerformance",
        args,
        status: "error",
        duration_ms: Math.round(performance.now() - start),
        error: `assertPerformance: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const actual = snapshot[metric];
    if (actual === null || actual === undefined) {
      failures.push(`${metric.toUpperCase()}: not measured (metric did not fire on this page)`);
      continue;
    }
    if (!checkThreshold(actual, threshold)) {
      const displayActual = metric === "cls" ? actual.toFixed(3) : `${Math.round(actual)}ms`;
      failures.push(`${metric.toUpperCase()}: ${displayActual} fails ${threshold.raw}`);
    }
  }

  if (failures.length === 0) {
    return { command: "assertPerformance", args, status: "passed", duration_ms: Math.round(performance.now() - start) };
  }
  return {
    command: "assertPerformance",
    args,
    status: "failed",
    duration_ms: Math.round(performance.now() - start),
    error: failures.join("; "),
  };
};
```

**Design note on "metric did not fire":** INP only fires after user interaction; LCP after the largest element paints. If the user asserts `inp: "<200ms"` on a page with no interactions, INP is `null`. We treat that as a failure with a clear message, rather than silently passing — otherwise flaky assertions silently become no-ops. Users can guard with `optional: true` if they want that step's failure downgraded (standard skeptic optional pattern).

### 2.3 Schema + registration

**File:** `cli/src/parser/flow-schema.ts`

Add to `COMMAND_KEYS` (line 13-54):
```ts
// Bundle 3: Observability assertions
"assertPerformance",
"assertNoNetworkErrors",
"accessibilityAudit",
```

Add to `Step` interface (line 68-134):
```ts
// Bundle 3: Observability assertions
assertPerformance?: {
  fcp?: string;
  lcp?: string;
  cls?: string;
  inp?: string;
  ttfb?: string;
};
assertNoNetworkErrors?:
  | boolean
  | {
      allowStatus?: number[];         // tolerated status codes, e.g. [404] to skip legitimate 404s
      allowUrls?: string[];           // URL substrings to exclude from error checks
      ignoreDuplicates?: boolean;
      ignoreMixedContent?: boolean;
      ignoreCors?: boolean;
      ignoreNetworkFailures?: boolean;
    };
accessibilityAudit?:
  | boolean
  | {
      standard?: "WCAG2A" | "WCAG2AA" | "WCAG21A" | "WCAG21AA" | "WCAG22AA";
      impacts?: Array<"critical" | "serious" | "moderate" | "minor">;   // levels to fail on
      include?: string[];              // CSS selectors to audit (axe-only)
      exclude?: string[];              // CSS selectors to skip (axe-only)
    };
```

Add to `StepSchema` (line 155-360), before the `.refine(...)` chain:
```ts
assertPerformance: z.object({
  fcp: z.string().optional(),
  lcp: z.string().optional(),
  cls: z.string().optional(),
  inp: z.string().optional(),
  ttfb: z.string().optional(),
}).optional(),
assertNoNetworkErrors: z.union([
  z.boolean(),
  z.object({
    allowStatus: z.array(z.number().int()).optional(),
    allowUrls: z.array(z.string()).optional(),
    ignoreDuplicates: z.boolean().optional(),
    ignoreMixedContent: z.boolean().optional(),
    ignoreCors: z.boolean().optional(),
    ignoreNetworkFailures: z.boolean().optional(),
  }),
]).optional(),
accessibilityAudit: z.union([
  z.boolean(),
  z.object({
    standard: z.enum(["WCAG2A", "WCAG2AA", "WCAG21A", "WCAG21AA", "WCAG22AA"]).optional(),
    impacts: z.array(z.enum(["critical", "serious", "moderate", "minor"])).optional(),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
  }),
]).optional(),
```

**File:** `cli/src/executor/step-handlers/index.ts`

Import at the top (after Bundle 1 imports, line 37-41):
```ts
// Bundle 3: Observability
import { handleAssertPerformance } from "./assert-performance.js";
import { handleAssertNoNetworkErrors } from "./assert-no-network-errors.js";
import { handleAccessibilityAudit } from "./accessibility-audit.js";
```

Register in `stepHandlers` map (after Bundle 1 entries, line 88-96):
```ts
// Bundle 3: Observability assertions (both dashed + camelCase)
"assert-performance": handleAssertPerformance,
assertPerformance: handleAssertPerformance,
"assert-no-network-errors": handleAssertNoNetworkErrors,
assertNoNetworkErrors: handleAssertNoNetworkErrors,
"accessibility-audit": handleAccessibilityAudit,
accessibilityAudit: handleAccessibilityAudit,
```

Add to the re-export block (line 113-150):
```ts
handleAssertPerformance,
handleAssertNoNetworkErrors,
handleAccessibilityAudit,
```

### 2.4 Tests

**File:** `cli/__tests__/unit/observability/performance-collector.test.ts`

Mock `Page` with `addInitScript` and `evaluate` spies:
- `attach` calls `addInitScript` **once** with a single combined `content` string.
- The `content` argument contains both the web-vitals IIFE source (regex check for `onLCP` as a function definition / export) AND the wrapper IIFE (regex check for `window.__skepticMetrics`, `long-animation-frame`).
- `snapshot` with `evaluate` returning `{ fcp: 1200, lcp: 2300, cls: 0.05, inp: 180, ttfb: 250, longAnimationFrames: [] }` → returns normalized shape.
- `snapshot` with `evaluate` returning `{ cls: 0.0567 }` → CLS rounded to `0.057`.
- `snapshot` when page closed → returns empty shape, no throw.
- `snapshot` when evaluate throws → returns empty shape, no throw, debug-logged.
- `detach` sets internal page ref to null.
- Wrapper script's idempotency guard: load wrapper twice (string regex check) — first call sets up observers, second returns early.

**File:** `cli/__tests__/unit/executor/step-handlers/assert-performance.test.ts`

- Happy: snapshot `{ lcp: 2000 }` + args `{ lcp: "<2.5s" }` → passed.
- Failure: snapshot `{ lcp: 3000 }` + args `{ lcp: "<2.5s" }` → failed with "LCP: 3000ms fails <2.5s".
- Multi-metric: one fails, one passes → failed with only the failing metric in error.
- CLS: snapshot `{ cls: 0.15 }` + args `{ cls: "<0.1" }` → failed with "CLS: 0.150 fails <0.1".
- Metric not measured: snapshot `{ inp: null }` + args `{ inp: "<200ms" }` → failed with "INP: not measured".
- Invalid threshold: args `{ lcp: "foo" }` → status: "error".
- No `performance` collector in ctx: returns status "error" with clear message.
- Empty args `{}` → passed (no assertions).

**File:** `cli/__tests__/integration/observability/performance-smoke.test.ts`

Real Playwright test against a fixture HTML page (`cli/__tests__/fixtures/observability/perf-test.html`) containing:
- A large image for LCP.
- Some content for FCP.
- A button that, when clicked, triggers a 300ms synchronous loop for INP.

Steps: navigate → click button → `assertPerformance: { lcp: "<5s", cls: "<0.5" }`. Assert passed.

Why a smoke test: web-vitals' page lifecycle dependencies (paint events, layout shifts) are hard to mock accurately. One real-browser check catches integration bugs the unit tests miss.

---

## Phase 3 — Network collector + `assertNoNetworkErrors`

### 3.1 `NetworkCollector` class

**File:** `cli/src/observability/collectors/network-collector.ts`

```ts
import type { Page, Request, Response } from "playwright";
import type { Collector, CollectorName, NetworkSnapshot, NetworkRequest } from "../types.js";
import type { ExecutionContext } from "../../executor/context.js";
import { logger } from "../../utils/logger.js";

interface NetworkCollectorOptions {
  captureLimit: number;        // 0 = unlimited
  duplicateWindowMs: number;
}

export class NetworkCollector implements Collector {
  readonly name: CollectorName = "network";
  private page: Page | null = null;
  /**
   * Insertion-ordered list of captured requests — reporters and issue computation iterate this.
   * Kept in sync with `entryByRequest` which exists solely for O(1) update lookup.
   */
  private readonly requests: NetworkRequest[] = [];
  /**
   * Keyed by Playwright's per-fire Request object (identity key, not url+method), which is
   * unique per actual network request. Using Request as the key means concurrent requests
   * to the same URL+method update independently — the cross-wiring bug that the url+method
   * reverse-scan had is structurally impossible here.
   */
  private readonly entryByRequest: Map<Request, NetworkRequest> = new Map();
  private readonly options: NetworkCollectorOptions;
  private onRequest?: (req: Request) => void;
  private onResponse?: (res: Response) => void;
  private onRequestFailed?: (req: Request) => void;
  private onRequestFinished?: (req: Request) => void;

  constructor(options: NetworkCollectorOptions) {
    this.options = options;
  }

  async attach(page: Page, _ctx: ExecutionContext): Promise<void> {
    this.page = page;

    this.onRequest = (req) => {
      if (this.options.captureLimit > 0 && this.requests.length >= this.options.captureLimit) return;
      // Capture the frame URL at request time — needed for per-request mixed-content
      // classification. Playwright's Request#frame() throws if the frame is detached;
      // guard so attach failures don't crash the handler.
      let frameUrl: string | undefined;
      try { frameUrl = req.frame().url(); } catch { frameUrl = undefined; }
      const entry: NetworkRequest = {
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        timestamp: Date.now(),
        frameUrl,
      };
      this.requests.push(entry);
      this.entryByRequest.set(req, entry);
    };

    this.onResponse = (res) => {
      const entry = this.entryByRequest.get(res.request());
      if (entry) entry.status = res.status();
    };

    this.onRequestFailed = (req) => {
      const entry = this.entryByRequest.get(req);
      if (!entry) return;
      entry.failure = req.failure()?.errorText ?? "unknown failure";
    };

    this.onRequestFinished = (req) => {
      const entry = this.entryByRequest.get(req);
      if (!entry) return;
      const timing = req.timing();
      // responseEnd and startTime are ms offsets from navigationStart; negative values mean
      // the response never completed, fall back to undefined.
      const duration = timing.responseEnd - timing.startTime;
      entry.duration = duration >= 0 ? Math.round(duration) : undefined;
    };

    page.on("request", this.onRequest);
    page.on("response", this.onResponse);
    page.on("requestfailed", this.onRequestFailed);
    page.on("requestfinished", this.onRequestFinished);
  }

  async snapshot(): Promise<NetworkSnapshot> {
    return {
      requests: this.requests.slice(),
      issues: this.computeIssues(),
    };
  }

  async detach(): Promise<void> {
    if (this.page && this.onRequest) this.page.off("request", this.onRequest);
    if (this.page && this.onResponse) this.page.off("response", this.onResponse);
    if (this.page && this.onRequestFailed) this.page.off("requestfailed", this.onRequestFailed);
    if (this.page && this.onRequestFinished) this.page.off("requestfinished", this.onRequestFinished);
    this.page = null;
    this.entryByRequest.clear();   // release Request object refs
  }

  private computeIssues(): NetworkSnapshot["issues"] {
    const failedRequests: NetworkSnapshot["issues"]["failedRequests"] = [];
    const networkFailures: NetworkSnapshot["issues"]["networkFailures"] = [];

    for (const r of this.requests) {
      // HTTP-level failure: response came back with a 4xx/5xx status.
      if (r.status !== undefined && r.status >= 400 && r.status < 600) {
        failedRequests.push({ url: r.url, method: r.method, status: r.status });
        continue;
      }
      // Network-level failure: the request never produced a response at all. Includes DNS
      // resolution failures (net::ERR_NAME_NOT_RESOLVED), TCP resets, aborted navigations,
      // blocked requests (CSP, ad blockers), and — on Chromium — CORS preflight blocks.
      // CORS is classified separately below; exclude it from `networkFailures` to avoid
      // double-counting.
      if (r.status === undefined && r.failure !== undefined) {
        const lower = r.failure.toLowerCase();
        if (!lower.includes("cors") && !lower.includes("access-control")) {
          networkFailures.push({ url: r.url, method: r.method, reason: r.failure });
        }
      }
    }

    const duplicates = this.findDuplicates();
    const mixedContent = this.findMixedContent();
    const corsErrors = this.findCorsErrors();

    return { failedRequests, networkFailures, duplicates, mixedContent, corsErrors };
  }

  private findDuplicates(): NetworkSnapshot["issues"]["duplicates"] {
    const buckets = new Map<string, NetworkRequest[]>();
    for (const r of this.requests) {
      const key = `${r.method}:${r.url}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(r);
    }
    const out: NetworkSnapshot["issues"]["duplicates"] = [];
    for (const [key, bucket] of buckets.entries()) {
      if (bucket.length < 2) continue;
      bucket.sort((a, b) => a.timestamp - b.timestamp);
      let windowCount = 1;
      for (let i = 1; i < bucket.length; i++) {
        if (bucket[i]!.timestamp - bucket[i - 1]!.timestamp < this.options.duplicateWindowMs) {
          windowCount++;
        } else {
          if (windowCount >= 2) {
            out.push({
              method: bucket[0]!.method,
              url: bucket[0]!.url,
              count: windowCount,
              windowMs: this.options.duplicateWindowMs,
            });
          }
          windowCount = 1;
        }
      }
      if (windowCount >= 2) {
        out.push({
          method: bucket[0]!.method,
          url: bucket[0]!.url,
          count: windowCount,
          windowMs: this.options.duplicateWindowMs,
        });
      }
    }
    return out;
  }

  private findMixedContent(): string[] {
    // Per-request classification — the question is whether each request was initiated
    // from an HTTPS context, not what the page URL is at snapshot time. This handles
    // flows that navigate between http and https schemes.
    const out: string[] = [];
    for (const r of this.requests) {
      if (!r.frameUrl || !r.frameUrl.startsWith("https://")) continue;
      if (r.url.startsWith("data:") || r.url.startsWith("blob:")) continue;
      if (r.url.startsWith("http://")) out.push(r.url);
    }
    return out;
  }

  private findCorsErrors(): NetworkSnapshot["issues"]["corsErrors"] {
    const out: NetworkSnapshot["issues"]["corsErrors"] = [];
    for (const r of this.requests) {
      if (!r.failure) continue;
      // Chromium surfaces CORS failures as error text containing "CORS" or "Access-Control"
      if (r.failure.includes("CORS") || r.failure.toLowerCase().includes("access-control")) {
        out.push({ url: r.url, method: r.method, reason: r.failure });
      }
    }
    return out;
  }
}
```

**Design notes:**
- **Why `page.off` in detach:** Playwright pages are per-flow (isolated context per `runFlow`), so listeners would die with the context close anyway. But explicit `off` is cheap and matches the interface contract.
- **Request matching via `Map<Request, NetworkRequest>`:** each `Request` event fires with a unique `Request` object; Playwright's `response.request()`, `requestfailed` / `requestfinished` callbacks all receive the same object instance. Keying the entry map on the object identity means concurrent requests to the same URL+method **cannot** cross-wire — the naive reverse-scan heuristic that an earlier draft used is replaced by O(1) identity lookup. When the `captureLimit` is reached, new requests are neither added to `requests[]` nor to `entryByRequest`, so their later response/failed/finished events become silent no-ops (the map lookup returns undefined and the early `return` skips the update). This is the correct behavior — uncaptured requests don't pollute partial state.
- **Capture limit:** 500 by default (chosen over Expect's unbounded design because long E2E flows routinely hit 1000+ requests; OOM is a real risk in CI). User overrides via `observability.networkCaptureLimit: 0` for unlimited.
- **Network-level failures** (DNS, TCP, aborts, CSP blocks) populate the new `networkFailures` issues category; `assertNoNetworkErrors` counts them. Previously such failures had no user-visible surface — Expect has the same gap.
- **CORS classification:** `requestfailed` events whose `failure.errorText` matches `/cors|access-control/i` are routed to `corsErrors` and excluded from `networkFailures` to avoid double-counting. Chromium's error text includes the string `"ERR_BLOCKED_BY_RESPONSE.NotSameOriginAfterDefaultedToSameOriginByCoep"` and similar — matches the substring `"cors"` loosely; false positives possible on exotic error messages but preferable to missing CORS cases. Firefox/WebKit users might get false negatives; acceptable for v1.
- **Duplicate detection:** sliding window within the request bucket. Matches Expect's 500ms default but handles multiple clusters (e.g. three rapid clicks spaced out) correctly, which Expect's simpler pairwise check doesn't.
- **Mixed content:** only flagged when page is `https://`. Skips `data:` and `blob:` URLs (modern SPAs use these for images/workers).
- **No URL filtering by default:** Expect doesn't filter analytics/beacons either. Users opt-in via `assertNoNetworkErrors: { allowUrls: ["google-analytics.com"] }`.

**Security / data-exposure note:** raw request URLs are captured as-is, including query strings that may contain session tokens, JWTs, or PII (e.g. `?token=eyJhbGci...`). Network metrics flow through to `FlowResult.metrics.network.requests` and — when the HTML or JSON reporter is enabled — are written to disk and potentially shared. V1 does **not** auto-redact URLs; documented in the README and the `observability` config block JSDoc. Users with sensitive endpoints should either (a) scope their flows away from captured URLs, (b) use `allowUrls` to filter out the URL from assertion, noting it still appears in the snapshot, or (c) disable network capture entirely by omitting `"network"` from `observability.collectors` and any `assertNoNetworkErrors` step. Automatic query-param redaction is tracked as v2 work; we chose not to ship it in v1 because heuristics would break legitimate debugging use cases (a user asserting on an API endpoint wants to see the params).

### 3.2 `assertNoNetworkErrors` step handler

**File:** `cli/src/executor/step-handlers/assert-no-network-errors.ts`

```ts
import type { Page } from "playwright";
import type { ExecutionContext } from "../context.js";
import type { StepResult } from "../types.js";
import type { Collector, NetworkSnapshot } from "../../observability/types.js";

interface AssertNoNetworkErrorsArgs {
  allowStatus?: number[];
  allowUrls?: string[];
  ignoreDuplicates?: boolean;
  ignoreMixedContent?: boolean;
  ignoreCors?: boolean;
  /** When true, DNS/TCP/aborted failures don't fail the assertion. Default: false. */
  ignoreNetworkFailures?: boolean;
}

export const handleAssertNoNetworkErrors = async (
  _page: Page,
  ctx: ExecutionContext,
  args: unknown,
): Promise<StepResult> => {
  const start = performance.now();
  // Support both `assertNoNetworkErrors: true` and `assertNoNetworkErrors: { ... }`
  const parsed: AssertNoNetworkErrorsArgs =
    args === true || args === undefined || args === null ? {} : (args as AssertNoNetworkErrorsArgs);

  const collector = ctx.collectors.get("network") as Collector | undefined;
  if (!collector) {
    return {
      command: "assertNoNetworkErrors",
      args,
      status: "error",
      duration_ms: Math.round(performance.now() - start),
      error: `Network collector not attached. Add "network" to observability.collectors in skeptic.config.yaml, or ensure the flow parser discovered this step.`,
    };
  }

  const snap = (await collector.snapshot()) as NetworkSnapshot;
  const allowUrls = parsed.allowUrls ?? [];
  const allowStatus = new Set(parsed.allowStatus ?? []);

  const matchesAllow = (url: string): boolean =>
    allowUrls.some((needle) => url.includes(needle));

  const issues: string[] = [];

  // 4xx/5xx
  const failed = snap.issues.failedRequests.filter(
    (r) => !matchesAllow(r.url) && !allowStatus.has(r.status),
  );
  if (failed.length > 0) {
    issues.push(`${failed.length} failed request(s): ${failed.slice(0, 3).map((r) => `${r.method} ${r.url} → ${r.status}`).join("; ")}${failed.length > 3 ? " ..." : ""}`);
  }

  // Network-level failures (DNS, TCP, aborted, blocked)
  if (!parsed.ignoreNetworkFailures) {
    const netFail = snap.issues.networkFailures.filter((r) => !matchesAllow(r.url));
    if (netFail.length > 0) {
      issues.push(`${netFail.length} network failure(s): ${netFail.slice(0, 3).map((r) => `${r.method} ${r.url} (${r.reason})`).join("; ")}${netFail.length > 3 ? " ..." : ""}`);
    }
  }

  // Duplicates
  if (!parsed.ignoreDuplicates) {
    const dups = snap.issues.duplicates.filter((d) => !matchesAllow(d.url));
    if (dups.length > 0) {
      issues.push(`${dups.length} duplicate request group(s): ${dups.slice(0, 3).map((d) => `${d.method} ${d.url} ×${d.count}`).join("; ")}${dups.length > 3 ? " ..." : ""}`);
    }
  }

  // Mixed content
  if (!parsed.ignoreMixedContent && snap.issues.mixedContent.length > 0) {
    const mc = snap.issues.mixedContent.filter((u) => !matchesAllow(u));
    if (mc.length > 0) {
      issues.push(`${mc.length} mixed-content resource(s): ${mc.slice(0, 3).join("; ")}${mc.length > 3 ? " ..." : ""}`);
    }
  }

  // CORS
  if (!parsed.ignoreCors && snap.issues.corsErrors.length > 0) {
    const cors = snap.issues.corsErrors.filter((c) => !matchesAllow(c.url));
    if (cors.length > 0) {
      issues.push(`${cors.length} CORS error(s): ${cors.slice(0, 3).map((c) => `${c.method} ${c.url}`).join("; ")}${cors.length > 3 ? " ..." : ""}`);
    }
  }

  if (issues.length === 0) {
    return { command: "assertNoNetworkErrors", args, status: "passed", duration_ms: Math.round(performance.now() - start) };
  }
  return {
    command: "assertNoNetworkErrors",
    args,
    status: "failed",
    duration_ms: Math.round(performance.now() - start),
    error: issues.join(" | "),
  };
};
```

### 3.3 Tests

**File:** `cli/__tests__/unit/observability/network-collector.test.ts`

Unit tests around a handrolled `FakePage` that exposes `emit(event, payload)` to simulate `page.on(...)` callbacks. Simulated `Request` objects are plain object instances — identity-keyed by reference, matching Playwright's API contract:
- `attach` registers four handlers (`request`, `response`, `requestfailed`, `requestfinished`).
- `request` event → entry in `requests[]` with correct shape, `status === undefined`, and the Request instance mapped in `entryByRequest`.
- `response` event → looks up the pending request by Request identity; fills `status`.
- `requestfailed` event → fills `failure`.
- `requestfinished` event → fills `duration` from `req.timing()`.
- **Concurrency regression:** two concurrent requests to the same `GET /api` (two different Request instances) — response for request A arrives before request B's response → A's entry gets A's status, B's entry gets B's status; no cross-wiring.
- 4xx response → appears in `snapshot().issues.failedRequests`.
- `requestfailed` with `errorText: "net::ERR_NAME_NOT_RESOLVED"` → appears in `networkFailures`, NOT in `failedRequests`, NOT in `corsErrors`.
- Failed request with `errorText: "net::ERR_FAILED because blocked by CORS policy"` → appears in `corsErrors`, NOT in `networkFailures`.
- Two identical GET requests 200ms apart → `duplicates` has one entry with `count: 2`.
- Two identical GET requests 1000ms apart → `duplicates` empty (outside default 500ms window).
- Request fires while `frame().url()` is `https://example.com`; request is `http://cdn.example/x.png` → `mixedContent` includes it.
- Request fires while `frame().url()` is `http://example.com`; request is `http://cdn.example/x.png` → NOT in `mixedContent` (initiator was HTTP).
- Navigation flow: request A fires on `http://example.com` page, then navigation to `https://example.com` happens, then request B fires on HTTPS page — only B is classified by its own frame URL. Both A and B have their own `frameUrl` captured at request time.
- Playwright throws when calling `req.frame()` (frame detached) → `frameUrl` remains undefined; mixed-content check skips that entry safely.
- `https://` frame + `data:` URL resource → not in `mixedContent`.
- `captureLimit: 3` + 5 requests → only 3 captured; response events for the uncaptured 4th/5th requests are silent no-ops (map lookup returns undefined).
- `detach` calls `page.off` four times and clears `entryByRequest`.
- Snapshot on detached collector → returns last known state, no throw.

**File:** `cli/__tests__/unit/executor/step-handlers/assert-no-network-errors.test.ts`

- No network issues → passed.
- One 404 + `allowStatus: [404]` → passed.
- One 500 → failed with "1 failed request(s): GET /api → 500".
- Three 500s → failed; error message truncates to first 3 with "...".
- Network failure (DNS) detected → failed with "1 network failure(s): GET ... (net::ERR_NAME_NOT_RESOLVED)".
- Network failure + `ignoreNetworkFailures: true` → passed.
- Duplicate detected + `ignoreDuplicates: true` → passed.
- Mixed content detected + page not https → `mixedContent` empty (collector-side), so passed.
- CORS detected + `ignoreCors: true` → passed.
- `allowUrls: ["analytics"]` filters out all matching URLs across all issue types including `networkFailures`.
- `args === true` (boolean shorthand) → treated as `{}`, all defaults (network failures NOT ignored).
- No `network` collector in ctx → status: "error".

**File:** `cli/__tests__/integration/observability/network-smoke.test.ts`

Real Playwright + `http.createServer` fixture that serves:
- `/index.html` (200, HTML with a button wired to duplicate + failing fetches).
- `/api` (returns 500 — simulated server error).
- `/dup` (returns 200 — the button triggers two calls in the same tick).

Steps: navigate → click button → `assertNoNetworkErrors` → expect **failed** with the error message naming both the 500 and the duplicate. Also a second step: navigate → click a button that fetches `http://nonexistent.invalid/` → `assertNoNetworkErrors` → expect **failed** naming the `networkFailures` entry.

**Scope note:** the smoke test intentionally only covers HTTP failures + duplicates + network failures. Mixed-content and CORS detection require an HTTPS origin plus a second origin without CORS headers, which adds self-signed-cert plumbing (Playwright's `ignoreHTTPSErrors` + `https.createServer`). Unit tests with `FakePage.emit()` cover those issue types directly against the collector's classification logic — sufficient for wiring verification. Expanding the smoke test to cover mixed-content and CORS is a v2 follow-up if the unit coverage proves insufficient.

---

## Phase 4 — Accessibility collector + `accessibilityAudit`

### 4.1 `AccessibilityCollector` class

**File:** `cli/src/observability/collectors/accessibility-collector.ts`

```ts
import type { Page } from "playwright";
import type {
  Collector,
  CollectorName,
  AccessibilitySnapshot,
  AccessibilityViolation,
} from "../types.js";
import type { ExecutionContext } from "../../executor/context.js";
import { logger } from "../../utils/logger.js";
import AxeBuilder from "@axe-core/playwright";

interface AccessibilityCollectorOptions {
  dualEngine: boolean;
  htmlSnippetLimit: number;   // cap on HTML snippet length in violation nodes (chars)
}

export interface AuditInvocation {
  standard: "WCAG2A" | "WCAG2AA" | "WCAG21A" | "WCAG21AA" | "WCAG22AA";
  include?: string[];
  exclude?: string[];
  impacts?: Array<"critical" | "serious" | "moderate" | "minor">;
}

const STANDARD_TO_AXE_TAGS: Record<AuditInvocation["standard"], string[]> = {
  WCAG2A: ["wcag2a"],
  WCAG2AA: ["wcag2a", "wcag2aa"],
  WCAG21A: ["wcag2a", "wcag21a"],
  WCAG21AA: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
  WCAG22AA: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"],
};

const IBM_SEVERITY_TO_IMPACT: Record<string, "serious" | "moderate" | "minor"> = {
  VIOLATION: "serious",
  RECOMMENDATION: "moderate",
  INFORMATION: "minor",
};

const IMPACT_ORDER: Record<"critical" | "serious" | "moderate" | "minor", number> = {
  critical: 0, serious: 1, moderate: 2, minor: 3,
};

export class AccessibilityCollector implements Collector {
  readonly name: CollectorName = "accessibility";
  private page: Page | null = null;
  private lastSnapshot: AccessibilitySnapshot | undefined;
  private equalAccessLoaded: "unknown" | "yes" | "no" = "unknown";
  private readonly options: AccessibilityCollectorOptions;
  private htmlSnippetLimit: number = 500;

  constructor(options: AccessibilityCollectorOptions) {
    this.options = options;
    this.htmlSnippetLimit = options.htmlSnippetLimit;
  }

  private truncateHtml(html: string): string {
    if (this.htmlSnippetLimit <= 0) return "";
    if (html.length <= this.htmlSnippetLimit) return html;
    return html.slice(0, this.htmlSnippetLimit) + "…";   // U+2026 = …
  }

  async attach(page: Page, _ctx: ExecutionContext): Promise<void> {
    this.page = page;
    if (this.options.dualEngine) {
      await this.tryLoadEqualAccess();
    }
  }

  /** Called by the `accessibilityAudit` step handler. Runs audits, stores result, returns it. */
  async audit(invocation: AuditInvocation): Promise<AccessibilitySnapshot> {
    if (!this.page || this.page.isClosed()) {
      const empty: AccessibilitySnapshot = {
        violations: [],
        summary: { violations: 0, passes: 0, incomplete: 0, dualEngine: false },
        standard: invocation.standard,
      };
      this.lastSnapshot = empty;
      return empty;
    }

    const axePromise = this.runAxe(invocation);
    const ibmPromise = this.options.dualEngine ? this.runEqualAccess(invocation) : Promise.resolve(null);

    const [axeResult, ibmResult] = await Promise.all([axePromise, ibmPromise]);

    // Dedup: axe wins on ruleId collision (matches Expect's rule, keeps rule-level prior art stable)
    const axeRuleIds = new Set(axeResult.violations.map((v) => v.ruleId));
    const merged: AccessibilityViolation[] = [
      ...axeResult.violations,
      ...(ibmResult?.violations.filter((v) => !axeRuleIds.has(v.ruleId)) ?? []),
    ];

    // Sort by impact severity
    merged.sort((a, b) => IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact]);

    const snap: AccessibilitySnapshot = {
      violations: merged,
      summary: {
        violations: merged.length,
        passes: axeResult.passes + (ibmResult?.passes ?? 0),
        incomplete: axeResult.incomplete + (ibmResult?.incomplete ?? 0),
        dualEngine: ibmResult !== null,
      },
      standard: invocation.standard,
    };
    this.lastSnapshot = snap;
    return snap;
  }

  async snapshot(): Promise<AccessibilitySnapshot | undefined> {
    return this.lastSnapshot;    // undefined if audit was never called
  }

  async detach(): Promise<void> {
    this.page = null;
  }

  private async runAxe(
    invocation: AuditInvocation,
  ): Promise<{ violations: AccessibilityViolation[]; passes: number; incomplete: number }> {
    if (!this.page) return { violations: [], passes: 0, incomplete: 0 };
    try {
      let builder = new AxeBuilder({ page: this.page });
      builder = builder.withTags(STANDARD_TO_AXE_TAGS[invocation.standard]);
      if (invocation.include) builder = builder.include(invocation.include);
      if (invocation.exclude) builder = builder.exclude(invocation.exclude);
      const result = await builder.analyze();
      const violations = result.violations.map<AccessibilityViolation>((v) => ({
        ruleId: v.id,
        impact: (v.impact ?? "minor") as AccessibilityViolation["impact"],
        engine: "axe",
        help: v.help,
        helpUrl: v.helpUrl,
        nodes: v.nodes.map((n) => ({
          target: Array.isArray(n.target) ? n.target.map(String) : [String(n.target)],
          html: this.truncateHtml(n.html),
          failureSummary: n.failureSummary,
        })),
      }));
      return { violations, passes: result.passes.length, incomplete: result.incomplete.length };
    } catch (err) {
      logger.warn(`[a11y:axe] audit failed: ${err instanceof Error ? err.message : String(err)}`);
      return { violations: [], passes: 0, incomplete: 0 };
    }
  }

  private async tryLoadEqualAccess(): Promise<void> {
    if (this.equalAccessLoaded !== "unknown") return;
    // Presence check via require.resolve on the subpath we'll actually read at audit time.
    // This is side-effect-free (no module execution) — we're just confirming the file path
    // is resolvable. Only MODULE_NOT_FOUND / ERR_PACKAGE_PATH_NOT_EXPORTED downgrade to
    // "not installed"; anything else (permission errors, etc.) surfaces as a warning with
    // the real error so genuine bugs aren't masked.
    try {
      const { createRequire } = await import("node:module");
      const req = createRequire(import.meta.url);
      req.resolve("accessibility-checker-engine/ace.js");
      this.equalAccessLoaded = "yes";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
        this.equalAccessLoaded = "no";
        logger.info(
          `[a11y] accessibility-checker-engine not installed — running axe-core only. ` +
          `Install with: npm i accessibility-checker-engine`,
        );
      } else {
        this.equalAccessLoaded = "no";
        logger.warn(
          `[a11y] accessibility-checker-engine resolve failed (unexpected): ${err instanceof Error ? err.message : String(err)} — falling back to axe-core only`,
        );
      }
    }
  }

  private async runEqualAccess(
    invocation: AuditInvocation,
  ): Promise<{ violations: AccessibilityViolation[]; passes: number; incomplete: number } | null> {
    if (this.equalAccessLoaded !== "yes" || !this.page) return null;
    try {
      // Lazy read of ace.js — deferred to first audit, not attach time. The presence check
      // already ran in tryLoadEqualAccess via require.resolve; this is the actual file read.
      const acePath = await this.resolveAceScriptPath();
      if (!acePath) return null;
      const aceScript = await (await import("node:fs/promises")).readFile(acePath, "utf-8");

      const raw = await this.page.evaluate(
        async ({ script }) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const g = globalThis as any;
          if (!g.ace) {
            // eslint-disable-next-line no-new-func
            new Function(script)();
          }
          const checker = new g.ace.Checker();
          const report = await checker.check(document, ["WCAG_2_2"]);
          // IMPORTANT: IBM's report.results entries include a `node: Element` DOM reference
          // which CANNOT be serialized across the Playwright boundary (structured clone
          // rejects live DOM nodes). Strip `node` before return — if we skip this, the
          // entire page.evaluate call throws a DataCloneError and we silently fall back
          // to axe-only via the outer catch, defeating dual-engine mode. Pattern taken
          // from Expect's accessibility.ts:110-117.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return {
            results: (report.results as any[]).map(({ node: _node, ...rest }) => rest),
          };
        },
        { script: aceScript },
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results = (raw as { results: Array<any> }).results ?? [];
      const violations: AccessibilityViolation[] = [];
      let passes = 0;
      let incomplete = 0;
      for (const r of results) {
        const kind = r.value?.[0];    // VIOLATION | RECOMMENDATION | INFORMATION | PASS
        const level = r.value?.[1];   // FAIL | POTENTIAL (only meaningful for VIOLATION)

        const pushViolation = (impact: "serious" | "moderate" | "minor") => {
          violations.push({
            ruleId: String(r.ruleId),
            impact,
            engine: "equal-access",
            help: String(r.message ?? r.ruleId),
            nodes: r.path?.dom
              ? [{ target: [String(r.path.dom)], html: this.truncateHtml(String(r.snippet ?? "")) }]
              : [],
          });
        };

        if (kind === "VIOLATION") {
          // FAIL = definite violation → impact: serious (from IBM_SEVERITY_TO_IMPACT["VIOLATION"]).
          // POTENTIAL = needs human review → count as incomplete, not a hard violation.
          if (level === "FAIL") {
            pushViolation(IBM_SEVERITY_TO_IMPACT.VIOLATION);
          } else if (level === "POTENTIAL") {
            incomplete++;
          }
        } else if (kind === "RECOMMENDATION") {
          pushViolation(IBM_SEVERITY_TO_IMPACT.RECOMMENDATION);     // moderate
        } else if (kind === "INFORMATION") {
          pushViolation(IBM_SEVERITY_TO_IMPACT.INFORMATION);        // minor
        } else if (kind === "PASS") {
          passes++;
        }
        // Any other kind (future IBM additions) is silently ignored — survives additions
        // without crashing, matching Expect's forward-compatibility posture.
      }
      return { violations, passes, incomplete };
    } catch (err) {
      logger.warn(`[a11y:equal-access] audit failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async resolveAceScriptPath(): Promise<string | null> {
    try {
      const { createRequire } = await import("node:module");
      const req = createRequire(import.meta.url);
      return req.resolve("accessibility-checker-engine/ace.js");
    } catch {
      return null;
    }
  }
}
```

**IBM Equal Access standard pinning:** Expect hardcodes `WCAG_2_2`. We match that regardless of the user's `standard` arg — the engine's WCAG filter isn't symmetric with axe's. Document in config block comment that `standard` applies to axe; IBM runs against 2.2 always.

**Optional-peer presence check:** `tryLoadEqualAccess` uses `createRequire(import.meta.url).resolve("accessibility-checker-engine/ace.js")`. Unlike dynamic `import()`, `require.resolve` performs path resolution without loading/executing the module — no side effects, no telemetry bootstrapping from the IBM package just to check if it exists. Matches Expect's own pattern (`packages/browser/src/accessibility.ts:65`). Only `MODULE_NOT_FOUND` and `ERR_PACKAGE_PATH_NOT_EXPORTED` downgrade to "not installed" silently; anything else (permission issues, corrupted install) surfaces as a warning so real bugs aren't masked behind the optional-dep fallback.

**Security / data-exposure note:** accessibility violations include `html` snippets of the failing DOM nodes, which can contain arbitrary user content — text inside form fields, rendered JSON from API responses, logged-in user names, etc. These snippets are captured into `FlowResult.metrics.accessibility.violations[].nodes[].html` and, when the HTML reporter is enabled, rendered (text-escaped) into the on-disk HTML report. V1 caps snippet size at 500 chars via `observability.accessibilityHtmlSnippetLimit` (overridable) to reduce accidental exfiltration of large payloads while preserving enough context for triage. Setting the limit to `0` suppresses snippets entirely. Users handling sensitive pages should either (a) scope audits via `exclude: [...]` to skip elements rendering user data, (b) run auditing only on unauthenticated preview URLs, or (c) disable the HTML reporter and consume violations programmatically. Axe rule IDs and CSS selectors are low-risk; the raw HTML is the concern.

### 4.2 `accessibilityAudit` step handler

**File:** `cli/src/executor/step-handlers/accessibility-audit.ts`

```ts
import type { Page } from "playwright";
import type { ExecutionContext } from "../context.js";
import type { StepResult } from "../types.js";
import type {
  AccessibilityCollector,
  AuditInvocation,
} from "../../observability/collectors/accessibility-collector.js";

interface AccessibilityAuditArgs {
  standard?: "WCAG2A" | "WCAG2AA" | "WCAG21A" | "WCAG21AA" | "WCAG22AA";
  impacts?: Array<"critical" | "serious" | "moderate" | "minor">;
  include?: string[];
  exclude?: string[];
}

const DEFAULT_FAIL_IMPACTS: ReadonlyArray<"critical" | "serious" | "moderate" | "minor"> = [
  "critical", "serious",
];

export const handleAccessibilityAudit = async (
  _page: Page,
  ctx: ExecutionContext,
  args: unknown,
): Promise<StepResult> => {
  const start = performance.now();
  const parsed: AccessibilityAuditArgs =
    args === true || args === undefined || args === null ? {} : (args as AccessibilityAuditArgs);

  const collector = ctx.collectors.get("accessibility") as AccessibilityCollector | undefined;
  if (!collector) {
    return {
      command: "accessibilityAudit",
      args,
      status: "error",
      duration_ms: Math.round(performance.now() - start),
      error: `Accessibility collector not attached. Add "accessibility" to observability.collectors in skeptic.config.yaml, or ensure the flow parser discovered this step.`,
    };
  }

  const invocation: AuditInvocation = {
    standard: parsed.standard ?? "WCAG2AA",
    include: parsed.include,
    exclude: parsed.exclude,
    impacts: parsed.impacts,
  };

  const snap = await collector.audit(invocation);
  const failImpacts = new Set(parsed.impacts ?? DEFAULT_FAIL_IMPACTS);
  const failing = snap.violations.filter((v) => failImpacts.has(v.impact));

  if (failing.length === 0) {
    return {
      command: "accessibilityAudit",
      args,
      status: "passed",
      duration_ms: Math.round(performance.now() - start),
    };
  }
  const engines = snap.summary.dualEngine ? "axe-core + IBM Equal Access" : "axe-core";
  const preview = failing
    .slice(0, 3)
    .map((v) => `[${v.impact}] ${v.ruleId} (${v.engine})`)
    .join("; ");
  return {
    command: "accessibilityAudit",
    args,
    status: "failed",
    duration_ms: Math.round(performance.now() - start),
    error: `${failing.length} ${invocation.standard} violation(s) via ${engines}: ${preview}${failing.length > 3 ? " ..." : ""}`,
  };
};
```

### 4.3 Tests

**File:** `cli/__tests__/unit/observability/accessibility-collector.test.ts`

Mock `@axe-core/playwright` (vi.mock):
- `attach` sets internal page; no network/page activity yet.
- `attach` with `dualEngine: true` + `accessibility-checker-engine` missing (stub `createRequire.resolve` to throw `MODULE_NOT_FOUND`) → `equalAccessLoaded === "no"`; one-time `logger.info` emitted; falls back to axe-only on audit.
- `attach` with `dualEngine: true` + `createRequire.resolve` throws a permission error (EACCES) → `equalAccessLoaded === "no"`, `logger.warn` emitted (NOT `logger.info`) — unexpected error is surfaced rather than masked.
- `audit` with standard `WCAG2AA` + mocked AxeBuilder returning violations → `snapshot` reflects the mock's violations.
- `audit` with axe returning `{ impact: "critical" }` → violation's impact is `"critical"`.
- Dedup: axe finds rule `color-contrast`, IBM finds rules `color-contrast` + `aria-label` → merged has 2 entries (axe's color-contrast + IBM's aria-label), axe's color-contrast wins.
- IBM severity mapping: `VIOLATION/FAIL` → `serious`; `RECOMMENDATION` → `moderate`; `INFORMATION` → `minor`; `VIOLATION/POTENTIAL` → NOT in violations, counted in `incomplete`.
- IBM dual-engine capture: mock IBM results with one FAIL + one RECOMMENDATION + one INFORMATION + one PASS → violations has 3 entries (serious + moderate + minor), passes === 1, incomplete === 0.
- Forward-compat: mock IBM result with `kind: "FUTURE_KIND"` → silently ignored, no throw, no violation.
- HTML snippet truncation: `htmlSnippetLimit: 10` + axe violation node with 200-char html → stored html is `<first 10 chars>…`.
- HTML snippet truncation: `htmlSnippetLimit: 0` → stored html is empty string.
- `snapshot` without prior `audit` → returns `undefined`.
- Sort: critical before serious before moderate.
- `detach` clears page ref.

**File:** `cli/__tests__/unit/executor/step-handlers/accessibility-audit.test.ts`

Mock `AccessibilityCollector`:
- Empty violations → passed.
- One `critical` violation + default `impacts` → failed.
- One `moderate` violation + default `impacts` (critical+serious) → passed (moderate not in failImpacts).
- Explicit `impacts: ["minor"]` catches only minor → one minor violation → failed.
- Three criticals + two serious → error message has 3 preview entries + " ..." suffix.
- `args === true` → treated as `{}` → defaults used.
- No `accessibility` collector in ctx → status: "error".
- Standard `WCAG21AA` passed through to `collector.audit` invocation.
- `include: ["#main"]` passed through to invocation.

**File:** `cli/__tests__/integration/observability/accessibility-smoke.test.ts`

Real Playwright + fixture HTML with one known axe violation (e.g. `<img>` with no alt):
- Navigate → `accessibilityAudit: { standard: "WCAG2AA" }` → expect failed.
- Navigate → `accessibilityAudit: { standard: "WCAG2AA", exclude: ["img"] }` → expect passed.

---

## Phase 5 — Reporter integration

### 5.1 ConsoleReporter: metrics summary line

**File:** `cli/src/reporter/console-reporter.ts`

After the `PASS`/`FAIL` status line at `onFlowComplete` (line 85 / 94), append a one-line metrics summary when present. Follow the visual-diff pattern from `wiggly-floating-whistle.md` Phase 4.4 — guard on presence, dim color, aligned indent.

```ts
onFlowComplete(result: FlowResult, _flow: FlowIdentifier): void {
  const status = /* ...existing... */;
  const lines: string[] = [];
  lines.push(`  ${status} ${chalk.dim(`${result.duration_ms}ms`)}`);
  if (result.videoPath) lines.push(`  ${chalk.dim("Video:")} ${chalk.cyan(result.videoPath)}`);

  // NEW: compact metrics summary
  if (result.metrics) {
    const parts: string[] = [];
    const perf = result.metrics.performance as PerformanceSnapshot | undefined;
    if (perf) {
      const bits: string[] = [];
      if (perf.fcp !== null) bits.push(`FCP ${formatMs(perf.fcp)}`);
      if (perf.lcp !== null) bits.push(`LCP ${formatMs(perf.lcp)}`);
      if (perf.cls !== null) bits.push(`CLS ${perf.cls.toFixed(3)}`);
      if (perf.inp !== null) bits.push(`INP ${formatMs(perf.inp)}`);
      if (perf.ttfb !== null) bits.push(`TTFB ${formatMs(perf.ttfb)}`);
      if (bits.length > 0) parts.push(`perf: ${bits.join(", ")}`);
    }
    const net = result.metrics.network as NetworkSnapshot | undefined;
    if (net) {
      const issueCount = net.issues.failedRequests.length +
        net.issues.networkFailures.length +
        net.issues.duplicates.length +
        net.issues.mixedContent.length +
        net.issues.corsErrors.length;
      parts.push(`net: ${net.requests.length} reqs${issueCount > 0 ? `, ${issueCount} issues` : ""}`);
    }
    const a11y = result.metrics.accessibility as AccessibilitySnapshot | undefined;
    if (a11y) parts.push(`a11y: ${a11y.summary.violations} violations`);
    if (parts.length > 0) lines.push(`  ${chalk.dim("Metrics:")} ${chalk.dim(parts.join(" · "))}`);
  }

  // ...existing buffer/console.log dispatch...
}

function formatMs(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
}
```

Import types: `import type { PerformanceSnapshot, NetworkSnapshot, AccessibilitySnapshot } from "../observability/types.js";`.

### 5.2 HtmlReporter: collapsible metrics section

**File:** `cli/src/reporter/html-reporter.ts`

In the flow-body template (around line 100 area — the flow-detail block after step list), add a `<details>` section when `flow.metrics` present:

```html
<details class="flow-metrics" open>
  <summary>Metrics</summary>
  <div class="metrics-grid">
    <div class="metric-card">
      <h4>Core Web Vitals</h4>
      <table>
        <tr><td>LCP</td><td>2.3s ✓</td></tr>
        ...
      </table>
    </div>
    <div class="metric-card">
      <h4>Network</h4>
      <p>42 requests, 2 issues</p>
      <ul>...</ul>
    </div>
    <div class="metric-card">
      <h4>Accessibility</h4>
      <p>WCAG2AA — 3 violations (axe-core)</p>
      <ul>
        <li>[serious] color-contrast — 5 elements</li>
      </ul>
    </div>
  </div>
</details>
```

Add CSS in the existing `<style>` block:
```css
.flow-metrics { margin-top: 0.75rem; padding: 0.75rem 1rem; background: #141414; border-radius: 6px; }
.flow-metrics summary { cursor: pointer; color: #90caf9; font-weight: 600; }
.metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 0.75rem; margin-top: 0.5rem; }
.metric-card { background: #1f1f1f; padding: 0.75rem; border-radius: 4px; }
.metric-card h4 { font-size: 0.85rem; color: #ffd700; margin-bottom: 0.5rem; }
.metric-card table td { padding: 0.1rem 0.3rem; font-size: 0.8rem; }
.metric-card .ok { color: #4caf50; }
.metric-card .bad { color: #f44336; }
```

Render logic in a helper function `buildMetricsSection(metrics: Record<string, unknown>): string` — escapes user content via `escapeHtml` (reuse existing `html-reporter.ts` helper if present; add one if not).

### 5.3 JsonReporter: pass-through

**File:** `cli/src/reporter/json-reporter.ts`

No changes needed. The reporter writes `{ version, timestamp, total, passed, failed, duration_ms, flows: summary.flows }` at `json-reporter.ts:29-37`. Each flow object in `flows[]` is a `FlowResult`, and since we added `metrics?: Record<string, unknown>` to `FlowResult`, it serializes inline with the rest of the flow via `JSON.stringify`. Reporters reading this output find metrics at `flows[i].metrics`, not `summary.flows[i].metrics`.

### 5.4 JunitReporter: omit

**File:** `cli/src/reporter/junit-reporter.ts`

No changes. Junit's testcase model doesn't fit well with nested observability data. Future work if users ask.

### 5.5 InkReporter: out of scope for v1

The Ink/TUI reporter is architecturally different from console/HTML: `cli/src/reporter/ink-reporter.ts` only dispatches events to React state (`cli/src/ui/types.ts`), rendered by `cli/src/ui/components/flow-progress.tsx`. Adding metrics would require threading them through the React state schema and components, which is a non-trivial UI change beyond the observability subsystem itself.

**Decision:** drop Ink metrics display from Bundle 3. Users running in TUI mode still see results via the console/HTML reporters when enabled (the TUI is typically an overlay on top of those). Follow-up issue: wire metrics through `FlowState` in `ui/types.ts` + render in `flow-progress.tsx` — tracked separately.

### 5.6 Tests

**File:** `cli/__tests__/unit/reporter/metrics-display.test.ts`

- Console: flow with full metrics → stdout contains `FCP ...`, `LCP 2.30s`, `CLS 0.050`, `INP ...`, `TTFB ...`, `a11y: 3 violations`, `net: 42 reqs`.
- Console: flow without metrics → no metrics line appears.
- Console: metrics with only `performance.fcp !== null` (other metrics null) → only `FCP ...` appears in the perf bits; no "CLS null", "LCP null" noise.
- Console: network issues include `networkFailures` → the displayed issue count sums all five categories (failedRequests, networkFailures, duplicates, mixedContent, corsErrors).
- HTML: metrics present → output contains `<details class="flow-metrics">`, metric cards, and CSS classes.
- HTML: metrics absent → no `.flow-metrics` section in output.
- JSON: top-level `flows[0].metrics` serializes with correct nested shape (the json-reporter writes `{ version, timestamp, total, passed, failed, duration_ms, flows: summary.flows }` — metrics ride along inside each flow, NOT under `summary.flows`).

---

## Phase 6 — End-to-end smoke + final audit

### 6.1 One combined smoke test

**File:** `cli/__tests__/integration/observability/bundle3-e2e.test.ts`

A single flow exercising all three collectors:
```yaml
---
name: Bundle 3 smoke
url: http://localhost:{port}
---
- navigate: /
- click: "#load-data"        # triggers a fetch
- assertPerformance: { lcp: "<5s", cls: "<0.5" }
- assertNoNetworkErrors: true
- accessibilityAudit: { standard: "WCAG2AA" }
```

Fixture `cli/__tests__/fixtures/observability/bundle3/index.html` plus an `http.createServer` that:
- Serves `/` with some content + an image for LCP.
- Has a `/load-data` endpoint called via fetch on button click.

Expected: all three step types pass; `result.metrics` has all three namespaces populated. Regression guard for the shared integration layer.

### 6.2 Verification checklist (runs after each phase)

```bash
cd cli
npm install        # after Phase 0.1 — regenerates package-lock.json
npm run build      # strict TS compile (no errors)
npm run check      # tsc --noEmit
npm test           # all 280+ new tests pass
```

**Per-phase smoke:**
- **Phase 1:** stub collector flow → snapshot appears in `FlowResult.metrics`, detach called exactly once.
- **Phase 2:** real-browser perf smoke → LCP threshold check passes on a simple page.
- **Phase 3:** real-browser + fake server → 500s, duplicates, and DNS-level network failures all detected and surfaced in the assertion error message. Mixed-content and CORS classification verified via unit tests (FakePage emit) only in v1.
- **Phase 4:** real-browser axe against a fixture with a known violation → failed result with `help`+`helpUrl` in the violation.
- **Phase 5:** one flow run with `--reporter html,console,json` → HTML file has metrics section, console prints summary line, JSON contains nested `metrics`.
- **Phase 6:** combined e2e — all three collectors attached to one flow, all three assertions execute, reporter output sane.

---

## Critical Files to Modify

| File | Phase | Change |
|------|-------|--------|
| `cli/package.json` | 0.1 | Add `web-vitals`, `@axe-core/playwright` to deps; add `accessibility-checker-engine` as optional peer |
| `cli/package-lock.json` | 0.1 | Regenerated by `npm install` |
| `cli/src/observability/types.ts` | 0.3 | NEW — `Collector` interface + snapshot types |
| `cli/src/observability/assert-parser.ts` | 0.4 | NEW — `parseThreshold`, `checkThreshold` |
| `cli/src/observability/registry.ts` | 1.3, 1.4 | NEW — `buildCollectors`, `inferRequiredCollectors` |
| `cli/src/observability/collectors/performance-collector.ts` | 2.1 | NEW — `PerformanceCollector` |
| `cli/src/observability/collectors/network-collector.ts` | 3.1 | NEW — `NetworkCollector` |
| `cli/src/observability/collectors/accessibility-collector.ts` | 4.1 | NEW — `AccessibilityCollector` + exported `AuditInvocation` |
| `cli/src/executor/types.ts` | 1.1, 1.5, 1.8 | Add `metrics?: Record<string, unknown>` to `FlowResult`; add `requiredCollectors` to `FlowInput`; add `observability` to `EngineOptions` |
| `cli/src/executor/context.ts` | 1.7 | Add `readonly collectors: Map<CollectorName, Collector>`; 8th positional constructor arg with empty-array default |
| `cli/src/executor/playwright-engine.ts` | 1.6 | Build collectors after `newPage`; attach; try/finally-wrapped snapshot+detach after `onFlowComplete`, before video; merge into `FlowResult.metrics` |
| `cli/src/executor/step-handlers/index.ts` | 2.3 | Register 3 new handlers (dashed + camelCase) |
| `cli/src/executor/step-handlers/assert-performance.ts` | 2.2 | NEW |
| `cli/src/executor/step-handlers/assert-no-network-errors.ts` | 3.2 | NEW |
| `cli/src/executor/step-handlers/accessibility-audit.ts` | 4.2 | NEW |
| `cli/src/config/schema.ts` | 1.2 | Add `ObservabilityConfigSchema` + wire into `skepticConfigSchema` + export type |
| `cli/src/parser/flow-schema.ts` | 2.3 | Add 3 command keys to `COMMAND_KEYS`, `Step`, `StepSchema` |
| `cli/src/commands/test.ts` | 1.5, 1.8 | Compute `requiredCollectors` via `inferRequiredCollectors`; pass `observability` on `EngineOptions` |
| `cli/src/commands/mcp.ts` | 1.5, 1.8 | Same as test.ts for `flowToInput` + `EngineOptions` |
| `cli/src/reporter/console-reporter.ts` | 5.1 | Metrics summary line |
| `cli/src/reporter/html-reporter.ts` | 5.2 | Collapsible metrics section + CSS |

**New test files (14):**

| File | Phase |
|------|-------|
| `cli/__tests__/unit/observability/assert-parser.test.ts` | 0.4 |
| `cli/__tests__/unit/observability/registry.test.ts` | 1.9 |
| `cli/__tests__/unit/config/observability-config.test.ts` | 1.9 |
| `cli/__tests__/unit/executor/observability-integration.test.ts` | 1.9 |
| `cli/__tests__/unit/observability/performance-collector.test.ts` | 2.4 |
| `cli/__tests__/unit/executor/step-handlers/assert-performance.test.ts` | 2.4 |
| `cli/__tests__/integration/observability/performance-smoke.test.ts` | 2.4 |
| `cli/__tests__/unit/observability/network-collector.test.ts` | 3.3 |
| `cli/__tests__/unit/executor/step-handlers/assert-no-network-errors.test.ts` | 3.3 |
| `cli/__tests__/integration/observability/network-smoke.test.ts` | 3.3 |
| `cli/__tests__/unit/observability/accessibility-collector.test.ts` | 4.3 |
| `cli/__tests__/unit/executor/step-handlers/accessibility-audit.test.ts` | 4.3 |
| `cli/__tests__/integration/observability/accessibility-smoke.test.ts` | 4.3 |
| `cli/__tests__/unit/reporter/metrics-display.test.ts` | 5.6 |
| `cli/__tests__/integration/observability/bundle3-e2e.test.ts` | 6.1 |

**Fixture files (2):**
- `cli/__tests__/fixtures/observability/perf-test.html`
- `cli/__tests__/fixtures/observability/bundle3/index.html`

---

## Reused Utilities

- `normalizeStep`, `NormalizedStep` — `cli/src/parser/step-normalizer.ts`
- `stepHandlers` registry — `cli/src/executor/step-handlers/index.ts`
- `ExecutionContext` pattern — `cli/src/executor/context.ts`
- `Collector` lifecycle matches the `ExecutionContext` teardown flag (`ctx.inTeardown`) pattern — `cli/src/executor/playwright-engine.ts:273-282`
- `appendWarning` for soft warnings in step results — `cli/src/executor/types.ts:22-27`
- `logger` (warn/debug/info) — `cli/src/utils/logger.js`
- `escapeHtml` pattern — match the visual-diff grid addition in `wiggly-floating-whistle.md` Phase 4.5 (`html-reporter.ts`)
- Reporter consumption style — `wiggly-floating-whistle.md` Phase 4.4 (guarded, optional, dim color)
- `createRequire(import.meta.url)` for resolving peer/optional dep paths — `node:module` builtin
- Zod patterns for config/step schemas — `cli/src/config/schema.ts` and `cli/src/parser/flow-schema.ts`

---

## Shared vs. Per-Feature Breakdown

**Shared (done once, in Phase 0 + 1):**
- `Collector` interface + snapshot types.
- `buildCollectors` registry.
- `inferRequiredCollectors` step walker.
- `FlowResult.metrics` field.
- `ExecutionContext.collectors` map.
- Engine attach/snapshot/detach lifecycle with abort/teardown integration.
- `observability` config block.
- Threshold parser (`assert-parser.ts`) — only `assertPerformance` uses today but structured for reuse.
- Reporter consumption pattern (metrics is optional, narrow at consumption).

**Per-feature (Phases 2/3/4):**
- Performance: `web-vitals` IIFE injection + LoAF observer + `assertPerformance` handler.
- Network: 4 Playwright event hooks + issue computation + `assertNoNetworkErrors` handler.
- Accessibility: axe + optional IBM + dedup + `accessibilityAudit` handler.
- Each feature adds 1 step handler + registration + schema extension + unit tests + one integration smoke.

**One-time in Phase 5:**
- Reporter output for all three collectors (console one-liner, HTML card, JSON pass-through).

**Net:** ~800 LOC of shared infra (Phase 0+1+5 reporter work) and ~600 LOC per collector (Phases 2/3/4 each). Total ~2200 LOC of production code + ~1200 LOC of tests.

---

## Open Design Questions (flagged for Codex review)

1. **Per-collector config depth.** The current `ObservabilityConfigSchema` has five flat fields (`collectors`, `networkCaptureLimit`, `duplicateWindowMs`, `accessibilityDualEngine`, `accessibilityHtmlSnippetLimit`). Should we namespace these as `observability.network.{captureLimit, duplicateWindowMs}` and `observability.accessibility.{dualEngine, htmlSnippetLimit}` for future growth, or keep flat for simplicity? Current choice: flat. Trade-off: flat is friendlier now, nested scales better for future toggles.
2. **Performance metric coverage in `assertPerformance`.** Current set: FCP/LCP/CLS/INP/TTFB. Should `assertPerformance` also accept `{ longAnimationFrames: { max: 5 } }` or `{ blockingDuration: "<150ms" }`? Decision in plan: **no for v1.** LoAF data is in `metrics.performance.longAnimationFrames` for reporters, but not assertable. Rationale: the four CWVs are the Expect-matched surface; LoAF assertions are a v2 feature request once we see real usage.
3. **Network request-body capture.** Expect doesn't; we don't. Do we add it behind an opt-in flag `observability.captureRequestBodies: true`? **No for v1.** High PII risk, ~10x memory cost.
4. **URL query-param redaction.** Raw URLs are captured as-is. Should v1 auto-redact common token patterns (`token=...`, `key=...`, `authorization=...`)? Plan: **no**, document in security note and defer to v2. Heuristic redaction would break debugging use cases where the user wants to assert on query params (`allowUrls` match); an opt-in knob can come later.
5. **Accessibility baseline/allowlist.** Expect has the same gap. Do we add `accessibilityAudit: { ignore: ["color-contrast"] }` now, or ship v1 without? Plan ships with `impacts` (severity filter) — users can set `impacts: ["critical"]` to tolerate serious/moderate. Rule-level allowlist is a follow-up if anyone asks.
6. **Metric unit display in reporter.** Plan formats LCP as `"2.30s"` for values ≥1000ms. Should CLS be displayed with 2 or 3 decimals? Plan: 3 decimals (matches spec). Open to feedback.

Every one has a default in the plan; none block implementation.
