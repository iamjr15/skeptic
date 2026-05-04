# swirly-pivoting-thrush — pivot skeptic from YAML flows to a TS test API + runner

**Status:** APPROVED — Codex review final (4 rounds, gpt-5.5; 23 findings applied)

**Round-2 deltas:** added explicit `runAction()` boundary so executor invariants (`abortReason`, `inTeardown`, `raceWithHardTimeout`) survive in TS-imperative mode (Codex #1); replaced YAML-step-based collector inference with up-front collector attachment driven by `--observability` and per-test `test.use({ collectors: [...] })` (Codex #2); added Bundle 1.5 (MCP/ACP migration, ~280 LoC) — both servers were YAML-deep and would compile-but-misbehave without rewrite (Codex #3); rebuilt the `generate` migration into Bundle 5.5 with TS-spec validation (typecheck-it-runs) and a literal-AST `page.goto()` extractor for coverage (Codex #4); explicitly bounded the runner MVP scope (no nested describe, no concurrent tests, no shared-context, no matcher plugins) so the 700 LoC ceiling holds (Codex #5); demoted Page-Proxy action capture from "complete" to "best-effort, never a correctness dependency" — action markers degrade to step-result-driven only when proxy misses (Codex #6); B5 dual-engine acceptance now packages `accessibility-checker-engine` as `optionalDependencies` AND a conditional gate that skips when the peer is missing (Codex #7); replaced blanket `*flow*.test.ts` deletion with an `rg`-driven inventory + classify-each policy (Codex #8); cost re-estimated at +2500-4500 LoC net (Codex #9). AI fixture API shape adjusted: `ai.assert(claim, { target? })` and `ai.extract(query, { schema?, target? })` — no repeated `page` arg (Codex Architecture Calls). FSL non-compete locked harder: zero code/text/CSS/structure copies from expect — patterns only via independent reimplementation.
**Owner:** Claude (planning) → user (approval) → Claude (impl)
**Scope:** `cli/` and the benchmark `*.flow.yaml` fixtures (migrated to `*.spec.ts`).
**Goal:** Replace skeptic's YAML-flow surface with a TypeScript test API + custom runner. Carry forward every observability / cursor / artifact / AI feature already shipped (and the velvety-finding-beacon plan's wins) onto the new foundation. Borrow heavily from agent-browser (Apache 2.0 — code-level ports with attribution) and expect (FSL-1.1-MIT — patterns only, no code copy). No users yet → hard-delete the YAML layer in v0.2; `*.flow.yaml` becomes invalid.

---

## 1. Context — why pivot

Three days of comprehensive testing on `jigyansurout.com` and two rounds of multi-bundle planning surfaced a structural issue: every "agent-UX" architectural call — `selectorHint` skeptic-grammar restrictions, `@eN` ref tokens with two contracts, the recorder-helper extraction, the resolver dispatch on `kind` — is load-bearing on YAML being the test format. Strip YAML and ~half of those decisions become unnecessary; the other half become trivial.

What YAML actually delivered: reproducibility, reviewable diffs, schema-validated parse-time errors, no-code authorship for non-engineers. What it cost: no dynamic selectors (escape hatch is `runScript:`), shallow control flow, painful selector authoring (the bug I hit twice while writing the comprehensive flow), and a parallel mini-language to the host TS.

skeptic has zero users. The pivot's migration cost is zero. The audience emerging — AI agents authoring tests programmatically — is better served by the same TS-imperative shape that Playwright Test, Cypress, and (under the hood) expect already use. Skeptic's actual moat — AI assertions, observability bundle, cursor overlay, inspect/snapshot — all *strengthen* in TS-imperative because they integrate naturally with `await` instead of being wedged into a declarative tree.

**User decisions locked** (per previous AskUserQuestion):
1. Custom skeptic runner (not vitest, not Playwright Test fixture). `skeptic run tests/**/*.spec.ts`.
2. AI assertions live on the test fixture as `ai.assert(...)` / `ai.assertNoDefects(...)` / `ai.extract(...)`.
3. Hard-delete YAML — no deprecation path, no `--legacy` flag.

---

## 2. Decisions — borrow strategy

| Source | License | What we lift | How |
|---|---|---|---|
| `agent-browser/cli/src/native/snapshot.rs` | Apache 2.0 | Snapshot algorithm: AX tree → ref minting → cursor-interactive detection → tree rendering (full / interactive / compact modes). The Rust → TS port is mechanical because the algorithm is small. | **Code-level port** with `// Source: agent-browser/cli/src/native/snapshot.rs:<lines> © Vercel Inc., Apache 2.0` headers. |
| `agent-browser/cli/src/native/element.rs` | Apache 2.0 | Ref resolution strategy: `RefMap` + `(role, name, nth)` tuple + selector-fallback dispatch. | Code-level port (TS classes, same shape). |
| `agent-browser/cli/src/native/cdp/discovery.rs` | Apache 2.0 | Auto-connect (`/json/version` → `/json/list` → `/devtools/browser` fallback). | Code-level port for `--connect <url>` auto-discovery. |
| `agent-browser/cli/src/native/screenshot.rs:38-52,426,512` | Apache 2.0 | Annotation-record shape + fullPage `scrollY` projection. | Code-level port. |
| `agent-browser/AGENTS.md` | Apache 2.0 | Agent-workflow doc structure. | Adapt heavily to skeptic's TS-imperative API; section structure mirrors theirs. |
| `expect/runtime/overlay/*` | FSL-1.1-MIT | Cursor overlay design intent: synthetic in-page cursor with persistence + click feedback + numbered action trail + per-step tooltip + shape detection. | **Inspiration only.** **No code, CSS, keyframe names, animation timings, text strings, or component structure copied** (Codex round 2 architecture note). Engineer reads only our existing `cursor-overlay.ts` + this user-facing UX brief — does NOT open files under `aurum-refs/expect/` while authoring. Original implementation, original animation names, original timings. |
| `expect/packages/browser/src/accessibility.ts` | FSL-1.1-MIT | Multi-engine pattern: axe + IBM Equal Access in parallel with dedup-by-ruleId. | Already implemented (`accessibility-collector.ts`); flip on by default. |
| `expect/packages/browser/src/runtime/lib/performance.ts` | FSL-1.1-MIT | LoAF script-attribution shape, Server-Timing capture, INP `interactionId`-aware tracking, severity-flag thresholds. | Pattern only — extend our existing `PerformanceCollector`. |
| `expect/packages/browser/src/runtime/lib/scroll-detection.ts` | FSL-1.1-MIT | "N items hidden above/below" markers for viewport-aware snapshot. | Pattern only. |
| `expect/packages/browser/src/mcp/server.ts` (screenshot tool, three modes) | FSL-1.1-MIT | The `mode: "snapshot" | "screenshot" | "annotated"` tri-state UX. | Pattern only — our equivalent is `snapshot()` helper + `screenshot()` helper + `screenshot(..., { annotate: true })`. |

`cli/LICENSES.md` (new file, ships in the npm tarball) carries the full Apache 2.0 license text + a NOTICE block listing every ported file. Per-file `// Source: …` headers on the ports.

---

## 3. Decisions — runner shape

We're picking the "Custom skeptic runner" option. Concretely:

**Bounded MVP scope** (Codex round 1 #5 — anything outside this list is explicit Bundle-N+1 follow-up):
- IN: `test()`, `test.skip()`, `test.only()`, file-level `test.use({...})`, `test.beforeEach()`, `test.afterEach()`, sequential test execution within a file, file-level parallelism via `--parallel N`.
- OUT (deferred to a later plan): nested `describe()` blocks, `beforeAll`/`afterAll` (use `beforeEach` + a setup spec for now), shared `BrowserContext` across tests, concurrent tests within a file, custom matcher plugins, fixture extension API (`extend({...})`), watch mode dependency graphing, parameterized tests (`test.each`).

If this list grows past ~700 LoC of runner code we stop and switch to a vitest adapter; the plan tracks LoC explicitly per bundle.

- **Discovery:** `fast-glob` over the user-supplied pattern (default `tests/**/*.spec.ts`). No vitest peer dep.
- **Transpile:** `tsx` (TypeScript Execute) as a runtime dependency, called via dynamic-import hook. Alternative considered: `esbuild-register` — same end result, but `tsx` is more maintained as of 2026 and handles `tsconfig.json` resolution out of the box. **SEA-build awareness** (Codex round 1 #5): tsx loads its own loader hooks; in our SEA binary path (`cli/src/utils/sea-require.ts`), tsx must resolve from the embedded `node_modules`. Verified once during B1 implementation: `dist/skeptic-sea` test runs against a real `*.spec.ts`. If tsx breaks under SEA, fallback is to embed a precompiled JS step or shell out to a sidecar `node` with `--import tsx`. Documented as risk mitigation.
- **Test definition:** `import { test } from "skeptic-cli"` exposes a `test()` function + `test.skip()`/`test.only()`/`test.use()` + `test.beforeEach()`/`test.afterEach()` modifiers. Implementation is a minimal in-process registry; tests get serialized into a per-file array on import. `test.describe()` is **NOT** in the MVP — we'd just nest the registry, costing ~80 LoC for a low-value feature.
- **Per-test isolation:** each `test()` call gets a fresh fixture: `{ page, snapshot, screenshot, settle, observability, ai, ctx }` — same `ExecutionContext` that powers today's flows, just constructed fresh per test instead of per YAML flow. `BrowserContext` is per-test by default. **`test.use({ context: "shared" })` opt-in is OUT** of MVP — tests get fresh contexts; setup-heavy suites use `test.beforeEach` for now.
- **Hooks:** `test.beforeEach`, `test.afterEach` only in MVP. `beforeAll`/`afterAll` deferred — workaround is a shared module-level setup or a dedicated setup test that runs first.
- **Assertions:** re-export Playwright's `expect` from the `skeptic-cli` package (Playwright is already a transitive dep). Add skeptic's domain expects as fixture methods (`observability.expectPerformance({...})`, `ai.assert(...)`, `screenshot.assertVisuallyMatches(...)`).
- **Reporter dispatch:** Reporter interface mostly survives but the type rename in B0.5 (`FlowResult → TestResult`, `flows → tests`, `onFlowStart → onTestStart`, `onFlowComplete → onTestComplete`) touches all 7 reporters + `comment.ts` consumer. Logic unchanged; identifiers only.
- **Sharding:** scheduling unit is **tests, not files** (Codex round 2 #2). Discovery worker imports every spec, builds a manifest, main process partitions the manifest with the same logic as today's `partitionFlows` in `cli/src/executor/shard.ts` (renamed `partitionTests`). Each execution worker gets a `{ file → testIds[] }` allowlist of stable `${file}#${ordinal}` ids (see §4.0.1).
- **Watch mode:** `chokidar` over the test glob; on change, re-discover + re-run affected files. Same `chokidar` dep as today.

The runner's CLI: `skeptic run [glob...] [flags]`. Replaces `skeptic test`. New flag: `--list` to discover tests without running them (lightweight sanity-check, replaces `validate`'s YAML role).

**`TestUseOptions` design** (Codex round 2 #4): every previous YAML flow-level / CLI flag has a corresponding `test.use({...})` field or a CLI flag. Explicit shape:

```ts
interface TestUseOptions {
  // Browser/context
  url?: string;                          // base URL — was YAML metadata.url
  viewport?: { width: number; height: number };  // was metadata.viewport
  device?: string;                       // device profile id — was metadata.device
  cookies?: boolean | { browser?: string };       // was metadata.auth + cli --cookies
  env?: Record<string, string>;          // was metadata.env
  // Test selection
  tags?: string[];                       // was metadata.tags
  // Observability
  collectors?: CollectorName[];          // declarative attach (§4.0.1)
  // Timing
  timeout?: number;                      // soft per-action default; was --timeout
  hardTimeout?: number;                  // hard per-test ceiling; was hardTimeout option
  // Retry
  retries?: number;                      // was --retries
}
```

CLI flags carrying over verbatim (mapped to runner config, not `test.use`):
`--observability`, `--observe`, `--video`, `--trace`, `--full-page-screenshot`, `--no-full-page-screenshot`, `--visual-settle`, `--no-visual-settle`, `--blank-frame-detection`, `--observability-write-sidecars`, `--sidecars`, `--reporter`, `--output`, `--parallel`, `--shard-split`, `--shard-all`, `--ci`, `--bail`, `--retries`, `--timeout`, `--device`, `--config`, `--headed`, `--watch`, `--cookies`, `--cookies-from`, `--analyze`, `--no-tui`, `--quiet`, `--verbose`.

Dropped flags (no TS equivalent, never essential): `--flow <slug>` (was for `.skeptic/generated/` lookup; replaced by direct path arg), `--grep` (replaced by Playwright Test-style `test.only` or `--shard` filtering), `--include-tags`/`--exclude-tags` (replaced by per-test `test.use({ tags })` + `--tag` filter on the CLI).

---

## 4. The new public API

```ts
// tests/jigyansurout.spec.ts
import { test, expect } from "skeptic-cli";

test("homepage smoke", async ({ page, snapshot, observability, ai, screenshot }) => {
  await page.goto("https://jigyansurout.com");

  // Snapshot returns a tree with helpers — same primitive as agent-browser's snapshot.
  const tree = await snapshot(page);
  const githubLink = tree.byRole("link", { hrefIncludes: "github.com" });
  await githubLink.click();

  // Playwright expect is re-exported.
  await expect(page).toHaveURL(/github\.com/);

  // AI helpers on the fixture.
  await ai.assert("the hero text mentions 2026");
  await ai.assertNoDefects();
  const year = await ai.extract("the year shown in the hero");
  expect(year).toMatch(/2026/);

  // Observability assertions.
  await observability.expectPerformance({ lcp: "<2500ms", cls: "<0.1" });
  await observability.expectNoNetworkErrors();
  await observability.expectNoConsoleErrors({ allow: [/cdn-cgi/] });

  // Screenshot helpers.
  await screenshot("hero", { fullPage: true });
  await screenshot("annotated", { fullPage: true, annotate: true });
});
```

### 4.0 Hard-isolation execution model (worker-per-file)

Codex round 2 #1: arbitrary TS test code can hang the event loop (`while(true)`), leak timers, mutate module state across tests. `Promise.race` + page-close from round 1 is **not** actually a hard timeout for arbitrary user code. Real hard timeouts require process-level isolation.

**Decision: worker-per-file, NOT per-test.** Each `*.spec.ts` runs in a `node:worker_threads` worker. Per-test isolation within a file is purely fixture-level (fresh `BrowserContext`, fresh `ExecutionContext`); per-file isolation is process-level.

Lifecycle:

1. Main process discovers files via fast-glob, sharding partitions registered tests across workers (see §4.0.1).
2. Per file: spawn a worker with the spec path + shard's allowlist of stable test ids. Worker imports the file, runs allowlisted tests sequentially.
3. Per test in the worker: soft timeout (page-close + run afterEach in `inTeardown=true`); hard kill if the worker hasn't acknowledged completion within `softTimeout + GRACE_MS` (default 2 s grace).
4. Worker → main IPC: events for `test:start` / `test:complete` / `step:*` (carrying `TestResult` + `StepResult` shapes); main forwards to reporters.

The worker boundary makes hard kill correctness-safe: `worker.terminate()` is synchronous and reclaims the V8 isolate. Module state, timers, pending promises all GCed.

**Hard-kill outcome for remaining tests in the killed worker** (Codex round 3 #3): when a worker gets terminated mid-run, the main process knows which tests in that worker's allowlist had already reported `test:complete`. Untested allowlisted tests are **requeued in a fresh worker, once**, with a `[skeptic] previous worker terminated` warning attached to their `TestResult`. If the second worker also dies on the same allowlist position, the offending test is marked `error: "test killed worker twice"` and the rest of that file's tests are marked `error: "skipped due to upstream worker kill"` — bounded recovery, not infinite. Acceptance test covers both `await new Promise(() => {})` (event-loop yield) and `while(true){}` (CPU spin). The `while(true)` test specifically verifies the hard-kill path runs after the soft-timeout grace, not just the soft path.

**Implementation note** (Codex round 4 cleanup): `worker.terminate()` returns a Promise. Await it; treat any termination rejection as a runner-infrastructure error and surface as `RunSummary`-level diagnostic, not a per-test failure.

**Top-level side-effect rule** (Codex round 3 #4): each spec file is imported twice — once by the discovery worker (manifest build) and once by each execution worker that has tests from it. **Test authors must not put browser-level side effects at module top level.** Allowed: `import` statements, type definitions, helper functions. Disallowed: `await page.goto(...)` or fetches at module top level. Documented in AGENTS.md (B6) and enforced by a regression fixture `__tests__/fixtures/runner/side-effect.spec.ts` that increments a counter at module top level — the test asserts the counter equals `2` (one discovery + one execution import), proving the behaviour is intentional and authors can rely on it.

This pushes the runner over the original 700 LoC stop line — see §6 for revised cost. Below the new threshold (~1400 LoC) the runner stays viable; if implementation exceeds that, halt and switch to vitest adapter (which has its own thread runner).

### 4.0.1 Sharding scheduling unit + stable test ids (Codex round 2 #2 + round 3 #2)

Resolved contradiction: shards partition **tests, not files**. Workflow:

1. Main process spawns a "discovery worker" that imports every discovered file (silent, no test execution — registers tests into a manifest).
2. Manifest is `[{ file, ordinal, id, name, only, skip, useOptions }, …]` — one entry per registered test. `ordinal` is the registration order within a file, starting at 0. `id` is the stable identifier `${file}#${ordinal}` — independent of test name (Codex round 3 #2 — duplicate test names within a file are otherwise ambiguous in allowlists).
3. `--shard-split N` deterministically partitions the manifest by `id` index modulo N (matches today's `partitionFlows` in `cli/src/executor/shard.ts:partitionFlows`, just keyed on stable ids).
4. Each execution worker gets a shard's allowlist `{ file → testIds[] }` (e.g. `{ "tests/foo.spec.ts": ["tests/foo.spec.ts#0", "tests/foo.spec.ts#3"] }`). Worker imports the file, runs only the tests whose registration ordinal is in the allowlist.
5. Duplicate test names within a file are **allowed** — they just register at different ordinals and run independently. Reporter output disambiguates by appending `#${ordinal}` to the displayed name when names collide.

Acceptance tests:
- 4 tests in one file with distinct names, `--shard-split 2` → 2 workers × 2 tests, merged `results.json` has all four.
- 2 tests in one file with the **same name**, `--shard-split 2` → 2 workers × 1 test each, both run, both appear in results with the disambiguating ordinal in their reporter name.

### 4.0.2 The `runAction` boundary

`CLAUDE.md` locks four executor invariants that today live around the YAML step-loop in `playwright-engine.ts:247` and `nested-executor.ts:119`: `raceWithHardTimeout` enforces hard ceilings, `ctx.abortReason` short-circuits dispatch, `ctx.inTeardown` bypasses abort for hooks, body promises must re-check `abortReason` between awaits. **An ad-hoc `await testFn(fixture)` invocation has none of these guarantees** — a misbehaving test could hang past `--timeout`, and teardown wouldn't run under the right flag.

**Solution: every fixture-method call goes through `runAction(label, fn)` (Codex round 1 #1).** It's the same pattern `nested-executor.ts:raceWithHardTimeout` enforces today, just at a different boundary. The fixture's helpers (snapshot, screenshot, settle, ai.*, observability.*) are wrapped in `runAction`; the Page Proxy's intercepted methods are wrapped in `runAction`. Direct Playwright calls (`page.click(...)` against an unwrapped Locator) bypass the wrapper, but Playwright's own `setDefaultTimeout` covers them — the runner sets that based on `--timeout` flag value before the test starts.

```ts
// runner/execute.ts pseudocode
async function executeTest(spec: TestSpec, ctx: ExecutionContext, fixture: SkepticFixture): Promise<TestResult> {
  ctx.abortReason = null;
  page.setDefaultTimeout(spec.timeout ?? globalTimeout);

  // Hard ceiling for the entire test, mirroring raceWithHardTimeout.
  const ceiling = new Promise<TestResult>((resolve) => setTimeout(() => {
    ctx.abortReason = `test timeout exceeded (${spec.hardTimeout}ms)`;
    page.context().close().catch(() => {});  // forces in-flight Playwright operations to reject
    resolve({ status: "failed", error: ctx.abortReason, ... });
  }, spec.hardTimeout));

  try {
    return await Promise.race([spec.fn(fixture), ceiling]);
  } finally {
    ctx.inTeardown = true;
    try { await runAfterEach(spec, fixture); } finally { ctx.inTeardown = false; }
  }
}

// fixture's runAction wrapper
const runAction = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  if (ctx.abortReason !== null && !ctx.inTeardown) {
    throw new Error(`[skeptic] aborted: ${ctx.abortReason}`);
  }
  return fn();  // Playwright's setDefaultTimeout enforces the per-action ceiling
};
```

This preserves all four invariants:
- Per-test hard ceiling via Promise.race (mirrors `raceWithHardTimeout`).
- `ctx.abortReason` checked before each fixture-method call (mirrors the pre-dispatch check in `playwright-engine.ts:225`).
- `ctx.inTeardown` flipped during `afterEach` so teardown bypasses the abort gate (mirrors the same pattern in `playwright-engine.ts:402`).
- Page closure on hard-timeout fires the cancellation through Playwright's own machinery — in-flight `page.click()` / `page.fill()` calls reject with "Target closed" rather than silently completing.

The runner wires this in `cli/src/runner/execute.ts`. Tests in `cli/__tests__/unit/runner/timeout.test.ts` cover: (a) hard-timeout fires page close, (b) `afterEach` runs under `inTeardown=true`, (c) post-abort fixture call throws cleanly.

### 4.0.1 Collector activation timing (Codex round 1 #2)

Today `playwright-engine.ts:193` attaches collectors **before navigation** based on `inferRequiredCollectors()` scanning YAML steps. In TS, the test runs `page.goto()` immediately — there's nothing to infer from. Three viable options:

| Option | Behaviour | Cost |
|---|---|---|
| **A. Attach all configured collectors up front** | If `--observability` is on or `test.use({ collectors: [...] })` declared them, attach everything before the test fn runs. No lazy attach. | Simple; matches today's `--observability` semantics; ~10ms attach cost paid once per test. |
| **B. Lazy attach on first `observability.*` call** | Attach collectors on the first call to `observability.expectPerformance()` etc. | Misses navigation timing entirely (perf collector needs `addInitScript` BEFORE goto). Doesn't work. |
| **C. Per-test declarative manifest** | `test.use({ collectors: ["performance", "network"] })` declared at file or test level. | More explicit; requires schema. |

**Decision: A + C.** `--observability` → attach all 4 (perf+net+console+a11y). No-flag → attach `test.use`-declared collectors only. No-flag-no-declaration → no collectors attached, `observability.expectPerformance()` throws with a clear "did you forget --observability or test.use({ collectors: [...] })?" hint. This mirrors today's behaviour where YAML inference happened pre-navigation, just made explicit.

Bundle 1's runner code wires `test.use({ collectors })` plumbing; Bundle 5 wires the `--observability` flag → "all collectors" mapping. The `inferRequiredCollectors()` function and `cli/src/observability/infer.ts` get **deleted** in B1 (no YAML steps to scan).

### 4.1 The fixture object

```ts
interface SkepticFixture {
  page: Page;                    // Playwright Page, fresh per test
  ctx: ExecutionContext;         // skeptic's existing context (preserves abortReason etc.)
  snapshot: (target?: Page | Locator, opts?: SnapshotOptions) => Promise<SnapshotTree>;
  screenshot: (name: string, opts?: ScreenshotOptions) => Promise<{ path: string; diagnostics: StepDiagnostic[] }>;
  settle: (opts?: VisualSettleConfig) => Promise<void>;  // wraps awaitVisualSettle
  observability: {
    expectPerformance(thresholds: PerfThresholds): Promise<void>;
    expectNoNetworkErrors(opts?: NetworkAssertOpts): Promise<void>;
    expectNoConsoleErrors(opts?: ConsoleAssertOpts): Promise<void>;
    expectAccessible(opts?: AxeAuditOpts): Promise<void>;
    snapshot(): Promise<{ performance?, network?, console?, accessibility? }>;
  };
  ai: {
    // Codex Architecture Calls — fixture already owns `page`, don't pass it again.
    // `target` opts in to a Locator if the assertion is scoped narrower than the page.
    assert(claim: string, opts?: { target?: Locator }): Promise<void>;
    assertNoDefects(opts?: AIDefectsOpts & { target?: Locator }): Promise<void>;
    extract<T = string>(query: string, opts?: { schema?: ZodSchema<T>; target?: Locator }): Promise<T>;
  };
}

interface SnapshotTree {
  yaml: string;                          // text tree, agent-browser-shaped
  refs: Map<string, RefEntry>;           // eN → { role, name, nth?, selectorHint? }
  byRef(ref: string): Locator;           // resolves via the locator factory
  byRole(role: string, opts?: { name?: string | RegExp; hrefIncludes?: string; index?: number }): Locator;
  byText(text: string | RegExp): Locator;
  byTestId(id: string): Locator;
  cursorInteractiveCount: number;
  ariaRefCount: number;
}
```

### 4.2 Snapshot semantics — agent-browser code-port

The `snapshot()` helper is the agent-browser snapshot algorithm ported to TS. Modes:

- `snapshot(page)` — full ARIA tree + cursor-interactive refs.
- `snapshot(page, { interactive: true })` — only nodes with refs (matches `agent-browser snapshot -i`).
- `snapshot(page, { compact: true })` — interactive + minimal ancestors (matches `-c`).
- `snapshot(page, { selector: ".modal" })` — scoped subtree.
- `snapshot(page, { viewportAware: true })` — defaults to true on the public API; emits `note "N items hidden above/below"` markers.

Output's YAML tree matches agent-browser's format byte-for-byte:

```
- heading "hi, i'm jigyansu" [ref=e1]
- link "" [ref=e2] /url: https://github.com/iamjr15
- button "Save" [ref=e3]
- div "Custom" [ref=e4] clickable [onclick]   ← cursor-interactive ref
```

Refs are valid only within the test that captured them — no cross-test reuse, no daemon. `byRef("e2")` resolves via the locator factory: `getByRole(...).nth(N)` for ARIA-source refs, `resolveElement(page, ctx, selectorHint)` for cursor-interactive refs. Same factory pattern velvety-finding-beacon settled on.

### 4.3 `skeptic inspect <url>` — for live exploration

Carries forward from velvety-finding-beacon. Same flags (`--interactive`, `--compact`, `--annotate`, `--selector`, `--json`, `--device`, `--headed`, `--wait`, `--with-playwright-hints`, `--connect <url>`) and same output format. The `--connect` flag uses agent-browser's CDP discovery: tries `/json/version` → `/json/list` → `/devtools/browser` fallback, IPv6-bracketed correctly.

Two contracts unchanged: `selectorHint` is the stable cross-process artifact (`role=link:GitHub`, `css=a[href*=...]`, `testid=...`); refs are volatile within a session.

---

## 5. Bundles

```
B0.5 Config + scaffolding + templates + reporter-type renames + runtime deps  (must precede B1 — deleting YAML otherwise breaks compile)
B1   Pivot core: build runner+API, migrate engine wiring, delete YAML      (foundational)
B1.5 MCP/ACP server migration                                               (depends on B1's API)
B2   Snapshot/inspect: agent-browser port + extend                          (depends on B1's API surface)
B3   Cursor overlay polish: expect-pattern features in vanilla              (independent)
B4   Annotated screenshot mode                                              (depends on B2)
B5   A11y dual-engine + perf-trace richness                                 (independent)
B5.5 `generate` rewrite + TS spec validation + AST coverage                 (depends on B1's API)
B6   AGENTS.md + LICENSES.md + benchmark migration + verification           (last)
```

Every bundle leaves `npm test` green and the binary functional.

### Bundle 0.5 — Config + scaffolding + reporter renames + runtime deps (Codex round 2 #3, #5, #6)

Must precede B1. Deleting YAML breaks compile in seven places we'd otherwise hit at runtime:

1. **Config schema (`cli/src/config/schema.ts`).** Imports `StepSchema` from `parser/flow-schema.js`, defines `onFlowStart`/`onFlowComplete: z.array(StepSchema)`, defaults `tests: "tests/**/*.yaml"`. Migration:
   - Drop `StepSchema` import.
   - Drop `onFlowStart`/`onFlowComplete` from `HooksConfigSchema` (replaced by `test.beforeEach`/`afterEach` in user spec files; workspace-wide hooks deferred to Bundle-N+1).
   - Default `tests: "tests/**/*.spec.ts"`.

2. **`cli/templates/`.** Three YAML templates (`example.flow.yaml`, `relational-selectors.flow.yaml`, `skeptic.config.yaml`) used by `init` and `add`. Migration:
   - `example.flow.yaml` → `example.spec.ts` showing the fixture API.
   - `relational-selectors.flow.yaml` → DELETE (relational selectors are gone in TS — Playwright's `filter`/`locator(...).filter(...)` covers it).
   - `skeptic.config.yaml` → updated to `tests: "tests/**/*.spec.ts"` default.
   - Add `tests/example.spec.ts` template + a `tsconfig.json` template under `templates/tsconfig.json`.

3. **`cli/src/commands/init.ts`.** Currently writes `tests/example.flow.yaml`. Migration: writes `tests/example.spec.ts` + `tsconfig.json` + a top-level `package.json` snippet for the `skeptic` dep.

4. **`cli/src/commands/add.ts`.** Currently teaches `skeptic test path/to/flow.yaml` in the GitHub-Action workflow it generates. Migration: `skeptic run tests/`. Also updates the example YAML it embeds in the workflow file.

5. **Reporter types (`cli/src/reporter/types.ts`).** Rename `FlowResult → TestResult`, `flows → tests` (RunSummary key), `onFlowStart → onTestStart`, `onFlowComplete → onTestComplete`. **All five reporters** (`console-reporter.ts`, `json-reporter.ts`, `junit-reporter.ts`, `html-reporter.ts`, `slack-reporter.ts`, `webhook-reporter.ts`, plus `ink-reporter.ts`) get the rename.

6. **`comment` command (`cli/src/commands/comment.ts:25`).** Validates `results.flows[]`. Migration: rename to `results.tests[]` to match `results.json` v0.3.0. Tests in `__tests__/unit/commands/comment.test.ts` get the same rename.

7. **Public library contract (Codex round 3 #1).** Today `cli/package.json:name === "skeptic-cli"` and there are no `exports` / `main` / `types` fields — `tsup` builds `dist/index.mjs` but npm consumers can't `import { test } from "skeptic-cli"` reliably. Migration:
   - Decision: keep `name: "skeptic-cli"` (the published name); the **public scaffold imports from `"skeptic-cli"`**, not `"skeptic"`. Renaming the npm package is a separate registry move and not worth the friction.
   - Add to `package.json`:
     ```json
     {
       "main": "./dist/index.mjs",
       "module": "./dist/index.mjs",
       "types": "./dist/index.d.ts",
       "exports": {
         ".":         { "import": "./dist/index.mjs", "types": "./dist/index.d.ts" },
         "./test":    { "import": "./dist/index.mjs", "types": "./dist/index.d.ts" },
         "./engine":  { "import": "./dist/index.mjs", "types": "./dist/index.d.ts" },
         "./package.json": "./package.json"
       }
     }
     ```
   - Update every example, scaffold, AGENTS.md, and B6 verification step to use `import { test, expect } from "skeptic-cli"` (matches the actual published package name; no string-name change needed if examples already use `skeptic-cli`).
   - New self-reference test: `cli/__tests__/integration/package-imports.test.ts` creates a temp directory with a `package.json` declaring `"skeptic-cli": "file:../../"`, runs `npm install`, then `node -e 'import("skeptic-cli").then(m => assert(m.test, m.expect))'`. Confirms the library surface is real.

8. **Runtime deps.** Add to `cli/package.json`:
   - `tsx` (runtime) — needed for `*.spec.ts` execution.
   - `fast-glob` (runtime) — currently transitive via Playwright? Verify; add explicit if not already top-level.
   - `typescript` (runtime) — currently devDependency only; needed at runtime for the AST walker in B5.5 + the `tsc --noEmit` validation. Adds ~60 MB to `node_modules` but is required.
   - SEA-binary impact: tsx + typescript significantly bloat the bundle. Verified during B0.5: SEA size goes from current ~80 MB to ~140 MB. Acceptable; the user-experience gain (one binary, no Node prereq) outweighs.

9. **`cli/src/ui/screens/`** (Codex round 2 #7) — `generate-review-screen.tsx` displays generated YAML for review. Stays, content updates in B5.5. Other screens (`results-screen.tsx`, `run-screen.tsx`, `watch-screen.tsx`) need only type renames (FlowResult → TestResult), no content change.

**Acceptance:**
- `npm run check` clean after just B0.5 changes (with the YAML parser/handlers still in place from B1).
- `skeptic init` writes a TS-shaped scaffold.
- `skeptic comment` parses a v0.3.0 results.json with `tests[]`.
- All reporters' tests pass with the rename.
- The SEA build still launches.

**Cost:** ~450 LoC modified across config + templates + commands + reporters + comment, ~80 LoC tests = ~530 LoC.

### Bundle 1 — Pivot core

**Inventory before deletion (Codex round 1 #8).** Implementation MUST start with:

```
rg -l "parseFlow|ResolvedFlow|FlowInput|runFlow|normalizeStep|FlowSchema|\.flow\.yaml" cli/src cli/__tests__
```

Each result classified:
- **DELETE** — file is purely YAML grammar / parser / dispatch loop / step-handler.
- **MIGRATE** — file is engine/observability/AI/reporter logic that happens to reference `FlowInput`/`runFlow` because YAML was the input shape; rename to `TestInput`/`runTest` and keep.
- **PRESERVE** — already library-shaped; no rename needed.

Confirmed inventory (the `rg` was run during planning):

| File | Class | Action |
|---|---|---|
| `cli/src/parser/{flow-parser,flow-schema,step-normalizer,glob-resolver}.ts` | DELETE | YAML-grammar |
| `cli/src/executor/step-handlers/` (~40 files) | DELETE | One-handler-per-YAML-step |
| `cli/src/commands/{validate,validate-core,test,record,record-session,record-yaml-renderer,recorder-script}.ts` | DELETE | YAML CLI / recorder emits YAML |
| `cli/src/observability/infer.ts` | DELETE | Codex round 1 #2 — no YAML steps to scan |
| `cli/src/executor/{aria-ref-error,relational-resolver,condition}.ts` | DELETE | YAML-only resolvers / condition-evaluator |
| `cli/src/executor/{playwright-engine,context,types,visual-settle,cursor-overlay,aria-snapshot-capture,aria-ref-resolver,aria-ref-types,element-resolver,shard,runner}.ts` | MIGRATE | Type renames `FlowInput → TestInput`, `runFlow → runTest`; logic unchanged |
| `cli/src/observability/**` (collectors, registry, redaction) | PRESERVE | Already TS APIs |
| `cli/src/reporter/**` | PRESERVE | Reporter interface is per-test event-shaped |
| `cli/src/ai/**` | PRESERVE | Already library-shaped (clients, retry, security, prompts) |
| `cli/src/utils/**`, `cli/src/feature-flags.ts`, `cli/src/constants.ts` | PRESERVE | Util layer |
| `cli/src/commands/{init,add,audit,browsers-install,comment,cookies}.ts` | PRESERVE | Non-YAML commands |
| `cli/src/commands/mcp.ts`, `acp.ts`, `acp-prompt-parser.ts` | MIGRATE in B1.5 | YAML-deep — see new Bundle 1.5 |
| `cli/src/commands/generate.ts` + `cli/src/ai/flow-generator.ts` + `cli/src/ai/coverage/**` | MIGRATE in B5.5 | YAML-output + coverage from `navigate:` steps — see new Bundle 5.5 |
| `__tests__/integration/aria-snapshot.test.ts` | MIGRATE | Tests engine API directly; rename FlowInput → TestInput |
| `__tests__/integration/observability/{sidecar-write,auto-a11y-audit,bundle3-e2e,engine-lifecycle,network-smoke,ibm-dual-engine,accessibility-smoke,performance-smoke}.test.ts` | MIGRATE | Same — direct engine tests, not YAML |
| `__tests__/integration/commands/test-command*.test.ts` | DELETE | YAML CLI flow loop tests |
| `__tests__/integration/commands/{acp-server,record-script,record-cli-surface,comment-cli-surface,add-cli-surface}.test.ts` | DELETE/MIGRATE per-file (acp/record-related → DELETE; comment/add CLI surface → PRESERVE) | Mixed |
| `__tests__/unit/parser/**` | DELETE | YAML grammar tests |
| `__tests__/unit/executor/{nested-executor,step-handlers,run-script,eval-script,scroll-until-visible,retry-handler,retry-if-no-change,relational-resolver,relational-handler-integration,new-step-handlers,random-handlers,aria-ref-handler-integration,aria-ref-resolver,dual-timeout}.test.ts` | DELETE | Step-handler-specific tests |
| `__tests__/unit/executor/{aria-snapshot-capture,element-resolver,script-sandbox,shard-partition}.test.ts` | MIGRATE | Library-shaped; minor type rename |
| `__tests__/unit/observability/**` | PRESERVE (rename) | Collectors |
| `__tests__/unit/reporter/**` | PRESERVE (rename) | Reporters |
| `__tests__/unit/ai/**` | PRESERVE | AI clients |
| `__tests__/unit/commands/{validate,record,record-collation,record-yaml-renderer,test-command-rerun,test-command-shard-env,test-command-trace,test-command-observe-alias,parallel}.test.ts` | DELETE | YAML CLI |
| `__tests__/unit/commands/{init,add,comment,mcp,acp-lifecycle,acp-prompt-parser,generate}.test.ts` | MIGRATE (mcp/acp/generate) or PRESERVE (init/add/comment) | Mixed |

**Remove (~3700 LoC):**

| File / dir | LoC | Why removed |
|---|---:|---|
| `cli/src/parser/flow-parser.ts` | ~150 | YAML front-matter parser. Replaced by tsx import. |
| `cli/src/parser/flow-schema.ts` | ~580 | Zod schema for YAML steps. Replaced by TS types. |
| `cli/src/parser/glob-resolver.ts` | ~80 | `*.flow.yaml` glob. Replaced by `fast-glob` over `*.spec.ts`. |
| `cli/src/parser/step-normalizer.ts` | ~50 | YAML step normalization. Not needed in TS. |
| `cli/src/executor/step-handlers/` (~40 files) | ~2200 | One handler per YAML step type. The actual *Playwright operations* (click, type, etc.) move into the API helpers; `runFlow`/`retry`/`repeat` become plain TS `for`/`try`/`while`. |
| `cli/src/executor/step-handlers/nested-executor.ts` | ~270 | YAML composite-step dispatcher. Not needed; `await` covers it. |
| `cli/src/executor/condition.ts` | ~60 | YAML `when:` evaluator. Not needed; `if` covers it. |
| `cli/src/commands/test.ts` | ~1310 | YAML flow loop. Replaced by `cli/src/commands/run.ts` (~400 LoC). |
| `cli/src/commands/validate.ts`, `validate-core.ts` | ~130 | YAML schema validation. Replaced by tsc + `--list`. |
| `cli/src/commands/record.ts`, `record-session.ts`, `record-yaml-renderer.ts`, `recorder-script.js` | ~580 | Recorder emits YAML. Replaced in B2 by recorder-helper extraction (the selector logic) into a shared util — but the YAML-emitting parts go. |
| `cli/src/commands/generate.ts` | ~180 | AI generates YAML flows. Rewrite in B6 to generate `*.spec.ts` instead, using the same prompts. |
| `cli/src/executor/aria-ref-error.ts` | ~30 | Error class for `@eN` resolution failure. Not needed — fixture's `byRef` throws plain Error with locator-style messages. |
| `cli/src/executor/relational-resolver.ts` | ~340 | YAML relational-selector grammar. Not needed in TS — Playwright's `filter`/`locator(...).filter(...)` covers it. |
| `cli/src/executor/element-resolver.ts` | ~80 | skeptic selector grammar (`role=`/`css=`/`testid=`/etc). Kept (still used by cursor-interactive fallback in snapshot — see B2). **Not removed.** |
| YAML-parser/handler/CLI tests (per-file inventory above), NOT `*flow*.test.ts` blanket | ~1500 | YAML behavior only. Engine/collector/reporter direct tests stay (per inventory). |

**Keep — already library-shaped, no changes in B1:**

```
cli/src/executor/playwright-engine.ts       (the engine — unchanged API: launch/runFlow/close;
                                              `runFlow` renamed to `runTest` with lightly adjusted
                                              FlowInput → TestInput shape. Internal step loop replaced
                                              by direct `await testFn(fixture)` invocation.)
cli/src/executor/context.ts                 (ExecutionContext — central per-test state)
cli/src/executor/visual-settle.ts            (visual-settle helper, blank-frame detector)
cli/src/executor/cursor-overlay.ts           (cursor overlay — extended in B3)
cli/src/executor/aria-snapshot-capture.ts    (ARIA snapshot — extended in B2 with cursor-interactive)
cli/src/executor/aria-ref-resolver.ts        (rewritten in B2 to back the SnapshotTree.byRef API)
cli/src/executor/aria-ref-types.ts            (extended in B2)
cli/src/executor/element-resolver.ts          (kept — used by cursor-interactive fallback)
cli/src/executor/types.ts                     (extended slightly: TestInput/TestResult ≈ FlowInput/FlowResult)
cli/src/executor/shard.ts                     (renamed partitionFlows → partitionTests, otherwise unchanged)
cli/src/observability/**                      (collectors, registry, redaction — unchanged)
cli/src/reporter/**                            (all reporters — minor wiring, no logic changes)
cli/src/ai/**                                  (AI clients — exposed via fixture in B6)
cli/src/utils/**                               (logger, asset-path, env, etc.)
cli/src/feature-flags.ts                       (build-time flags)
```

**New — the API + runner (~1900 LoC across files):**

```
cli/src/api/index.ts                          ~50 lines — re-exports (test, expect, types)
cli/src/api/test.ts                           ~250 lines — test() / test.skip / test.only / test.use / test.beforeEach / test.afterEach / registry (NO describe — out of MVP)
cli/src/api/fixture.ts                        ~280 lines — buildFixture(ctx, page) returning the SkepticFixture
cli/src/api/snapshot.ts                       ~120 lines — snapshot() helper + SnapshotTree class (B2 extends)
cli/src/api/screenshot.ts                     ~80 lines — screenshot() helper wraps engine's existing flow
cli/src/api/observability.ts                  ~200 lines — observability fixture with the 4 expect* methods
cli/src/api/ai.ts                              ~100 lines — ai fixture wrapping existing assertion-evaluator + extract-text
cli/src/api/expect-skeptic.ts                  ~80 lines — domain matchers (toMatchSnapshot, toBeAccessible)

cli/src/runner/index.ts                        ~80 lines — main-process entrypoint
cli/src/runner/discover.ts                    ~140 lines — fast-glob + discovery worker (registers tests without executing)
cli/src/runner/registry.ts                    ~120 lines — file-scoped test/hook registry (mirrors vitest)
cli/src/runner/execute.ts                     ~280 lines — main-process orchestrator + IPC + per-test soft/hard timeout + reporter dispatch
cli/src/runner/worker.ts                       ~220 lines — worker-thread entrypoint that imports a spec, runs allowlisted tests, posts events to main (Codex round 2 #1)
cli/src/runner/ipc.ts                          ~100 lines — typed message protocol between main and workers
cli/src/runner/watch.ts                        ~80 lines — chokidar-based re-run

cli/src/commands/run.ts                        ~400 lines — `skeptic run` CLI (replaces test.ts)
```

**Acceptance** (Codex round 1 #5 — strengthened beyond smoke):
- `npm run check` clean.
- `npm test` green.
- **Two-test-one-file:** `tests/two-tests.spec.ts` defines two independent `test(...)` calls; both run, results.json shows two entries.
- **Hooks:** `tests/hooks.spec.ts` uses `test.beforeEach`/`afterEach`; ordering verified.
- **`test.skip` and `test.only`:** both honored; skipped tests appear in results.json with status `"skipped"`.
- **Retry:** `--retries 2` re-runs a failing test; reporter records the retry count.
- **Hard timeout — async hang:** test that does `await new Promise(() => {})` under `--timeout 1000` fails within ~1.1s. Page is closed by the runner; subsequent tests in the file run unaffected (soft path).
- **Hard timeout — CPU spin:** test that does `while(true){}` under `--timeout 1000` is killed by `worker.terminate()` after the 2 s grace. Remaining tests in the file are requeued in a fresh worker (Codex round 3 #3); the original test is marked `error: "test timeout exceeded (1000ms)"`.
- **Shard split:** `--shard-split 2` partitions a 4-test file across two shard runs; merged results contain all four.
- **JSON reporter:** `--reporter json --output ./out` writes `results.json` v0.3.0 with the renamed `tests` key (was `flows`).
- **Observability sidecars:** `--observability --observability-write-sidecars` writes `perf-trace.md`, `console.json`, `network.json` per test.
- **`abortReason` re-check:** unit test in `__tests__/unit/runner/timeout.test.ts` asserts that fixture calls after a hard-timeout fire throw `[skeptic] aborted: test timeout exceeded`, NOT silently complete.
- **Collector activation timing:** `__tests__/unit/runner/collector-activation.test.ts` asserts that `--observability` attaches all 4 collectors BEFORE the test's first `page.goto()`, and that `test.use({ collectors: ["network"] })` attaches only network.

**Cost:** ~1900 LoC new; ~3500 LoC removed; net **−1600 LoC**.

### Bundle 1.5 — MCP/ACP server migration (Codex round 1 #3)

Both `mcp` and `acp` servers expose YAML-deep tool schemas: `mcp.ts:31` registers `list_flows` / `validate_flow` / `generate_flow` / `run_flow` tools that take YAML strings; `acp.ts:274` runs YAML flows from agent prompts. After B1's deletion these would compile-but-misbehave (the server starts, tools fail on first call). Two-step migration:

1. **Tool schema rewrite.** `list_flows` → `list_tests` (returns `*.spec.ts` paths); `validate_flow` → `validate_tests` (typecheck + import-only sanity); `generate_flow` → `generate_test` (calls B5.5's TS spec generator); `run_flow` → `run_test` (invokes the runner against a single spec file or test name).
2. **Prompt-parser migration.** `acp-prompt-parser.ts` extracts test references from agent prompts. The "find a flow file matching X" semantics map cleanly to "find a `*.spec.ts` file matching X." Rename + glob change. The boundPath / boundResolveFlows realpath sandboxing logic (lessons.md entry #20) carries over verbatim — security-critical, no functional change.

**MCP/ACP integration tests** (`__tests__/integration/commands/acp-server.test.ts` is currently skipped; we don't have to maintain its skipped-state behavior, but the new run-test tool needs a fresh integration test).

**Cost:** ~280 LoC modified (two server files + prompt parser) + ~120 LoC new tests = ~400 LoC.

### Bundle 2 — Snapshot, inspect, refs (agent-browser port)

Port the agent-browser snapshot algorithm into TS. Most of B1's velvety-finding-beacon design carries; the difference is we have a TS API target instead of YAML refs.

**Code ports** (Apache 2.0, with `// Source:` headers):

- `cli/src/api/snapshot.ts:SnapshotTree` ports the rendering logic from `agent-browser/cli/src/native/snapshot.rs:1060-1230` (full / interactive / compact rendering, indent preservation, node visibility filtering).
- `cli/src/executor/aria-snapshot-capture.ts` extended: cursor-interactive second pass ported from `snapshot.rs:609-720` (`cursor:pointer` + `onclick` + `tabindex` heuristic, exclude-already-interactive-tags filter, child-of-interactive-ancestor pruning, 100-cap).
- `cli/src/executor/aria-ref-resolver.ts` becomes the locator factory: ported from `agent-browser/cli/src/native/element.rs:124-214` (`@eN` parsing, `kind`-aware dispatch with `getByRole(...).nth(n)` for `aria` and `resolveElement(page, ctx, selectorHint)` for `cursor-interactive`).
- `cli/src/executor/aria-ref-types.ts:RefEntry` mirrors `element.rs:18-33`: `{ kind, role, name?, nth?, selectorHint?, matchCountAtSnapshot }`.

**Pattern-only borrows** (from expect):

- `viewportAware` "N items hidden above/below" markers — pattern from `expect/runtime/lib/scroll-detection.ts:34-99`. Original implementation.

**`skeptic inspect <url>`** carries forward from velvety-finding-beacon §1.2 unchanged. New flags: `--connect <url>` for CDP auto-discovery (port from `agent-browser/cli/src/native/cdp/discovery.rs:1-100`).

**Per-link `href` extraction** — pattern from `agent-browser/cli/src/native/snapshot.rs:416`. Implementation: `await Promise.all(linkRefs.map(ref => locator.getAttribute("href")))` capped at 50.

**Acceptance:**
- `tests/snapshot.spec.ts` calls `await snapshot(page)`, asserts `tree.refs.size > 0`, `tree.byRole("link", { hrefIncludes: "github" }).click()` resolves to a real Locator.
- `skeptic inspect https://example.com` emits a YAML tree with refs, `selectorHint:` lines, exit 0 within 5 s.
- `skeptic inspect <url> --connect ws://localhost:9222` connects to a running Chrome.
- Cursor-interactive fixture (`__tests__/fixtures/cursor-interactive.html` with `<div onclick>` + a `<button>` for the negative case) — heuristic captures the div, NOT the button.
- Insertion-retarget warning: same regression test as velvety-finding-beacon, guarded by `matchCountAtSnapshot`.

**Cost:** ~600 LoC new (ports + tests). The bundle is smaller than velvety-finding-beacon's B1 because the TS API absorbs the resolver-discriminator + recorder-extraction work directly.

### Bundle 3 — Cursor overlay polish (inspiration only — independent reimplementation)

Five user-facing improvements, **all written from scratch** without reading expect's source (Codex round 2 architecture note — FSL non-compete safety):

1. **sessionStorage cursor persistence.** Debounced (~500 ms) write of cursor coordinates relative to viewport (so they scale on resize/zoom). Restored on overlay init.
2. **Shape detection.** On mousemove, read `getComputedStyle(elementFromPoint(x,y)).cursor` and swap inline SVG. Five shapes: pointer / text / grab / move / not-allowed. Original SVG paths drawn for each.
3. **Glow-pulse ambient animation.** Subtle pulsing ring around the cursor while idle. ~2 s loop, our own keyframes (no copy).
4. **Action markers.** Numbered badges at click points. Source-of-truth is the runner's per-test action log: after each successful interaction-target operation, the runner calls `cursor.recordAction(commandName, x?, y?)` via `page.evaluate`. Marker fades over a couple seconds.
5. **Tooltip label.** Brief tooltip above the cursor showing the current step's command name (NOT args — PII safety). Cleared after a short timeout. `cursor.setCommandLabel(commandName)`.

**Implementation surface:** in TS-imperative mode the action log can't come from a step-handler dispatch loop. **Action-marker capture is best-effort, NOT a correctness dependency** (Codex round 1 #6).

Two complementary signals, in priority order:

1. **Page Proxy (best-effort).** The fixture's `page` is a Proxy that intercepts the common interaction methods on `Page` (`click`, `fill`, `hover`, `dblclick`, `selectOption`, `press`, `type`, `uncheck`, `check`) and on `Locator` (same set, plus the chain-returning methods `locator`, `getByRole`, `getByText`, `getByLabel`, `getByPlaceholder`, `getByTestId`, `filter`, `and`, `or`, `first`, `last`, `nth`, `frameLocator` — return wrapped Locators). Direct keyboard/mouse APIs (`page.keyboard.press`, `page.mouse.click`), JS-triggered actions, and frames are NOT covered. Methods are bound to the original target via `Reflect.apply(target[prop], target, args)` so Playwright's internal `this` references aren't broken.
2. **Step-result side-channel (fallback for fixture-routed actions ONLY — Codex round 2 #9).** When the user calls a fixture method (e.g. `await screenshot(...)`, `await snapshot(...)`, `await ai.assert(...)`), the runner's `runAction(label, fn)` wrapper emits an action-marker event with a synthetic coordinate (page center if no Locator target). **This fallback does NOT cover** raw `page.keyboard.press(...)`, `page.mouse.click(...)`, `page.evaluate(() => button.click())`, or any direct CDP call — those bypass both the Proxy and the fixture wrapper. The acceptance test's documented-gap row explicitly lists these as "no marker" so test authors and reviewers know what's covered.

Test (`__tests__/integration/cursor/proxy-coverage.test.ts`): exercise 8 representative call shapes (`page.click`, `page.locator(css).click`, `page.locator(css).filter(...).click`, `page.frameLocator(...).locator(...).click`, `page.keyboard.press`, raw `await locator.click()` from a stored Locator, `page.evaluate(() => button.click())`). Document which the Proxy catches and which fall back to step-result-driven markers. Keep test as living documentation of the gap.

Implementation cost: ~150 LoC for the Proxy wrappers + ~60 LoC for the action-log structures + ~80 LoC for the test = ~290 LoC.

**Cost:** ~310 LoC + ~150 LoC of tests = ~460 LoC.

### Bundle 4 — Annotated screenshot mode

Carry forward velvety-finding-beacon B2 unchanged in design. Implementation:

- `screenshot(name, { annotate: true })` on the fixture → snapshot, get bboxes via the locator factory, project for fullPage by adding `scrollY`, inject Shadow-DOM-isolated badges, hide cursor overlay, capture PNG, restore in `finally`, attach `annotation-map` diagnostic to the test result (ref + role + boundingBox + selectorHint, no `name` field for PII).
- `skeptic inspect <url> --annotate --output ./annotated.png` produces the same annotated PNG + emits the annotation map to stdout.

**Cost:** ~280 LoC + ~120 LoC tests = ~400 LoC.

### Bundle 5 — A11y dual-engine + perf-trace richness

Carry forward velvety-finding-beacon B4 verbatim, with one acceptance fix (Codex round 1 #7):

- Add `accessibility-checker-engine` to `cli/package.json:optionalDependencies`. README section updated.
- `--observability` profile flips `accessibilityDualEngine: true`. **Acceptance gate is conditional**: when the `accessibility-checker-engine` peer is loadable, assert `metrics.accessibility.summary.dualEngine === true && violations >= 5`. When the peer is NOT loadable (slim binary, install failed), assert `dualEngine === false && violations >= 1` (axe-only baseline). Test reports which path it took. The CI matrix runs the verification benchmark with the peer installed, separately runs against the slim build to verify graceful-degrade.
- `LongAnimationFrame.scripts[].forcedStyleAndLayoutDuration` field added (script-level per Chromium spec, not frame-level — Codex round-2 finding from velvety-finding-beacon survives).
- Server-Timing capture in navigation-timing block.
- Perf-trace markdown gets POOR/forced-layout severity flags and a script ranking subsection.

**Cost:** ~140 LoC + ~110 LoC tests = ~250 LoC.

### Bundle 5.5 — `generate` rewrite + coverage source (Codex round 1 #4)

The existing `generate` is more than a prompt template — it has three coupled subsystems we have to migrate together:

1. **Prompt rewrite.** `cli/src/ai/prompts.ts` emits "produce a YAML flow with steps like `- click: …`." Rewritten to "produce a TS test using the skeptic API like `await page.click(...)`." Schema-validation example output included. ~80 LoC delta.
2. **Generated-output validation.** `cli/src/ai/flow-generator.ts:40` validates each LLM-generated chunk against the YAML Zod schema. TS replacement: write the LLM output to a temp `.spec.ts` file, run `tsc --noEmit` against it (using the existing `cli/src/commands/audit.ts` pattern that shells out to `tsc`), reject if compile fails. Optionally also dynamic-import the file and check it registers ≥1 test. ~120 LoC.
3. **Coverage source.** `cli/src/ai/coverage/coverage-builder.ts:43` and `route-resolver.ts:180` walk YAML flows to extract `navigate:` URLs as the "covered routes" set. TS replacement: a literal-AST extractor that walks a `*.spec.ts` file's AST (using `typescript`'s compiler API, which is already a dev dep) and extracts string-literal arguments to `page.goto(...)`, `expect(page).toHaveURL(...)`, and `await ai.assert(..., { url: ... })` calls. Conservative: only literal strings, no template literals or variables. Documented limitation: dynamic URLs require explicit `test.use({ urls: ["..."] })` declaration. ~150 LoC.

The diff-aware coverage system (which routes have tests, which don't, prioritize untested) carries over unchanged once the route extractor is rewired.

**Acceptance:** `skeptic generate -m "smoke test the hero"` emits a `*.spec.ts` that:
- typechecks clean
- imports without crashing
- contains ≥1 `test(...)` call
- runs to completion against the target site

**Cost:** ~350 LoC modified (prompts + generator + coverage) + ~80 LoC tests = ~430 LoC. The earlier "150 LoC for generate rewrite" estimate was wildly off (Codex round 1 #9).

### Bundle 6 — AGENTS.md + LICENSES.md + benchmark migration + verification

**`cli/AGENTS.md`** — adapted heavily from `agent-browser/AGENTS.md` (Apache 2.0, attributed). Sections:

- Overview — skeptic is a TS test runner; agents author `*.spec.ts`, run them, parse results.json.
- Discovery loop — `skeptic inspect <url>` to see refs/selectorHints, write a `*.spec.ts` using the suggestions, `skeptic run` to execute.
- Fixture cheatsheet — the 7 fixture members with usage examples.
- Snapshot vs. snapshot tree — when to use each; ref lifecycle.
- Output schema — `results.json` v0.3.0 (bumped from 0.2.0 — flow→test rename).
- Failure-mode guide — diagnostic kinds and how to act.
- Common patterns — login, multi-page nav, hover-then-click, scroll-into-view.
- Cursor + video — what the action markers mean.

**`cli/LICENSES.md`** — full Apache 2.0 text + NOTICE block listing every ported file:

```
This product includes software developed by Vercel Inc. (agent-browser),
licensed under the Apache License 2.0. Files derived from agent-browser:
- cli/src/api/snapshot.ts (rendering logic from snapshot.rs)
- cli/src/executor/aria-snapshot-capture.ts (cursor-interactive heuristic)
- cli/src/executor/aria-ref-resolver.ts (RefMap dispatch)
- cli/src/executor/aria-ref-types.ts (RefEntry shape)
- cli/src/runner/cdp-discovery.ts (CDP auto-connect)
- cli/src/api/annotation.ts (annotation-record shape, fullPage projection)
- cli/AGENTS.md (workflow doc structure)
```

`package.json.files` adds `"LICENSES.md"`. tsup banner prepends `/*! @license skeptic — see LICENSES.md for third-party attributions */` to the existing `createRequire` shim banner (preserving SEA-mode semantics).

**Migrate the benchmark fixtures.** The two `*.flow.yaml` files in `benchmark-artifacts/jigyansurout-20260429-053823/skeptic/` (the smoke flow and the comprehensive flow) get rewritten as `*.spec.ts`. The comprehensive test file becomes the integration acceptance test for B6.

**`skeptic generate`** rewrite — see Bundle 5.5 for the actual implementation (Codex round 2 #8 — the earlier "150 LoC, only template changes" estimate was wrong; B5.5 has the real work).

**Verification:**
1. Build clean (`npm run check && npm run build`).
2. Test suite green (`npm test`).
3. `skeptic run benchmark-artifacts/jigyansurout-comprehensive.spec.ts --observability --video --trace` runs to completion.
4. Output verification: `metrics.accessibility.summary.violations >= 5` (dual-engine), action markers visible in video, cursor persists across pages, annotated screenshot has labels.
5. `skeptic inspect https://jigyansurout.com` returns the social icons as `link "" [ref=eN] /url: https://github.com/iamjr15` style entries with selectorHints.
6. Comprehensive test re-author: blank slate, run `skeptic inspect`, copy `selectorHint` strings into a fresh `*.spec.ts`, run it. Should pass first try (the YAML version failed twice on the social-icon selector).
7. `skeptic generate -m "test the homepage hero"` emits a valid `*.spec.ts` that runs.

**Cost:** ~150 LoC for `generate` rewrite, ~700 LoC for the comprehensive `*.spec.ts` benchmark, ~300 LoC for AGENTS.md + LICENSES.md, ~200 LoC for tsup config + package.json + verification helpers = ~1350 LoC.

---

## 6. Total cost estimate (Codex round 2 #9 — re-estimated)

| Bundle | Removed | New | Tests | Net |
|---|---:|---:|---:|---:|
| B0.5 config + scaffolding + reporter renames + runtime deps + public package contract (NEW — Codex rounds 2 #3,#5,#6 + round 3 #1) | 0 | 530 | 130 | +660 |
| B1 pivot core (incl. worker-per-file isolation + requeue, runAction boundary, collector activation, stable test ids, hooks/skip/only/retry/sharding/timeout/sidecar/side-effect acceptance) | 3700 | 2800 | 1200 | +300 |
| B1.5 MCP/ACP migration | 0 | 280 | 120 | +400 |
| B2 snapshot/inspect/refs | 0 | 450 | 200 | +650 |
| B3 cursor overlay polish | 0 | 310 | 220 | +530 |
| B4 annotated mode | 0 | 280 | 120 | +400 |
| B5 a11y dual-engine + perf-trace richness | 0 | 140 | 130 | +270 |
| B5.5 generate rewrite + AST coverage + TS validation | 0 | 350 | 80 | +430 |
| B6 AGENTS.md + LICENSES.md + benchmark migration + verification | 0 | 880 | 0 | +880 |
| **Total** | **3700** | **6020** | **2200** | **+4520 LoC net** |

Codex round 2 budgeted +4000-5500; this lands at +4520. Codebase ends ~2000 LoC larger because the worker-thread runtime, B0.5 hidden coupling, and B1.5/B5.5 (which round 1 had buried in B6) all dominate the YAML deletion savings.

About **ten to fourteen engineering days** at typical pace. Ships incrementally; binary stays usable after each bundle.

**Stop-line**: if B1's runner code (`cli/src/runner/*` + `cli/src/api/*`) exceeds ~1400 LoC during implementation, halt and switch to a vitest adapter (vitest's worker-thread runner is mature; we'd write a fixture + reporter plugin). Honest stop-line, not aspirational.

---

## 7. Migration of existing artifacts

All three of these are part of B6:

1. `benchmark-artifacts/jigyansurout-20260429-053823/skeptic/jigyansurout-comprehensive.flow.yaml` → `jigyansurout-comprehensive.spec.ts`. Manual conversion; serves as the verification benchmark.
2. `cli/__tests__/integration/observability/sidecar-write.test.ts` and `auto-a11y-audit.test.ts` already use direct `PlaywrightEngine` calls, not YAML — they survive with minor type renames (FlowInput → TestInput).
3. `cli/__tests__/integration/commands/test-command.test.ts` and shard tests get rewritten to invoke `runTest` (the new runner) with synthetic test files. Existing assertions about reporter output / sharding behavior carry over.

No `*.flow.yaml` artifacts remain in the repo after B6 ships.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Custom runner is a non-trivial commitment.** vitest-as-runner would be ~200 LoC lighter. | The Custom path was the user's chosen option. Mitigation: minimum-viable runner (~700 LoC across discover/registry/execute/watch) deliberately mirrors vitest's surface so a future port is mechanical. No exotic features beyond what vitest/Playwright Test offer. |
| **`tsx` peer dependency adds Node version pinning.** | tsx supports Node 18+; skeptic already requires Node 22 (`package.json:engines`). No effective constraint added. |
| **Page Proxy for action-marker capture might break exotic Playwright APIs.** Things like `page.context()`, `page.frame()` need careful handling so wrapping doesn't return a bare object. | Implementation: Proxy pattern with a `Reflect.get` trap that only wraps the methods we care about (`click`/`fill`/`hover`/`dblclick`/`selectOption`/`press`/`type` plus their `Locator` equivalents). Everything else passes through unwrapped. Comprehensive integration test exercises each wrapped method + a few unwrapped ones. |
| **Hard-deleting the recorder removes a feature** (auto-generate from real browser usage). | Recorder is rebuilt in a follow-up plan as `skeptic record <url> --output tests/foo.spec.ts` — emits TS instead of YAML. **Out of scope for this pivot**; the existing recorder is a YAML emitter, not a TS emitter, and rebuilding it from scratch is half a bundle by itself. Tracked as Bundle-N+1. |
| **AI generate's prompt changes might regress flow quality.** | The `cli/__tests__/unit/ai/prompts.test.ts` snapshot tests get updated. New tests in B6 verify that generated `*.spec.ts` files compile + parse + match a structural skeleton check. |
| **expect-borrowing may breach FSL non-compete.** | Strict pattern-only policy with expect: no code copies, original implementations. Code review checklist: any line under `aurum-refs/expect/` we've read while authoring a corresponding skeptic file → call it out, write our version from a different angle. agent-browser is Apache 2.0 → free to copy with attribution. |
| **Per-file `// Source:` headers might be stripped by tsup.** | The same mitigation as velvety-finding-beacon: tsup banner prepended to existing `createRequire` shim banner; file-level attribution lives in `cli/LICENSES.md`. |
| **`skeptic run` flag set has to match `skeptic test`'s flag set or users (future) get confused.** | All flags carry over verbatim. New flags are additive (`--list`, `--connect`). The README + AGENTS.md call out the rename + flag mapping table. |
| **The pivot ships in one v0.2.0 release with a breaking change.** | We have no users. v0.1.x → v0.2.0 explicitly removes YAML in CHANGELOG. Anyone with an in-progress YAML can continue with v0.1.x; the tarball stays on npm. Future migration tool tracked in the same Bundle-N+1 as the recorder rebuild. |

---

## 9. Out of scope (explicit non-goals)

- **No daemon mode.** Same reasoning as velvety-finding-beacon: stays out.
- **No CDP-direct rewrite.** Playwright stays.
- **No recorder.** Deferred to Bundle-N+1.
- **No YAML migration tool.** No users.
- **No vitest adapter.** User chose custom runner.
- **No Playwright Test fixture mode.** User chose custom runner.
- **No browser automation beyond Chromium initially.** Existing webkit/firefox engine option carries over but isn't part of the verification benchmark.

---

## 10. Verification (end-to-end)

After all six bundles ship:

1. `cd cli && npm run check && npm test && npm run build` — all green.
2. `node dist/skeptic.mjs --help` shows the `run`, `inspect`, `generate`, `init`, `add`, `cookies`, `mcp`, `acp`, `comment`, `audit`, `browsers` commands. No `test`, `validate`, `record`.
3. `node dist/skeptic.mjs run benchmark-artifacts/.../jigyansurout-comprehensive.spec.ts --observability --video --trace` — completes; results.json v0.3.0 present; sidecars + report present; cursor visible across pages in video; ≥ 5 a11y violations.
4. `node dist/skeptic.mjs inspect https://jigyansurout.com/` — YAML tree to stdout, social icon links surface as `link "" [ref=eN] /url: ...`, exit ≤ 5 s.
5. `node dist/skeptic.mjs inspect https://jigyansurout.com/ --annotate --output ./annotated.png` — PNG written, annotation map echoed to stdout.
6. `node dist/skeptic.mjs generate -m "smoke test the hero"` — emits a syntactically-valid `*.spec.ts` file that compiles + runs.
7. Comprehensive flow re-author (the gold-path agent test): blank slate → `inspect` → write `*.spec.ts` using `selectorHint`s → `run`. Passes first try, no selector failures.

---

## 11. Why this is the right pivot

The TS API is the same shape as Playwright Test, vitest browser-mode, and Cypress — the patterns AI agents already know. The agent-browser code we port is Apache 2.0 and explicitly designed for agent UX; the borrow is clean. The expect features we mirror (cursor polish, dual-engine a11y, perf-trace richness) are pure UX/diagnostic value with no architectural lock-in. Skeptic's actual moat — AI assertions, observability bundle, cursor overlay, inspect/snapshot — all integrate naturally with `await` and become more useful in TS-imperative form than they were in YAML-declarative.

The decision the user pushed back on — "what's the point of YAML?" — was the right one. Strip it; everything else falls into place.
