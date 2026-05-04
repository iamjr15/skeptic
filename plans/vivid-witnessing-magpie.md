# vivid-witnessing-magpie — skeptic artifact & report quality

**Status:** APPROVED — Codex review final (3 rounds, gpt-5.5)
**Owner:** Claude (planning) → user (approval) → Claude (impl)
**Scope:** `cli/` only. No infra / docs / website changes.
**Goal:** Close the artifact-quality gap with Expect (`/Users/iamjr15/Desktop/aurum-refs/expect`) without losing skeptic's speed advantage. Concretely, fix blank screenshots, useless tiny videos, hidden traces, misleading report copy, and the absent observability section in default reports — while preserving every executor invariant currently locked in `CLAUDE.md`.

**Round-2 deltas (incorporating Codex review):** artifact config now plumbed onto `ExecutionContext`; `FlowResult.artifacts` consolidates all paths; trace stop moved out of `finally` (or finally now mutates a hoisted `let result`); status semantics stay on the existing 4-value enum (no `passed-with-warning`); auto a11y audit added when `--observability` is on; default-config-detection via Zod-presence dropped in favour of `defaultsForReports`; reporter-aware merge moved into `commands/test.ts`; network body materialization replaced with page-side `PerformanceResourceTiming.transferSize`; console-text redaction default-on; screenshot path traversal blocked; `videoMeta.durationMs` dropped (Playwright Video API has no duration accessor).

---

## 1. Evidence — what's actually broken right now

Reproduced against the benchmark at `benchmark-artifacts/jigyansurout-20260428-200102/`:

| Symptom | Concrete artifact | Root cause |
|---|---|---|
| Blank-black screenshot | `skeptic/output-pass/Jigyansu_Rout_smoke-0/homepage.png` — PNG 1280×720, 4 255 bytes | `cli/src/executor/step-handlers/screenshot.ts:22` calls `page.screenshot({ path, fullPage: false })`. No settle window before capture. The site has a WebGL preloader (`preloader-shader.js`, `rgba.js`) that renders solid black until the load handler completes; `assert-visible` matches DOM text *behind* the preloader and `screenshot` fires ~87 ms later, while the canvas is still painting black. |
| Useless 3 178-byte video | `skeptic/output-pass/Jigyansu_Rout_smoke-0/videos/Jigyansu_Rout_smoke.webm` — WebM ~800×450, ~2.5 s | `cli/src/executor/playwright-engine.ts:101` sets `recordVideo: { dir: videoDir }` but **omits `size`**. Playwright defaults to 800×450 (max 800w) for video, not the configured viewport. The flow is also short (3 steps, ~2 s); the visible black-preloader frames are all that gets recorded. |
| Trace not surfaced | `Jigyansu_Rout_smoke.trace.zip` exists on disk but only logged at `playwright-engine.ts:391` | `FlowResult` (`cli/src/executor/types.ts:31`) has no `artifacts.trace` field; reporters never see it. |
| Misleading alt text on passing report | `report.html:99` — `<img ... alt="failure screenshot">` on a passing flow | `html-reporter.ts:162` hardcodes `"failure screenshot"` for every screenshot regardless of context. |
| Video shown only as a tooltip | `report.html:75-76` — `<span title="...">♫ Video</span>` | `html-reporter.ts:175-177` renders an emoji span with the path tucked in `title=`, not a clickable link or `<video controls>`. |
| No observability in default reports | `results.json` for the run has no `metrics` block; report has no metrics section | `config/schema.ts:64-72` defaults `observability.collectors` to `[]`. Collectors only attach when (a) the YAML has `assertPerformance`/`assertNoNetworkErrors`/`accessibilityAudit`, or (b) the user opts in via config. Default runs get nothing — even though the data is essentially free for performance + network. |
| No console-message capture at all | n/a | No collector exists for `page.on("console")`. Expect has rich console output; skeptic emits none. |

Expect on the same page (same harness, same network, same Chromium): full 1280×2720 screenshot, ~1.8 MB video with visible content, structured perf-trace markdown, JSON network log, accessibility violations, console messages.

The performance gap (skeptic faster) is real and worth keeping. The artifact gap is what we're closing.

---

## 2. Design principles & non-goals

**Principles**

1. **Don't tax the fast path.** Default behavior changes that affect every test must be cheap (low-tens-of-ms or less) and bounded by a hard ceiling. Anything more expensive is opt-in.
2. **Single-flag opt-in for richer artifacts.** A new `--observability` (alias `--observe`) flag turns on the full Expect-parity bundle in one go: settle, full-page screenshot, console + network + performance + a11y collectors, perf-trace markdown sidecar. Power users and individual YAML steps can still flip pieces on/off.
3. **Preserve every executor invariant.** `ctx.abortReason` must still be honored, `ctx.inTeardown` must still bypass abort, `optional: true` and `onFlowStart` hook-failure paths must still clear `abortReason`. Any new awaitable inside a step body must re-check `ctx.abortReason` between awaits exactly as `buildStepBody` does today.
4. **Honest failure modes.** A blank screenshot is more dangerous than a missing one — silent green is worse than "no evidence." When evidence is suspect (blank frame, settle timed out), the report says so explicitly via `StepResult.diagnostics`. The status enum (`"passed" | "failed" | "error" | "skipped"`) is **not** extended — under `blankFrameDetection: "warn"` (default) the step stays `"passed"` and a diagnostic is appended; under `"fail"` (which `--observability` selects) the step becomes `"failed"`, which propagates through every existing `status === "passed"` consumer (test.ts pass/fail tallies, junit-reporter, retry, bail, TUI) without any cross-cutting changes.
5. **No code copying from Expect.** Expect is FSL-1.1-MIT (becomes MIT after 2 years). We borrow API shape ideas, output formats, and naming conventions, but every line we ship is ours. License header and tests prove independent implementation.

**Non-goals (out of scope for this plan)**

- Changing default `--video` / `--trace` to opt-in vs opt-out (they're already opt-in flags; we keep that).
- Adding Lighthouse, axe-core scope expansion, or new external runtime deps. Stay on Playwright + the `web-vitals` IIFE we already bundle + the existing `@axe-core/playwright` peer.
- Replacing the HTML reporter with a SPA. We refactor the static-HTML output, period.
- Adding a separate `expect skeptic-mode` adapter. Skeptic stays YAML-flow-driven.
- Adding new YAML composite steps (no `expect playwright {js}` analog). The `runScript`/`evalScript` pair already exists; we don't expand it.

---

## 3. Architecture map of the changes

Five bundles. Each ships independently, gates on its predecessors only where the dependency graph forces it. Each bundle ends with a verifiable demo against the `jigyansurout` flow.

```
B1 (engine)  →  B2 (reporter)  →  B3 (observability defaults)  →  B4 (CLI flags + sidecars)  →  B5 (verification)
   ▲                ▲                       ▲                              ▲                          ▲
   │                │                       │                              │                          │
   evidence is      report tells the        reports show free perf/net    one --observability flag    re-run, compare,
   real (settle,    truth (artifacts        even on default runs;         turns on the full Expect    ship, write
   full-page,       panel, alt fixed,       blank-frame check writes      parity bundle + writes      lessons.md
   trace surfaced,  video playable,         a warning visibly             *.md sidecars
   video sized)     trace linked)
```

---

## 4. Bundle 1 — engine: real evidence

Changes are scoped, additive, and revert cleanly if any later bundle is dropped.

### 4.1 Screenshot handler — `cli/src/executor/step-handlers/screenshot.ts`

Replace the 35-line file with a single async function that:

1. Accepts the existing `string` shorthand and a new object form `{ name?: string; fullPage?: boolean; settle?: VisualSettleArg }`. The schema change lives in §4.4.
2. Resolves the artifact config off `ctx.artifactConfig` (populated by the engine, §4.2). Precedence per field: step arg > `ctx.artifactConfig.<field>` > built-in default. So `fullPage` flow is: step `args.fullPage` > `ctx.artifactConfig.fullPageScreenshots` > `false`.
3. Calls `awaitVisualSettle(page, ctx, settleConfig)` (new helper, §4.3) **before** `page.screenshot`. Helper is a no-op fast-path when the config disables it.
4. After capture, runs `detectBlankFrame(buffer, blankThreshold)` (new helper, §4.5). On a blank result:
   - With `blankFrameDetection: "warn"` (default): append a `{ kind: "blank-screenshot", … }` entry to `result.diagnostics` and a string to `result.warnings`. Keep `status: "passed"`.
   - With `blankFrameDetection: "fail"` (opt-in via `--observability` or per-step): set `status: "failed"`, set `error`, also append the diagnostic. The status flip is the only transition; no new enum value introduced.
   - With `blankFrameDetection: "off"`: skip the check entirely.
5. **Path traversal protection:** resolve the screenshot output path with `path.resolve(ctx.flowDir, filename)` and require the result to start with `path.resolve(ctx.flowDir) + path.sep` (or equal the resolved flowDir for an empty filename, which we still reject as ambiguous). On rejection, return `status: "failed"` with `error: "screenshot path escapes flow directory: <name>"`. This closes the user-controlled-name → out-of-tree-write hole the current handler has at `screenshot.ts:18-20`.
6. Re-checks `ctx.abortReason` between awaits — the settle helper, the screenshot await, and the blank-frame check all run as separate awaits, so each must gate on `ctx.abortReason` to honor the locked executor invariant.
7. Removes the `(ctx as unknown as Record<string, string>).outputDir` cast at line 19 — `flowDir` is always populated by the engine (see §4.2).

**Lines of code:** ~120 (vs 35 today). Acceptable for the new behavior.

### 4.2 Engine — `cli/src/executor/playwright-engine.ts`

Five changes, in execution order:

1. **Line 97-102, contextOptions:** when `videoEnabled`, also set `recordVideo.size`. Precedence: `engineOptions.videoSize > viewport > 1280×720`. Playwright silently clamps video to ~800w when `size` is omitted, which is the root cause of the 800×450 webm we saw in the benchmark.
2. **Line 146-156, ExecutionContext construction:** populate the new `ctx.artifactConfig` (§4.6) by passing the engine's resolved artifact options into the `ExecutionContext` constructor. Engine builds the config once per flow from `EngineOptions` plus per-flow viewport. This is the only plumbing path that lets step handlers see the new defaults (Codex round 1 finding — handlers receive only `(page, ctx, args)`).
3. **Hoist `FlowResult` to a `let result` at the top of `runFlow` and explicit finalization order.** This is the structural fix Codex flagged across both review rounds: today the function returns a fresh object literal at lines 376-385, and the `finally` block (lines 387-395) tries to compute the trace path afterwards but has no handle to mutate. Round 2 raised an additional concern: writing sidecars before the trace finishes leaves `flow.json` with a missing `artifacts.trace` field. Fix both at once with an explicit ordered finalization in the try block:
   ```ts
   let result: FlowResult = { name: input.name, file: input.file, status: "passed",
                              duration_ms: 0, steps: [], artifacts: {} };
   try {
     // ... existing body: launch page, attach collectors, run steps, run onFlowComplete ...
     // Collector snapshots populate result.metrics here.

     // Finalization order — locked because flow.json must reflect every other artifact:
     // (1) collector snapshots are already in result.metrics by this point.
     // (2) Optional pre-video settle (only when ctx.artifactConfig.visualSettle.enabled).
     // (3) Save video → result.artifacts.video.{path,width,height}. Closes page (Playwright requires).
     // (4) Stop trace → result.artifacts.trace. Pulled OUT OF finally precisely so flow.json
     //     gets the trace path; finally is now reserved for cleanup-only (page/context close).
     // (5) Write sidecars (perf-trace.md, console.json, network.json, flow.json).
     //     flow.json is written last so it can include all of result.artifacts.*.
     return result;
   } finally {
     // Cleanup ONLY. No new fields added to result here.
     if (page && !page.isClosed()) await page.close().catch(() => {});
     if (context) await context.close().catch(() => {});
   }
   ```
   The trace stop is now in the try block (between video save and sidecar writes), wrapped in its own try/catch so a tracing failure logs a warning but doesn't abort the flow result. The finally is purely page/context cleanup. This guarantees `flow.json`, when it's written in step (5), already reflects `artifacts.trace` and `artifacts.video`.
4. **Line 358-374, video finalization** (now step 3 in the ordered list above): save the video as today, but populate `result.artifacts.video = { path: destPath, width: contextOptions.recordVideo.size.width, height: contextOptions.recordVideo.size.height }`. **No** `durationMs` — Playwright's Video class exposes only `path()`, `saveAs()`, `delete()`, no duration accessor. A WebM-header parser to recover duration is rejected scope-creep for now (logged as future work in §10 Q6).
5. **Drop the "settle before page.close()" idea from round 1.** It contradicted the behavior-equivalence promise. Settle now fires only inside the screenshot handler, gated on `ctx.artifactConfig.visualSettle.enabled`. Pre-video-finalize is no-op in default mode; under `--observability` an explicit `awaitVisualSettle(page, ctx, ctx.artifactConfig.visualSettle)` is invoked at step (2) of the ordered list above — *before* the video saves and the page closes, after collector snapshots — so the last recorded frames are non-blank without affecting non-observability runs.

**Invariant audit:** every new await sits inside `runFlow`. The settle call inside the screenshot handler *is* part of a step body and follows the abortReason-between-awaits rule (verified in §4.3 step list). The post-step settle (under observability) and trace stop run after `executeNestedSteps` returns, are not part of the body raced by `raceWithHardTimeout`, and so don't change the documented hardTimeout contract. Trace stop is wrapped in its own try/catch so a tracing failure cannot mask the flow result.

### 4.3 Visual-settle helper — new file `cli/src/executor/visual-settle.ts`

A small, allocation-light helper. Public API:

```ts
export interface VisualSettleConfig {
  enabled: boolean;          // master gate; default false (cheap path)
  networkIdleMs: number;     // wait for `networkidle` with this ceiling; default 500
  animationFrames: number;   // double-RAF count; default 2 when enabled, 0 when disabled
  pixelStableMs: number;     // optional: wait until viewport pixel hash unchanged for this long; default 0 (off)
  hardCeilingMs: number;     // overall budget; default 1500
}

export const awaitVisualSettle = async (
  page: Page,
  ctx: ExecutionContext,
  cfg: VisualSettleConfig,
): Promise<void>;
```

Implementation outline (each step gated on `ctx.abortReason`):

1. `if (!cfg.enabled) return;` — keeps the fast path zero-cost for the default mode.
2. `Promise.race([page.waitForLoadState("networkidle"), sleep(cfg.networkIdleMs)])` — capped wait, never blocks beyond `networkIdleMs`.
3. Double-RAF via `page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")`, `cfg.animationFrames` times. This is the single most effective settle in practice for canvas/WebGL pages — preloaders typically clear by the second RAF.
4. Optional pixel-stability poll: hash the central 256×256 viewport region via `page.screenshot({ clip })` + `crc32`; loop with 50 ms gap until the hash is unchanged twice in a row, capped at `cfg.pixelStableMs`. Disabled by default (cost: 1-3 extra screenshots).
5. The whole helper is wrapped in a Node-side `Promise.race` against `cfg.hardCeilingMs` so a misbehaving page can't blow the step's hardTimeout.

**Default profile (no `--observability`):** `{ enabled: false }`. Existing tests must not regress because the behavior is unchanged.

**`--observability` profile:** `{ enabled: true, networkIdleMs: 500, animationFrames: 2, pixelStableMs: 0, hardCeilingMs: 1500 }`.

**Per-step override:** YAML can pass `screenshot: { name: "x", settle: { animationFrames: 4, pixelStableMs: 1000 } }`.

### 4.4 Schema — `cli/src/parser/flow-schema.ts`

1. Replace `screenshot: z.string().optional()` (line 291) with:
   ```ts
   screenshot: z
     .union([
       z.string(),
       z.object({
         name: z.string().optional(),
         fullPage: z.boolean().optional(),
         settle: VisualSettleArgSchema.optional(),
         /** Per-step override of the engine's blankFrameDetection setting. */
         blankFrameDetection: z.enum(["off", "warn", "fail"]).optional(),
       }).strict(),
     ])
     .optional(),
   ```
   The per-step `blankFrameDetection` resolves with the same precedence ladder as `fullPage` (§4.1 step 2): step arg > `ctx.artifactConfig.blankFrameDetection` > `"warn"`. This closes the gap Codex round 2 flagged: §4.1 promised the override, the schema needs to honor it.
2. Add `VisualSettleArgSchema` — `boolean | { networkIdleMs?, animationFrames?, pixelStableMs?, hardCeilingMs? }` — and re-export the type. Boolean shorthand: `true` → engine default profile, `false` → disabled.
3. Update the `Step` interface mirror (lines 138-246) to match the union (`string | { name?, fullPage?, settle?, blankFrameDetection? }`).
4. No change to the `KNOWN_STEP_KEYS` set — `screenshot` already lives there.

### 4.5 Blank-frame detection — new helper inside `cli/src/executor/visual-settle.ts`

Cheap, in-process. Two heuristics; both must trigger to call a frame "blank":

1. **Pixel-variance check:** decode the buffer to RGBA via the `pngjs` package (already a dep, see `package.json`), sample at most 4 096 pixels on a stride pattern, compute (max - min) per channel. If max range across all sampled channels is `< 8` (i.e., near-uniform color), flag suspect.
2. **Aspect/file-size sanity:** for a 1280×720 PNG at 8-bit RGB, anything under 8 KB is statistically improbable to contain content. Threshold `bytes < SCREENSHOT_BLANK_BYTE_FLOOR` (constant, default 8 192) is the second flag.

Both flags → mark blank. Either alone → just a warning.

This avoids false positives on legitimately near-uniform UIs (e.g., empty form pages with a single button) while reliably catching the WebGL-preloader-black-canvas case.

### 4.6 Result types & ExecutionContext — `cli/src/executor/types.ts`, `cli/src/executor/context.ts`

`StepResult.status` enum is unchanged (`"passed" | "failed" | "error" | "skipped"`). New shape:

```ts
export interface StepResult {
  // ... existing fields, status enum unchanged ...
  /** Structured diagnostics. Reporters render alongside `warnings`. Optional. */
  diagnostics?: Array<{
    kind: "blank-screenshot" | "settle-timeout" | "path-rejected" | string;
    message: string;
    meta?: Record<string, unknown>;
  }>;
}

export interface FlowArtifacts {
  /** Path to Playwright trace zip. Populated by the engine after `tracing.stop` runs in the
   *  ordered finalization block (see §4.2 step 3) — between video save and sidecar writes,
   *  inside the try block. The `finally` is reserved for page/context cleanup. */
  trace?: string;
  /** WebM video plus its true (recorded) dimensions. No duration field — see §4.2 step 4. */
  video?: { path: string; width: number; height: number };
  /** Per-step screenshot files captured during the run, in order. Mirrors `ctx.screenshots`. */
  screenshots?: string[];
  /** Markdown sidecar emitted under `--observability-write-sidecars`. */
  perfTrace?: string;
  /** JSON sidecar of console messages (post-redaction). */
  consoleSnapshot?: string;
  /** JSON sidecar of network requests + computed issues. */
  networkSnapshot?: string;
  /** Per-flow JSON file (a slice of results.json scoped to this flow). */
  flowJson?: string;
}

export interface FlowResult {
  // ... existing fields unchanged ...
  /** All on-disk artifacts produced by this flow. Empty object when no artifacts captured. */
  artifacts: FlowArtifacts;
}

export interface ArtifactRuntimeConfig {
  fullPageScreenshots: boolean;
  visualSettle: VisualSettleConfig;
  blankFrameDetection: "off" | "warn" | "fail";
  writeSidecars: boolean;
}

export interface EngineOptions {
  // ... existing fields ...
  /** Override video recording size; defaults to viewport. */
  videoSize?: { width: number; height: number };
  /** Resolved at engine construction; flows into `ExecutionContext.artifactConfig`. */
  artifactConfig?: ArtifactRuntimeConfig;
}
```

And `ExecutionContext` (`cli/src/executor/context.ts`) gains:

```ts
class ExecutionContext {
  // ... existing fields ...
  readonly artifactConfig: ArtifactRuntimeConfig;
  constructor(... existing args ..., artifactConfig: ArtifactRuntimeConfig = DEFAULT_ARTIFACT_CONFIG) { ... }
}
```

Default config (`DEFAULT_ARTIFACT_CONFIG`): all fields disabled / off, matching today's behavior. Engine populates this with the resolved per-flow config in `runFlow` before constructing the context (line 146-156 in current file).

`appendWarning` keeps its current signature; we add a sibling `appendDiagnostic(result, kind, message, meta?)` helper. Callers can use both (warnings drive the human-readable string list, diagnostics drive structured rendering in the report).

### 4.7 Bundle 1 acceptance criteria

- `npm run check` passes (`tsc --noEmit`).
- `npm test` passes; all existing screenshot/playwright-engine tests still green; the test command-trace test still green.
- Re-running the `jigyansurout.flow.yaml` with `--observability` produces:
  - A non-black `homepage.png` containing actual hero content.
  - A WebM ≥ 250 KB (sanity floor; expect-pass is 1.8 MB) at the configured viewport size, embedded `width`/`height` matching `recordVideo.size`.
  - `results.json` containing `artifacts.trace`, `artifacts.video.{path,width,height}`, `artifacts.screenshots`, and (when no defects) an empty `diagnostics` field on the screenshot step.
- Behavior matrix without `--observability`. "Behavior-equivalent" below means: identical wall-clock within ±2%, identical step pass/fail outcomes, identical `results.json` modulo additive fields. Artifact dimensions/sizes change when `--video` is on regardless of reporter — that's the bug fix.
  | Reporter selection | `--video` / `--trace` | Behavior change vs today |
  |---|---|---|
  | console / json / junit only | none | **Behavior-equivalent.** New `artifacts: {}` empty block on `FlowResult` (additive). Settle disabled, fullPage off, blank-frame check off, no observability auto-attach. |
  | console / json / junit only | `--video` | **Video size changes.** Records at viewport (e.g. 1280×720) instead of Playwright's silent 800×450 default. Result file size grows accordingly. Step semantics unchanged. New `artifacts.video.{path,width,height}` populated. |
  | console / json / junit only | `--trace` | **Trace surfaces in the result.** `artifacts.trace` is populated on `FlowResult` instead of being log-only. No new trace file content; same Playwright `tracing.start({screenshots, snapshots})`. |
  | html (+ optionally json) | any | Layout rewrite from Bundle 3 applies; auto-attaches passive perf+net+console (Bundle 2). Wall-clock budget ≤ +10% on the benchmark flow. **Intentionally not behavior-equivalent** — this is the user-visible win. |
- Proof points: every existing snapshot fixture and integration test stays green except those whose fixtures explicitly cover the HTML report or the `videoPath` field (those get refreshed snapshot files in Bundle 3's PR with reviewer-visible diffs documenting the rename to `artifacts.video.path`). No test fixture is silently green-rotted; every fixture diff is reviewed.

---

## 5. Bundle 2 — observability: free wins on default + console capture

Two work-streams. Both ride on Bundle 1's type additions.

### 5.1 Default-on collectors — wired in `cli/src/commands/test.ts`, *not* in the registry

Today `observability.collectors` defaults to `[]` and `buildCollectors` returns nothing unless inferred or configured. Codex (round 1) correctly noted (a) Zod's default erases the difference between "user explicitly set `collectors: []`" and "user omitted the field," and (b) `buildCollectors` doesn't see reporter formats. Both arguments push the merge logic into `commands/test.ts`, where reporter formats are already in scope (line 226-228).

The new flow:

1. **Config knob:** `observability.defaultsForReports` (`"none" | "passive" | "full"`, default `"passive"`). This is the *only* control; we do not try to detect "user omitted `collectors`" from the schema. The user opts out by setting `defaultsForReports: "none"`.
2. **Resolution in `commands/test.ts`** (around lines 226-228 where `reporterFormats` and `hasExplicitNonConsoleReporter` are computed, and lines 350-354 where the engine `observability` config is assembled):
   ```ts
   const htmlActive = reporterFormats.includes("html");
   const baseCollectors = new Set<CollectorName>(config.observability.collectors);
   const mode = config.observability.defaultsForReports;
   if (htmlActive && (mode === "passive" || mode === "full")) {
     baseCollectors.add("performance"); baseCollectors.add("network"); baseCollectors.add("console");
   }
   if (htmlActive && mode === "full") {
     baseCollectors.add("accessibility");
   }
   const observability: ObservabilityRuntimeConfig = {
     ...config.observability,
     collectors: [...baseCollectors],
   };
   ```
   When `--observability` is on, the resolution overrides this block: it forces `mode = "full"` regardless of config, and forces `htmlActive` semantics even when an HTML reporter isn't active (the user explicitly asked for the bundle).
3. **Registry stays reporter-agnostic.** `buildCollectors` in `cli/src/observability/registry.ts` only learns about `console` (new collector name); no signature change for the merge.
4. **`a11y` is explicit.** Heavier than perf+net (axe injection + DOM walk), so attaches only when (a) the YAML uses `accessibilityAudit:`, (b) `defaultsForReports: "full"`, or (c) `--observability`. Even when attached, it requires an explicit `audit()` invocation — addressed in §5.6.
5. **Cost audit:** Performance collector — one `addInitScript` (~2 ms), one `evaluate` at flow end (~5 ms), zero per-step cost. Network — four `page.on(…)` listeners, < 1 ms attach, ~10 µs per request entry. Console — one `page.on("console", …)` listener, < 1 ms attach, ~5 µs per message + redaction (~50 µs amortized for typical patterns). All three together remain well under the "low-tens-of-ms" ceiling for a flow.

### 5.2 Console collector — new file `cli/src/observability/collectors/console-collector.ts`

Mirrors `NetworkCollector`'s shape:

- Listens on `page.on("console", msg => …)`.
- Captures `{ type, text, location?: {url, line, col}, timestamp }` per message.
- Caps at `consoleCaptureLimit` (default 200, configurable via `observability.consoleCaptureLimit`).
- Snapshot returns `{ messages, summary: { total, errorCount, warningCount, infoCount } }`.
- Detach removes the listener.

Add `"console"` to `CollectorName`. Wire into the registry. Auto-attach under the same `defaultsForReports` rules as network.

**Redaction (default ON; non-trivial — Codex round 1 finding):** console text is *not* covered by `redactUrl` because it's free-form. Implement `redactConsoleText(text)` in `cli/src/observability/url-redact.ts` (or a sibling). Patterns to mask with `[REDACTED]`:

- JWTs: `\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`.
- `Bearer ` followed by 16+ chars.
- Common credential keys appearing as `key=value` or `"key":"value"`: `password`, `passwd`, `api[_-]?key`, `secret`, `token`, `authorization`. Mask the *value* only, leave the key visible for diagnostics.
- Email addresses: `\b[\w.+-]+@[\w-]+\.[\w.-]+\b` (replace local-part with `[EMAIL]` to keep the domain for context).
- URLs inside the text — pass through `redactUrl` so query-string secrets get the same treatment as network URLs.

After redaction, truncate to 4 KB per message. Cap total messages at `consoleCaptureLimit` (200 default).

Toggle `observability.consoleRedaction: boolean` (default `true`). If a user sets this to `false`, log a single warning at engine startup ("console-redaction disabled — captured text may contain credentials"). The toggle is documented but discouraged; the report includes a banner when redaction was off.

The collector itself fits the existing `Collector` interface verbatim. The HTML reporter section (Bundle 3) renders it.

### 5.3 Performance-trace sidecar — new file `cli/src/reporter/perf-trace-md.ts`

A pure formatter. Input: `PerformanceSnapshot + NetworkSnapshot + AccessibilitySnapshot | undefined` per flow. Output: a Markdown string with sections matching what Expect emits today:

- **Web Vitals** — FCP/LCP/CLS/INP with Google's good/needs-improvement/poor thresholds.
- **Navigation Timing** — TTFB, DCL, Load. (Extend `PerformanceCollector` to also capture `performance.timing` once at snapshot — adds ~2 ms.)
- **Long Animation Frames** — already in `PerformanceSnapshot.longAnimationFrames`; format with the script-attribution table Expect uses.
- **Resources** — read from `PerformanceSnapshot.resources` (the new field added in §5.4 and populated via `performance.getEntriesByType("resource")` at flow-end snapshot time). Top-10 slowest by `duration`, top-10 largest by `transferSize`. The `NetworkSnapshot.requests` log is *not* the source for this section; it's used only for the Network section and to enrich the per-resource entry with `method`/`status`/`failure` via URL match. When `PerformanceSnapshot.resources` is empty (e.g. perf collector wasn't running), the entire Resources section is omitted from the markdown rather than rendered with `0 B` rows.
- **Network issues** — separate section sourced from `NetworkSnapshot.issues` (failed requests, duplicates, mixed content, CORS errors). Omitted when no network collector ran.
- **Accessibility** — only when audit ran (manual or auto §5.6); impact-grouped violation list.

This file is consumed by Bundle 3 (HTML reporter renders a `<a href="perf-trace.md">Open performance trace</a>` link off `flow.artifacts.perfTrace`) and Bundle 4 (the engine writes the sidecar to `<flowDir>/perf-trace.md` when `--observability` is set or when `observability.writeSidecars: true`, then sets `result.artifacts.perfTrace` to the absolute path).

### 5.4 Network capture: `transferSize` via `PerformanceResourceTiming` (no body materialization)

The round-1 plan proposed `await response.body().then(b => b.byteLength)`. Codex correctly flagged this as a memory + PII risk: it forces Playwright to materialize the full response body for every captured request just to compute a size. Dropped.

Replacement: at flow end, `PerformanceCollector.snapshot()` additionally evaluates a small page-side script that returns `performance.getEntriesByType("resource")` mapped to `{ name, transferSize, encodedBodySize, decodedBodySize, duration }`. The browser already collected this data zero-cost; we just read it. Add `resources: ResourceTiming[]` to `PerformanceSnapshot` (typed in `cli/src/observability/types.ts`).

The perf-trace markdown formatter (§5.3) joins these by URL with the network collector's request log to produce the "Slowest" / "Largest" sub-sections, matching what Expect's perf-trace markdown shows. When the perf collector isn't running (e.g. `defaultsForReports: "none"`), the Resources section is omitted from the markdown rather than rendered with `0B` rows.

No new `networkCaptureBodies` flag. No `response.body()` calls.

### 5.5 Bundle 2 acceptance criteria

- `metrics.performance` and `metrics.network` populate by default for HTML-reporter runs without YAML changes.
- `metrics.console` populates and survives a round-trip through `JsonReporter`.
- `PerformanceSnapshot.resources` populates with at least one entry on any flow that loads a sub-resource (e.g. the `jigyansurout` flow yields ~40 entries).
- Console-text redaction unit-test: input strings containing JWT, `Bearer abc…`, `password=hunter2`, `user@example.com` all return `[REDACTED]` / `[EMAIL]` markers.
- New unit tests: `console-collector.test.ts`, `console-redaction.test.ts`, `registry.test.ts` (extend), `perf-trace-md.test.ts`, `performance-collector-resources.test.ts`.
- Cost: warm-cache run of the `jigyansurout` flow grows by < 50 ms vs today's same flow with no observability. Measured under `--reporter html --output …`. (Tracked under Bundle 5.)

### 5.6 Auto a11y audit at flow end (under `--observability` or `defaultsForReports: "full"`)

Codex round 1 finding: `AccessibilityCollector.snapshot()` returns `lastSnapshot`, which is set only by an explicit `audit()` call from the `accessibilityAudit` step handler. Attaching the collector without auto-triggering an audit yields an empty snapshot, so the report's a11y card stays empty even when the user expected violations.

Fix: in `playwright-engine.ts:runFlow`, the auto-audit must run **after the main step loop completes** (just after the `for` loop at lines 191-310 exits, where `flowStatus` is finalized) and **before** `onFlowComplete` hooks fire (lines 315-326). Rationale: teardown hooks may navigate away (logout flows), close modals, or otherwise mutate the page; auditing post-teardown would inspect the wrong state. Auditing before teardown also means the audit sees the same DOM the user's last assertion saw.

The insertion point becomes a new ~10-line block immediately before the `if (input.onFlowComplete?.length) {` block:

```ts
const a11yCollector = ctx.collectors.get("accessibility") as AccessibilityCollector | undefined;
const userAuditRan = a11yCollector && (await a11yCollector.snapshot()) !== undefined;
const autoAuditEnabled = observabilityConfig.autoAccessibilityAudit ?? false;
if (a11yCollector && !userAuditRan && autoAuditEnabled && !ctx.abortReason) {
  try {
    await a11yCollector.audit({
      standard: observabilityConfig.accessibilityStandard ?? "WCAG21AA",
      impacts: observabilityConfig.accessibilityImpacts ?? ["critical", "serious"],
    });
  } catch (err) {
    logger.warn(`Auto a11y audit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

Wiring:

- `ObservabilityConfigSchema` gains `autoAccessibilityAudit: z.boolean().default(false)`, `accessibilityStandard: z.enum(["WCAG2A","WCAG2AA","WCAG21A","WCAG21AA","WCAG22AA"]).default("WCAG21AA")`, `accessibilityImpacts: z.array(...).optional()`.
- `commands/test.ts` flips `autoAccessibilityAudit: true` when `--observability` is on or `defaultsForReports: "full"` is configured.
- The auto-audit honors `ctx.abortReason` and is gated on the main step loop having reached normal completion (no hard-timeout abort). On failure, the warning is logged and we do not let the audit error mask the flow result. Auto-audit failure does **not** flip `flow.status` to `failed`; that's reserved for explicit `accessibilityAudit:` steps.
- **Interaction with `accessibilityAudit:` inside `onFlowComplete:`** (Codex round 3 cleanup note). When the user drops an explicit `accessibilityAudit:` into a teardown hook, the order is: (1) auto-audit runs first against the post-step page; (2) `onFlowComplete` runs, and its `accessibilityAudit:` step calls `audit()` again, *overwriting* `lastSnapshot` with the post-teardown state. This is the documented behavior — the user explicitly asked for a teardown audit, so the teardown audit wins. To suppress the auto-audit entirely, the user can either (a) set `autoAccessibilityAudit: false` in their flow config or (b) put an `accessibilityAudit:` step at the end of their `steps:` list (which the engine sees as "user-run audit" via the `userAuditRan` check in the snippet above and short-circuits the auto-audit). Documented in §10 Q5's tentative-answer addendum and tested in `auto-a11y-audit.test.ts`.

Acceptance: a Bundle-2 integration test runs a flow with `--observability` (no `accessibilityAudit:` step) against a fixture page known to violate at least one WCAG rule (e.g. an unlabeled SVG). `metrics.accessibility.summary.violations > 0` after the run.

---

## 6. Bundle 3 — HTML reporter UX rewrite

The current report is two columns, screenshots embedded as base64, and that's it. The rewrite keeps the dark-theme styling but reorganizes for artifact-first navigation.

### 6.1 Layout — `cli/src/reporter/html-reporter.ts`

Per-flow body becomes:

```
[Flow header: name, badge, duration, file path]
  [Artifacts panel — clickable & embedded media]
    Screenshot (thumbnail + click-to-open)
    Video (<video controls> when present)
    Trace (link: "Open in Playwright Trace Viewer" → `npx playwright show-trace <path>`)
    Performance trace (link to *.md sidecar when present)
    JSON results (link to results.json subpath for this flow)
  [Steps table — same as today, but compacter and with diagnostics column]
  [Metrics section — Performance / Network / Accessibility / Console cards]
  [Warnings & diagnostics section — surfaces blank-frame, settle-timeout, soft-timeout, retried-once]
```

Concrete changes:

1. **Artifacts panel** — new `buildArtifactsPanel(flow)` helper. Reads only from `flow.artifacts.*`. Renders (a) a thumbnail of the most relevant screenshot (`failure-step-N.png` if present, else the last `screenshot:` step from `flow.artifacts.screenshots`), (b) `<video controls preload="metadata">` if `flow.artifacts.video` exists, (c) a styled link card for `flow.artifacts.trace` with copy-to-clipboard for the `npx playwright show-trace …` command, (d) a link to `flow.artifacts.perfTrace` when present.
2. **Embed strategy** — keep the existing `SKEPTIC_HTML_EMBED_MAX_KB` budget (default 1 024 KB) for screenshots. Video is *never* embedded as base64 (always linked, large file). Trace is always linked. Sidecar markdown is rendered as a link, *not* fetched-and-inlined (keeps report self-contained but small).
3. **Alt text fix** — `renderScreenshotMedia(asset, alt)` already takes an explicit `alt`. Stop hardcoding `"failure screenshot"`. Pass:
   - `"baseline screenshot"` / `"current screenshot"` / `"diff screenshot"` for visual-diff trios (already done).
   - For the per-step screenshot rendering: pass an alt derived from the step (`<step.command> screenshot — <args>`) and a separate `figcaption` calling out failure vs evidence: failure paths show `Failure evidence`, screenshot-step paths show `Screenshot: <name>`.
4. **Diagnostics column** — a new column in the steps table that renders any `result.diagnostics`/`result.warnings` as small chips with hover detail. Critical for surfacing blank-frame warnings.
5. **Metrics cards** — keep the existing card grid but add a fourth card for Console (`{ total, errors, warnings }` with a collapsible top-N). Cap rendered messages at 50 with a "show all in console-snapshot.json" link.
6. **Failed flows still auto-open**, passed flows stay collapsed (existing `flow.failed` JS at line 118).
7. **Self-contained styles** stay inline (no external CSS, matches today's footprint).

### 6.2 JSON reporter — `cli/src/reporter/json-reporter.ts`

Mostly inherits from the type changes in Bundle 1. Concretely:

- Schema bump: `version: "0.2.0"` (the existing `"0.1.0"` is freeform — bumping is documentation, not API contract).
- Emits the new `artifacts` block (with `trace`, `video`, `screenshots`, `perfTrace`, `consoleSnapshot`, `networkSnapshot`, `flowJson` populated as available), the new `diagnostics` field per step, plus `metrics.console` when present.
- Existing pretty-print env var stays.
- Add a `metrics.summary` shortcut (e.g. `{ perfScore: "good" | "needs-improvement" | "poor", a11yViolations: N, networkIssues: N, consoleErrors: N }`) computed once at write time so downstream tooling (PR comment, dashboards) doesn't have to re-walk.

### 6.3 Console reporter & Ink TUI

- `console-reporter.ts:106-118` already prints the video path (today reads `result.videoPath`; the migration changes this to `result.artifacts.video?.path`). Add lines for `result.artifacts.trace` (when present) and a one-liner for diagnostics on each failing step, mirroring the visual-diff lines pattern (lines 68-73). Keep emoji-light; chalk only.
- `ink-reporter.ts` (not read in detail above) — only touched if a test fails after the type changes; no UX redesign in this bundle.

### 6.4 Bundle 3 acceptance criteria

- Existing `__tests__/unit/reporter/html-reporter.test.ts` updated; new assertions for: artifacts panel presence, `<video controls>` element when `flow.artifacts.video` is set, alt text matches `"<command> screenshot — …"` not `"failure screenshot"`, trace link renders when `flow.artifacts.trace` is set.
- New visual-test fixture: a synthetic `RunSummary` whose flow has `artifacts.trace` + `metrics.console` + a `diagnostics: [{ kind: "blank-screenshot", … }]` step. Snapshot the rendered HTML. Snapshot test guards against regressions.
- The on-disk report from a real `jigyansurout` rerun: video is playable in the browser without leaving the report; trace link copies a runnable command to clipboard; alt text reads correctly when inspected.
- Console reporter prints `Trace: <path>` line on a `--trace` run; prints `Video: <path>` line on a `--video` run (already does).

---

## 7. Bundle 4 — CLI flags, config, sidecar writes

Brings the user-facing surface in line with the new defaults.

### 7.1 New flags — `cli/src/index.ts` & `cli/src/commands/test.ts`

`index.ts` (the `program.command("test")` block, lines 58-94) gains:

```
--observability                       # umbrella: full settle + fullPage + perf+net+a11y(auto)+console + sidecar md
--observe                             # alias for --observability (shorter to type)
--full-page-screenshot                # forces fullPage=true on all screenshot steps
--no-full-page-screenshot             # opt out (overrides config)
--visual-settle                       # enable settle helper standalone
--no-visual-settle                    # opt out
--blank-frame-detection <mode>        # off | warn | fail; default depends on --observability
--observability-write-sidecars        # alias --sidecars; write per-flow perf-trace.md + console.json + network.json
```

**Commander alias plumbing.** Codex round 2 flagged that `--observe` cannot be a casual aside — Commander needs an explicit alias declaration or both flags need explicit merge logic. The plan: declare them as **two separate options** that both set boolean fields on `cmdOpts`, then in `runTest` merge with `const observability = cmdOpts.observability ?? cmdOpts.observe ?? false;`. (Commander's `option()` API doesn't have a built-in alias for boolean flags; using two declarations and merging is the cleanest pattern that already matches our `--no-tui` / `--tui` precedent at index.ts:88.) New unit test `__tests__/unit/commands/test-command-observe-alias.test.ts` asserts that running with `--observe` produces an `EngineOptions` shape byte-equal to running with `--observability`.

The flag's effects (resolved in `runTest` around lines 285-355):

- `--observability` ON resolves to (each individual flag can override):
  ```ts
  const observabilityProfile: Partial<ArtifactRuntimeConfig & ObservabilityRuntimeConfig> = {
    fullPageScreenshots: true,
    visualSettle: { enabled: true, networkIdleMs: 500, animationFrames: 2, pixelStableMs: 0, hardCeilingMs: 1500 },
    blankFrameDetection: "fail",
    writeSidecars: true,
    defaultsForReports: "full",          // forces perf+net+console+a11y irrespective of reporter mix
    autoAccessibilityAudit: true,
    consoleCaptureLimit: 200,
    consoleRedaction: true,
    accessibilityStandard: "WCAG21AA",
  };
  ```
  No `networkCaptureBodies` — replaced by page-side `PerformanceResourceTiming` (§5.4).

- **Sidecar writes** happen in the engine, *not* in `finally` — placed inside the try block right after `result.metrics` is populated, before the `return result;`. Each sidecar wrapped in its own try/catch so a failed write logs a warning but doesn't kill the flow result. Files written:
  - `<flowDir>/perf-trace.md` — from `perf-trace-md.ts`. Path → `result.artifacts.perfTrace`.
  - `<flowDir>/console.json` — raw redacted messages + summary. Path → `result.artifacts.consoleSnapshot`.
  - `<flowDir>/network.json` — `{ requests, issues }` from `NetworkSnapshot`. Path → `result.artifacts.networkSnapshot`.
  - `<flowDir>/flow.json` — slice of the eventual `results.json` for *this* flow only (handy for cross-flow PR comments). Path → `result.artifacts.flowJson`.

- `TestCommandOptions` interface (lines 66-98 of `test.ts`) gains the new fields. `buildOverrides` does not pipe them into `config`; they live as engine-direct fields and on the resolved `ObservabilityRuntimeConfig`.

### 7.2 Config — `cli/src/config/schema.ts`

`ObservabilityConfigSchema` (lines 64-72) gains:

```
defaultsForReports: z.enum(["none", "passive", "full"]).default("passive"),
consoleCaptureLimit: z.number().int().min(0).default(200),
consoleRedaction: z.boolean().default(true),
visualSettle: z.union([z.boolean(), VisualSettleConfigSchema]).default(false),
fullPageScreenshots: z.boolean().default(false),
blankFrameDetection: z.enum(["off", "warn", "fail"]).default("warn"),
writeSidecars: z.boolean().default(false),
autoAccessibilityAudit: z.boolean().default(false),
accessibilityStandard: z.enum(["WCAG2A", "WCAG2AA", "WCAG21A", "WCAG21AA", "WCAG22AA"]).default("WCAG21AA"),
accessibilityImpacts: z.array(z.enum(["critical", "serious", "moderate", "minor"])).optional(),
```

No `networkCaptureBodies` — dropped per §5.4.

Backwards-compat: every field has a default that preserves today's behavior *for non-HTML-reporter runs*. HTML-reporter runs intentionally pick up the passive defaults via `defaultsForReports: "passive"`. Existing `skeptic.config.yaml` files validate unchanged.

### 7.3 PR comment & README

- `cli/src/commands/comment.ts` — keep current shape, but include the new `metrics.summary` line ("Web Vitals: FCP 1.2s · LCP 3.4s · A11y: 12 violations · 4 console errors") when those fields are populated. One-line addition to the existing template.
- `cli/README.md` — short section: "What `--observability` gives you," with a table of artifacts produced. Optional in this plan; we can defer.

### 7.4 Bundle 4 acceptance criteria

- New flags appear in `skeptic test --help`.
- `--observability-write-sidecars` writes four sidecar files; their content matches a hand-formatted reference fixture (covered by a new `__tests__/integration/observability/sidecar-write.test.ts`).
- A run with `--observability` against the `jigyansurout` flow produces:
  - Non-blank, full-page `homepage.png`.
  - 1280×720 (or device-overridden) WebM containing visible content; `result.artifacts.video.{width,height}` reflect the recorded size.
  - `<flowDir>/perf-trace.md` with Web Vitals, LoAF, navigation timing, top resources (joined from `PerformanceResourceTiming`).
  - `<flowDir>/console.json` with at least the WebGL warning messages, redaction applied (verified by absence of common credential patterns in any captured strings).
  - `<flowDir>/network.json` with the request log + computed issues.
  - `<flowDir>/flow.json` matching the per-flow slice of the merged `results.json`.
  - `metrics.accessibility` populated by the auto-audit (§5.6).
  - `report.html` with all of the above linked / embedded / surfaced as designed in §6.
- A run *without* the flag, **with HTML reporter active**, against the same flow:
  - Wall-clock time ≤ 110% of today's same flow with no observability.
  - Report shows passive perf + net + console cards; no a11y card (since auto-audit is off and YAML didn't request).
  - Screenshot alt text reads correctly (no `"failure screenshot"` on a passing flow).
- A run *without* the flag, **with console-only or JSON-only reporters**: byte-equivalent to today (modulo the additive empty `artifacts: {}` block in `FlowResult`).

---

## 8. Bundle 5 — verification, perf budget, ship

### 8.1 Live re-run of the benchmark

Steps:

1. Branch off main at the post-Bundle-4 commit.
2. `cd cli && npm run build`.
3. From `benchmark-artifacts/jigyansurout-20260428-200102/skeptic/`, run twice:
   - `node ../../../cli/dist/index.js test jigyansurout.flow.yaml --reporter html json --output ./output-pass-new --video --trace`
   - `node ../../../cli/dist/index.js test jigyansurout.flow.yaml --reporter html json --output ./output-pass-observability --video --trace --observability`
4. Compare:
   - Screenshot dimensions/file size between old, new-default, new-observability.
   - WebM dimensions/file size.
   - Wall-clock duration (`results.json.duration_ms`) between old and new-default — must not exceed +10%; between new-default and new-observability — informational only.
   - HTML report visual: open both new reports, click through Artifacts panel, play video, click trace link.
   - JSON report fields: confirm `artifacts.trace`, `artifacts.video.{path,width,height}`, `artifacts.perfTrace`, `artifacts.consoleSnapshot`, `artifacts.networkSnapshot`, `artifacts.flowJson`, `metrics.console`, `metrics.summary`.
5. Save the new outputs alongside the originals in `benchmark-artifacts/jigyansurout-<new-timestamp>/skeptic/` so a future engineer can do the comparison again.

### 8.2 Test suite & quality gates

- `cd cli && npm run check` — clean.
- `cd cli && npm test` — all green. Specifically: existing `html-reporter.test.ts`, `console-reporter.test.ts`, `playwright-engine.test.ts` (where it exists), all observability tests.
- `cd cli && npm run build` — clean tsup output, no new bundle warnings.
- Repo-level: `cd /Users/iamjr15/Desktop/aurum && (no root tests yet; CLAUDE.md mentions backend `make ci` and frontend `npm run check` but neither lives in this PR's scope; we still run them if anything inadvertently touched).`
- `git diff --stat` review: the changes should land within roughly: ≤6 modified core files (`screenshot.ts`, `playwright-engine.ts`, `html-reporter.ts`, `json-reporter.ts`, `console-reporter.ts`, `flow-schema.ts`, `schema.ts`, `index.ts`, `commands/test.ts`, `executor/types.ts`, `observability/registry.ts`) + 4-6 new files (`visual-settle.ts`, `console-collector.ts`, `perf-trace-md.ts`, plus tests).

### 8.3 Risks & mitigations

| Risk | Mitigation |
|---|---|
| Settle helper makes default tests perceptibly slower | Default profile keeps `enabled: false`; settle only attaches under `--observability`. The Bundle-5 wall-clock comparison enforces the +10% budget. |
| Blank-frame detection false-positives on legitimately uniform UIs | Two-flag rule (variance + size) plus `"warn"` default that doesn't fail the test. Override per-step. |
| HTML report regression from layout rewrite | Snapshot tests against rendered HTML for at least 3 fixture summaries (passing-with-screenshot, failing-with-diff, passing-with-metrics). |
| Console-message capture leaks PII | New `redactConsoleText` (§5.2) masks JWTs, `Bearer …`, password/api_key/token/secret values, and email local-parts; URLs in text go through `redactUrl`. Default ON; opt-out logs a startup warning and the report shows a banner. Truncate `text` to 4 KB per message. |
| Network-body materialization for transferSize | Replaced with page-side `PerformanceResourceTiming` evaluate (§5.4). No `response.body()` calls. Memory and PII risk eliminated. |
| Path traversal via user-supplied screenshot name | Resolve final path, require it under `path.resolve(ctx.flowDir) + path.sep`; reject with structured `failed` step otherwise (§4.1 step 5). |
| `recordVideo.size` larger than 800×450 increases bundle size | Documented; matches user intent (they passed `--video`). Mitigation: when no observability flag, keep size = viewport but cap at 1280×720 even if device profile is larger (rare); under `--observability`, follow viewport exactly. |
| Performance collector + console collector together push memory on long flows | LoAF cap at 50, network cap at 500, console cap at 200. All already enforced or added. Long flows can configure `consoleCaptureLimit` higher if needed. |
| Schema additions break user YAMLs | `screenshot:` accepts `string | object` — strict zod union with refine. Existing `screenshot: "homepage.png"` continues to validate. New tests cover both forms. |
| FSL license risk on copied patterns | We borrow API/output shape and naming, never code. We add a CONTRIBUTING note "Do not paste from `aurum-refs/expect`." Code review checklist line for the implementing branch. |

### 8.4 Lessons capture — `tasks/lessons.md`

After implementation, append:

- "When the page has a WebGL preloader, DOM-based assertVisible passes before the screen is paintable. Default screenshot pipelines should not assume DOM-visible == screen-visible."
- "Playwright's `recordVideo.size` defaults silently to 800×450 if you only set `dir`. Always pass `size` explicitly when you care about the final video."
- "Blank-frame detection beats blank-screenshot debugging — silent green is the worst failure mode."

---

## 9. Order of operations for the implementing branch

1. Bundle 1 PR: types + visual-settle + screenshot/engine wiring + tests. No reporter/UX changes yet. Gates the rest.
2. Bundle 2 PR: console-collector + default-on logic + perf-trace-md formatter + tests. Independent of Bundle 3.
3. Bundle 3 PR: html-reporter rewrite + console/json reporter additions + reporter tests. Depends on Bundle 1 (`FlowArtifacts` block, `diagnostics`) and Bundle 2 (console metrics, perf-trace-md sidecar exists).
4. Bundle 4 PR: CLI flags + config schema additions + sidecar engine wiring + integration tests.
5. Bundle 5: verification + benchmark re-run + lessons.md.

Each PR is independently reviewable, independently revertable, and the production binary stays usable at each commit.

---

## 10. Open questions for the user (non-blocking, but worth confirming)

1. **HTML embed budget for screenshots.** Today: 1 024 KB. With full-page screenshots common, average screenshot may grow 4-10×. Keep budget, raise to 4 MB, or switch to always-link? *Tentative answer: keep 1 024 KB, full-page screenshots usually exceed it, get linked instead of embedded — same UX as today's large-fail screenshots.*
2. **Video size when `--device` profile is in use.** Today: video records at Playwright's 800-cap. New: video records at viewport. If `device: "iphone-12"` (390×844), should video stay 390×844 or upscale to a more report-friendly size? *Tentative answer: respect device viewport; users running mobile profiles likely want mobile-aspect video.*
3. **Console-collector on by default for HTML reporter?** Cost is negligible; PII surface is mitigated by default-on redaction. *Tentative answer: yes, mirror network's auto-attach rules.*
4. **`--observability` short alias.** Proposed `--observe`. Alternatives: `-O`, `--rich`, `--full`. *Tentative answer: `--observe` reads as a verb; reads well in CI configs.*
5. **Auto a11y audit timing.** Currently fires once at end-of-flow before snapshot. Should it fire per-page after each `navigate:` instead? *Tentative answer: end-of-flow only — multi-page audits would multiply cost and double-report the same violations on shared layouts. The user can still drop explicit `accessibilityAudit:` steps where they want per-page coverage.*
6. **WebM duration metadata.** Dropped from `videoMeta` because Playwright's Video API has no duration accessor. Worth a Bundle-6 follow-up to parse the WebM Cluster timestamps? *Tentative answer: defer — duration is `result.duration_ms` in practice, that's the number users care about.*

---

## Appendix A — file-by-file change summary

```
MODIFIED:
  cli/src/executor/step-handlers/screenshot.ts          ~+90 lines (settle, fullPage, blank-detect, path-traversal)
  cli/src/executor/playwright-engine.ts                 ~+55 lines (videoSize, hoisted result, ctx.artifactConfig wiring, auto-a11y, sidecar writes)
  cli/src/executor/types.ts                             ~+30 lines (FlowArtifacts, ArtifactRuntimeConfig, diagnostics, EngineOptions)
  cli/src/executor/context.ts                           ~+10 lines (artifactConfig field + DEFAULT_ARTIFACT_CONFIG)
  cli/src/parser/flow-schema.ts                         ~+30 lines (screenshot union, VisualSettleArgSchema)
  cli/src/config/schema.ts                              ~+25 lines (defaultsForReports, console/visual-settle/a11y observability fields)
  cli/src/observability/registry.ts                     ~+10 lines ("console" wired in)
  cli/src/observability/types.ts                        ~+25 lines (ConsoleSnapshot, "console" CollectorName, ResourceTiming, autoAccessibility config)
  cli/src/observability/url-redact.ts                   ~+50 lines (or sibling file; redactConsoleText)
  cli/src/observability/collectors/performance-collector.ts  ~+30 lines (navigation timing + resources capture)
  cli/src/observability/collectors/network-collector.ts ~  0 lines (no body materialization; transferSize moved to perf-resource-timing path)
  cli/src/reporter/html-reporter.ts                     ~+220 lines (artifacts panel, <video controls>, trace link, alt text fix, console card, diagnostics column)
  cli/src/reporter/json-reporter.ts                     ~+15 lines (metrics.summary, version bump)
  cli/src/reporter/console-reporter.ts                  ~+15 lines (trace path line, diagnostics summary)
  cli/src/index.ts                                       ~+20 lines (new flags incl. --observability-write-sidecars)
  cli/src/commands/test.ts                              ~+70 lines (flag plumbing, observability profile assembly, htmlActive defaults merge)

NEW:
  cli/src/executor/visual-settle.ts                     ~150 lines (helper + blank-frame detector)
  cli/src/observability/collectors/console-collector.ts ~120 lines
  cli/src/reporter/perf-trace-md.ts                     ~180 lines (markdown formatter)
  cli/__tests__/unit/executor/visual-settle.test.ts     ~150 lines
  cli/__tests__/unit/executor/step-handlers/screenshot.test.ts (new) ~140 lines (incl. path-traversal cases)
  cli/__tests__/unit/observability/console-collector.test.ts ~120 lines
  cli/__tests__/unit/observability/console-redaction.test.ts ~80 lines
  cli/__tests__/unit/observability/performance-collector-resources.test.ts ~80 lines
  cli/__tests__/unit/reporter/perf-trace-md.test.ts     ~150 lines
  cli/__tests__/integration/observability/sidecar-write.test.ts ~150 lines
  cli/__tests__/integration/observability/auto-a11y-audit.test.ts ~100 lines

UNCHANGED — confirmed not in scope:
  cli/src/executor/step-handlers/nested-executor.ts     # invariants preserved by construction
  cli/src/parser/step-normalizer.ts                     # screenshot's normalized shape passes through unchanged
  All other step handlers
  Backend, frontend, infra
```

## Appendix B — invariant audit checklist (fill in during PR review)

For each new awaitable inside a step body or hook body:

- [ ] `await` is preceded by an explicit `if (ctx.abortReason !== null) return …;` check.
- [ ] No new path that mutates `ctx.abortReason` outside `optional`-downgrade and `onFlowStart` hook-failure branches.
- [ ] `raceWithHardTimeout` still wraps the outer step body; new helpers don't bypass it.
- [ ] Every helper that owns a `setTimeout` clears it in a `finally`.
- [ ] All new collectors implement `attach`/`snapshot`/`detach` and are registered in `buildCollectors`; their `detach` is idempotent.
- [ ] Sidecar writes happen *after* `ctx.collectors` snapshots have been taken, *before* the engine's `return result;`.
- [ ] `result` is hoisted to a `let` at the top of `runFlow`; `finally` mutates it (not a fresh literal); single `return result;` at end-of-try.
- [ ] `StepResult.status` enum is unchanged — no new value added; new behavior is encoded via `result.diagnostics` and (optionally) a `passed`→`failed` flip under `blankFrameDetection: "fail"`.
- [ ] Auto a11y audit (§5.6) runs only when `autoAccessibilityAudit` is set, only when no prior `accessibilityAudit:` step ran, and only when `ctx.abortReason === null`.
