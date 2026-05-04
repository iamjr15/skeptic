# Plan: Maestro + Expect Feature Adoption

## Context

Competitive analysis of Maestro and Expect identified 18 features and design principles to adopt into skeptic CLI. This plan covers all of them with implementation details verified against the actual codebase. Revised after Codex review (Round 1: 12 findings, Round 2: 6 findings — all addressed).

skeptic CLI v0.1.0 has 21 step commands, 7 CLI commands, ~92 tests. These additions bring the command count to 32.

---

## Cross-Cutting Prerequisites (before any feature)

### P1. Add `sourceDir` to ExecutionContext
**Why:** Multiple features (runScript, config hooks, runFlow improvements) need the source flow file's directory. Currently `ctx.flowDir` is the artifact output dir, and `run-flow.ts:68-69` casts ctx to access a never-set `currentFlowFile`.

**File:** `cli/src/executor/context.ts`
- Add `sourceDir: string` property (directory containing the flow YAML file)
- Set in constructor: `this.sourceDir = sourceDir ?? process.cwd()`

**File:** `cli/src/executor/playwright-engine.ts`
- When creating ExecutionContext, pass `path.dirname(input.file)` as `sourceDir`

**File:** `cli/src/executor/step-handlers/run-flow.ts`
- Replace the `currentFlowFile` cast hack (line 68-69) with `ctx.sourceDir`

### P2. Extract `executeNestedSteps()` helper
**Why:** `retry`, `repeat`, `runFlow` all need to execute nested `Step[]` → normalize → dispatch with full step options support. Currently each does it differently (`repeat.ts` assumes pre-normalized, `run-flow.ts` normalizes inline), and none handle `when`/`timeout`/`optional` which are enforced only in `playwright-engine.ts:133-180`.

**File:** `cli/src/executor/step-handlers/nested-executor.ts` (new)
```ts
import { normalizeStep, type NormalizedStep } from "../../parser/step-normalizer.js";
import { stepHandlers } from "./index.js";
import { evaluateCondition } from "../condition.js";
import type { Step } from "../../parser/flow-schema.js";
import type { Page } from "playwright";
import type { ExecutionContext } from "../context.js";
import type { StepResult } from "../types.js";

export async function executeNestedSteps(
  steps: Step[] | NormalizedStep[],
  page: Page,
  ctx: ExecutionContext,
): Promise<{ status: "passed" | "failed" | "error"; error?: string; results: StepResult[] }>
```
- Accept raw `Step[]` or pre-normalized `NormalizedStep[]`. Detect format and normalize if needed.
- **Replicate engine's single-step execution logic** for each step:
  1. Evaluate `options.when` condition → skip if false
  2. Lookup handler from `stepHandlers[step.command]`
  3. If `options.timeout` set, apply as step-level timeout
  4. Execute handler
  5. If `options.optional` and step failed → downgrade to passed
- Return on first hard failure (non-optional).
- Used by: `retry.ts`, `repeat.ts` (refactor), `run-flow.ts` inline commands.

### P3. Inject AIClient into execution pipeline
**Why:** Step handlers currently instantiate `GeminiClient` directly (verified: `assert-with-ai.ts:43-47`, `assert-no-defects.ts`, `extract-text-ai.ts`). Multi-provider support (F16) requires a provider-agnostic interface injected from config.

**File:** `cli/src/ai/ai-client.ts` (new) — Interface:
```ts
export interface AIClient {
  analyzeImage(imageBuffer: Buffer, prompt: string, temperature?: number): Promise<string>;
  generateText(prompt: string, system?: string, temperature?: number): Promise<string>;
}
```

**File:** `cli/src/ai/client-factory.ts` (new) — Factory: `createAIClient(config: AIConfig): AIClient`

**File:** `cli/src/executor/types.ts` — Add `aiClient?: AIClient` and `trace?: boolean` to `EngineOptions`:
```ts
export interface EngineOptions {
  // ... existing fields ...
  aiClient?: AIClient;
  trace?: boolean;
}
```

**File:** `cli/src/executor/context.ts` — Add optional `aiClient?: AIClient` property

**File:** `cli/src/executor/playwright-engine.ts`
- Accept `aiClient` from `EngineOptions`, pass to `ExecutionContext`
- Accept `trace` from `EngineOptions`; if enabled, call `context.tracing.start()` / `context.tracing.stop()` around flow execution

**File:** `cli/src/commands/test.ts`
- Build `aiClient` from config via `createAIClient(config.ai)` when AI features are needed
- Pass to `EngineOptions` as `aiClient`
- Pass `trace: opts.trace` to `EngineOptions`
- **Update `--analyze` path** (line 323): use `aiClient` from engine options instead of creating separate `GeminiClient`

**File:** `cli/src/commands/mcp.ts`
- Load config in MCP handlers (`handleRunFlow`, `handleRunTest`)
- Build `aiClient` from config, pass to engine
- Thread `config.hooks` through to `flowToInput()`

**File:** `cli/src/executor/runner.ts` — Accept `EngineOptions` (already does), ensure `aiClient` flows through

**Files to update:** `assert-with-ai.ts`, `assert-no-defects.ts`, `extract-text-ai.ts`, `assertion-evaluator.ts` — Use `ctx.aiClient` instead of `new GeminiClient(process.env["GEMINI_API_KEY"]!)`.

**File:** `cli/src/ai/security.ts` — Generalize `checkAIEnabled()` and `firstUseWarning()`:
- `checkAIEnabled(apiKey)` → `checkAIEnabled(client?: AIClient)` — check if client exists/configured, not just Gemini key
- `firstUseWarning()` — make message provider-agnostic ("AI features will send screenshots to an external API") instead of mentioning "Gemini"
- Remove hardcoded `GEMINI_API_KEY` references, rely on `aiClient` being configured

---

## Implementation Phases

### Phase 1: Foundation (no cross-dependencies)

**F1. Workspace-Level Hooks** | P0

Config-level `hooks.onFlowStart`/`onFlowComplete` that apply to ALL flows, running before per-flow hooks.

Files:
- `cli/src/config/schema.ts` — Import `StepSchema` from `../parser/flow-schema.js` (verified: no circular dep — config doesn't import from parser today, and parser doesn't import from config). Add:
  ```ts
  const HooksConfigSchema = z.object({
    onFlowStart: z.array(StepSchema).default([]),
    onFlowComplete: z.array(StepSchema).default([]),
  });
  ```
  Add `hooks: HooksConfigSchema.default({})` to `skepticConfigSchema`.
- `cli/src/commands/test.ts` — Modify `flowToInput()` to accept config hooks. Concatenate with **full NormalizedStep** preservation (timeout, optional, label, when — not just `{command, args}`). Pass `config.hooks` at call sites (~line 188, 228).
- `cli/src/commands/mcp.ts` — Also update mcp.ts's `flowToInput()` to accept and merge config hooks (line ~268).

**Hook execution pipeline (end-to-end):**
1. `cli/src/executor/types.ts` — Change `FlowInput.onFlowStart` and `FlowInput.onFlowComplete` from `Array<{ command: string; args: unknown }>` to `NormalizedStep[]` (import from `step-normalizer.ts`).
2. `cli/src/commands/test.ts` `flowToInput()` — Use `normalizeStep()` on each hook step (config + per-flow), producing `NormalizedStep[]` with full options (timeout, optional, label, when).
3. `cli/src/executor/playwright-engine.ts` — Replace direct handler dispatch for hooks (line ~117) with `executeNestedSteps(input.onFlowStart, page, ctx)` from P2. This ensures hooks respect when/timeout/optional.
4. `cli/src/commands/mcp.ts` — Same: load config, merge hooks via `normalizeStep()`, produce `NormalizedStep[]`.

Test: `cli/__tests__/unit/config/workspace-hooks.test.ts` — parse, validate, merge order, options preservation, hook execution through executeNestedSteps.

---

**F4. Adversarial AI Prompts** | P0

File: `cli/src/ai/prompts.ts`
- Rewrite `GENERATE_FROM_DIFF_PROMPT` (line 56-87): Replace "verify changes work correctly" with:
  ```
  You are an adversarial QA engineer. Your goal is to BREAK the application, not just confirm it works.
  
  For each changed feature, generate test flows that probe:
  - Empty inputs and missing required fields
  - Boundary values (0, -1, MAX_INT, extremely long strings >1000 chars)
  - XSS strings in text inputs (<script>alert(1)</script>)
  - SQL injection patterns in search/filter fields  
  - Double-submission (click submit twice rapidly)
  - Back-button mid-flow (navigate back during multi-step processes)
  - Invalid data formats (wrong email, future dates, unicode, emoji)
  - State corruption (skip required steps, revisit completed steps)
  
  ALSO generate one happy-path flow verifying the core functionality.
  Prioritize error handling and edge cases over happy-path tests.
  ```
- Rewrite `GENERATE_FROM_DESCRIPTION_PROMPT` (line 89-113) with same adversarial treatment.
- Update available commands list in both prompts to include all new step types (back, doubleClick, hover, etc.)
- **Do NOT include `runScript`/`evalScript` in AI prompts** — these are trusted-only, not for AI generation.

Test: `cli/__tests__/unit/ai/prompts.test.ts` — verify prompts contain adversarial keywords, don't mention runScript.

---

**F8. New Step Types: back, doubleClick, hover, copyTextFrom** | P1

Four small handlers following the `click.ts` pattern.

New files:
- `cli/src/executor/step-handlers/back.ts` — `page.goBack({ waitUntil: "domcontentloaded" })`. Args: `boolean` (just a trigger).
- `cli/src/executor/step-handlers/double-click.ts` — Same as click but `element.dblclick()`. Args: `string` (selector).
- `cli/src/executor/step-handlers/hover.ts` — Same as click but `element.hover()`. Args: `string` (selector).
- `cli/src/executor/step-handlers/copy-text-from.ts` — Resolve element, `element.textContent()`, store in `ctx.setVariable(variable, text)`. Args: `string | { selector: string; variable?: string }`. Default variable: `"copiedText"`.

Schema: `cli/src/parser/flow-schema.ts` — Add to `COMMAND_KEYS`, `Step` interface, `StepSchema`.
Registry: `cli/src/executor/step-handlers/index.ts` — Register with dashed + camelCase aliases.

Test: `cli/__tests__/unit/executor/new-step-handlers.test.ts`

---

**F9. Visual Regression Diff Images** | P1 (verification + reporter enhancement)

Current `assert-screenshot.ts` already generates `diff-*.png` and `current-*.png` and sets `result.screenshot`. Enhancements:

- `cli/src/reporter/console-reporter.ts` — Print diff path for `assert-screenshot` failures.
- `cli/src/reporter/html-reporter.ts` — Show baseline + current + diff images side-by-side for `assert-screenshot` failures. Look for `current-` file alongside the `diff-` path.

Test: `cli/__tests__/unit/reporter/console-reporter.test.ts` — add case for screenshot path display.
Test: `cli/__tests__/unit/reporter/html-reporter.test.ts` — add case for side-by-side rendering.

---

### Phase 2: Core Commands

**F2. Step-Level retry Block** | P0

New file: `cli/src/executor/step-handlers/retry.ts`

Uses `executeNestedSteps()` from P2, following the `run-flow.ts` normalization pattern (NOT `repeat.ts`).

```
Interface: { maxRetries: number; commands: Step[] }

Algorithm:
  Normalize commands via normalizeStep() (like run-flow.ts:62-64)
  for attempt = 0 to maxRetries:
    for each normalized step:
      result = handler(page, ctx, step.args)
      if failed/error:
        if attempt < maxRetries: break inner, continue outer (retry)
        else: return failure with "exhausted N retries"
    if all passed: return passed (break outer)
```

Schema: Add `"retry"` to `COMMAND_KEYS`. Add `retry?: { maxRetries: number; commands: Step[] }` with `maxRetries` validated as `z.number().min(1).max(10).default(3)`.

Test: `cli/__tests__/unit/executor/retry-handler.test.ts` — success without retry, success on 2nd attempt, exhausted retries, nested step normalization.

---

**F3. Diff-Aware --target Modes** | P0

CLI changes:
- `cli/src/index.ts` — Change `generate` command: make `--diff` a boolean flag (no optional arg). Add `.option("--target <mode>", "diff scope: changes, unstaged, branch", "changes")`.
- `cli/src/commands/generate.ts` — Update to use `opts.diff` as boolean + `opts.target` as mode. Pass `target` to `generateFromDiff()`.

Core changes in `cli/src/ai/flow-generator.ts`:
- Rewrite `generateFromDiff()` signature: `(client, target, baseUrl, baseBranch, excludePaths)`
- **Use `execFileSync("git", [...args])` instead of `execSync()`** — prevents command injection from user-controlled refs.
- Three branches:
  - `"changes"`: `execFileSync("git", ["diff", "-M", "HEAD"])`. Fallback to `["diff", "-M", "--cached"]`.
  - `"unstaged"`: `execFileSync("git", ["diff", "-M"])` (working tree only).
  - `"branch"`: `execFileSync("git", ["merge-base", "HEAD", baseBranch])` then `execFileSync("git", ["diff", "-M", mergeBase + "..HEAD"])`.
- **Fix flow splitting**: Replace naive `split(/^---$/m)` (line 76) with proper YAML multi-document parsing using the `yaml` package's `parseAllDocuments()`. Each flow is a pair of documents (metadata + steps). Parse into validated flow objects, then serialize back to YAML strings for output.

Test: `cli/__tests__/unit/ai/diff-targets.test.ts` — mock `execFileSync`, verify correct args per mode. Also test YAML parsing of multi-flow output.

---

**F6. scrollUntilVisible** | P1

New file: `cli/src/executor/step-handlers/scroll-until-visible.ts`
```
Args: string | { selector, direction?: "up"|"down", maxScrolls?: number, scrollAmount?: number }
Defaults: direction="down", maxScrolls=20, scrollAmount=300

Algorithm:
  for i = 0 to maxScrolls:
    try resolveElement(page, selector) with 500ms timeout
    if element.isVisible(): store ctx.lastElement, return passed
    else: page.evaluate(window.scrollBy(0, ±scrollAmount))
    wait 200ms for lazy content
  return failed("element not found after N scrolls")
```

Schema: Add `"scrollUntilVisible"` to `COMMAND_KEYS`. Register with both aliases.

Test: `cli/__tests__/unit/executor/scroll-until-visible.test.ts`

---

**F12. executionOrder Config** | P2

Simplified per Codex feedback — no `continueOnFailure` (use existing `bail` instead).

- `cli/src/config/schema.ts` — Add to `ExecutionConfigSchema`:
  ```ts
  flowsOrder: z.array(z.string()).default([])  // file paths, not names
  ```
- `cli/src/commands/test.ts` — After `filterFlows()`, sort flows:
  - Normalize `flowsOrder` entries: `config.execution.flowsOrder.map(p => path.resolve(configDir, p))` to produce absolute paths matching `flow.file` from `glob-resolver.ts:20`
  - Place `flowsOrder` entries first (in specified order), then remaining flows in original order
  - When `parallel > 1`, `flowsOrder` only controls queue insertion order (actual execution order depends on worker availability)

---

**F13. Browser Permissions** | P2

New file: `cli/src/executor/step-handlers/set-permissions.ts`
- Args: `string[]` (permissions to grant) or `Record<string, "allow" | "deny">`
- **Track granted permissions** in `ctx.setVariable("__grantedPermissions", JSON.stringify(granted))` 
- For "allow": add to tracked set, call `page.context().grantPermissions([...fullSet])`
- For "deny": remove from tracked set, `page.context().clearPermissions()`, re-grant remaining

Schema: Add `"setPermissions"` to `COMMAND_KEYS`.

---

**F14. Geolocation Mocking** | P2

New file: `cli/src/executor/step-handlers/set-location.ts`
- Args: `{ latitude: number; longitude: number; accuracy?: number }`
- Auto-grant geolocation permission + set location via `page.context().setGeolocation()`

Schema: Add `"setLocation"` to `COMMAND_KEYS`.

---

**F15. Clock Manipulation** | P2

New file: `cli/src/executor/step-handlers/travel.ts`
- Args: string — two explicit modes:
  - **Absolute**: ISO 8601 string → `page.clock.install({ time: parsed })` on first use, `page.clock.setFixedTime(parsed)` on subsequent
  - **Relative**: `"+2h"`, `"+30m"`, `"+1d"` → `page.clock.fastForward(ms)` (requires clock to be installed first; auto-install with current time if not yet installed)
- **Track clock state** in context: `ctx.setVariable("__clockInstalled", "true")` and `ctx.setVariable("__clockTime", isoString)` for chained relative travel

Schema: Add `"travel"` to `COMMAND_KEYS`.

Duration parser:
```ts
function parseDuration(input: string): number {
  const match = input.match(/^\+(\d+)([smhd])$/);
  if (!match) throw new Error(`Invalid duration: ${input}`);
  const [, val, unit] = match;
  const mult: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return parseInt(val!) * mult[unit!]!;
}
```

---

### Phase 3: JavaScript & AI

**F5. JavaScript Integration (runScript / evalScript)** | P1

**Security model (revised per Codex):**
- Scripts are **trusted-only** — user-authored flows, NOT AI-generated
- Do NOT expose full `process.env` — only flow-scoped `ctx.variables` + explicitly configured `config.env`
- Do NOT advertise `runScript`/`evalScript` in AI generation prompts
- Use `node:vm` with clear documentation that it's a convenience sandbox, not a security boundary

NPM dep: `@faker-js/faker ^9.0.0`

New files:

1. `cli/src/executor/step-handlers/script-sandbox.ts`
   ```ts
   export async function executeScript(
     code: string, page: Page, ctx: ExecutionContext
   ): Promise<Record<string, string>>
   ```
   - Build globals:
     - `output`: plain object from `ctx.variables` (Map → Object)
     - `http`: fetch wrapper with `{ get, post, put, delete }` returning `{ ok, status, body, headers }`
     - `faker`: synchronously `require("@faker-js/faker").faker` (top-level import, not lazy)
     - `env`: `Object.fromEntries(ctx.variables)` only (NO `process.env`)
   - Use `vm.createContext({ output, http, faker, env, console: { log: noop, warn: noop } })`
   - Wrap code in async IIFE: `(async () => { ${code} })()`
   - Execute with `vm.runInContext()`, await the Promise
   - Write back `output` keys to `ctx.variables` (stringify non-string values)
   - `variables` remains `Map<string, string>` — serialize objects with `JSON.stringify()`

2. `cli/src/executor/step-handlers/run-script.ts`
   - Args: string (file path). Resolve relative to **`ctx.sourceDir`** (P1 prerequisite).
   - Read file with `fs.readFileSync()`, pass to `executeScript()`.

3. `cli/src/executor/step-handlers/eval-script.ts`
   - Args: string (inline JS code). Pass directly to `executeScript()`.

Schema: Add `"runScript"` and `"evalScript"` to `COMMAND_KEYS`.

**F10 (Faker in YAML) — DROPPED.** Per Codex review, `${faker.internet.email()}` doesn't match the interpolation regex (`/\$\{(\w+)\}/g` — dots not matched) and making `interpolate()` async would be a massive refactor. Faker is available only via `evalScript`/`runScript`. Example:
```yaml
- evalScript: "output.email = faker.internet.email()"
- type: { selector: "#email", text: "${email}" }
```

Tests:
- `cli/__tests__/unit/executor/script-sandbox.test.ts` — output persistence, http mock, faker access, no process.env exposure, no require
- `cli/__tests__/unit/executor/run-script.test.ts` — file loading from sourceDir
- `cli/__tests__/unit/executor/eval-script.test.ts` — inline execution

---

**F16. Multi-Agent AI Providers** | P1

Builds on P3 (AIClient injection).

New files:
- `cli/src/ai/openai-client.ts` — Raw `fetch()` to `api.openai.com/v1/chat/completions`. Implements `AIClient`. Reads `OPENAI_API_KEY` or `config.ai.apiKey`. Supports image analysis via GPT-4o vision.
- `cli/src/ai/anthropic-client.ts` — Raw `fetch()` to `api.anthropic.com/v1/messages`. Implements `AIClient`. Reads `ANTHROPIC_API_KEY` or `config.ai.apiKey`. Supports image analysis via Claude vision.

Modify:
- `cli/src/config/schema.ts` — `ai.provider: z.enum(["gemini", "openai", "anthropic"])`
- `cli/src/ai/gemini-client.ts` — Add `implements AIClient`
- `cli/src/ai/client-factory.ts` — Switch on provider, read config.ai.apiKey/model/maxRequestsPerMinute
- `cli/src/commands/generate.ts` — Use `createAIClient(config.ai)` instead of `new GeminiClient()`; respect `config.ai.apiKey`, `config.ai.baseBranch`, `config.ai.excludePaths`
- `cli/src/commands/mcp.ts` — Use `createAIClient(config.ai)` instead of hardcoded Gemini
- `cli/src/ai/assertion-evaluator.ts` — Change parameter type from `GeminiClient` to `AIClient`

No new npm deps — raw `fetch()` for OpenAI and Anthropic.

Tests:
- `cli/__tests__/unit/ai/client-factory.test.ts` — verify factory returns correct client per provider
- `cli/__tests__/unit/ai/openai-client.test.ts` — mock fetch, verify request format
- `cli/__tests__/unit/ai/anthropic-client.test.ts` — mock fetch, verify request format

---

### Phase 4: UX & Polish

**F7. Interactive TUI Plan Review for Generate** | P1

New files:
- `cli/src/ui/screens/generate-review-screen.tsx` — Ink component showing generated flows in a scrollable list. Each flow shows name, step count, tags. Keyboard: `a`=approve all, `Enter`=toggle select, `r`=regenerate with new instruction, `q`=skip all, `s`=save & approve selected.
- `cli/src/ui/screens/generate-review-render.tsx` — Entry point: `renderGenerateReview(flows: ParsedFlow[]): Promise<{ approved: ParsedFlow[] }>` using Ink's `render()`.

Modify: `cli/src/commands/generate.ts`
- Add `yes?: boolean` to `GenerateCommandOptions`
- Import `detectCI` from `../utils/ci-detect.js`
- After generating, parse output into validated flow objects (already needed for F3's fix)
- If `!detectCI().isCI && process.stdout.isTTY && !opts.yes`: render TUI review
- Otherwise auto-approve all flows

Modify: `cli/src/index.ts`
- Add `-y, --yes` option to the `generate` command definition

---

**F11. Saved Flows (-f flag)** | P2

- `cli/src/constants.ts` — Add `SAVED_FLOWS_DIR = ".skeptic/flows"`
- `cli/src/utils/slug.ts` (new) — `slugify(name: string): string`. Handle collision: check if slug exists, append `-2`, `-3`, etc.
- `cli/src/commands/generate.ts` — When `--save`, parse generated YAML to extract name from validated metadata, slugify, save to `.skeptic/flows/{slug}.yaml`. Warn on collision.
- `cli/src/commands/test.ts` — Add `flow?: string` to options. If set, resolve from `.skeptic/flows/{slug}.yaml`. Error if not found. `--flow` takes precedence over positional `[flows...]`.
- `cli/src/index.ts` — Add `-f, --flow <slug>` option to test command.

Test: `cli/__tests__/unit/utils/slug.test.ts` — basic slugification, collision handling.

---

**F17. audit Command** | P2

New file: `cli/src/commands/audit.ts`
- Detect package manager: check for `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, else npm
- Read `package.json` scripts, find: `lint`, `check`, `typecheck`, `type-check`, `format`, `tsc`
- Run each with `execFileSync(pm, ["run", scriptName], { stdio: "pipe" })` 
- Report pass/fail per script with timing
- `--fix` flag: only if `lint:fix` or `lint --fix` script exists, run it

Modify: `cli/src/index.ts` — Register `audit` command.

---

**F18. Session Replay** | P2 (simplified per Codex)

**Use Playwright's built-in tracing** instead of custom rrweb injection.

- `cli/src/executor/types.ts` — `trace?: boolean` already added to `EngineOptions` in P3
- `cli/src/executor/playwright-engine.ts` — In `runFlow()`, if `this.options.trace` enabled:
  ```ts
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  // ... run flow ...
  await context.tracing.stop({ path: join(flowDir, `${safeName}.trace.zip`) });
  ```
- `cli/src/commands/test.ts` — Add `trace?: boolean` to `TestCommandOptions`. Pass `trace: opts.trace` to `EngineOptions` (already wired in P3).
- `cli/src/index.ts` — Add `--trace` option to test command
- Print message: "Trace saved. View with: npx playwright show-trace {path}"

No new npm deps — Playwright tracing is built-in.

---

## Schema Changes Summary

`cli/src/parser/flow-schema.ts` — COMMAND_KEYS grows from 21 to 32:
```
+ "retry", "runScript", "evalScript", "scrollUntilVisible",
  "back", "doubleClick", "hover", "copyTextFrom",
  "setPermissions", "setLocation", "travel"
```

`cli/src/config/schema.ts`:
- `hooks: { onFlowStart: Step[], onFlowComplete: Step[] }`
- `execution.flowsOrder: string[]`
- `ai.provider: "gemini" | "openai" | "anthropic"`

---

## New Files Summary (23 files)

Prerequisites (2):
```
cli/src/executor/step-handlers/nested-executor.ts
cli/src/ai/ai-client.ts
```

Handlers (12):
```
cli/src/executor/step-handlers/retry.ts
cli/src/executor/step-handlers/script-sandbox.ts
cli/src/executor/step-handlers/run-script.ts
cli/src/executor/step-handlers/eval-script.ts
cli/src/executor/step-handlers/scroll-until-visible.ts
cli/src/executor/step-handlers/back.ts
cli/src/executor/step-handlers/double-click.ts
cli/src/executor/step-handlers/hover.ts
cli/src/executor/step-handlers/copy-text-from.ts
cli/src/executor/step-handlers/set-permissions.ts
cli/src/executor/step-handlers/set-location.ts
cli/src/executor/step-handlers/travel.ts
```

AI (3):
```
cli/src/ai/openai-client.ts
cli/src/ai/anthropic-client.ts
cli/src/ai/client-factory.ts
```

Commands/Utilities/TUI (4):
```
cli/src/commands/audit.ts
cli/src/utils/slug.ts
cli/src/ui/screens/generate-review-screen.tsx
cli/src/ui/screens/generate-review-render.tsx
```

Tests (14):
```
cli/__tests__/unit/config/workspace-hooks.test.ts
cli/__tests__/unit/executor/retry-handler.test.ts
cli/__tests__/unit/executor/new-step-handlers.test.ts
cli/__tests__/unit/executor/scroll-until-visible.test.ts
cli/__tests__/unit/executor/script-sandbox.test.ts
cli/__tests__/unit/executor/run-script.test.ts
cli/__tests__/unit/executor/eval-script.test.ts
cli/__tests__/unit/ai/diff-targets.test.ts
cli/__tests__/unit/ai/prompts.test.ts
cli/__tests__/unit/ai/client-factory.test.ts
cli/__tests__/unit/ai/openai-client.test.ts
cli/__tests__/unit/ai/anthropic-client.test.ts
cli/__tests__/unit/utils/slug.test.ts
cli/__tests__/unit/reporter/visual-diff-reporter.test.ts
```

---

## NPM Dependencies

- `@faker-js/faker ^9.0.0` (Phase 3)

No others — Playwright tracing is built-in, OpenAI/Anthropic use raw `fetch()`.

---

## Verification

After each phase:
1. `cd cli && npm run build` — TypeScript compiles
2. `cd cli && npm run check` — Type-check passes
3. `cd cli && npm test` — All tests pass

Manual smoke tests:
- Phase 1: Flow with `back`, `doubleClick`, `hover`, `copyTextFrom` steps runs. Config hooks execute before per-flow hooks.
- Phase 2: `retry` block retries on failure. `scrollUntilVisible` finds element after scrolling. `skeptic generate --diff --target branch` uses correct git commands.
- Phase 3: `runScript` executes JS with faker/http access but no process.env. Multi-provider AI: set `ai.provider: "openai"` → works. 
- Phase 4: `skeptic generate -m "test login"` shows TUI review. `skeptic test -f slug` loads saved flow. `skeptic audit` runs lint/typecheck. `--trace` generates Playwright trace.
