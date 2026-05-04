# Bundle 1 — Runtime Reliability & Step Options

Slug: `prancy-floating-codd`

## Context

skeptic's runtime has four gaps that bundle cleanly because they all touch the same three layers — `flow-schema.ts`, `step-normalizer.ts`, and the executor (nested-executor + playwright-engine):

1. **MCP viewport drift.** `cli/src/commands/test.ts:480` threads `viewport: flow.metadata.viewport` into `FlowInput`, but `cli/src/commands/mcp.ts` `flowToInput` (lines 278–304) omits it. The same drift was fixed last cycle for `hooks` / `env` / `baseUrl`; `viewport` is the final holdout. MCP-driven runs silently ignore `viewport:` in flow front-matter.
2. **Single-timeout model can't express "warn me".** `timeout` on a step is all-or-nothing: the step either completes in time or fails. Real flows have "this should be fast, but don't fail if it's a bit slow" cases. Competitive analysis item #43 names this the *dual-timeout strategy* — Maestro has ~7s fluent wait vs ~17s hard ceiling. skeptic generalizes to per-step `hardTimeout` (fail) vs `softTimeout` (warn + continue).
3. **Clicks silently drop.** Overlapping elements, animation-in-flight, or race-against-hydration all cause `page.click()` to succeed syntactically but have zero effect. Maestro solved this with opt-in `retryTapIfNoChange` (PR #206, Sep 2022) — capture DOM + URL before the tap, compare after a settle window, retry once if nothing changed. skeptic adds `retryIfNoChange: boolean` as a step option (opt-in, click-only).
4. **Faker is trapped inside `runScript`.** `@faker-js/faker` v9 is already imported synchronously at `cli/src/executor/step-handlers/script-sandbox.ts:2`, but exposed only to the VM sandbox. Flow authors who want "fill with a random email" must write a `runScript` step. Maestro's approach (PR #256) was first-class commands: `inputRandomEmail`, `inputRandomNumber`, `inputRandomPersonName`, `inputRandomText`. skeptic adds `randomType`, `randomEmail`, `randomNumber`, `randomPhone` — zero-JS random fills.

**Goal:** ship all four in one bundle, reusing existing machinery (`normalizeStep`, `ctx.activeTimeout` restoration, `resolveElement`, `COMMAND_KEYS` → `AI_EXPOSED_COMMANDS` → prompts). Zero new concepts — the executor's existing per-step wrapper in `nested-executor.ts`/`playwright-engine.ts` is the only surface that grows.

(See "Out of scope" list under Reference Implementations below.)

## Reference Implementations (Maestro — verified against `/Users/iamjr15/Desktop/skeptic-refs/maestro`)

| Feature | Maestro source | Semantics lifted |
|---|---|---|
| `retryIfNoChange` | `Maestro.kt:275–401` (cap: `getNumberOfRetries(retryIfNoChange=true) → 2`, i.e. initial + 1 retry; 0.5% screenshot-diff threshold at line 678); `YamlElementSelector.kt:32` (YAML knob nested under the selector) | Capture state before tap, settle via `waitForAppToSettle()`, re-capture, retry once if hierarchy/screenshot unchanged. **skeptic simplifies to URL + DOM-length/node-count fingerprint** — skips screenshot-diff entirely because skeptic already has visual-diff reporters when the author actually wants pixel comparison. skeptic also **lifts the knob to step-level options** (alongside `timeout`, `optional`, `label`, `when`) rather than nesting inside click args, matching the established skeptic convention. |
| Dual timeout | `Orchestra.kt:129–130` (`lookupTimeoutMs = 17000L`, `optionalLookupTimeoutMs = 7000L`); `Orchestra.kt:1312–1316` (branch on `optional` flag); `Orchestra.kt:1584` (`adjustedToLatestInteraction` — dynamic reduction by wall-clock elapsed) | Maestro picks 17s vs 7s **based on the `optional: true` selector flag** and shrinks later commands by elapsed flow budget. **skeptic reinterprets this**: `hardTimeout` = fail-on-exceed (existing Playwright timeout behavior, just renamed), `softTimeout` = warn-on-exceed (Node-side `setTimeout` that fires `logger.warn` + flags `StepResult.warning` but does not interrupt). This is strictly more expressive than Maestro's two-bucket model (any numeric value, not just 17s/7s). Dynamic reduction is deliberately out of scope — listed below. |
| Random inputs | `Commands.kt:754–794` (`InputRandomCommand` with `InputRandomType` enum; `genRandomString()` uses `net.datafaker.Faker` fresh per call, defaults length=8, guards length ≤ 0 → 8); `YamlInputRandomText.kt:22–57` (per-name YAML classes); `Orchestra.kt:357,1198–1202` (delegates to existing `InputTextCommand` path) | First-class commands: generate faker value at execution time, then delegate to the existing text-input path. skeptic mirrors this with one handler file per user-facing name (like Maestro's YAML classes) and reuses the same `resolveElement → clear → fill` flow as `handleType` (inlined, not delegated — functionally identical, matches skeptic's "handlers are independent" house rule). |

Decision deltas from Maestro (called out explicitly so /codex-review can challenge them):

1. **Names drop the `input` prefix** (`randomEmail` not `inputRandomEmail`). Matches skeptic's existing `clearInput` / `setVariable` casing. Task brief also specifies these names verbatim.
2. **Added `randomPhone`** (Maestro has no phone command; `faker.phone.number()` is a one-liner and requested by the task brief).
3. **Dropped `randomPersonName`** (low value in web-E2E; `randomType` covers free-form text). Task brief does not include it.
4. **Default length = 8** for `randomType` / `randomNumber` (matches `Commands.kt:766`). Initial draft had 10 for `randomType`; corrected.
5. **Length validation is strict at schema** (Zod `.positive()` rejects 0/negative). Maestro silently coerces ≤ 0 → 8 at runtime; skeptic prefers early failure because flow authors can see the mistake at parse time instead of a silent 8-char default surprising them at run time. Consistent with skeptic's existing `.positive()` guard on `timeout` (see `workspace-hooks.test.ts:56`).
6. **Change detection: URL + DOM fingerprint only**, no screenshot diff. Simpler, cheaper, and skeptic's `assertScreenshot` handler already covers pixel comparison when that is the author's intent.
7. **`retryIfNoChange` lives at step-options level**, not inside selector args. Maestro nests it under `tapOn:`. skeptic puts it alongside `timeout` / `optional` — this keeps `click:` args as the simple string they are today and matches every other step-level knob skeptic already has.
8. **Dual-timeout semantics are orthogonal to Maestro's**, not a port. `hardTimeout`/`softTimeout` are user-supplied numeric values with warn-vs-fail semantics; Maestro's 17s/7s bucket is tied to an `optional` flag. Flagged in Phase 2 so reviewers don't expect a literal port.

**Out of scope (deliberate):**
- Applying `retryIfNoChange` by default (Maestro kept it opt-in — issues #1202, #1766 rejected flipping the default).
- Dynamic timeout reduction (Maestro's `adjustedToLatestInteraction` at `Orchestra.kt:1584` — a separate concept from dual-timeout; would require flow-wall-clock tracking skeptic doesn't have).
- Screenshot-based change detection (0.5% threshold at `Maestro.kt:678` — deferred; visual-diff reporters handle this differently in skeptic).
- Spatial selectors (`below:`, `rightOf:`) — competitive analysis #37, different bundle.

## Phase 1 — MCP Viewport Parity (Full, Not Just Front-Matter)

**Goal:** eliminate **two** sites of viewport drift, not one. The original plan missed that CLI also threads `config.browser.viewport` into `EngineOptions` (`cli/src/commands/test.ts:200`), while both MCP `EngineOptions` constructions (`mcp.ts:130–135` in `handleRunFlow`, `mcp.ts:165–169` in `handleRunTest`) drop it entirely.

### 1.1 Flow-level fix — add `viewport` to MCP `flowToInput`
`cli/src/commands/mcp.ts:278–304` — the return object currently spreads `url, name, file, steps, timeout, device, auth, env, onFlowStart, onFlowComplete`. Add:

```ts
viewport: flow.metadata.viewport,
```

…immediately after `timeout` (match the field order in `cli/src/commands/test.ts:474–485`).

### 1.2 Workspace-level fix — thread `config.browser.viewport` into MCP engine options
Both MCP engine-options constructions must mirror `test.ts:194–219`:

```ts
// cli/src/commands/mcp.ts:130–135 (handleRunFlow) — add viewport line:
const engineOpts: EngineOptions = {
  headed,
  timeout: config.browser.timeout,
  viewport: config.browser.viewport,
  aiClient,
  aiProvider: config.ai.provider,
};

// cli/src/commands/mcp.ts:165–169 (handleRunTest) — same addition:
const engine = new PlaywrightEngine({
  timeout: config.browser.timeout,
  viewport: config.browser.viewport,
  aiClient,
  aiProvider: config.ai.provider,
});
```

Flow-metadata viewport already overrides engine viewport via `playwright-engine.ts:69–74` — no executor change needed.

### 1.3 Parity regression tests — cover **both** sites
`cli/__tests__/unit/config/workspace-hooks.test.ts` `describe("flowToInput hook merging (MCP path — CLI/MCP parity)")` (lines 130–165):

- `it("threads flow.metadata.viewport through to FlowInput (CLI/MCP parity)")` — assert both `cliFlowToInput` and `mcpFlowToInput` return `viewport: { width: 375, height: 812 }` when set in flow metadata; assert both return `viewport: undefined` when metadata omits it.

New test file or added `describe` block — `cli/__tests__/unit/commands/mcp.test.ts` (file already exists per the initial audit):
- `it("threads config.browser.viewport into EngineOptions (handleRunFlow)")` — spy/mock `PlaywrightEngine` constructor; pass a config with `browser.viewport = { width: 1920, height: 1080 }`; assert the constructor receives the viewport.
- `it("threads config.browser.viewport into EngineOptions (handleRunTest)")` — same pattern for `handleRunTest`.

### 1.4 Verification
```bash
cd cli && npm run check && npm test -- workspace-hooks mcp
```
New parity tests green; no regressions in the existing parity suite.

## Phase 2 — Dual Timeout Strategy (`hardTimeout` / `softTimeout`)

**Goal:** split `timeout` into fail-on-exceed (`hardTimeout`) vs warn-on-exceed (`softTimeout`). Keep `timeout` as a backward-compat alias — **when both are present, `hardTimeout` silently wins**; no rejection. Scope is step-level only; `browser.timeout` in workspace config remains the workspace-level hard-timeout default (no `browser.softTimeout` introduced in this bundle — deliberately out of scope).

### 2.1 Schema additions — `cli/src/parser/flow-schema.ts`

Extend `Step` interface (lines 63–120) and `StepSchema` zod object (lines 124–274) with:

```ts
// Interface additions (alongside existing timeout, optional, label, when):
hardTimeout?: number;
softTimeout?: number;

// Zod additions (inside the StepSchema object literal):
hardTimeout: z.number().positive().optional(),
softTimeout: z.number().positive().optional(),
```

Add `hardTimeout` / `softTimeout` to `SHARED_KEYS` (line 122) so the "no unknown keys" refinement (line 268) accepts them.

Add **one** refinement after the existing command-count refinement (lines 253–269):

```ts
.refine(
  (step) => {
    const hard = step.hardTimeout ?? step.timeout;
    if (step.softTimeout !== undefined && hard !== undefined && step.softTimeout >= hard) {
      return false;
    }
    return true;
  },
  { message: "softTimeout must be less than hardTimeout (or timeout)." },
);
```

**Single alias rule:** setting both `timeout` and `hardTimeout` is allowed; `hardTimeout` silently wins via `hardTimeout ?? timeout`. No mutual-exclusion refinement. This matches how most YAML tools handle field aliases and keeps the deprecation path clean.

### 2.2 Normalizer — `cli/src/parser/step-normalizer.ts`

Extend `StepOptions` (lines 4–9) with the new knobs and resolve the alias:

```ts
export interface StepOptions {
  timeout?: number;        // kept for back-compat display / reporter; aliases hardTimeout
  hardTimeout?: number;
  softTimeout?: number;
  optional?: boolean;
  label?: string;
  when?: Condition;
}
```

In `normalizeStep` (line 22–29), populate:

```ts
options: {
  timeout: step.timeout,
  hardTimeout: step.hardTimeout ?? step.timeout,
  softTimeout: step.softTimeout,
  optional: step.optional,
  label: step.label,
  when: step.when,
},
```

Rationale: downstream code reads `options.hardTimeout` as the single source of truth; `options.timeout` is preserved only so `ink-reporter` / JSON reporter keep rendering the field name the user wrote.

### 2.3 Executor wiring — `cli/src/executor/types.ts` + `step-handlers/nested-executor.ts` + `playwright-engine.ts`

**Add `StepResult.warnings?: string[]`** (array, not scalar) in `cli/src/executor/types.ts` (lines 8–18). An array is append-safe so soft-timeout, retry-if-no-change, and any future non-fatal notices can all coexist on one step result without clobbering each other. Reporters that don't care ignore unknown fields.

Add a tiny append helper co-located with the `StepResult` type (same file):
```ts
export const appendWarning = (result: StepResult, warning: string): StepResult => {
  if (!result.warnings) result.warnings = [];
  result.warnings.push(warning);
  return result;
};
```

**Hard-fail ceiling — key correctness fix.** Several existing handlers bypass Playwright's default timeout entirely: `assert-visible.ts:22` hard-codes `10_000`, `wait.ts:25` ignores timeout setup, `wait-for-element.ts:41`/`scroll-until-visible.ts:65`/`assert-text.ts:36`/`assert-not-visible.ts:29` either pass their own timeout or use a raw sleep. Setting `page.context().setDefaultTimeout()` **does not guarantee** the step returns within `hardTimeout`. To make `hardTimeout` a true fail ceiling, wrap the handler call in `Promise.race` against a Node-side timer:

```ts
// helper in nested-executor.ts (and mirrored at top-level in playwright-engine.ts).
// `body` is whatever the step ultimately runs — for plain steps that's just the handler;
// for click+retryIfNoChange it's a composed function (see Phase 3.2).
const raceWithHardTimeout = async (
  body: () => Promise<StepResult>,
  hardTimeout: number | undefined,
  command: string,
  args: unknown,
  ctx: ExecutionContext,
): Promise<StepResult> => {
  if (hardTimeout === undefined) return body();
  let timer: NodeJS.Timeout | undefined;
  const ceiling = new Promise<StepResult>((resolve) => {
    timer = setTimeout(() => {
      // CRITICAL: flip the abort flag so composite loops and the top-level flow loop
      // stop dispatching further work on this page before the stale handler can race with them.
      ctx.abortReason = `hardTimeout exceeded (${hardTimeout}ms) on '${command}'`;
      resolve({
        command,
        args,
        status: "failed",
        duration_ms: hardTimeout,
        error: `hardTimeout exceeded (${hardTimeout}ms)`,
      });
    }, hardTimeout);
  });
  try {
    return await Promise.race([body(), ceiling]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
```

**Why the abort flag is load-bearing.** A naive Promise.race leaves the original handler running against `page`. In skeptic's executor, the next thing that happens after a failed step is often another dispatch on the same page — `retry.ts:34` starts the next iteration, `repeat.ts:44` dispatches the next loop body, `run-flow.ts:84` moves to the next child step, and `playwright-engine.ts:200` runs screenshot-on-failure and then onFlowComplete hooks. If the stale handler then calls `ctx.setVariable(...)` or issues another `element.click()`, state corrupts. The fix is a single mutable field on the context:

```ts
// cli/src/executor/context.ts — add to ExecutionContext class:
abortReason: string | null = null;
```

Every enclosing loop checks the flag before dispatching:

- `nested-executor.ts` main step loop: skip remaining steps and return the last failed result if `ctx.abortReason !== null` **and the caller did not pass `continueOnError: true`**.
- `retry.ts` / `repeat.ts` / `run-flow.ts` — check between iterations; if aborted, return without another attempt.
- `playwright-engine.ts` top-level flow-body loop — stop dispatching flow-body steps on abort.

**Two explicit escape hatches that must be specified together** (this is the correctness bar Round 3/4 flagged):

1. **Teardown (`onFlowComplete`) must run regardless of abort — including composite teardown.** Add a context-level flag, not a per-call option, because hook steps include composites (`retry:`, `repeat:`, `runFlow:` — all valid per `flow-schema.ts:276`). Composite handlers call `executeNestedSteps` again internally without awareness of teardown semantics; a per-call `continueOnError` passed only at the outer dispatch would not reach them.

   ```ts
   // cli/src/executor/context.ts — add to ExecutionContext class (alongside abortReason):
   inTeardown: boolean = false;
   ```

   `playwright-engine.ts` wraps the existing `onFlowComplete` dispatch (`playwright-engine.ts:226`) with `ctx.inTeardown = true` / `ctx.inTeardown = false` in a try/finally. The pre-dispatch check in `nested-executor.ts` becomes:

   ```ts
   if (ctx.abortReason !== null && !options?.continueOnError && !ctx.inTeardown) { short-circuit }
   ```

   Because `inTeardown` lives on the shared context object, it propagates automatically through every nested `executeNestedSteps` call that a composite teardown hook might make (`retry.ts:35`, `repeat.ts:44`, `run-flow.ts:84`), with no change to any composite handler. The existing per-call `continueOnError` option keeps its original meaning (ignore errors within a list of steps) — the two flags are orthogonal. Stale handler races during teardown are already accepted (teardown is best-effort).

2. **Non-fatal paths must clear the flag when they apply their non-fatal semantics.** Two existing paths have explicit "warn but continue" contracts that a naive abort would silently regress:
   - `optional: true` downgrade in `nested-executor.ts:84–87` (and mirror at `playwright-engine.ts:195–198`). After the status-to-`passed` downgrade, also `ctx.abortReason = null`.
   - `onFlowStart` hook-failure warning in `playwright-engine.ts:135–137`. After `logger.warn`, `ctx.abortReason = null`.

   Rationale: if the flow author marked a step `optional: true`, they're saying "don't let its failure stop the flow" — a hardTimeout mid-flight in that step is still a failure of that step, not a reason to abort the whole flow. Same reasoning for `onFlowStart` hook steps. Clearing the flag at the exact point the non-fatal semantics are applied keeps the rule local and inspectable.

Combined, these two rules make `ctx.abortReason` a scoped "the current dispatch path should terminate" signal, not a global kill switch. The stale handler may still reach `ctx.setVariable` once (we can't preempt), but no further *normal* dispatches will observe corrupt state, and explicit non-fatal contracts are preserved.

Document both rules in `CLAUDE.md` (Phase 5).

**Nested executor (`nested-executor.ts`):** the abort check must be the **very first** thing inside the per-step loop — **before** the existing `evaluateCondition(step.options.when, ...)` at line 40. A `when.visible` predicate queries Playwright locators via `condition.ts:15`; allowing it to run post-abort reintroduces the stale-handler race on the new locator query.

```ts
// Top of per-step body in nested-executor.ts — BEFORE the when-condition check at line 40.
if (ctx.abortReason !== null && !ctx.inTeardown && !options?.continueOnError) {
  return { command: step.command, args: step.args, status: "failed", duration_ms: 0, error: ctx.abortReason };
}
// Existing when-condition check follows …
// Existing timeout-mutation block (to be replaced) follows …
```

The same "abort-first, condition-second" ordering applies to every loop that evaluates `when`/`while`:
- `playwright-engine.ts:147` (top-level flow-body loop with `when`)
- `repeat.ts:38` (loop-top `while` check — add abort check BEFORE the existing `evaluateCondition(parsed.while, ...)`)
- `retry.ts` between iterations (no when/while, but still needs the abort check before redispatch)
- `run-flow.ts:84` — **note**: run-flow delegates its child-step dispatch to `executeNestedSteps`, so the abort check for child steps is inherited from the shared nested-executor rule (above). No separate loop-top check is needed inside `run-flow.ts` itself. The abort check between the `runFlow` step and the next sibling step comes from whichever caller is dispatching `runFlow` (nested-executor or playwright-engine top-level).

Then continue with the timeout-mutation replacement:

const hardTimeout = step.options?.hardTimeout ?? step.options?.timeout;
const softTimeout = step.options?.softTimeout;

if (hardTimeout !== undefined) {
  ctx.activeTimeout = hardTimeout;
  page.context().setDefaultTimeout(hardTimeout); // still helps handlers that DO honor it
}

let softTimer: NodeJS.Timeout | undefined;
let softTimeoutFired = false;
if (softTimeout !== undefined) {
  softTimer = setTimeout(() => {
    softTimeoutFired = true;
    logger.warn(`[softTimeout] step '${step.options?.label ?? step.command}' exceeded ${softTimeout}ms (continuing)`);
  }, softTimeout);
}

// `stepBody` is the full unit of work under a single timeout budget. For click+retryIfNoChange
// it composes fingerprint + handler + settle + optional retry (see Phase 3.2). For every other
// command it's just the handler call.
const stepBody = buildStepBody(step, handler, page, ctx);

let result: StepResult;
try {
  result = await raceWithHardTimeout(stepBody, hardTimeout, step.command, step.args, ctx);
  if (softTimeoutFired) {
    appendWarning(result, `soft-timeout exceeded (${softTimeout}ms)`);
  }
} finally {
  if (softTimer) clearTimeout(softTimer);
  // existing activeTimeout + default-timeout restoration …
}
```

**Playwright engine top-level (`playwright-engine.ts` lines 178–192):** apply the identical pattern. The main flow-body loop must also check `ctx.abortReason` between steps and stop dispatching (teardown hooks at `onFlowComplete` still run — see existing `continueOnError: true` path at `playwright-engine.ts:226`).

**Composite-handler warning propagation.** `retry.ts:35–43`, `repeat.ts:44–53`, `run-flow.ts:84` all return a fresh `StepResult` without carrying over child warnings. Update each so the parent result's `warnings` is the concatenation of all child-step warnings:

- `retry.ts`: after the inner `executeNestedSteps` call, copy `result.warnings` onto the outer `retry` result before returning.
- `repeat.ts`: accumulate warnings across iterations and attach to the outer `repeat` result.
- `run-flow.ts`: same — child flow's per-step warnings bubble up onto the `runFlow` step result.

This keeps soft-timeout / retry notices visible when the step that fired them is nested.

### 2.4 Reporter + TUI surface

**`cli/src/reporter/console-reporter.ts`** — on step-complete, if `result.warnings?.length`, print `  ⚠ <warning>` in yellow (one line per warning) after the step's pass line. Reuse any existing chalk import; otherwise a minimal `⚠` prefix is enough.

**TUI (ink) propagation** — the TUI state drops unknown `StepResult` fields today. Three surgical edits:

1. `cli/src/ui/types.ts:12–19` — extend `StepState`:
   ```ts
   export interface StepState {
     command: string;
     args: unknown;
     phase: "pending" | "running" | "passed" | "failed" | "error" | "skipped";
     duration_ms: number;
     error?: string;
     screenshot?: string;
     warnings?: string[];   // NEW
   }
   ```

2. `cli/src/ui/types.ts` — in the `step:complete` reducer case (around line 97–110), copy `event.step.warnings` into the step state along with the other fields.

3. `cli/src/ui/components/step-line.tsx:60–67` (`passed` case) — after the duration text, if the step has `warnings`, render a compact `⚠ (N)` badge in yellow; in verbose mode, render each warning on its own indented line (mirror the existing `step.error && verbose` pattern at line 77–79). Apply the same rendering to `step-line-compact.tsx:12` if it handles the passed state.

**Skipped reporters:** `json-reporter` serializes `warnings` automatically via JSON. `junit-reporter` and `html-reporter` are intentionally not updated in this bundle — per-step warnings aren't a CI-artifact concern yet; revisit if users ask.

### 2.5 Existing test updates (required before new tests)

`cli/__tests__/unit/config/workspace-hooks.test.ts:112` currently asserts `expect(options).toEqual({ timeout, optional, when, label })` with a 4-field exact-equality check. Adding `hardTimeout` / `softTimeout` / `retryIfNoChange` to `StepOptions` will break this assertion. Update to either (a) `expect(options).toMatchObject(...)` with the 4 original keys, or (b) include the new keys (as `undefined`) in the expected object. Prefer (a) — `toMatchObject` survives future additions.

### 2.6 New tests

- `cli/__tests__/unit/parser/flow-parser.test.ts` — add parse tests:
  - `hardTimeout: 5000, softTimeout: 2000` → parses successfully.
  - `timeout: 5000, hardTimeout: 3000` → **parses successfully** (no rejection); normalizer picks `hardTimeout`.
  - `hardTimeout: 1000, softTimeout: 2000` → **rejected** (softTimeout must be less than hardTimeout).
- `cli/__tests__/unit/parser/step-normalizer.test.ts` (create if absent) — test alias resolution:
  - `timeout: 1000` alone → `options.hardTimeout === 1000`, `options.timeout === 1000`.
  - `hardTimeout: 2000` alone → `options.hardTimeout === 2000`, `options.timeout === undefined`.
  - Both set: `options.hardTimeout` equals the explicit `hardTimeout` (silent win, no error).
- `cli/__tests__/unit/executor/step-handlers.test.ts`:
  - `describe("soft timeout")` — fake handler that `await new Promise(r => setTimeout(r, 100))` with `softTimeout: 10`; assert `result.warnings` contains a `/soft-timeout/` match, `logger.warn` was called, step status remains `passed`.
  - `describe("hard timeout ceiling")` — fake handler that sleeps 500ms with `hardTimeout: 50`; assert step returns `status: "failed"` within ~50ms, error matches `/hardTimeout exceeded/`. Key: the fake handler must not honor `setDefaultTimeout` — this proves Promise.race actually enforces the ceiling.
  - `describe("hard timeout aborts enclosing execution")` — a `retry` block whose first iteration hits hardTimeout; assert the second iteration is **not** dispatched (spy on handler call count). Same pattern for `repeat` and the top-level flow-body loop in `playwright-engine.ts` — once `ctx.abortReason` is set, later steps short-circuit with the abort reason as their `error`.
  - `describe("abort does not block teardown")` — a flow whose body step hits hardTimeout; assert that every step in `onFlowComplete` still runs. **Cover both flat and composite teardown** (two separate cases):
    - `onFlowComplete: [{ click: "a" }, { click: "b" }]` — assert both click handlers are called.
    - `onFlowComplete: [{ retry: { maxRetries: 2, commands: [{ click: "logout" }] } }]` — assert the inner `click: "logout"` handler runs (confirms `ctx.inTeardown` propagates through the `retry` composite's internal `executeNestedSteps` call).
  - `describe("abort is cleared on non-fatal paths")` — (a) an `optional: true` step that hits hardTimeout: assert `ctx.abortReason === null` after the step completes and the next flow-body step IS dispatched; (b) an `onFlowStart` hook step that hits hardTimeout: assert the flow body still runs with `ctx.abortReason === null`.
  - `describe("retryIfNoChange fits inside step budget")` — step with `retryIfNoChange: true, hardTimeout: 200`; handler configured to take 150ms per attempt with an unchanged fingerprint. Assert the step fails around 200ms (not 300ms+), confirming the whole retry body shares one budget rather than each attempt getting its own.
  - `describe("retryIfNoChange aborts before retry click")` — `hardTimeout: 100, retryIfNoChange: true`, and `DOM_SETTLE_MS` effectively larger than hardTimeout (mock or shorten hardTimeout to 100, keep DOM_SETTLE_MS default 500). Handler records every call. Scenario: attempt 1 passes at ~30ms, settle begins, hardTimeout fires at 100ms (sets `abortReason`). Assert handler was called **exactly once** — the in-body abort check before the retry click prevents attempt 2 from running. Without the in-body checks, this test fails with 2 calls.
  - `describe("retryIfNoChange aborts before even the first click if fingerprint outlives budget")` — stub `page.evaluate` to take 200ms; set `hardTimeout: 100`. Assert the click handler is called **zero times** (fingerprint await outlives the timeout; the abort check between fingerprint and first click skips the click entirely).
  - `describe("abort skips when/while condition evaluation")` — (a) flow with step A (triggers abort) followed by step B using `when: { visible: "#thing" }`: spy on `evaluateCondition` — assert it's NOT called for step B. (b) a `repeat` whose first iteration triggers abort and whose `while` is `{ visible: "#thing" }`: assert `evaluateCondition` is NOT called for the second iteration. Confirms the abort check is above the condition check, not below.
  - `describe("composite warning propagation")` — a `retry` whose inner step fires soft-timeout: assert the outer `retry` result carries the child's warnings. Same for `repeat` and `runFlow`.

## Phase 3 — `retryIfNoChange` Click Option

**Goal:** opt-in step option. When `retryIfNoChange: true`, executor captures URL + DOM fingerprint before `click`, lets the click run, waits a short settle window, re-captures, retries once if unchanged.

### 3.1 Schema + normalizer

`cli/src/parser/flow-schema.ts` — add to `Step` interface and `StepSchema`:

```ts
retryIfNoChange?: boolean;
// zod:
retryIfNoChange: z.boolean().optional(),
```

Add to `SHARED_KEYS`.

`cli/src/parser/step-normalizer.ts` — add to `StepOptions` and extract in `normalizeStep`:

```ts
options: {
  ...,
  retryIfNoChange: step.retryIfNoChange,
}
```

### 3.2 Executor-level retry wrapper — `nested-executor.ts` (and top-level in `playwright-engine.ts`)

**Why executor-level, not inside `click.ts`:** the logic is change-detection around a handler call; it doesn't need the click handler's internals. Keeping it out of the handler also means:
- No handler signature change.
- Later, if we want `hover` or `press` to opt in, it's one `if`-branch away.

**Fingerprint strategy (revised).** The initial draft used `url | textLen | nodeCount` — Codex correctly flagged that this misses class/attribute toggles, disabled-state changes, and same-length text swaps, and can false-trigger on unrelated churn. Use the strongest practical signal that's still cheap on the hot path: URL + full `document.body.outerHTML`. Plain string comparison of outerHTML catches every DOM mutation — attribute flips, ARIA state changes, node additions/removals, text swaps. 10–500KB strings compare in microseconds; the bottleneck is the cross-process `evaluate` round-trip (~1–10ms), which is already dominated by the 500ms settle window.

```ts
const DOM_SETTLE_MS = 500; // Maestro uses waitForAppToSettle() (Android 750ms, iOS 3000ms). Playwright's networkidle quiet-time is 500ms. Start at 500ms; tune if flaky.

interface Fingerprint { url: string; body: string }

const getChangeFingerprint = async (page: Page): Promise<Fingerprint> => {
  try {
    return {
      url: page.url(),
      body: await page.evaluate(() => document.body?.outerHTML ?? ""),
    };
  } catch {
    // Navigation in flight, page torn down, etc. — treat as "changed" by returning a unique sentinel.
    return { url: page.url(), body: `__evaluate-failed-${Date.now()}__` };
  }
};

const fingerprintsEqual = (a: Fingerprint, b: Fingerprint): boolean =>
  a.url === b.url && a.body === b.body;
```

**Caveat documented in code comment:** pages with live content (clocks, animated counters, auto-refreshing widgets) may produce new outerHTML on every settle tick → the retry won't fire (false-negative). This is the correct direction of failure — we prefer "didn't retry when we could have" over "retried a destructive click twice." If users hit this in practice, the escape hatch is to not opt in.

**Budget scope — important.** `hardTimeout` and `softTimeout` are declared per **step**, not per click attempt. If a step has `retryIfNoChange: true` and `hardTimeout: 1000`, the whole sequence (click attempt 1 + fingerprint + settle + maybe attempt 2 + fingerprint 2) must fit inside 1000ms. The way to enforce this is to compose the full body as a single function and pass it to `raceWithHardTimeout` once — not to wrap each inner `handler(...)` call individually.

Introduce a `buildStepBody` helper in `nested-executor.ts`:

```ts
const buildStepBody = (
  step: NormalizedStep,
  handler: StepHandler,
  page: Page,
  ctx: ExecutionContext,
): (() => Promise<StepResult>) => {
  const retryEnabled = step.command === "click" && step.options?.retryIfNoChange === true;
  if (!retryEnabled) {
    return () => handler(page, ctx, step.args);
  }
  return async () => {
    const before = await getChangeFingerprint(page);
    // Fingerprint involves a cross-process page.evaluate; hardTimeout may have fired during it.
    // Guard BEFORE the first click — if aborted, don't even issue attempt 1.
    if (ctx.abortReason !== null) {
      return { command: "click", args: step.args, status: "failed", duration_ms: 0, error: ctx.abortReason };
    }

    let result = await handler(page, ctx, step.args);

    // Abort may have fired during attempt 1. raceWithHardTimeout set abortReason and returned
    // early, but this body is still running because Promise.race can't cancel it.
    // Check before any further work — especially before the destructive retry click.
    if (ctx.abortReason !== null) return result;
    if (result.status !== "passed") return result;

    await page.waitForTimeout(DOM_SETTLE_MS);

    // And again after the settle wait — hardTimeout may well have fired *during* the settle
    // (easy to hit when hardTimeout < DOM_SETTLE_MS).
    if (ctx.abortReason !== null) return result;

    const after = await getChangeFingerprint(page);
    if (!fingerprintsEqual(before, after)) return result;

    // Last guard: before the second click, re-check abort. This is the click that corrupts
    // state if it runs after the executor has already moved on.
    if (ctx.abortReason !== null) return result;

    logger.warn(`[retryIfNoChange] click on '${String(step.args)}' did not change the page — retrying once`);
    result = await handler(page, ctx, step.args);
    if (result.status === "passed") {
      appendWarning(result, "retried once (no change after first click)");
    }
    return result;
  };
};
```

The in-body `ctx.abortReason` checks are a correctness invariant for any future composed body — if Phase 3 grows to cover `hover`, `press`, etc., each additional awaited step inside the body must also guard against abort before any side-effecting work that follows. Callable out in `CLAUDE.md` as part of the "any body passed to `raceWithHardTimeout` must re-check `ctx.abortReason` between awaits" rule.

`raceWithHardTimeout` then wraps the whole body under one budget (see Phase 2.3 snippet). `softTimeout` fires on wall-clock just like any other step — if the settle+retry pushes past soft, the step pass still gets a `⚠ soft-timeout exceeded` warning. If it pushes past hard, the step fails mid-way and `ctx.abortReason` trips to stop further work.

`appendWarning` is the helper from Phase 2.3 — using it here means the retry warning coexists cleanly with any soft-timeout warning the same step might earn.

Mirror `buildStepBody` usage in `playwright-engine.ts`'s top-level step dispatch.

### 3.3 Tests

`cli/__tests__/unit/executor/step-handlers.test.ts` — new `describe("retryIfNoChange")`:

- `it("does not retry when page changes after click")` — mock `page.url()` to return different values on successive calls; assert click handler invoked exactly once.
- `it("retries once when URL and DOM fingerprint unchanged")` — mock `page.url()` to return the same value; mock `page.evaluate` to return same fingerprint; assert click handler invoked twice.
- `it("only applies to click, not to other handlers")` — set `retryIfNoChange: true` on a `type` step; assert no fingerprint capture and no retry behavior.
- `it("does not double-fail when click itself fails")` — mock click to return `status: "failed"`; assert **no second click (retry) and no post-click fingerprint comparison** after the failed first click. (The pre-click fingerprint IS captured — that's unavoidable in the current algorithm since we don't know ahead of time that the click will fail.)

## Phase 4 — Random Input Step Types

**Goal:** four new handlers (`randomType`, `randomEmail`, `randomNumber`, `randomPhone`) that generate a faker value, fill an input, optionally store in a flow variable.

### 4.1 Handler pattern

One file per command: `cli/src/executor/step-handlers/random-type.ts`, `random-email.ts`, `random-number.ts`, `random-phone.ts`.

Shared args shape (follows existing `copyTextFrom` pattern — `Step.copyTextFrom?: string | { selector: string; variable?: string }`):

```ts
// Shorthand (selector-only) OR full object:
interface RandomArgs {
  selector: string;
  variable?: string;  // optional: store generated value in this flow variable
  length?: number;    // only meaningful for randomType / randomNumber
}
```

Each handler:
1. Parse args (accept string = selector, or object).
2. Generate value via faker (method per handler; see table).
3. Resolve element via `resolveElement(page, selector)`.
4. `await element.clear(); await element.fill(value);` (mirrors `handleType` at `cli/src/executor/step-handlers/type.ts:60`).
5. If `variable` set, `ctx.setVariable(variable, value)`.
6. Return `StepResult` with the generated value exposed in `result.args` (for debugging) — keep `args` as the parsed input, not the generated value, to avoid confusing logs.

Faker mapping:

| Command | Faker call | Default when `length` omitted |
|---|---|---|
| `randomType` | `faker.string.alphanumeric({ length })` | 8 chars (matches Maestro `Commands.kt:766` default) |
| `randomEmail` | `faker.internet.email()` | n/a |
| `randomNumber` | `faker.string.numeric({ length })` | 8 digits (returns a string, matching Maestro's PR #256 — still fills an input as text) |
| `randomPhone` | `faker.phone.number()` | n/a |

**Note on `randomNumber`:** use `faker.string.numeric({ length })` not `faker.number.int(...)` — the value goes into a text input via `element.fill(value)`, so we want a numeric *string*. Matches Maestro's `inputRandomNumber` (8-digit default). `length` validated as positive int **capped at 1000** in schema (Maestro silently coerces ≤ 0 → 8; skeptic prefers a strict parse error — see decision delta #5). The upper bound is a cheap guard against `length: 1000000` in untrusted flow YAML becoming a CI memory/time DoS; 1000 is comfortably above any realistic form-input length.

### 4.2 Schema additions — `cli/src/parser/flow-schema.ts`

Append to `COMMAND_KEYS` (lines 13–49):

```ts
"randomType",
"randomEmail",
"randomNumber",
"randomPhone",
```

These are automatically picked up by `AI_EXPOSED_COMMANDS` (lines 58–60) — no filter change needed; they are safe for AI generation.

Extend `Step` interface (lines 63–120):

```ts
randomType?: string | { selector: string; variable?: string; length?: number };
randomEmail?: string | { selector: string; variable?: string };
randomNumber?: string | { selector: string; variable?: string; length?: number };
randomPhone?: string | { selector: string; variable?: string };
```

Extend `StepSchema` (lines 124–274) with:

```ts
randomType: z
  .union([
    z.string(),
    z.object({
      selector: z.string(),
      variable: z.string().optional(),
      length: z.number().int().positive().max(1000).optional(),
    }),
  ])
  .optional(),
randomEmail: z
  .union([
    z.string(),
    z.object({
      selector: z.string(),
      variable: z.string().optional(),
    }),
  ])
  .optional(),
randomNumber: z
  .union([
    z.string(),
    z.object({
      selector: z.string(),
      variable: z.string().optional(),
      length: z.number().int().positive().max(1000).optional(),
    }),
  ])
  .optional(),
randomPhone: z
  .union([
    z.string(),
    z.object({
      selector: z.string(),
      variable: z.string().optional(),
    }),
  ])
  .optional(),
```

### 4.3 Register handlers — `cli/src/executor/step-handlers/index.ts`

Import the four new handlers. Add both camelCase and kebab-case entries to the `stepHandlers` record (lines 38–97), matching house convention:

```ts
randomType: handleRandomType,
"random-type": handleRandomType,
randomEmail: handleRandomEmail,
"random-email": handleRandomEmail,
randomNumber: handleRandomNumber,
"random-number": handleRandomNumber,
randomPhone: handleRandomPhone,
"random-phone": handleRandomPhone,
```

Export the handlers alongside existing exports.

### 4.4 AI prompt visibility (automatic — sanity check)

`cli/src/ai/prompts.ts` consumes `AI_EXPOSED_COMMANDS` at line 1–3 and interpolates into both generation prompts (line 94, line 132). Adding the four names to `COMMAND_KEYS` flows them into the prompt automatically.

Update `cli/__tests__/unit/ai/prompts.test.ts` (lines 62–72) — the existing loop asserts every command in `AI_EXPOSED_COMMANDS` appears in both prompts. This test will automatically cover the four new names once they're in `COMMAND_KEYS`; verify no other hard-coded assertions need bumping.

### 4.5 Tests — `cli/__tests__/unit/executor/random-handlers.test.ts` (new file)

Mirror `cli/__tests__/unit/executor/new-step-handlers.test.ts` (the `copyTextFrom` pattern).

For each of the four handlers:
- `it("string-arg mode: fills input with a faker-generated value")` — mock `page.locator`/`getByText`/etc. returning a locator with spy'd `clear` and `fill`. Assert `fill` called once with a non-empty string. For `randomEmail`, assert value matches `/.+@.+/`. For `randomNumber`, assert `/^\d+$/` and default 8 digits. For `randomPhone`, assert non-empty.
- `it("object-arg mode with variable: stores generated value in ctx")` — pass `{ selector: "input", variable: "myVar" }`; assert `ctx.getVariable("myVar")` returns the same string passed to `fill`.
- `it("object-arg mode with length: respects length for randomType/randomNumber")` — pass `{ selector: "input", length: 3 }`; assert fill value has length 3.
- `it("returns failed status when selector cannot resolve")` — mock `resolveElement` throwing; assert `result.status === "failed"` and `result.error` present.

Schema tests in `cli/__tests__/unit/parser/flow-parser.test.ts`:
- Parse each new command in both shorthand and object form.
- Assert each appears in `COMMAND_KEYS` and `AI_EXPOSED_COMMANDS`.

## Phase 5 — Docs

**Goal:** the four new knobs (`hardTimeout`, `softTimeout`, `retryIfNoChange`, 4 random commands) need to show up where flow authors will look for them.

`cli/README.md` today documents only `timeout` / `optional` / `label` / `when` as shared step fields (line 81) and lists commands in a table around line 109. Update:

- The shared-step-options paragraph (around line 81): list `hardTimeout`, `softTimeout`, `retryIfNoChange` with one-line each. Note the `timeout` → `hardTimeout` alias.
- The commands table (around line 109): add rows for `randomType`, `randomEmail`, `randomNumber`, `randomPhone` with a minimal YAML example in the shorthand form.
- One short subsection near the end on **non-fatal warnings** — what `result.warnings` means in JSON/console output, and that it's emitted by `softTimeout` and `retryIfNoChange` today.

`CLAUDE.md` at the repo root — append entries under "Key Technical Decisions":
- `hardTimeout` is enforced by Promise.race, not just Playwright's `setDefaultTimeout` (because several existing handlers hard-code their own timeouts / bypass the default).
- When a hard-timeout fires, `ctx.abortReason` is set; every composite handler (`retry`, `repeat`, `run-flow`) and the top-level flow-body loop must check this flag before dispatching the next step.
- **`ctx.inTeardown` bypasses the abort check.** It's set only inside the `onFlowComplete` dispatch (try/finally in `playwright-engine.ts`). Because it lives on the shared context object, it automatically propagates through composite teardown hooks (e.g. a `retry:` inside `onFlowComplete`). `continueOnError` is a separate, orthogonal per-call option for ignoring step errors within a list.
- **`ctx.abortReason` is cleared when a non-fatal path applies its semantics.** Specifically: (a) when an `optional: true` step's failure is downgraded to `passed`; (b) when an `onFlowStart` hook failure is downgraded to a warning. A hardTimeout inside those paths is the failure of the step/hook, not a reason to abort the whole flow.
- **Any body passed to `raceWithHardTimeout` must re-check `ctx.abortReason` between awaits.** Promise.race cannot cancel the body; if hardTimeout fires, the body keeps running in the background. Before any side-effecting step (especially destructive ones like a retry click), guard with `if (ctx.abortReason !== null) return result;`. See `buildStepBody` in `nested-executor.ts` for the canonical example.

No verification-specific commands — doc-only changes go through the normal `npm run check` / `npm test` gate to confirm no code references were bumped incorrectly.

## Critical Files

| Path | Phase(s) | Change |
|---|---|---|
| `cli/src/commands/mcp.ts` | 1 | Add `viewport: flow.metadata.viewport` to `flowToInput`; add `viewport: config.browser.viewport` to both `EngineOptions` constructions (handleRunFlow + handleRunTest) |
| `cli/__tests__/unit/config/workspace-hooks.test.ts` | 1, 2 | Add flow-metadata viewport parity test; soften line 112's exact-equality assertion to `toMatchObject` so new step-option fields don't break it |
| `cli/__tests__/unit/commands/mcp.test.ts` | 1 | Add tests that both MCP handlers thread `config.browser.viewport` into `EngineOptions` |
| `cli/src/parser/flow-schema.ts` | 2, 3, 4 | Add `hardTimeout` / `softTimeout` / `retryIfNoChange` to `Step` + `StepSchema` + `SHARED_KEYS`; append 4 random commands to `COMMAND_KEYS`; extend `Step` + `StepSchema` with random command fields (length capped at 1000); add **single** `softTimeout < hardTimeout` refinement (no mutual-exclusion rule) |
| `cli/src/parser/step-normalizer.ts` | 2, 3 | Extend `StepOptions`; resolve `hardTimeout ?? timeout` alias; extract `softTimeout` + `retryIfNoChange` |
| `cli/src/executor/types.ts` | 2 | Add `StepResult.warnings?: string[]` + `appendWarning` helper |
| `cli/src/executor/context.ts` | 2 | Add `abortReason: string \| null = null` and `inTeardown: boolean = false` fields on `ExecutionContext` |
| `cli/src/executor/step-handlers/nested-executor.ts` | 2, 3 | Add `raceWithHardTimeout` + `buildStepBody` helpers; per-step wrapper composes whole retry body under one budget; pre-dispatch short-circuit on `ctx.abortReason` **unless `continueOnError: true`**; clear `ctx.abortReason` inside the existing `optional`-downgrade branch |
| `cli/src/executor/playwright-engine.ts` | 2, 3 | Mirror executor-level wiring; top-level flow-body loop checks `ctx.abortReason` before each step; wrap the `onFlowComplete` dispatch at line 226 with `ctx.inTeardown = true` / `= false` in try/finally so composite teardown hooks propagate the flag via the shared ctx; clear `ctx.abortReason` inside the existing `onFlowStart` hook-failure warning branch and inside the top-level `optional`-downgrade branch |
| `cli/src/executor/step-handlers/retry.ts` | 2 | Carry child `warnings` into outer retry result; check `ctx.abortReason` between iterations |
| `cli/src/executor/step-handlers/repeat.ts` | 2 | Accumulate child `warnings` across iterations into outer result; check `ctx.abortReason` between iterations |
| `cli/src/executor/step-handlers/run-flow.ts` | 2 | Propagate nested flow's per-step warnings onto `runFlow` step result. Child-step abort is inherited via its `executeNestedSteps` call (no separate loop-top check needed — run-flow delegates rather than looping in-place). |
| `cli/src/reporter/console-reporter.ts` | 2 | Render each entry in `result.warnings` as `⚠ …` after the step pass line |
| `cli/src/ui/types.ts` | 2 | Add `warnings?: string[]` to `StepState`; copy through in `step:complete` reducer |
| `cli/src/ui/components/step-line.tsx` | 2 | Render `⚠ (N)` badge in passed case; expand to list in verbose |
| `cli/src/ui/components/step-line-compact.tsx` | 2 | Same warning badge rendering |
| `cli/src/executor/step-handlers/random-type.ts` | 4 | New handler |
| `cli/src/executor/step-handlers/random-email.ts` | 4 | New handler |
| `cli/src/executor/step-handlers/random-number.ts` | 4 | New handler |
| `cli/src/executor/step-handlers/random-phone.ts` | 4 | New handler |
| `cli/src/executor/step-handlers/index.ts` | 4 | Import + register 4 handlers with camelCase + kebab aliases |
| `cli/__tests__/unit/parser/flow-parser.test.ts` | 2, 3, 4 | Schema parse/reject cases for new fields + new commands + length cap |
| `cli/__tests__/unit/parser/step-normalizer.test.ts` | 2, 3 | Normalize-alias cases (create file if absent) |
| `cli/__tests__/unit/executor/step-handlers.test.ts` | 2, 3 | `describe("soft timeout")`, `describe("hard timeout ceiling")`, `describe("composite warning propagation")`, `describe("retryIfNoChange")` |
| `cli/__tests__/unit/executor/random-handlers.test.ts` | 4 | New file — 4 handlers × 3–4 cases |
| `cli/__tests__/unit/ai/prompts.test.ts` | 4 | Sanity-check the existing loop still passes with 4 new commands |
| `cli/README.md` | 5 | Document new shared-step options, 4 random commands, and `result.warnings` |
| `CLAUDE.md` | 5 | One-line entry: hardTimeout enforced by Promise.race, not just Playwright timeout |

## Reused Utilities (no reinvention)

| Utility | Location | Used by |
|---|---|---|
| `normalizeStep` / `StepOptions` | `cli/src/parser/step-normalizer.ts` | Phase 2, 3 — extended, not rewritten |
| `ctx.activeTimeout` + restoration pattern | `cli/src/executor/context.ts`, `nested-executor.ts`, `playwright-engine.ts` | Phase 2 — extended to `hardTimeout` |
| `logger.warn` | `cli/src/utils/logger.ts` | Phase 2, 3 — soft-timeout + retry notices |
| `resolveElement` | `cli/src/executor/element-resolver.ts` | Phase 4 — all 4 random handlers |
| `ctx.interpolate` + `ctx.setVariable` | `cli/src/executor/context.ts` | Phase 4 — selector interpolation + variable capture |
| `ctx.lastElement` pattern | `cli/src/executor/step-handlers/click.ts:21` | Phase 4 — set after `resolveElement` like other handlers |
| `element.clear()` + `element.fill(value)` | `cli/src/executor/step-handlers/type.ts:58–60` | Phase 4 — exact pattern, don't delegate (handlers are independent) |
| `faker` (v9) | `cli/src/executor/step-handlers/script-sandbox.ts:2` | Phase 4 — same import, same symbol |
| `COMMAND_KEYS` → `AI_EXPOSED_COMMANDS` → prompts | `cli/src/parser/flow-schema.ts:13–60`, `cli/src/ai/prompts.ts:1–3` | Phase 4 — new commands flow through automatically |
| Parity test pattern (CLI vs MCP `flowToInput`) | `cli/__tests__/unit/config/workspace-hooks.test.ts:130–165` | Phase 1 — add one more `it` in the same describe |
| `copyTextFrom` handler pattern (string-or-object args, variable capture) | `cli/src/executor/step-handlers/copy-text-from.ts` | Phase 4 — direct template for 4 new handlers |

## Verification

Run after each phase:

```bash
cd cli && npm run check && npm run build && npm test
```

Phase-specific checks:

- **Phase 1:** `npm test -- workspace-hooks mcp` — 1 new flow-metadata parity test + 2 new MCP config-viewport tests pass; existing parity tests stay green.
- **Phase 2:** `npm test -- step-handlers flow-parser step-normalizer workspace-hooks` — new timeout cases pass; `workspace-hooks.test.ts:112` assertion survives the `StepOptions` extension; existing 280 tests stay green. Smoke-run: `softTimeout: 50, hardTimeout: 5000` with a slow handler → confirm `⚠ soft-timeout exceeded` appears and step still passes. Smoke-run: `hardTimeout: 50` with a handler that ignores `setDefaultTimeout` (e.g. `wait: 500`) → confirm step returns failed within ~50ms (proves Promise.race is doing work).
- **Phase 3:** `npm test -- step-handlers` — new `retryIfNoChange` tests pass. Smoke-run a flow with `click: "#submit"` + `retryIfNoChange: true` against a page where the click is gated by a 500ms animation; confirm automatic retry message in logs and `warnings` on the JSON result.
- **Phase 4:** `npm test -- random-handlers flow-parser prompts` — new handler tests pass; AI prompt tests still cover all exposed commands. Smoke-run a flow:
  ```yaml
  - randomEmail: "input[name=email]"
  - randomNumber:
      selector: "input[name=phone]"
      length: 10
      variable: generatedPhone
  - click: "button[type=submit]"
  ```
  Confirm via the JSON reporter output (or `--verbose` console) that both inputs were filled with faker-generated values and `generatedPhone` appears in the context variables snapshot. `assertText` is not a valid readback for input values — `assert-text.ts:32` only checks visible text / `textContent`, not `input.value`. Variable capture is covered by the handler unit tests (each `random*` handler has an "object-arg mode with variable" case that asserts `ctx.getVariable(...)` returns the faker-generated string). Also try `length: 5000` → expect a parse error (cap is 1000).
- **Phase 5:** `npm run build` — README / CLAUDE.md changes have no code impact; the build passes unchanged.

**Final (whole-bundle) verification:**

```bash
cd cli && npm run check && npm run build && npm test
```

- All 280+ existing tests green.
- New tests: ~3 (Phase 1) + ~9 (Phase 2) + ~4 (Phase 3) + ~16 (Phase 4) ≈ 32 new test cases.
- Grep after impl: `rg "viewport" cli/src/commands/` — CLI and MCP both thread the field at both flow-metadata and engine-options level.
- Grep after impl: `rg "hardTimeout|softTimeout" cli/src/` — executor wraps every handler call in `runHandlerWithHardTimeout` when hardTimeout is set.
- Grep after impl: `rg "retryIfNoChange" cli/src/` — hits schema, normalizer, nested-executor, playwright-engine, tests.
- Grep after impl: `rg "randomType|randomEmail|randomNumber|randomPhone" cli/src/` — hits schema (COMMAND_KEYS), 4 handler files, index.ts registry.
- Grep after impl: `rg "warnings" cli/src/executor cli/src/reporter cli/src/ui` — warnings array flows from types → executor → composites → reporter → TUI state → rendering.

**Implementation audit (before declaring done):** spawn one Explore agent to verify every row in the Critical Files table has the expected change. No cleanup tasks left in the code.
