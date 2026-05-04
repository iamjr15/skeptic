# Plan: Close Remaining Gaps from `iterative-splashing-shamir.md`

## Context

The Maestro+Expect adoption plan (`plans/iterative-splashing-shamir.md`) is ~80% implemented. Production code for the 11 new step handlers, retry block, config hooks, clock/geolocation/permissions, audit command, saved flows, session tracing, and three AI provider clients is in place. The remaining gaps, grouped by phase below, fall into three buckets: (1) latent bugs that block multi-provider and nested-step correctness, (2) surface-level refactors that let existing features honor `when`/`timeout`/`optional` consistently, and (3) 13 missing test files.

Key gaps identified from the audit + Codex review:

- **Multi-provider is nominally wired but broken at runtime**: `cli/src/config/schema.ts:63` defaults `model` to `gemini-2.5-flash` for every provider, and `cli/src/ai/client-factory.ts:17` falls back to `GEMINI_API_KEY` regardless of provider. A user setting `provider: "openai"` will send `gemini-2.5-flash` to `api.openai.com`.
- **`executeNestedSteps` exists but is unused**: `retry.ts`, `repeat.ts`, and `run-flow.ts` each reimplement step execution; `run-flow.ts:60-65` actively strips `options` during normalization; `playwright-engine.ts:131-148` executes hooks manually with no `timeout`; `mcp.ts:260-267` `stepToCommand` also strips `options`.
- **AI step handlers still instantiate `new GeminiClient(process.env["GEMINI_API_KEY"]!)`** at `assert-with-ai.ts:48`, `assert-no-defects.ts:33`, `extract-text-ai.ts:50`; `test.ts` and `mcp.ts` never populate `EngineOptions.aiClient`; `GeminiClient` doesn't declare `implements AIClient`; `assertion-evaluator.ts` is typed to `GeminiClient`; `security.ts` hardcodes Gemini-specific strings and uses a single `.ai-consent` file across providers.
- **`flow-generator.ts:82-85`** uses a naive string split and returns unvalidated YAML. Should validate via `yaml.parseAllDocuments()` + `FlowSchema.safeParse()` before returning.
- **`@faker-js/faker` is not a dependency**; `script-sandbox.ts:29-45` ships a lazy-proxy that errors at runtime.
- **`StepResult`** has only a generic `screenshot` field; visual-regression consumers can't distinguish baseline/current/diff; `console-reporter.ts` never shows any path, `html-reporter.ts` renders one image only.
- **14 new test files** listed in the target plan do not exist, and one existing (`security.test.ts`) needs updating for the new signatures.

Goal: every change lands with the tests specified in the target plan; **at the executor and generator level**, all three AI providers work correctly (`assertWithAI`, `assertNoDefects`, `extractTextWithAI`, `skeptic generate`); and `when`/`timeout`/`optional` are honored uniformly across flows, hooks, retries, repeats, and run-flow.

**Explicitly out of scope** (follow-up work): the `skeptic add github-action --ai` scaffold still hardcodes `GEMINI_API_KEY` in `cli/src/commands/add.ts:24,132`, and the CI scaffold test `cli/__tests__/unit/commands/add.test.ts:53` locks that in. Making the scaffold provider-aware is a separate change that doesn't affect runtime correctness of the three AI step handlers or the `generate` command; it's the user-setup docs, not the execution path. Track as a follow-up issue.

---

## Phase 1 — Unify nested step execution

### 1.1 Harden `executeNestedSteps` (active-timeout tracking, try/finally, catch throws)

**File:** `cli/src/executor/step-handlers/nested-executor.ts`

The helper enforces `when` (lines 30-33) and `optional` (51-53) but not `timeout`, doesn't catch handler exceptions, and — most importantly — cannot correctly restore a parent composite step's timeout. Consider:

```yaml
- retry: { maxRetries: 3, timeout: 5000, commands: [ { click: "#x", timeout: 1000 }, { click: "#y" } ] }
```

The engine sets PW default to `5000` before calling `handleRetry`. The helper sets it to `1000` for the first child. After that child, the second child `#y` (no timeout) must run with `5000` — not the flow default `30000`. The earlier draft restored to `ctx.defaultTimeout`, which is the flow default — wrong.

**Fix — track "active timeout" in ctx.** Add a mutable `activeTimeout: number` field to `ExecutionContext` (distinct from the readonly `defaultTimeout`). The engine and the helper both keep this in sync with Playwright's browser-context default timeout. Any code that needs to restore a parent timeout reads `ctx.activeTimeout`.

**File:** `cli/src/executor/context.ts` — add:
```ts
readonly defaultTimeout: number;   // flow-level default (immutable after construction)
activeTimeout: number;             // currently-active timeout (mutated during step dispatch)
```
Initialize both from the constructor param; helpers and the engine are responsible for keeping `activeTimeout` in sync.

**File:** `cli/src/executor/playwright-engine.ts:185-198` — around each top-level step, update `activeTimeout` alongside Playwright's default:
```ts
const parentTimeout = ctx.activeTimeout;
if (options?.timeout !== undefined) {                     // note: !== undefined, not truthy
  context.setDefaultTimeout(options.timeout);
  ctx.activeTimeout = options.timeout;
}
try {
  result = await handler(page, ctx, step.args);
} finally {
  if (options?.timeout !== undefined) {
    context.setDefaultTimeout(parentTimeout);
    ctx.activeTimeout = parentTimeout;
  }
}
```
(Same pattern for the per-step `try/finally` already in the engine — just add the `ctx.activeTimeout` line and swap the truthy check.)

**Helper `executeNestedSteps`:**
```ts
const results: StepResult[] = [];
let firstFailure: { status: "failed" | "error"; error?: string } | null = null;

for (const step of normalized) {
  if (step.options?.when) { /* ...existing skip logic: push "skipped" result, continue... */ }
  const handler = stepHandlers[step.command];
  if (!handler) { /* ...existing unknown-command path — pushes error and returns... */ }

  const parentTimeout = ctx.activeTimeout;
  if (step.options?.timeout !== undefined) {
    page.context().setDefaultTimeout(step.options.timeout);
    ctx.activeTimeout = step.options.timeout;
  }
  let result: StepResult;
  try {
    result = await handler(page, ctx, step.args);
  } catch (err) {
    result = {
      command: step.command,
      args: step.args,
      status: "error",
      duration_ms: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (step.options?.timeout !== undefined) {
      page.context().setDefaultTimeout(parentTimeout);
      ctx.activeTimeout = parentTimeout;
    }
  }

  // Downgrade optional failures — mirrors playwright-engine.ts:201-204
  if (step.options?.optional && (result.status === "failed" || result.status === "error")) {
    result.error = `[optional] ${result.error ?? "step failed"}`;
    result.status = "passed";
  }
  results.push(result);

  // Track the first non-optional failure for aggregate reporting
  if (result.status === "failed" || result.status === "error") {
    if (firstFailure === null) firstFailure = { status: result.status, error: result.error };
    if (!options.continueOnError) {
      return { status: result.status, error: result.error, results };
    }
    // continueOnError: true — keep iterating so remaining steps still run
  }
}

// Reached end of the loop (either all passed, or continueOnError swallowed failures)
if (firstFailure) return { status: firstFailure.status, error: firstFailure.error, results };
return { status: "passed", results };
```

Invariants:
- Optional child failures always downgrade to `"passed"` with `[optional]` prefix on the error — same as the top-level engine.
- `continueOnError: false` (default): returns on the first non-optional failure. `retry`/`repeat`/`run-flow`/`onFlowStart` see identical semantics to today.
- `continueOnError: true` (teardown): iterates every step, but the aggregate return status still reports the first non-optional failure so a caller that cares can surface it (today's `onFlowComplete` wrapper intentionally ignores the return — see 1.6 Part B).

Helper signature — add an options bag to handle both "stop on first failure" (retry/repeat/run-flow, onFlowStart) and "best-effort keep going" (onFlowComplete teardown):

```ts
export async function executeNestedSteps(
  steps: Step[] | NormalizedStep[],
  page: Page,
  ctx: ExecutionContext,
  options: { continueOnError?: boolean } = {},
): Promise<{ status: "passed" | "failed" | "error"; error?: string; results: StepResult[] }>
```

- Default `continueOnError: false` preserves stop-on-first-failure for retry/repeat/run-flow/onFlowStart.
- Aggregate return `status`: `"passed"` iff no non-optional failure occurred; otherwise the first failure's status (even if the loop kept running).
- With `continueOnError: true`, the loop does not `return` on failure — it pushes the error result and continues to the next step. Used only at `onFlowComplete`.

This also makes `retry.ts`/`repeat.ts`/`run-flow.ts` resilient to handler throws. `onFlowComplete` preserves best-effort semantics via the outer try/catch at the engine site (1.5).

### 1.2 Wire the context (one time)

**File:** `cli/src/executor/context.ts` — per 1.1: add `readonly defaultTimeout: number` AND mutable `activeTimeout: number`. Both constructor params; default both to `30_000` if not supplied.

**File:** `cli/src/executor/playwright-engine.ts:113-119` — pass the **effective per-flow timeout** `input.timeout ?? this.options.timeout ?? 30_000` (same formula the engine uses at line 94/188) into the `ExecutionContext` constructor. Both `defaultTimeout` and `activeTimeout` start at that value. Composite steps then correctly restore nested children to the active value, not the engine default.

### 1.3 Migrate `retry.ts`

**File:** `cli/src/executor/step-handlers/retry.ts`

Replace the inline loop (lines 32-75) with a thin wrapper that calls the helper once per attempt. Retry owns only the attempt loop; `when`/`optional`/`timeout` enforcement is the helper's responsibility:

```ts
for (let attempt = 0; attempt <= maxRetries; attempt++) {
  const { status } = await executeNestedSteps(normalized, page, ctx);  // default: continueOnError: false
  if (status === "passed") return { command: "retry", args, status: "passed", duration_ms };
  if (attempt === maxRetries) return { /* exhausted */ };
}
```

### 1.4 Migrate `repeat.ts`

**File:** `cli/src/executor/step-handlers/repeat.ts`

Current loop (lines 45-60) has zero `when`/`optional`/`timeout` support. Replace the inner loop with `executeNestedSteps(normalized, page, ctx)` — no extra timeout arg, helper consults `ctx.activeTimeout` internally (1.1). Keep the outer `while` check (line 39) — that's repeat-specific semantics, not per-step.

### 1.5 Fix `run-flow.ts` option-stripping bug + migrate

**File:** `cli/src/executor/step-handlers/run-flow.ts`

Lines 60-65 today:
```ts
steps = parsed.commands.map((s) => {
  const n = normalizeStep(s);
  return { command: n.command, args: n.args };  // options lost
});
```

Fix: keep the normalized step whole. Replace the inline execution loop (lines 96-117) with `executeNestedSteps(normalized, page, ctx)`. Preserves `when`/`timeout`/`optional` for inline commands.

### 1.6 Route hooks through `executeNestedSteps`

Two replacements in `cli/src/executor/playwright-engine.ts`.

Current semantics (preserve both):
- `onFlowStart` at lines 131-148: if a hook returns `failed`/`error`, the loop `break`s so later onFlowStart hooks are skipped; the flow body still runs.
- `onFlowComplete` at lines 229-247: every teardown hook runs regardless of earlier failures; thrown handlers are swallowed.

**Part A — `onFlowStart`:**
```ts
if (input.onFlowStart?.length) {
  const hookResult = await executeNestedSteps(input.onFlowStart, page, ctx);
  // Default continueOnError: false — helper stops on first non-optional failure,
  // matching the existing `break` at playwright-engine.ts:145.
  if (hookResult.status !== "passed") {
    logger.warn(`onFlowStart hook failed: ${hookResult.error ?? "unknown"}`);
    // Flow body still runs (matches current behavior — no early return here).
  }
}
```

**Part B — `onFlowComplete` at lines 229-248.** Current semantics: (1) every hook runs even if an earlier one fails; (2) thrown handlers are swallowed. Both must survive the migration. Use the helper with `continueOnError: true`:
```ts
if (input.onFlowComplete?.length) {
  try {
    await executeNestedSteps(input.onFlowComplete, page, ctx, { continueOnError: true });
    // Intentionally ignore the return status — teardown failure must not mask the flow result.
  } catch {
    // executeNestedSteps converts handler throws to error results internally (1.1),
    // but keep this outer catch as a belt-and-braces guard.
  }
}
```

This preserves the "all hooks run, errors swallowed" invariant of lines 229-247 while still honoring `when`/`timeout`/`optional` on teardown steps.

### 1.7 Fix `mcp.ts`: preserve step options AND merge workspace hooks

**File:** `cli/src/commands/mcp.ts:260-281`

Two bugs at this one call site:

**(a) `stepToCommand` strips `options`.** Replace the `flowToInput.steps` mapping at line 274 with `flow.steps.map(normalizeStep)` (which already preserves options). Change `FlowInput.steps` in `types.ts` to `NormalizedStep[]`; update the engine's step dispatch at `playwright-engine.ts:152-182` to read from `NormalizedStep` (it already reads `.options` — just align the type). Verify `test.ts` already uses `normalizeStep` (prior audit confirmed this).

**(b) `flowToInput` ignores `config.hooks` AND `config.env`.** The CLI path in `cli/src/commands/test.ts` already merges workspace-level settings:
- Hooks: `config.hooks.onFlowStart` runs before `flow.metadata.onFlowStart` (same for `onFlowComplete`).
- Env: `config.env` is merged with `flow.metadata.env`, flow-level keys taking precedence (`test.ts:479`).

MCP `flowToInput` today pulls both from `flow.metadata` only (`mcp.ts:274,278`). Change it to accept `config.hooks` and `config.env` and merge identically:

```ts
function flowToInput(
  flow: ResolvedFlow,
  baseUrl: string,
  hooks: HooksConfig,
  workspaceEnv: Record<string, string>,
): FlowInput {
  return {
    // ...unchanged fields...
    steps: flow.steps.map(normalizeStep),
    onFlowStart: [
      ...hooks.onFlowStart.map(normalizeStep),
      ...(flow.metadata.onFlowStart?.map(normalizeStep) ?? []),
    ],
    onFlowComplete: [
      ...hooks.onFlowComplete.map(normalizeStep),
      ...(flow.metadata.onFlowComplete?.map(normalizeStep) ?? []),
    ],
    env: { ...workspaceEnv, ...(flow.metadata.env ?? {}) },   // flow-level overrides workspace, matches CLI precedence
  };
}
```

Load config at the `handleRunFlow` / `handleRunTest` entry (already specified in 2.7) and pass `config.hooks` + `config.env` into each `flowToInput` call. After these changes, CLI and MCP entry points treat hooks, base URL, and env identically. Add a regression test to 5.1 for the env merge path via the MCP `flowToInput` export.

### 1.8 Test: `cli/__tests__/unit/executor/retry-handler.test.ts`

- Passes without retry
- Passes on 2nd attempt
- Exhausts retries → returns `"exhausted N retries"`
- Nested `when: false` → skipped
- Nested `optional: true` → failure downgraded to passed
- Nested `timeout: 500` → `page.context().setDefaultTimeout` called with `500` then restored to `ctx.activeTimeout` (the parent's value) in `finally`, even when the handler throws (use a mock handler that throws; verify `setDefaultTimeout` called twice — once with `500`, once with the parent value).
- **Composite-timeout regression test**: a `retry` step with `options.timeout: 5000` wrapping two children (first has `timeout: 1000`, second has no timeout) — assert that during the second child's execution the PW default is `5000`, not the flow default. Simulate by passing `defaultTimeout: 30000` to the context, setting `ctx.activeTimeout = 5000` before calling the helper (imitating the engine's setup), and spying on `setDefaultTimeout`.
- `timeout: 0` is banned via schema (see 1.2b below); the helper still uses `!== undefined` as an extra guard.

### 1.2b Ban `timeout: 0` at the schema boundary

Decision: `0` is nonsensical for any timeout we accept (Playwright interprets it as "no timeout", which is dangerous in CI and trivially misused). Enforce `.positive()` in three schemas so downstream code can stop worrying about the zero case:

- `cli/src/parser/flow-schema.ts:239` (step `options.timeout`): `z.number().positive()`
- `cli/src/parser/flow-schema.ts:277` (flow `metadata.timeout`): `z.number().positive()`
- `cli/src/config/schema.ts:11` (browser/engine timeout): `z.number().positive()`

With `0` rejected at parse time, `ctx.activeTimeout` can never be `0`, the engine's existing truthy-style flow-timeout application at `playwright-engine.ts:94` stays correct, and the nested-executor's `!== undefined` guard remains a safety net rather than a necessity. Add a parser test asserting `safeParse({ metadata: { timeout: 0 } })` fails.

Idiom: `cli/__tests__/unit/executor/step-handlers.test.ts:7-33`.

---

## Phase 2 — Finish AI client injection (multi-provider safe)

### 2.1 Fix factory defaults + env-var fallback (**the bug Codex flagged**)

**File:** `cli/src/config/schema.ts:60-82`

Two changes:

1. Remove the Gemini-specific default for `model` (per-provider default now lives in the factory):
```ts
const AIConfigSchema = z.object({
  provider: z.enum(["gemini", "openai", "anthropic"]).default("gemini"),
  apiKey: z.string().optional(),
  model: z.string().optional(),                 // was: .default("gemini-2.5-flash")
  maxRequestsPerMinute: z.number().default(55),
  baseBranch: z.string().default("main"),
  excludePaths: z.array(z.string()).default(["*.env*", "secrets/", "*.key", "*.pem"]),
});
```

2. **Change `ai: AIConfigSchema.optional()` at line 79 → `ai: AIConfigSchema.default({})`.**
   Reason: a user with only `GEMINI_API_KEY` set and no `skeptic.config.yaml` `ai` block expects it to "just work". With `.optional()`, `loadConfig()` returns `config.ai === undefined` → factory returns `undefined` → step errors. With `.default({})`, zod fills in `{ provider: "gemini", maxRequestsPerMinute: 55, baseBranch: "main", excludePaths: [...] }`; the factory then picks up `GEMINI_API_KEY` and returns a working `GeminiClient`. Preserves env-only backwards compatibility while still letting users override via config.

**File:** `cli/src/ai/client-factory.ts`

Two fixes:
1. Env-var fallback must not cross providers. Read only the provider-specific env var:
```ts
const envKeyName = {
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
}[config.provider];
const apiKey = config.apiKey ?? process.env[envKeyName];
```
2. Provider-specific model defaults when `config.model` is undefined:
```ts
const defaultModel = {
  gemini: "gemini-2.5-flash",
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-20250514",
}[config.provider];
const model = config.model ?? defaultModel;
```

### 2.2 Declare `GeminiClient implements AIClient` + expose provider

**File:** `cli/src/ai/ai-client.ts`

Extend the interface to expose provider metadata (needed for warnings and consent):
```ts
export type AIProvider = "gemini" | "openai" | "anthropic";

export interface AIClient {
  readonly provider: AIProvider;
  analyzeImage(imageBuffer: Buffer, prompt: string, temperature?: number): Promise<string>;
  generateText(prompt: string, system?: string, temperature?: number): Promise<string>;
}
```

**Files:** `cli/src/ai/gemini-client.ts:4`, `cli/src/ai/openai-client.ts:3`, `cli/src/ai/anthropic-client.ts:3`

- Declare `implements AIClient` (only Gemini currently doesn't).
- Add `readonly provider: AIProvider = "gemini" | "openai" | "anthropic"` respectively. Initialize in constructor (no extra param needed).

### 2.3 Retype `assertion-evaluator.ts` to `AIClient`

**File:** `cli/src/ai/assertion-evaluator.ts`

Replace `GeminiClient` with `AIClient` on all four exported functions (`evaluateAssertion` line 11, `evaluateDefects` line 21, `extractText` line 29, `analyzeFailure` line 43). Change import from `./gemini-client.js` → `./ai-client.js`.

### 2.4 Generalize `security.ts` (per-provider, error-class)

**File:** `cli/src/ai/security.ts`

- `checkAIEnabled(client: AIClient | undefined): void` — throws if `client == null`. Message: `"AI features require an API key. Set ${envKeyName} or configure ai.apiKey."` (compute `envKeyName` from provider when client exists; generic message when absent).
- `firstUseWarning(provider: AIProvider): void` — per-provider consent file: `` `.skeptic/.ai-consent-${provider}` ``. Warning text: `"${PRODUCT_NAME} AI features will send screenshots and prompts to ${provider} (${providerHostname}). Data may leave your machine."` where `providerHostname` is `"generativelanguage.googleapis.com" | "api.openai.com" | "api.anthropic.com"`.
- Keep `filterDiffPaths` and `takeRedactedScreenshot` unchanged.

**File:** `cli/__tests__/unit/ai/security.test.ts`

The existing file (`:7-23`) hardcodes `"AI features require a Gemini API key"`. Update to the new signature and message. Add tests for per-provider consent: separate file per provider, one warning each.

### 2.5 Step handlers use `ctx.aiClient` (with `status: "error"`)

**Files:**
- `cli/src/executor/step-handlers/assert-with-ai.ts:44-48`
- `cli/src/executor/step-handlers/assert-no-defects.ts:29-33`
- `cli/src/executor/step-handlers/extract-text-ai.ts:46-50`

Replace the env-var read + `new GeminiClient(...)` with — **using the shared `missingClientMessage` helper from 2.7a** and preserving the consent warning that exists today at `assert-with-ai.ts:46`, `assert-no-defects.ts:31`, `extract-text-ai.ts:48`:

```ts
import { checkAIEnabled, firstUseWarning, missingClientMessage } from "../../ai/security.js";

// ...inside handler...
if (!ctx.aiClient) {
  return {
    command: "<name>",
    args,
    status: "error",       // setup/config issue, not a test failure
    duration_ms: Math.round(performance.now() - start),
    error: missingClientMessage({ provider: ctx.aiProvider }),   // provider-aware per 2.7a
  };
}
const client = ctx.aiClient;
checkAIEnabled(client);                      // no-op if client is defined
firstUseWarning(client.provider);            // per-provider consent file (from 2.4)
```

Remove the `GeminiClient` import and the `process.env["GEMINI_API_KEY"]` read. Calls into `assertion-evaluator` already match `AIClient` after 2.3.

### 2.6 `test.ts`: build and pass `aiClient`; fix `--analyze`

**File:** `cli/src/commands/test.ts`

- Near line 189 (before `engineOpts` construction), call `const aiClient = await createAIClient(config.ai);`. Import `createAIClient` from `../ai/client-factory.js`.
- Add `aiClient` to `EngineOptions`.
- `--analyze` path at line 365-394: replace `new GeminiClient(...)` at line 369 with `aiClient ?? (await createAIClient(config.ai))`. `--analyze` is an **optional diagnostic** (see 2.7a delivery table) — if still `undefined`, call `logger.warn(missingClientMessage(config.ai))` and skip the analysis. **Do not set `process.exitCode`** and do not crash the test run.
- Also set `aiProvider: config.ai.provider` on `EngineOptions` (per 2.7a `aiProvider` threading), so step handlers still produce provider-aware errors even when `aiClient` is absent.

### 2.7 `mcp.ts`: wire `aiClient` through all three handlers

**File:** `cli/src/commands/mcp.ts`

Today none of the three handlers have `config` in scope. Add `loadConfig()` inside each handler (the only source of the `ai`, `hooks`, and `url` settings):

```ts
import { loadConfig } from "../config/loader.js";
import { createAIClient } from "../ai/client-factory.js";
```

- `handleRunFlow` (starts ~line 120) and `handleRunTest` (starts ~line 145):
  - `const config = loadConfig();`
  - `const aiClient = await createAIClient(config.ai);`
  - **`const baseUrl = (args["baseUrl"] as string) ?? config.url ?? "";`** — matches the CLI path at `test.ts:83` (currently `mcp.ts:121,146` falls back to `""`, which breaks relative URLs for MCP callers that don't pass `baseUrl`).
  - Pass `config.hooks` AND `config.env` into each `flowToInput()` call (per 1.7b).
  - Include `aiClient` and `aiProvider: config.ai.provider` in the `EngineOptions` passed to `PlaywrightEngine` at lines 126, 153.
- `handleGenerateFlow` (lines 180-198):
  - `const config = loadConfig();`
  - **`const baseUrl = (args["baseUrl"] as string) ?? config.url ?? "http://localhost:3000";`** (matching CLI generate.ts:26 — current code at mcp.ts:183 skips `config.url`).
  - `const client = await createAIClient(config.ai);` (instead of reading `GEMINI_API_KEY` at line 185 and `new GeminiClient(apiKey)` at line 192)
  - If `!client`: `return { content: [{ type: "text", text: missingClientMessage(config.ai) }], isError: true };` (matches 2.7a delivery table)
- Drop the `GEMINI_API_KEY` reads at lines 185-187.

### 2.6a Wire `skeptic generate --model` override

Today `cli/src/index.ts:90` defines `--model <model>` with a hardcoded Commander default of `"gemini-2.5-flash"`, but `cli/src/commands/generate.ts` never reads `opts.model`. The flag is silently ignored. Worse — if someone wires `opts.model` naively after 2.1, the Commander default would force a Gemini model on an `openai`/`anthropic` provider.

Two changes:
- **`cli/src/index.ts:90`** — remove the hardcoded default: `.option("--model <model>", "AI model to use (overrides ai.model in config)")`. Commander now returns `undefined` when the flag is omitted.
- **`cli/src/commands/generate.ts:24-28`** — merge `opts.model` into the AI config before building the client:
  ```ts
  const aiConfig = opts.model ? { ...config.ai, model: opts.model } : config.ai;
  const client = await createAIClient(aiConfig);
  ```
  (Defers to `config.ai.model` when `--model` absent; factory's per-provider default kicks in if both are absent.)

Add a command-level test in `cli/__tests__/unit/commands/generate.test.ts` (existing file — extend, don't duplicate): invoke `runGenerate({ message: "X", model: "gpt-4o-mini", config: <mock with provider: openai> })`, mock `createAIClient`, assert it was called with `{ provider: "openai", model: "gpt-4o-mini", ... }`.

### 2.7a Consistent provider-aware "missing API key" message

The message body is unified across all callers; only the delivery differs per entry point (required vs optional AI).

**File:** `cli/src/ai/security.ts` — export a shared helper:
```ts
export function missingClientMessage(ai?: { provider?: AIProvider }): string {
  const provider = ai?.provider ?? "gemini";
  const envKey = { gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" }[provider];
  return (
    `No API key configured for provider "${provider}". ` +
    `Set ${envKey} in your environment, or ai.apiKey in skeptic.config.yaml. ` +
    `To switch providers, set ai.provider (gemini | openai | anthropic) in config.`
  );
}
```

**Delivery per entry point:**

| Site | AI required? | Behavior when client is `undefined` |
|------|--------------|-------------------------------------|
| `cli/src/commands/generate.ts` | Yes | `logger.error(missingClientMessage(config.ai)); process.exitCode = 1; return;` |
| `cli/src/commands/mcp.ts` `handleGenerateFlow` | Yes | `return { content: [{ type: "text", text: missingClientMessage(config.ai) }], isError: true };` |
| `cli/src/commands/test.ts` `--analyze` | **No** (optional diagnostic) | `logger.warn(missingClientMessage(config.ai)); /* skip analysis, no exit code */` |
| Step handlers (`assert-with-ai.ts` etc.) via `ctx.aiClient` check | Yes for that step | Return `StepResult` with `status: "error"`, `error: missingClientMessage({ provider: ctx.aiProvider })`. |

**Thread `aiProvider` into the context independently of the client** so the step-handler message is still accurate when the configured provider is `openai`/`anthropic` but no key is set (factory returned `undefined`). Otherwise the step handler would default to `"gemini"` and tell the user to set `GEMINI_API_KEY`, which is wrong.

Changes:
- `cli/src/executor/types.ts` `EngineOptions` — add `aiProvider?: AIProvider` (separate from `aiClient`).
- `cli/src/executor/context.ts` — add `readonly aiProvider?: AIProvider` property; constructor accepts it alongside `aiClient`.
- `cli/src/executor/playwright-engine.ts:113-119` — pass `this.options.aiProvider` into the `ExecutionContext` constructor.
- `cli/src/commands/test.ts` and `cli/src/commands/mcp.ts` — when building `EngineOptions`, set `aiProvider: config.ai.provider` (always populated because `ai` now defaults to `{ provider: "gemini", ... }` per 2.1). This is independent of whether `aiClient` is defined.

Single source of truth for the error text; tests 2.8 and 5.9 import `missingClientMessage` and assert substring rather than matching whole strings twice. Add a step-handler test case: `ai.provider: "openai"` + no `OPENAI_API_KEY` → step returns `status: "error"` with message containing `"provider \"openai\""` and `"OPENAI_API_KEY"`, **not** `"GEMINI_API_KEY"`.

### 2.8 Tests: client-factory + provider clients

**Files (new):**
- `cli/__tests__/unit/ai/client-factory.test.ts` — cases:
  - `provider: "openai"` + `OPENAI_API_KEY` env → returns `OpenAIClient`, passes model `"gpt-4o"` when `config.model` absent
  - `provider: "anthropic"` + `ANTHROPIC_API_KEY` → returns `AnthropicClient`, default model `"claude-sonnet-4-20250514"`
  - `provider: "gemini"` + `GEMINI_API_KEY` → returns `GeminiClient`, default model `"gemini-2.5-flash"`
  - `provider: "openai"` with `GEMINI_API_KEY` set but no `OPENAI_API_KEY` → returns `undefined` (no cross-provider fallback)
  - `config === undefined` → returns `undefined`
  - Verify `stub.env` / `vi.stubEnv` semantics; restore after each test
  - **Does NOT assert "throws on bad provider"** — factory returns `undefined` via zod-validated enum
- `cli/__tests__/unit/ai/openai-client.test.ts` — mock `global.fetch`:
  - `analyzeImage` POSTs to `https://api.openai.com/v1/chat/completions` with `Authorization: Bearer ${key}`, `model` in body, image payload as `{ type: "image_url", image_url: { url: "data:image/png;base64,..." } }`
  - `generateText` same endpoint with text-only content
- `cli/__tests__/unit/ai/anthropic-client.test.ts` — mock `global.fetch`:
  - `analyzeImage` POSTs to `https://api.anthropic.com/v1/messages` with `x-api-key: ${key}`, `anthropic-version` header, `model`, image content `{ type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }`
  - `generateText` same endpoint with text-only content

Idiom: `cli/__tests__/unit/ai/gemini-client.test.ts`.

---

## Phase 3 — Validated flow generator (keep string API)

Per Codex's alternative and simpler approach: **keep the public API as `string[]`** but validate each chunk internally via `yaml.parseAllDocuments()` + `FlowSchema`. Skip malformed flows with a warning. Filenames continue to use `slugify`/`uniqueSlug`. Avoids cascading refactor of `--message`, print loop, TUI, and `generate.test.ts`.

### 3.1 Validate flows inside `flow-generator.ts`

**File:** `cli/src/ai/flow-generator.ts`

Three fixes to land together; the first two are prerequisites for Fix C to actually work.

**Fix A — Replace `filterDiffPaths` matcher with minimatch.** The current matcher at `cli/src/ai/security.ts:59-85` only supports exact file paths, trailing-`*` prefixes, and `pattern/` directory prefixes. The schema defaults `["*.env*", "secrets/", "*.key", "*.pem"]` at `cli/src/config/schema.ts:68` do **not** match any real file path under the current matcher — `*.env*` → `pattern.slice(0, -1) === "*.env"` → `filePath.startsWith("*.env")` is always `false`. The documented excludePaths behavior silently fails.

Add `minimatch` (already a transitive dep via `glob@^11.0.2` — safe to import directly; alternatively pin it as a direct dep with `^10.0.0`). Rewrite the matcher:

```ts
import { minimatch } from "minimatch";

function normalizePattern(pattern: string): string {
  // Directory patterns ("secrets/") must recurse — minimatch won't match "secrets/tokens.json" against literal "secrets/".
  if (pattern.endsWith("/")) return `${pattern}**`;
  return pattern;
}

export function filterDiffPaths(diff: string, excludePatterns: string[]): string {
  if (excludePatterns.length === 0) return diff;

  const normalized = excludePatterns.map(normalizePattern);
  const lines = diff.split("\n");
  const result: string[] = [];
  let skip = false;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/diff --git a\/(.+) b\/(.+)/);
      const filePath = match?.[2] ?? "";
      skip = normalized.some((pattern) =>
        minimatch(filePath, pattern, { matchBase: true, dot: true }),
      );
    }
    if (!skip) result.push(line);
  }
  return result.join("\n");
}
```

Why each option matters:
- `matchBase: true` — for patterns with **no slash** (`*.env`, `*.key`), matches against the basename (so `app/.env`, `certs/server.key` work). `matchBase` is a no-op for patterns containing `/` — hence the `normalizePattern` step.
- `dot: true` — allows dotfiles like `.env` to match without explicit leading `.`.
- `normalizePattern` — turns `secrets/` into `secrets/**` so `secrets/tokens.json` matches. Leaves pattern-with-magic (`secrets/*.yaml`) alone.

Update `cli/__tests__/unit/ai/security.test.ts` to cover the **actual defaults**: diffs touching `server.env.local`, `certs/api.key`, `deployment.pem`, and `secrets/tokens.json` must all be excluded by the default `excludePaths`. Existing narrow-pattern tests at `:61` can remain but the defaults must pass too.

**Fix B — post-filter empty-diff check.** Today the function early-returns only when the raw `git diff` output is empty (line ~60), BEFORE `filterDiffPaths()`. An all-excluded diff (every changed file matches an `excludePaths` pattern) still proceeds to the LLM with an effectively empty `Code changes:` section, producing unrelated flows. Add a second check after filtering:

```ts
const diff = filterDiffPaths(rawDiff, excludePaths);
if (!diff.trim()) {
  logger.warn("[generate] All changed files excluded by ai.excludePaths — nothing to generate.");
  return [];
}
```

**Fix C — validate and split the LLM output.** Replace lines 82-85 with:
```ts
import { parseAllDocuments } from "yaml";
import { FlowSchema } from "../parser/flow-schema.js";

const chunks = raw
  .split(/^===FLOW_SEPARATOR===$/m)
  .map((s) => s.trim())
  .filter(Boolean);

const valid: string[] = [];
for (const chunk of chunks) {
  try {
    const docs = parseAllDocuments(chunk);
    // Prompt contract: exactly 2 documents (metadata + steps). Reject 0, 1, or 3+ to catch
    // malformed LLM output before it reaches execution.
    if (docs.length !== 2) {
      logger.warn(`[generate] Skipping flow: expected exactly 2 YAML documents, got ${docs.length}`);
      continue;
    }
    // Reject YAML with parse errors (e.g. duplicate keys) BEFORE toJSON, which would silently
    // return a lossy representation. Aggregate across ALL docs — matches flow-parser.ts:27-32
    // which iterates every document.
    const yamlErrors = docs.flatMap((d) => d.errors);
    if (yamlErrors.length > 0) {
      logger.warn(`[generate] Skipping flow with YAML errors: ${yamlErrors[0]!.message}`);
      continue;
    }
    const metadata = docs[0]!.toJSON();
    const steps = docs[1]!.toJSON();
    const parsed = FlowSchema.safeParse({ metadata, steps });
    if (!parsed.success) {
      logger.warn(`[generate] Skipping invalid flow: ${parsed.error.message}`);
      continue;
    }
    valid.push(chunk);
  } catch (err) {
    logger.warn(`[generate] Skipping unparseable flow: ${err instanceof Error ? err.message : String(err)}`);
  }
}
return valid;
```

Apply the same `doc.errors.length > 0` guard to the `generateFromDescription` validation below.

**Also: tighten `GENERATE_FROM_DESCRIPTION_PROMPT`** (`cli/src/ai/prompts.ts:99-132`) to explicitly require a single flow. The current prompt at line 132 says "If generating multiple flows, separate them with `===FLOW_SEPARATOR===`" — incompatible with `generateFromDescription` returning `string` (single flow). Remove that instruction; replace with: `"Respond with ONLY the YAML content for a single flow (one metadata document + one steps document, separated by ---)."`. The diff-prompt retains the multi-flow instruction.

**`generateFromDescription` (single-flow path) keeps its existing `string` return type.** Callers at `cli/src/commands/generate.ts:51` and `cli/src/commands/mcp.ts:193` consume it as a single string. Validate the returned YAML inside the function; on validation failure, `throw new Error("[generate] LLM returned invalid flow: <zod or yaml error>")`.

**`mcp.ts:180-198`** — `handleGenerateFlow` already wraps the body in try/catch and returns `{ isError: true }` (lines 196-198), so it surfaces the throw correctly.

**`cli/src/commands/generate.ts` — add a try/catch in `runGenerate`** around the generator calls (neither `runGenerate` nor `index.ts:93-95` currently catches). Otherwise the rejected promise surfaces as a Commander-level unhandled rejection, not the clean `logger.error` + `process.exitCode = 1` pattern used elsewhere:

```ts
try {
  if (opts.diff) {
    yamlOutputs = await generateFromDiff(client, target, baseUrl, ...);
  } else if (opts.message) {
    const yaml = await generateFromDescription(client, opts.message, baseUrl);
    yamlOutputs = [yaml];
  }
} catch (err) {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
  return;
}
```

### 3.1b Update the commands list the LLM sees

**File:** `cli/src/ai/prompts.ts:90,128`

Both prompts today list only ~20 commands (missing `repeat`, `runFlow`, `setPermissions`, `setLocation`, `travel`, `assertScreenshot`, `assertWithAI`, `assertNoDefects`, `extractTextWithAI`). Test 5.7 will fail without this update. Replace both lines with a single list derived from `COMMAND_KEYS` minus `runScript`/`evalScript`:

```
Available commands: navigate, click, type, assertVisible, assertNotVisible, assertUrl, assertText, screenshot, wait, waitForElement, scroll, select, press, clearInput, assertWithAI, assertNoDefects, extractTextWithAI, assertScreenshot, runFlow, repeat, setVariable, back, doubleClick, hover, copyTextFrom, retry, scrollUntilVisible, setPermissions, setLocation, travel
```

(30 commands — `COMMAND_KEYS.length === 32` minus `runScript`/`evalScript`.)

**Required:** export a new constant `AI_EXPOSED_COMMANDS` from `cli/src/parser/flow-schema.ts`:
```ts
export const AI_EXPOSED_COMMANDS = COMMAND_KEYS.filter(
  (c) => c !== "runScript" && c !== "evalScript",
) as readonly CommandKey[];
```
Both `GENERATE_FROM_DIFF_PROMPT` and `GENERATE_FROM_DESCRIPTION_PROMPT` build their "Available commands" list by `AI_EXPOSED_COMMANDS.join(", ")`. Test 5.7 imports the same constant. Single source of truth — adding a new command to `COMMAND_KEYS` updates both without touching prompts.

### 3.2 Fix empty-slug edge case in `slug.ts`

**File:** `cli/src/utils/slug.ts:4-9`

`slugify("!!!")` currently returns `""` (the regex replaces all punctuation with `-`, then trims leading/trailing `-`, yielding empty). Today's `generate.ts:99-102` writes `${slug}.yaml`, which becomes `.yaml` — a hidden file — and prints `skeptic test -f ` (empty slug) as the usage hint, which is not a valid command.

Fix inside `slugify`:
```ts
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return base || "flow";    // fallback for punctuation-only or non-ASCII inputs
}
```

`uniqueSlug` already handles collisions, so multiple fallback-to-`"flow"` slugs become `flow`, `flow-2`, `flow-3`. Test 5.8 covers this (`slugify("!!!") === "flow"`, plus collision cases). No caller changes required — `slugify` already neutralizes `/` and `..`, and with this fix it also never returns empty.

### 3.3 TUI unchanged

`generate-review-screen.tsx:21-40` already parses YAML internally and falls back to name-regex on parse errors. Since `flow-generator.ts` now guarantees validated flows, the TUI's fallback path becomes a belt-and-braces safety net — leave it alone.

### 3.4 Test: `cli/__tests__/unit/ai/diff-targets.test.ts`

- Mock `execFileSync` (from `node:child_process`) per `target` mode:
  - `changes` → args `["diff", "-M", "HEAD"]` (fallback to `["diff", "-M", "--cached"]` when empty)
  - `unstaged` → args `["diff", "-M"]`
  - `branch` → first `["merge-base", "HEAD", baseBranch]`, then `["diff", "-M", "<sha>..HEAD"]`
- Mock `AIClient.generateText` to return two valid flows separated by `===FLOW_SEPARATOR===`; assert array length 2.
- Inject a malformed flow (e.g., steps doc missing); assert it's filtered out and a warning is logged (spy `logger.warn`).
- Inject a flow with a YAML document error (duplicate key, e.g. two `click:` in the same step); assert it's filtered out with a "YAML errors" warning — `toJSON()` alone would have accepted it.
- Inject a flow chunk with **three** YAML documents where the third has a syntax error; assert the chunk is rejected. Proves errors are aggregated across all docs and the `docs.length !== 2` guard catches malformed multi-doc output.
- Empty diff → returns `[]`, no LLM call.
- **Non-empty raw diff but `excludePaths` strips everything** → returns `[]`, a "nothing to generate" warning is emitted via `logger.warn`, no LLM call. Construct by mocking `execFileSync` to return a diff touching only `*.env`, with `excludePaths: ["*.env*"]`.

---

## Phase 4 — Faker dependency + visual diff reporter

### 4.1 Add `@faker-js/faker` + clean up sandbox

**File:** `cli/package.json:37-58`

Add `"@faker-js/faker": "^9.0.0"` to `dependencies`. Run `npm install` to regenerate `cli/package-lock.json` (will be committed alongside).

**File:** `cli/src/executor/step-handlers/script-sandbox.ts:29-45`

Replace lazy dynamic-import + proxy with a top-level static import:
```ts
import { faker } from "@faker-js/faker";
```

Remove the try/catch fallback.

### 4.2 Extend `StepResult` with structured diff paths

**File:** `cli/src/executor/types.ts:8-15`

```ts
export interface StepResult {
  command: string;
  args: unknown;
  status: "passed" | "failed" | "error" | "skipped";
  duration_ms: number;
  error?: string;
  screenshot?: string;        // generic failure screenshot (unchanged)
  baselinePath?: string;      // visual assertion baseline (new)
  currentPath?: string;       // visual assertion current frame (new)
  diffPath?: string;          // visual assertion pixel-diff overlay (new)
}
```

### 4.3 `assert-screenshot.ts` populates new fields

**File:** `cli/src/executor/step-handlers/assert-screenshot.ts:119-126`

On visual-regression failure, set all three paths:
```ts
return {
  command: "assertScreenshot",
  args,
  status: "failed",
  duration_ms,
  error: `visual regression: ${(1 - matchRatio).toFixed(3)} difference`,
  baselinePath,
  currentPath,
  diffPath,
  screenshot: diffPath,  // keep for back-compat (existing HTML reporter reads this)
};
```

On first-run baseline write (lines 61-67), set `baselinePath` only (no diff/current yet).

### 4.4 `console-reporter.ts` prints diff location

**File:** `cli/src/reporter/console-reporter.ts`

After the existing error line (line 45 area), when `step.diffPath` is set, append three `chalk.dim` lines:
```
      baseline: <baselinePath>
      current:  <currentPath>
      diff:     <diffPath>
```

Guard on presence of `diffPath`; skip entirely for non-visual failures.

### 4.5 `html-reporter.ts` side-by-side images

**File:** `cli/src/reporter/html-reporter.ts:106-133`

When all three paths present, render a 3-column grid inside the step failure block:
```html
<div class="visual-diff">
  <figure><figcaption>Baseline</figcaption><img src="data:image/png;base64,..."></figure>
  <figure><figcaption>Current</figcaption><img src="data:image/png;base64,..."></figure>
  <figure><figcaption>Diff</figcaption><img src="data:image/png;base64,..."></figure>
</div>
```

Reuse `readScreenshotBase64()` (`html-reporter.ts:153-162`). Add CSS:
```css
.visual-diff { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; margin-top: 0.5rem; }
.visual-diff figure { margin: 0; }
.visual-diff figcaption { font-size: 0.8rem; color: #888; margin-bottom: 0.25rem; }
.visual-diff img { max-width: 100%; border: 1px solid #333; border-radius: 4px; }
```

Fall back to the existing single-image rendering (line 119-124) when only `step.screenshot` is set (non-visual failures).

### 4.6 Test: `cli/__tests__/unit/reporter/visual-diff-reporter.test.ts`

- Console: `assertScreenshot` failure with all three paths → stdout contains each path on its own line.
- Console: `click` failure with only `screenshot` → no diff block.
- HTML: visual regression → output contains three `<figure>` inside `.visual-diff`.
- HTML: generic failure with only `screenshot` → single `<img>` rendered, no `.visual-diff` wrapper.

Idiom: `cli/__tests__/unit/reporter/html-reporter.test.ts`.

---

## Phase 5 — Remaining test coverage

All use vitest idiom from `cli/__tests__/unit/executor/step-handlers.test.ts:1-33`. Tests for 1.8, 2.8, 3.4, 4.6 already covered above. Remaining 9:

### 5.1 `cli/__tests__/unit/config/workspace-hooks.test.ts`

- Parse via `skepticConfigSchema.safeParse({ hooks: { onFlowStart: [...], onFlowComplete: [...] } })` — assert hooks survive unchanged, defaults to empty arrays when `hooks` absent. (`HooksConfigSchema` stays private — `skepticConfigSchema` is sufficient.)
- **Export `flowToInput` from `cli/src/commands/test.ts`** (minimal change — it's a pure function with no side effects; safe to expose).
- Direct unit test on `flowToInput` (exported from `cli/src/commands/test.ts`):
  - config `hooks.onFlowStart = [A]`, flow `metadata.onFlowStart = [B]` → result `onFlowStart` is `[A, B]` (config first) as `NormalizedStep[]`.
  - Same check for `onFlowComplete`.
  - A hook step with `{ click: "#x", timeout: 500, optional: true, when: {...}, label: "l" }` → all four options survive normalization into the resulting `NormalizedStep`.
  - No config hooks, only per-flow hooks → output equals the per-flow list alone.
  - No hooks at all → output hook arrays are `undefined` (or empty — match the current type).
- **MCP regression test** — export MCP's `flowToInput` too (or a module-local test-only export). Assert (1) the same four hook-merge cases above; (2) env merge: workspace `config.env = { A: "1", B: "2" }` + flow `metadata.env = { B: "3", C: "4" }` → result `env = { A: "1", B: "3", C: "4" }` (flow-level wins); (3) when flow has no `metadata.env`, result is workspace env unchanged. Prevents CLI/MCP parity from drifting again.

### 5.2 `cli/__tests__/unit/executor/new-step-handlers.test.ts`
One `describe` per handler:
- `back`: `page.goBack({ waitUntil: "domcontentloaded" })`.
- `doubleClick`: resolved locator's `.dblclick()`.
- `hover`: resolved locator's `.hover()`.
- `copyTextFrom`: default variable `"copiedText"`; explicit `{ selector, variable }` form stores under custom name.

### 5.3 `cli/__tests__/unit/executor/scroll-until-visible.test.ts`
- Element visible on first attempt → no scroll.
- Visible after N scrolls → `page.evaluate` called N times.
- `maxScrolls` exhausted → `failed` with "not found after N scrolls".
- Direction `"up"` → negative delta.

### 5.4 `cli/__tests__/unit/executor/script-sandbox.test.ts`
- `output.foo = "bar"` → `ctx.variables.get("foo") === "bar"`.
- Non-string outputs `JSON.stringify`'d.
- `http.get(url)` returns `{ ok, status, body, headers }` (mock `global.fetch`).
- `faker.internet.email()` returns a string (now synchronous since faker is eager).
- **No** `process.env` access: `typeof process === "undefined"` inside VM, or reference throws.
- **No** `require`: `typeof require === "undefined"`.
- `env` global contains only `ctx.variables` entries.

### 5.5 `cli/__tests__/unit/executor/run-script.test.ts`
- File resolved relative to `ctx.sourceDir` (not `process.cwd`).
- ENOENT file → `failed` with message containing the path.
- Fixtures in `os.tmpdir()` with `beforeEach`/`afterEach` cleanup.

### 5.6 `cli/__tests__/unit/executor/eval-script.test.ts`
- Inline code executes.
- `ctx.interpolate(args)` called so `${var}` works.
- Non-string args → `failed`.

### 5.7 `cli/__tests__/unit/ai/prompts.test.ts`
- `GENERATE_FROM_DIFF_PROMPT` contains: "adversarial QA engineer", "XSS", "SQL injection", "double-submission", "back-button" (already present in current code — lock in with tests).
- Neither prompt mentions `runScript` or `evalScript`.
- Both prompts list every name in `AI_EXPOSED_COMMANDS` (exported from `flow-schema.ts` per 3.1b). Iterate: `for (const cmd of AI_EXPOSED_COMMANDS) expect(prompt).toContain(cmd)`.
- Neither prompt contains the strings `"runScript"` or `"evalScript"`.

### 5.8 `cli/__tests__/unit/utils/slug.test.ts`
Test the current API: `slugify(name: string): string` and `uniqueSlug(name: string, dir: string): string` (after the fallback fix in 3.2).
- `slugify("Login Flow")` → `"login-flow"`.
- `slugify("My  App / Test")` → `"my-app-test"`.
- `slugify("!!!")` → `"flow"` (fallback from 3.2).
- `slugify("🚀")` → `"flow"` (non-ASCII also collapses to empty then falls back).
- `uniqueSlug("login", tmpDir)` where `tmpDir` is empty → `"login"`.
- `uniqueSlug("login", tmpDir)` where `tmpDir/login.yaml` exists → `"login-2"`.
- `uniqueSlug("login", tmpDir)` where both `login.yaml` and `login-2.yaml` exist → `"login-3"`.
- `uniqueSlug("!!!", tmpDir)` with `flow.yaml` already existing → `"flow-2"` (fallback + collision).
- Use `os.mkdtempSync(os.tmpdir() + "/slug-")` with cleanup in `afterEach`.

### 5.9 (existing test update): `cli/__tests__/unit/ai/security.test.ts`
Update for the new signature (`checkAIEnabled(client)`) and generalized message (no hardcoded "Gemini"). Add per-provider consent-file tests. Preserve the TTY-mock pattern at `:26-30`.

---

## Critical Files to Modify

| File | Phase | Change |
|------|-------|--------|
| `cli/src/executor/step-handlers/nested-executor.ts` | 1.1 | Restore via `ctx.activeTimeout`; try/catch/finally; `{ continueOnError }` option |
| `cli/src/executor/context.ts` | 1.2, 2.7a | Add `readonly defaultTimeout` + mutable `activeTimeout`; add `readonly aiProvider?: AIProvider` |
| `cli/src/executor/playwright-engine.ts` | 1.1, 1.2, 1.6 | Pass effective flow timeout; keep `ctx.activeTimeout` in sync around each step; route hooks via helper |
| `cli/src/executor/step-handlers/retry.ts` | 1.3 | Delegate to helper |
| `cli/src/executor/step-handlers/repeat.ts` | 1.4 | Delegate to helper |
| `cli/src/executor/step-handlers/run-flow.ts` | 1.5 | Preserve options, delegate |
| `cli/src/commands/mcp.ts` | 1.7, 2.7 | Preserve options in `flowToInput`; wire `aiClient` |
| `cli/src/executor/types.ts` | 1.7, 4.2 | Widen `FlowInput.steps` to `NormalizedStep[]`; extend `StepResult` |
| `cli/src/ai/client-factory.ts` | 2.1 | Per-provider env + model defaults |
| `cli/src/index.ts` | 2.6a | Remove hardcoded `--model` default on `generate` command |
| `cli/src/commands/generate.ts` | 2.6a, 3.1, 3.2 | Merge `opts.model` into AI config; wrap generator calls in try/catch |
| `cli/__tests__/unit/commands/generate.test.ts` | 2.6a | Extend with `--model` override test |
| `cli/src/ai/ai-client.ts` | 2.2 | Add `provider` to interface |
| `cli/src/ai/gemini-client.ts` | 2.2 | `implements AIClient`, `provider = "gemini"` |
| `cli/src/ai/openai-client.ts` | 2.2 | `provider = "openai"` |
| `cli/src/ai/anthropic-client.ts` | 2.2 | `provider = "anthropic"` |
| `cli/src/ai/assertion-evaluator.ts` | 2.3 | Retype to `AIClient` |
| `cli/src/ai/security.ts` | 2.4, 2.7a, 3.1 Fix A | Per-provider consent; generic message; `missingClientMessage` export; `filterDiffPaths` rewritten with `minimatch` |
| `cli/package.json` | 3.1 Fix A, 4.1 | Add `minimatch ^10.0.0` (currently transitive); add `@faker-js/faker ^9.0.0` |
| `cli/src/executor/step-handlers/assert-with-ai.ts` | 2.5 | `ctx.aiClient`, `status: "error"` |
| `cli/src/executor/step-handlers/assert-no-defects.ts` | 2.5 | `ctx.aiClient`, `status: "error"` |
| `cli/src/executor/step-handlers/extract-text-ai.ts` | 2.5 | `ctx.aiClient`, `status: "error"` |
| `cli/src/commands/test.ts` | 2.6 | Build + pass `aiClient`; fix `--analyze` |
| `cli/src/utils/slug.ts` | 3.2 | `slugify` fallback `|| "flow"` for empty base |
| `cli/src/ai/flow-generator.ts` | 3.1 | `parseAllDocuments` + `doc.errors` guard + `FlowSchema.safeParse` (string API preserved) |
| `cli/src/ai/prompts.ts` | 3.1b | Both prompts build command list via `AI_EXPOSED_COMMANDS.join(", ")` |
| `cli/src/parser/flow-schema.ts` | 1.2b, 3.1b | `.positive()` on step + flow `timeout`; export `AI_EXPOSED_COMMANDS` (required; shared by prompts + test 5.7) |
| `cli/src/config/schema.ts` (browser/engine timeout) | 1.2b, 2.1 | `.positive()` on timeout; `model` optional; `ai: default({})` |
| `cli/package-lock.json` | 3.1 Fix A, 4.1 | regenerated by `npm install` |
| `cli/src/executor/step-handlers/script-sandbox.ts` | 4.1 | Top-level faker import |
| `cli/src/executor/step-handlers/assert-screenshot.ts` | 4.3 | Populate diff paths |
| `cli/src/reporter/console-reporter.ts` | 4.4 | Print diff location |
| `cli/src/reporter/html-reporter.ts` | 4.5 | Side-by-side render |
| `cli/__tests__/unit/ai/security.test.ts` | 5.9 | Update for new signature/message |

Plus 14 new test files under `cli/__tests__/unit/` (1.8, 2.8 ×3, 3.4, 4.6, 5.1–5.8) and 1 updated existing test file (5.9 `security.test.ts`).

---

## Reused Utilities

- `normalizeStep()` — `cli/src/parser/step-normalizer.ts`
- `evaluateCondition()` — `cli/src/executor/condition.ts`
- `stepHandlers` — `cli/src/executor/step-handlers/index.ts`
- `FlowSchema`, `type Flow`, `FlowMetadataSchema` — `cli/src/parser/flow-schema.ts:289-294`
- `parseAllDocuments` from `yaml@^2.7.1` (already a dep)
- `detectCI()` — `cli/src/utils/ci-detect.ts:43`
- `createAIClient()` — `cli/src/ai/client-factory.ts:11`
- `slugify()`, `uniqueSlug()` — `cli/src/utils/slug.ts:4,11` (note: `slugify` collapses `[^a-z0-9]` to `-`, making metadata-derived filenames safe against traversal)
- `readScreenshotBase64()` — `cli/src/reporter/html-reporter.ts:153-162`
- `takeRedactedScreenshot()` — `cli/src/ai/security.ts:48`
- `mockLocator()`, `createMockPage()` idiom — `cli/__tests__/unit/executor/step-handlers.test.ts:7-33`
- TTY/consent mock idiom — `cli/__tests__/unit/ai/security.test.ts:26-30`

---

## Verification

Run after each phase:

```bash
cd cli
npm install            # after Phase 4.1 — regenerates package-lock.json
npm run build          # strict TS compile
npm run check          # tsc --noEmit
npm test               # vitest — all existing + new tests pass
```

**End-to-end smoke tests:**

- **Phase 1:** Flow `retry` block with nested `{ click: "#x", optional: true, timeout: 500 }`. Verify optional failure downgrades, timeout restored after the step (next step sees flow-default). Also a flow with `onFlowStart: [ { navigate: "/login", timeout: 3000 } ]` — hook honors the timeout.
- **Phase 2:** Three `skeptic.config.yaml` variants (`provider: gemini|openai|anthropic`) each with only the matching `*_API_KEY`. Run a flow containing `assertWithAI`. Capture outgoing requests via a mitm / local proxy and confirm each hits the correct provider host with the correct default model. Then swap to a wrong env var (e.g., `provider: openai` + only `GEMINI_API_KEY`) — verify the flow errors with `status: "error"` saying `OPENAI_API_KEY` is missing, not a silent fallback.
- **Phase 3:** `skeptic generate --diff --target branch` against a feature branch. TUI shows each flow by name/step count/tags. Inject a malformed flow via a stubbed LLM response — verify it's dropped with a warning, not rendered.
- **Phase 4:** Flow with `assertScreenshot` against a stale baseline. Console output lists `baseline:` / `current:` / `diff:` paths. Open the generated HTML report — three images render side-by-side. Also `evalScript: "output.email = faker.internet.email()"` followed by `type: { selector: "#email", text: "${email}" }` — the email type-in works.
- **Phase 5:** `npm test` — all 14 new test files and the updated `security.test.ts` pass.
