# Plan: Bundle 3 Observability — Follow-up Work

## Context

Bundle 3 (observability collectors) landed in `plans/crunchy-observing-starling.md` — production code is complete, 116 new tests pass, end-to-end smoke verified against a real browser. This follow-up plan captures **every** item that was deferred during implementation, skipped under a narrow-to-ship constraint, or flagged as a v2 feature. Total: 4 workstreams, ~20 discrete items.

**Audit (performed 2026-04-24):** 9 of 15 planned test files landed (60%). 3 integration smoke tests are missing. The engine-lifecycle integration test I drafted was removed mid-implementation because `it.skipIf` with `vi.spyOn` on ESM modules didn't work as expected. Documentation wasn't updated. Four minor code-quality issues were left in the production code, all annotated in the audit report.

**Scope:** This plan covers four phases plus a roadmap. Phases 1–3 are must-do to call Bundle 3 "finished." Phase 4 is the roadmap of legitimately-deferred features — each should be picked up as its own plan when prioritized.

**Non-goals:**
- Re-opening the Bundle 3 design. The Collector interface, `FlowResult.metrics` shape, config block, and step-handler contracts are frozen. Anything touching those structurally needs a new plan.
- Shipping every Phase 4 roadmap item. Those are capacity-dependent; this plan enumerates them so they're not forgotten, not so they're scheduled.

---

## Phase 1 — Close the test-coverage gaps

**Why must-do:** the plan promised 3 integration smoke tests plus a combined E2E plus an engine-lifecycle test. Without them, the three new step handlers' real-browser behavior is untested in CI — regressions would ship.

### 1.1 Performance smoke test

**Files (new):**
- `cli/__tests__/integration/observability/performance-smoke.test.ts`
- `cli/__tests__/fixtures/observability/perf-test.html`

Fixture HTML: a page with a large `<img>` for LCP (use a ~500KB data URL so we don't depend on network), a click handler that triggers a 300ms synchronous loop for INP, and enough body content to force FCP.

Test steps: spawn `http.createServer` serving the fixture → launch `PlaywrightEngine` with `observability.collectors: ["performance"]` → run a flow: `navigate: /` → `wait: 1000` (let metrics fire) → `click: #btn` → `wait: 500` → `assertPerformance: { lcp: "<5s", cls: "<0.5" }`. Assert flow passed and `FlowResult.metrics.performance.lcp` is non-null.

**Gating test:** run on Chromium only (Firefox's LCP observer fires differently); skip on CI without browsers (pattern from `cli/__tests__/integration/commands/test-command.test.ts`).

**Covers:** full path from `addInitScript` → `web-vitals` IIFE → observer wiring → `page.evaluate` snapshot read → threshold check.

### 1.2 Network smoke test

**Files (new):**
- `cli/__tests__/integration/observability/network-smoke.test.ts`
- `cli/__tests__/fixtures/observability/network-test/index.html`
- `cli/__tests__/fixtures/observability/network-test/server.js` (or inline in the test)

Fixture: `http.createServer` serving `/index.html` (HTML with a button that fires two `/dup` requests synchronously + one `fetch('http://nonexistent.invalid/')` for a DNS failure), `/api` (returns 500), `/dup` (returns 200).

Test: navigate → click button → `assertNoNetworkErrors: { allowStatus: [404] }` → expect **failed** with error message naming the 500 + the duplicate + the DNS failure (networkFailures category).

**Scope note (per plan):** mixed-content and CORS stay unit-tested via `FakePage.emit()` in `cli/__tests__/unit/observability/network-collector.test.ts:172-225`. Adding HTTPS fixture is v2.

### 1.3 Accessibility smoke test

**Files (new):**
- `cli/__tests__/integration/observability/accessibility-smoke.test.ts`
- `cli/__tests__/fixtures/observability/a11y-test.html`

Fixture: a page with a known axe-catchable violation (e.g. `<img>` with no alt, or buttons without accessible names, or a color-contrast failure).

Two test cases:
1. `accessibilityAudit: { standard: "WCAG2AA" }` → expect failed with at least one violation surfaced in error message.
2. `accessibilityAudit: { standard: "WCAG2AA", exclude: ["img"] }` → expect passed.

**Covers:** real AxeBuilder instantiation, WCAG tag filtering, `include`/`exclude` selector passthrough, and the violation → StepResult error-string shape.

### 1.4 Engine-lifecycle integration test (re-do)

**File (new):** `cli/__tests__/unit/observability/engine-integration.test.ts`

The initial attempt at this test (drafted during Bundle 3 Phase 1, then deleted) tried to use `vi.spyOn(registry, "buildCollectors").mockReturnValue([stubCollector])` combined with `it.skipIf(!browser)`. The skip check ran at test-registration time, before `beforeAll` executed, so every test skipped regardless of browser availability. Rewrite using the project's established mocking pattern.

**Approach: ESM module-level `vi.mock` with `vi.hoisted`.** The repo already uses this pattern at `cli/__tests__/unit/commands/test-command-trace.test.ts:1-22` to stub `PlaywrightEngine`. Apply the same idiom to the registry:

```ts
import { vi } from "vitest";

const { stubFactory } = vi.hoisted(() => {
  const collectors: Array<{ name: string; behavior: { attachThrows?: boolean; snapshotThrows?: boolean; detachThrows?: boolean }; spies: { attach: ReturnType<typeof vi.fn>; snapshot: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> } }> = [];
  return {
    stubFactory: { collectors, reset: () => { collectors.length = 0; } },
  };
});

vi.mock("../../../src/observability/registry.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/observability/registry.js")>();
  return {
    ...actual,
    buildCollectors: vi.fn(() => stubFactory.collectors.map((c) => ({
      name: c.name,
      attach: c.spies.attach,
      snapshot: c.spies.snapshot,
      detach: c.spies.detach,
    }))),
  };
});
```

Per-test, each test populates `stubFactory.collectors` with the desired stubs and calls `engine.runFlow(input)` against a real Chromium. Resolve the browser at module top-level (top-level `await` is supported by vitest) so `describe.skipIf(!browser)` evaluates correctly:

```ts
let browser: Browser | null = null;
try {
  browser = await chromium.launch({ headless: true });
} catch { /* not available */ }

describe.skipIf(!browser)("PlaywrightEngine collector lifecycle", () => {
  afterAll(async () => { if (browser) await browser.close(); });
  beforeEach(() => stubFactory.reset());
  // tests
});
```

**Why this is better than the rejected `_collectorFactoryOverride`:**
- `EngineOptions` is exported public runtime API. Adding `_collectorFactoryOverride` would leak a test-only knob into the public surface.
- The `vi.mock` boundary is invisible to production code — no production type changes, no field that has to be documented as "do not use" forever.
- Matches an established pattern already in the repo (`test-command-trace.test.ts`).

**Five test cases:**
- Attach → snapshot → detach called in order; `FlowResult.metrics` populated.
- Attach failure drops the collector; flow still runs; no metrics emitted for that collector.
- Snapshot failure logged; other collectors still populate.
- Detach failure does not mask flow status.
- Null-valued snapshot is not included in `FlowResult.metrics`.

**Alternative if the integration test still proves brittle:** drop it, rely on the combined E2E (1.5) plus per-phase smokes (1.1-1.3) for lifecycle coverage. Document the trade-off.

### 1.5 Combined Bundle 3 E2E

**Files (new):**
- `cli/__tests__/integration/observability/bundle3-e2e.test.ts`
- `cli/__tests__/fixtures/observability/bundle3/index.html`
- `cli/__tests__/fixtures/observability/bundle3/flow.yaml`

Single flow exercising all three step types. **Key constraint:** the flow-parser at `cli/src/parser/flow-parser.ts` preserves literal metadata URLs as-is (verified against `cli/__tests__/unit/parser/flow-parser.test.ts:15`); `flowToInput` at `cli/src/commands/test.ts:465` falls back to `baseUrl` only when `flow.metadata.url` is absent. So `url: http://localhost:{PORT}` would NOT be templated.

**Fix the fixture approach.** Omit `url:` from the flow metadata; the test passes the runtime URL via `baseUrl` to `flowToInput`:

```yaml
# bundle3/flow.yaml — no url in metadata
---
name: Bundle 3 smoke
---
- navigate: /
- wait: 1000
- click: "#load-data"
- wait: 500
- assertPerformance: { lcp: "<5s", cls: "<0.5" }
- assertNoNetworkErrors: { allowStatus: [404] }
- accessibilityAudit: { standard: "WCAG2AA" }
```

```ts
// in the test
const server = http.createServer(...).listen(0);
const port = (server.address() as AddressInfo).port;
const baseUrl = `http://localhost:${port}`;
const flow = parseFlowFile(fixtureFlowPath);
const input = flowToInput(flow, baseUrl, {}, 0);
const result = await engine.runFlow(input);
```

Assert: flow passed, `FlowResult.metrics` has all three namespaces. Specifically `metrics.performance.lcp !== null`, `metrics.network.requests.length > 0`, `metrics.accessibility.summary.violations` is a number.

**Gating:** `listen(0)` picks a free port; no clash with parallel tests. Cleanup via `server.close()` in `afterAll`.

### 1.6 IBM Equal Access dual-engine validation

**Problem:** `cli/src/observability/collectors/accessibility-collector.ts:177-209` supports `accessibility-checker-engine` as an optional peer. No test verifies this path actually works — the existing unit test at `cli/__tests__/unit/observability/accessibility-collector.test.ts` mocks both `@axe-core/playwright` AND the `createRequire.resolve` behavior. If IBM's `ace.js` layout changed or the `page.evaluate` serialization hack broke, we'd never know.

**Two options:**

a) **Skip-if-not-installed integration test** (preferred). New file `cli/__tests__/integration/observability/ibm-dual-engine.test.ts`. At file top:
```ts
let ibmInstalled = false;
try {
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  req.resolve("accessibility-checker-engine/ace.js");
  ibmInstalled = true;
} catch { /* not installed */ }
```
Wrap the entire `describe` block in `describe.skipIf(!ibmInstalled)`. CI config (to be added separately): one job installs the peer dep and runs the test; default CI doesn't. Matches the pattern `@playwright/test` uses for optional browser installs.

**Serial execution required.** IBM `accessibility-checker` has known `ace.Checker is not a constructor` failures when multiple checks run in parallel against the same page context. Mark the test file with `vitest`'s `concurrent: false` (which is the default but make it explicit via `describe.sequential`), and avoid running this test in parallel with other a11y tests. If we add a CI matrix job for the dual-engine path (recommended), pin `--no-file-parallelism` for that job's vitest invocation.

b) **Document and defer.** Add `## Testing` section to plan doc saying "dual-engine path is exercised only via the mocked unit test; real-engine verification requires manual setup of `accessibility-checker-engine`." Less good — leaves a meaningful code path without coverage.

**Recommendation:** ship option (a). The IBM peer is documented as "install if you want dual-engine"; a test that runs only when it's installed is the right shape.

**Precondition:** Phase 2.4a (IBM standard mapping fix) must land before this test. Otherwise the test's WCAG2A/WCAG21AA invocations don't actually reach IBM with the right profile.

---

## Phase 2 — Code-quality cleanup

Small fixes flagged by the audit. All are local to files touched by Bundle 3.

### 2.1 Network collector: remove dead `windowStart` variable

**File:** `cli/src/observability/collectors/network-collector.ts:153, 169`

`windowStart` is assigned twice (lines 153, 169) and never read downstream. A `void windowStart` at line 185 was added to silence the unused-var warning. Decision: delete the variable and the `void` suppression, keep `windowCount` which is the actual state. Check the current algorithm still produces correct duplicate groups after removal — it does (duplicates are reported on `windowCount >= 2`, not on `windowStart`).

### 2.2 Registry: clarify `runFlow` double-scan behavior

**File:** `cli/src/observability/registry.ts:74-90, 133-148`

When a step is `{ runFlow: { file: "./child.yaml", commands: [...] } }` (object form with both external file and inline commands), `visit()` handles it once at lines 88-89 via `scanExternalFile(args.file, ...)`. But the recursive `scanRawSteps` at lines 133-148 also fires `scanExternalFile` for `composite === "runFlow"` at lines 145-146. The `visited` set prevents infinite loops but the logic path is duplicated.

**Fix:** consolidate external-file resolution into a single code path. Either:
- Remove the `scanExternalFile` call inside `scanRawSteps`'s composite loop (lines 145-146) on the grounds that composite-step traversal from `visit()` already covers it; OR
- Remove `visit()`'s `scanExternalFile` call (lines 88-89) and rely on `scanRawSteps` for all external-file resolution.

Either way, add a comment explaining which path is authoritative. Include a regression test: a flow with `{ runFlow: { file: "./child.yaml", commands: [{ assertPerformance: ... }] } }` must resolve both the child file AND the inline commands, and the child file must be scanned exactly once (assertable via a spy on `parseFlowFile`).

### 2.3 Performance collector: defensive IIFE path resolution

**File:** `cli/src/observability/collectors/performance-collector.ts:14-22`

`resolveWebVitalsIifePath()` synchronously resolves `web-vitals` ESM entry at module load. If a future web-vitals minor removes the `dist/` IIFE variant (unlikely but possible), `readFile` at line 23 throws at first call. The error propagates to the first `attach()` invocation, which `PlaywrightEngine` catches at line 143, logs a warning, and drops the collector — user sees "Collector 'performance' attach failed: ENOENT" with no context.

**Fix:** add a one-time sync existence check at module load. If missing, log a warn and set `WEB_VITALS_IIFE_PATH = null`; `loadWebVitalsSource` returns empty when null, `buildInitScript` then no-ops (the `typeof webVitals === 'undefined'` guard already handles this). Error surfaces cleanly at import time with a message pointing at the web-vitals package, not a mysterious ENOENT deep in attach.

Alternative: pin `web-vitals` to `^4.2.4` in package.json (already done) and add a unit test asserting `WEB_VITALS_IIFE_PATH` exists on disk. Cheapest and catches regressions from `npm install` variations.

### 2.4 Accessibility collector: propagate audit failures (refined)

**File:** `cli/src/observability/collectors/accessibility-collector.ts:163-170, 223-227`

Both `runAxe()` and `runEqualAccess()` catch errors and log a warning via the collector's `logger.warn` (lines 183, 294 today), then return empty results. If axe instantiation throws (missing `page.context()`, CSP blocking script injection, etc.), the handler sees `violations: []` and reports `"passed"`. Users see a warn line in their log but the step result still says passed — the failure mode isn't carried through to the structured result.

**Wrong fix (rejected by Codex):** treat any errored engine as a hard `status: "error"`. With dual-engine enabled, a clean axe pass + IBM crash would flip to error — too aggressive.

**Right fix — track per-engine status, surface as `error` ONLY when ALL requested engines errored:**

Extend `AccessibilitySnapshot.summary` with two **optional** fields (keeping the existing required fields untouched, so the ~12 test fixtures that hand-construct `AccessibilitySnapshot` literals at `cli/__tests__/unit/reporter/metrics-display.test.ts:50,56` and `cli/__tests__/unit/executor/step-handlers/accessibility-audit.test.ts:50,62,76,88,106,119,130,143,156` keep compiling):

```ts
summary: {
  violations: number;
  passes: number;
  incomplete: number;
  dualEngine: boolean;
  // NEW — both optional to avoid fixture churn across existing tests
  enginesRequested?: Array<"axe" | "equal-access">;
  enginesErrored?: Array<{ engine: "axe" | "equal-access"; reason: string }>;
}
```

`runAxe()` and `runEqualAccess()` keep their existing `logger.warn` calls — those stay (closest log-line to the failure point, useful for users grepping debug output). They additionally return a `{ erroredReason?: string }` field on their internal result. `audit()` aggregates into `summary.enginesRequested` (always includes `"axe"`; includes `"equal-access"` only when `options.dualEngine && this.equalAccessLoaded === "yes"`) and `summary.enginesErrored`.

**Handler behavior in `cli/src/executor/step-handlers/accessibility-audit.ts`:**
- Default both fields when undefined (back-compat for hand-constructed snapshots in tests):
  - `const enginesRequested = snap.summary.enginesRequested ?? ["axe"];`
  - `const enginesErrored = snap.summary.enginesErrored ?? [];`
- If `enginesErrored.length === enginesRequested.length` (all requested engines failed) → return `status: "error"` with concatenated reasons.
- Otherwise → today's behavior unchanged. **Do NOT add a redundant `logger.warn` in the handler** — the collector already emitted the warn on each engine's failure (see `accessibility-collector.ts:183, 294`), so a handler-level warn would double-log. The structured-result fields (`enginesErrored`) are sufficient for downstream tooling (HTML reporter, JSON reporter) to pick up partial-failure metadata.
- `enginesErrored.length === 0` → today's behavior, no change.

This preserves the "axe pass + IBM crash → partial result, axe wins, structured failure fields populated" semantic that dual-engine users implicitly accept (IBM is best-effort), while surfacing the failure mode where every engine actually crashed.

**Invariant for the new fields:** `enginesRequested` and `enginesErrored` are populated TOGETHER or BOTH OMITTED. The collector always emits both as a pair when it produces a snapshot via the new code path; the `?? ["axe"]` / `?? []` fallback exists strictly for legacy hand-built fixtures that pre-date this change. Fresh code that hand-constructs an `AccessibilitySnapshot` should populate both or neither — never just one.

**Page-closed branch (`cli/src/observability/collectors/accessibility-collector.ts:107-115`):** today's `audit()` returns an empty snapshot (no violations) when the page is closed/missing, which the handler currently reports as `status: "passed"`. With Phase 2.4's new fields, **also** populate `enginesErrored` in this branch — mark every requested engine as errored with reason `"page closed or unavailable before audit"`. The handler's "all-failed" check then correctly surfaces this as `status: "error"`, removing the last false-pass path.

**Test cases (split across two files):**

*Collector unit tests (extend `cli/__tests__/unit/observability/accessibility-collector.test.ts`):*
- axe runs clean, IBM not requested (single-engine) → snapshot has `enginesRequested: ["axe"]`, `enginesErrored: []`.
- axe runs clean, IBM requested + throws → snapshot has `enginesRequested: ["axe", "equal-access"]`, `enginesErrored: [{ engine: "equal-access", reason: ... }]`, summary still carries axe's violations.
- axe throws, IBM not requested → snapshot has `enginesRequested: ["axe"]`, `enginesErrored: [{ engine: "axe", ... }]`.
- Both axe and IBM throw → snapshot has both engines in both arrays.
- Page closed before audit → snapshot has `enginesErrored` populated for every engine in `enginesRequested` with reason `"page closed or unavailable before audit"`.
- Collector's `logger.warn` emitted on each engine failure (existing behavior preserved).

*Handler tests (extend `cli/__tests__/unit/executor/step-handlers/accessibility-audit.test.ts`):*
- Snapshot with `enginesErrored.length === 0` → status passed (or failed on violations) — today's behavior, regression check.
- Snapshot with `enginesErrored.length > 0 && enginesErrored.length < enginesRequested.length` → partial failure: status passed/failed based on surviving engine's violations, **no handler-level `logger.warn`** (collector already warned).
- Snapshot with `enginesErrored.length === enginesRequested.length` → status `"error"`, error message contains every engine's reason.
- Snapshot with `enginesRequested === undefined` (legacy fixture) → handler defaults to `["axe"]` and applies the rule normally.
- Snapshot with both new fields undefined (legacy fixture) → handler treats as "axe-only, no errors" → today's behavior preserved.
- Spy on `logger.warn` to confirm the handler does NOT call it for partial-failure cases.

### 2.4a Fix IBM hardcoded WCAG_2_2 standard

**File:** `cli/src/observability/collectors/accessibility-collector.ts:242`

The current code hardcodes `checker.check(g.document, ["WCAG_2_2"])` regardless of `invocation.standard`. With dual-engine enabled, `accessibilityAudit: { standard: "WCAG2A" }` returns axe-WCAG2A merged with IBM-WCAG2.2 — inconsistent and misleading.

**Fix — map invocation.standard to IBM profile:**

```ts
const STANDARD_TO_IBM_PROFILE: Record<AuditInvocation["standard"], string> = {
  WCAG2A:   "WCAG_2_0",
  WCAG2AA:  "WCAG_2_0",
  WCAG21A:  "WCAG_2_1",
  WCAG21AA: "WCAG_2_1",
  WCAG22AA: "WCAG_2_2",
};
```

Pass the mapped profile into `checker.check`:
```ts
const ibmProfile = STANDARD_TO_IBM_PROFILE[invocation.standard];
const report = await checker.check(g.document, [ibmProfile]);
```

**Asymmetry note:** IBM's profile granularity is coarser than axe's (no AA distinction within a WCAG version — IBM rules are flagged with their applicability). This is a documented limitation of IBM Equal Access; the mapping above picks the closest fit. Document in the JSDoc on the constant.

**Plan-level cleanup:** delete the existing claim in the original Bundle 3 plan that "IBM WCAG standard hardcoded to `WCAG_2_2`; document that `standard` applies to axe only." With this fix it applies to both engines (with the asymmetry noted).

**Test:** extend `cli/__tests__/unit/observability/accessibility-collector.test.ts` to assert the mapped profile is passed to IBM's checker for each of the five WCAG standards. Use the existing `vi.mock` pattern; spy on the script's evaluate-arg shape.

### 2.5 Standardize collector logger prefixes

Three collectors use inconsistent prefixes:
- `performance-collector.ts:111` — `[performance]`
- `accessibility-collector.ts:184, 203, 209, 225` — `[a11y]`, `[a11y:axe]`, `[a11y:equal-access]`
- `network-collector.ts` — no logging at all

**Fix:** standardize on `[perf]` / `[net]` / `[a11y]` (short, consistent with existing `[softTimeout]`, `[retryIfNoChange]` conventions in the executor). Add a `debug` log in `NetworkCollector.detach()` that reports the final request count — cheap to add, useful for debugging flow-level behavior. One grep + sed replace per collector.

### 2.6 URL token redaction (pulled forward from Phase 4)

**Status:** Raw URLs are captured at `cli/src/observability/collectors/network-collector.ts:43`, rendered into failure strings at `cli/src/executor/step-handlers/assert-no-network-errors.ts:48`, and serialized verbatim by the JSON reporter at `cli/src/reporter/json-reporter.ts:29`. Tokens or PII in query strings flow to disk reports — present privacy leak.

**Why pull this up:** the original Bundle 3 plan flagged this as a v2 follow-up with the rationale that heuristic redaction would break debugging. Codex pushed back: the snapshot feeds both step handlers AND reporters, so a "preserve raw, redact on hand-off" design is more invasive than the original 1-day estimate. The minimum-viable fix is much smaller — redact at capture time for known token-shaped query parameters only.

**MVP scope (this phase):**
- New helper at `cli/src/observability/url-redact.ts`.
- Two-tier matching for the default redact-list:
  1. **Exact-name match** (case-insensitive): `token`, `apikey`, `api_key`, `auth`, `authorization`, `secret`, `password`, `pwd`, `access_token`, `refresh_token`, `bearer`, `signature`, `sig`, `nonce`, `csrf`, `key`, `private_key`, `session`, `sessionid`, `session_id`. Bare `key` is included because Google APIs (Maps Static, etc.) document it as a sensitive auth parameter.
  2. **Suffix match** (case-insensitive, on the trailing hyphen-or-underscore segment of the param name): `-signature`, `-credential`, `-security-token`, `-token`, `-secret`, `-key`. This catches vendor-prefixed presigned-URL params: AWS SigV4 (`X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Security-Token`), Google Cloud (`X-Goog-Signature`, `X-Goog-Credential`), Azure SAS (`sig`, `se`, `sp` — `sig` covered by exact match), etc. AWS's Presigned URL Best Practices doc explicitly recommends redacting `X-Amz-Signature` from logs.
- Normalize before matching: lowercase the parameter name and treat `-` and `_` as equivalent (so `X-Amz-Signature` and `X_AMZ_SIGNATURE` both match).
- Apply at `NetworkCollector.onRequest` callback when computing `entry.url`. Replace value with `***` (length-preserving not required; transparency over fidelity).
- Skip the helper when the URL has no query string (cheap fast-path).
- Both `entry.url` and `entry.frameUrl` get the same treatment.
- Issue records (`failedRequests`, `duplicates`, `mixedContent`, `corsErrors`, `networkFailures`) all carry already-redacted URLs because they reference `entry.url`.

**False-positive guards:**
- Suffix match requires a separator (`-` or `_`) before the suffix string. `lookup` does not match `-key` because there's no separator. `link-key` does match. This is implemented by checking the normalized name ends with `_<suffix>` after dash→underscore normalization.
- Bare `key` is exact-match only — never suffix-matched, so `subkey` and `linkKey` do not match. Vendor-prefixed `*-key` (`X-Amz-Key`) goes through the suffix path.

**Out of MVP (deferred to original Phase 4.3 — now repositioned as 4.3' "extended URL redaction"):**
- Per-flow opt-out (`observability.network.captureRawUrls: true`).
- User-defined redact-list extension via config.
- Path-segment redaction (e.g. `/users/{id}/...`).
- Header redaction.

**Files:**
- `cli/src/observability/url-redact.ts` — NEW. Single function `redactUrl(url: string): string`, plus exported `DEFAULT_REDACT_PARAMS` constant.
- `cli/src/observability/collectors/network-collector.ts` — apply redaction in `onRequest` before storing in `entry`.
- `cli/__tests__/unit/observability/url-redact.test.ts` — NEW. Cases:
  - **Pass-throughs:** no query → unchanged; URL fragments preserved; non-HTTP URLs (`data:`, `blob:`) → unchanged.
  - **Exact-match defaults:** `?token=abc` → `?token=***`; `?password=p` → `?password=***`; mixed `?safe=1&token=abc` → `?safe=1&token=***`; case insensitive `?Authorization=...` → redacted; multi-value `?token=a&token=b` → both redacted.
  - **Vendor-prefixed (suffix-match):** `?X-Amz-Signature=...` → redacted; `?X-Amz-Credential=...` → redacted; `?X-Amz-Security-Token=...` → redacted; `?X-Goog-Signature=...` → redacted; case-insensitive `?x-amz-signature=...` → redacted.
  - **Bare `key`:** `?key=YOUR_API_KEY` → redacted (covers Google Maps Static).
  - **False-positive guards:** `?lookup=foo` → unchanged (no separator before `key`); `?subkey=x` → unchanged; `?linkkey=x` → unchanged; `?link_key=x` → REDACTED (separator present); `?network=x` → unchanged.
  - **Hyphen/underscore equivalence:** `?X_Amz_Signature=...` → redacted same as `?X-Amz-Signature=...`.

**Documentation impact:** update the README security note (Phase 3.1) to say "URL query parameters with token-shaped names are redacted by default; full opt-out is a v2 follow-up."

**Test impact:** existing network-collector tests that assert on `entry.url` for URLs without redacted params are unaffected. Tests using URLs like `/api?token=...` need to be updated — search the existing suite and adjust assertions.

---

## Phase 3 — Documentation and DX

### 3.1 README observability section

**File:** `cli/README.md`

Audit confirms zero mentions of `observability`, `assertPerformance`, `assertNoNetworkErrors`, `accessibilityAudit`, or the config block. Add a new top-level section after "AI Features" (currently around `cli/README.md:251`):

```markdown
## Observability

skeptic captures performance metrics, network traffic, and accessibility violations during
test runs. Collectors attach per-flow based on which assertion steps your flow uses.

### Step-level assertions

\`\`\`yaml
- assertPerformance: { lcp: "<2.5s", cls: "<0.1", inp: "<200ms" }
- assertNoNetworkErrors: { allowStatus: [404] }
- accessibilityAudit: { standard: "WCAG2AA", impacts: ["critical", "serious"] }
\`\`\`

### Capture behaviour

- **Performance** and **network** collectors run continuously when enabled — they observe
  the page lifecycle from attach to detach. The `assertPerformance:` and `assertNoNetworkErrors:`
  steps query the live snapshot.
- **Accessibility** runs on demand — only when an `accessibilityAudit:` step fires. The
  collector attaches at flow start (loads optional IBM Equal Access if configured) but
  doesn't audit until the step is reached.

### Force always-on capture

Attach the performance and network collectors even when no assertion step uses them
(useful for inspecting the JSON report after a flow run):

\`\`\`yaml
# skeptic.config.yaml
observability:
  collectors: [performance, network]
\`\`\`

All metrics land in `FlowResult.metrics.{performance,network,accessibility}`.
Reporters (console, HTML, JSON) surface them automatically.

### Privacy

URL query parameters with token-shaped names (`token`, `apikey`, `auth`, `password`, etc.)
are redacted to `***` in captured network requests. Users with sensitive endpoints should
also scope flows away from them. Full opt-out via config is a v2 follow-up.
```

Keep the section under 120 lines — detailed docs belong in future `docs/observability.md`.

### 3.2 Example flow scaffolded by `skeptic init`

**Constraint discovered during audit:** `cli/src/commands/init.ts:34-44` only copies the single file `templates/example.flow.yaml` to `tests/example.flow.yaml`. A new file at `cli/templates/examples/observability.flow.yaml` would never be picked up unless `runInit` changes too.

**Two options:**

a) **Single example, broaden scope.** Replace the existing `cli/templates/example.flow.yaml` with one that demonstrates observability alongside the original example content. Pro: zero changes to `runInit`. Con: the example becomes more complex; it's now demonstrating multiple features at once. The existing `cli/__tests__/unit/commands/init.test.ts:22` asserts the file is created at `tests/example.flow.yaml` — content can change without breaking the test.

b) **Add a second template + extend `runInit`.** New `cli/templates/observability.flow.yaml`. Modify `runInit` to copy it to `tests/observability.flow.yaml`. Update `init.test.ts` to assert both files exist. Pro: cleaner separation. Con: ripples through three files plus the test.

**Decision: option (a).** Lower risk, lower scope. The existing example is small enough that adding three observability assertions is a natural extension, not a feature dump. **Important constraint:** the example will execute as part of users' `skeptic test` runs after `skeptic init`, so it must not require a fixture server. Use a real public test page like `https://example.com` for `navigate`, but **only include `assertPerformance:` and `accessibilityAudit:` with permissive thresholds** — `assertNoNetworkErrors` against a real third-party URL will hit unrelated tracking/analytics/CORS noise and fail unpredictably. Document in a YAML comment that users wanting `assertNoNetworkErrors` should run against their own dev server.

**Body sketch:**
```yaml
---
name: example flow
url: https://example.com
---
- navigate: /
- assertVisible: "h1"
# Observability assertions — uncomment after `skeptic init` to try them out.
# assertNoNetworkErrors against third-party URLs is noisy; prefer your own dev server.
# - assertPerformance: { lcp: "<5s", cls: "<0.5" }
# - accessibilityAudit: { standard: "WCAG2AA", impacts: ["critical"] }
```

Commented-out observability lines: users see the syntax without flows failing on first run.

### 3.3 Step-handler help text

**File:** `cli/src/index.ts` and wherever command help is surfaced

No runtime flags to add (observability is config-driven), but if there's a `--list-commands` style helper, the three new commands should appear. Audit at implementation time; this is a 5-line change if needed and a no-op otherwise.

### 3.4 Cross-link existing template guidance

**Files:** `cli/templates/guidance/accessibility.md`, `cli/templates/guidance/performance.md`

Audit confirms these files exist at `cli/templates/guidance/` (not `cli/templates/` as the prior draft said). Add a one-line section at the top of each referencing the matching step handler:
- `accessibility.md`: "For automated checks during a test run, use the `accessibilityAudit:` step handler — see the README's Observability section."
- `performance.md`: "For threshold assertions during a test run, use the `assertPerformance:` step handler — see the README's Observability section."

Both files are user-facing guidance; the cross-link makes the new step handlers discoverable from existing docs. Kept minimal — these are guidance docs, not reference.

---

## Phase 4 — Deferred v2 features (roadmap)

Each item below was explicitly deferred in the Bundle 3 plan. They're independent workstreams — scope and schedule as individual follow-up plans when prioritized. The order reflects rough priority (most-requested first), not implementation order.

### 4.1 LoAF-level assertions

**Status:** Data is captured today at `FlowResult.metrics.performance.longAnimationFrames`. Not assertable.

**Scope:** extend `assertPerformance` schema to accept `{ longAnimationFrames: { max: number; blockingDuration: "<200ms" } }`. Add parser logic in `assert-performance.ts`. Reporter already shows LoAF frame count in HTML; add blocking-duration summary.

**Trigger:** user writes LoAF assertion or flags a real perf issue LoAF would catch.

**Est. effort:** 1 day (schema + parser + handler + tests; no new collector logic).

### 4.2 A11y rule-level allowlist

**Status:** Users can filter by `impacts` today (severity filter). Cannot ignore specific rules.

**Scope:** add `accessibilityAudit: { ignore: ["color-contrast", "aria-label"] }` to the step schema + handler. Post-filter violations by `ruleId` after dedup. Optionally extend to config-level `observability.accessibilityAllowlist` for workspace-wide acceptance of known violations.

**Trigger:** user reports false positives on a specific rule they've explicitly accepted.

**Est. effort:** half-day (schema + handler filter + tests).

### 4.3 URL redaction — extended controls

**Status:** Phase 2.6 ships token-pattern redaction at capture time as a non-negotiable default. This Phase 4 item covers the **extended** controls deferred from the MVP.

**Scope:**
- `observability.network.captureRawUrls: true` — opt out of redaction entirely. For users who control their environment and need full URLs for debugging.
- `observability.network.extraRedactParams: string[]` — extend the default redact list (e.g. `["sessionId", "userToken"]`).
- Path-segment redaction patterns (e.g. `/users/<id>/...` → `/users/***/...`). Requires user-defined regexes.
- Header redaction (only relevant once Phase 4.7 request-body capture lands).

**Trigger:** user requests opt-out for debugging, or asks to extend the redact list to a domain-specific token name.

**Est. effort:** 1 day (schema + opt-out branch + extended-list merge + tests).

### 4.4 Per-collector config namespacing

**Status:** Flat config today (`observability.networkCaptureLimit`, `observability.accessibilityDualEngine`). Works but scales awkwardly as options grow.

**Scope:** migrate to nested `observability.network.captureLimit`, `observability.accessibility.dualEngine`. Backward-compat: accept flat form with a deprecation warning for 1 minor.

**Trigger:** config block grows past 8+ flat fields.

**Est. effort:** half-day (schema restructure + migration + deprecation warn + tests).

### 4.5 Ink/TUI metrics integration

**Status:** Explicitly dropped from Bundle 3 in plan section 5.5. Live flow runs in TUI mode don't show metrics.

**Scope:** thread `metrics?: Record<string, unknown>` through `cli/src/ui/types.ts` `FlowState`; update `cli/src/reporter/ink-reporter.ts` to populate it; extend `cli/src/ui/components/flow-progress.tsx` to render a compact metrics line.

**Trigger:** user runs TUI mode and asks why metrics aren't visible; or internal request for parity.

**Est. effort:** 1 day (state plumbing + component update + snapshot tests via `ink-testing-library`).

### 4.6 CDP-based network monitoring (HAR export)

**Status:** Playwright event API is used today. No HAR export, no request/response bodies.

**Scope:** add `observability.network.exportHAR?: boolean` — when true, spin up a CDP session per page (`context.newCDPSession(page)`), enable Network domain events, collect full request/response pairs, serialize as HAR 1.2 at snapshot time. Write to `flowDir/network.har`.

**Trigger:** user requests full network trace for replay / third-party analysis tool import.

**Est. effort:** 3-4 days (CDP integration, HAR spec conformance, memory management, tests).

### 4.7 Request-body capture

**Status:** Not captured. High PII risk.

**Scope:** opt-in via `observability.network.captureRequestBodies: true`. Hook `request.postData()` at `page.on("request")`. Add size cap (default 10KB per body, total 1MB per flow). Document PII risk loudly in the config comment.

**Trigger:** user explicitly enables and accepts the risk.

**Est. effort:** 1 day (capture + cap + tests + docs warning).

### 4.8 A11y baseline comparison

**Status:** No baseline concept; every run is absolute.

**Scope:** `accessibilityAudit: { baseline: "./baselines/a11y.json" }` — first run writes the baseline, subsequent runs diff (only fail on **new** violations). Mirrors the visual-regression baseline pattern at `cli/src/executor/step-handlers/assert-screenshot.ts`.

**Trigger:** user accumulates known a11y debt they can't fix but need to gate against regression.

**Est. effort:** 1-2 days (baseline read/write, diff algorithm, handler integration, tests).

### 4.9 Dedicated A11y HTML reporter

**Status:** A11y data rendered inline in per-flow metrics card. No standalone a11y-focused report.

**Scope:** new `AccessibilityReporter` class in `cli/src/reporter/`. Generates a cross-flow accessibility summary: top violations by ruleId, pages failing WCAG criteria, axe vs IBM attribution breakdown, remediation links. Separate `a11y-report.html` in output dir.

**Trigger:** user runs many flows and wants a cross-flow a11y audit for compliance reporting.

**Est. effort:** 2-3 days (aggregation logic + HTML template + CSS + tests).

### 4.10 JUnit reporter metrics integration

**Status:** JUnit reporter omits metrics today — XML `testcase` shape doesn't fit nested metrics well.

**Scope:** add metrics as `<property>` elements inside each `testcase`, e.g. `<property name="performance.lcp" value="2300"/>`. Jenkins, GitLab, CircleCI all honor properties; most test dashboards surface them.

**Trigger:** user pipes skeptic results into CI dashboards and wants trend graphs.

**Est. effort:** half-day (XML extension + tests).

### 4.11 Performance budget files

**Status:** Thresholds live per-step in flow YAML. No workspace-wide budget.

**Scope:** `observability.performance.budgets?: { lcp: "<2.5s", cls: "<0.1", ... }` in `skeptic.config.yaml`. Applied automatically to every flow (implicit `assertPerformance` at flow end). Overridable per-flow.

**Trigger:** user wants to fail the entire run if any flow misses the perf budget without sprinkling `assertPerformance` in every flow.

**Est. effort:** 1 day (config schema + engine integration + tests).

### 4.12 OpenTelemetry exporter

**Status:** No OTel integration.

**Scope:** optional `observability.otel: { endpoint: "...", ... }`. Export per-flow metrics as OTLP spans. Useful for teams already on OTel backends (Honeycomb, DataDog, Grafana Tempo).

**Trigger:** enterprise user asks for OTel pipeline integration.

**Est. effort:** 2 days (dep addition, span shape design, exporter wiring, tests).

### 4.13 GitHub Actions annotations format

**Status:** Standard reporters output goes to log. GH Actions annotations require a specific `::error file=...::` format.

**Scope:** new `GitHubReporter` (or `--reporter github-actions`). Emits `::error file=flow.yaml,line=N::assertPerformance failed: LCP 3000ms exceeds 2500ms` for every observability assertion failure. Lets GH show inline code-review annotations on failing assertions.

**Trigger:** user runs skeptic in GH Actions CI and wants inline PR comments.

**Est. effort:** half-day (reporter + mapping + tests). Trivially pairs with `skeptic add github-action --ai` scaffold work.

---

## Critical Files to Modify (Phases 1–3)

| File | Phase | Change |
|------|-------|--------|
| `cli/__tests__/integration/observability/performance-smoke.test.ts` | 1.1 | NEW — real-browser perf smoke |
| `cli/__tests__/fixtures/observability/perf-test.html` | 1.1 | NEW — fixture |
| `cli/__tests__/integration/observability/network-smoke.test.ts` | 1.2 | NEW — real-browser network smoke |
| `cli/__tests__/fixtures/observability/network-test/*` | 1.2 | NEW — fixture |
| `cli/__tests__/integration/observability/accessibility-smoke.test.ts` | 1.3 | NEW — real-browser a11y smoke |
| `cli/__tests__/fixtures/observability/a11y-test.html` | 1.3 | NEW — fixture |
| `cli/__tests__/unit/observability/engine-integration.test.ts` | 1.4 | NEW — engine lifecycle via `vi.mock("../observability/registry.js")` + `vi.hoisted`; no production code changes |
| `cli/__tests__/integration/observability/bundle3-e2e.test.ts` | 1.5 | NEW — combined E2E |
| `cli/__tests__/fixtures/observability/bundle3/*` | 1.5 | NEW — fixture |
| `cli/__tests__/integration/observability/ibm-dual-engine.test.ts` | 1.6 | NEW — skip-if-not-installed IBM test, sequential |
| `cli/src/observability/collectors/network-collector.ts` | 2.1, 2.5, 2.6 | Remove `windowStart`; add detach debug log; apply `redactUrl` in `onRequest` |
| `cli/src/observability/registry.ts` | 2.2 | Consolidate external-file scan path; add regression test |
| `cli/src/observability/collectors/performance-collector.ts` | 2.3 | Defensive path check or pinned-version test |
| `cli/src/observability/collectors/accessibility-collector.ts` | 2.4, 2.4a, 2.5 | Per-engine status + reasons; IBM standard mapping; standardize prefix |
| `cli/src/executor/step-handlers/accessibility-audit.ts` | 2.4 | Return `"error"` only when ALL requested engines errored; partial failures pass through silently (collector already warned) |
| `cli/src/observability/types.ts` | 2.4 | Add `enginesRequested` + `enginesErrored` to `AccessibilitySnapshot.summary` |
| `cli/src/observability/url-redact.ts` | 2.6 | NEW — `redactUrl()` + `DEFAULT_REDACT_PARAMS` |
| `cli/__tests__/unit/observability/url-redact.test.ts` | 2.6 | NEW — token redaction unit tests |
| `cli/README.md` | 3.1 | Add Observability section (capture behaviour + privacy note) |
| `cli/templates/example.flow.yaml` | 3.2 | Extend with commented-out observability lines |
| `cli/src/index.ts` | 3.3 | Update command help if applicable |
| `cli/templates/guidance/accessibility.md`, `cli/templates/guidance/performance.md` | 3.4 | Cross-link new step commands |

Plus: 8 new test files, 6 new fixture files.

---

## Reused Utilities

- `http.createServer` fixture pattern — already used in `cli/__tests__/integration/commands/test-command.test.ts`
- `chromium.launch({ headless: true })` lifecycle — same file
- `describe.skipIf` pattern — vitest standard; works correctly when the boolean is computed synchronously at file load time (unlike `it.skipIf` with values set in `beforeAll`)
- `FakePage.emit()` idiom — already in use in `cli/__tests__/unit/observability/network-collector.test.ts`
- `mockLocator`/`createMockPage` — `cli/__tests__/unit/executor/step-handlers.test.ts:7-40`
- `AxeBuilder` mocking via `vi.mock` — already in `cli/__tests__/unit/observability/accessibility-collector.test.ts`
- `parseFlowFile` for fixture parsing — `cli/src/parser/flow-parser.ts`

---

## Verification

After each phase:
```bash
cd cli
npm run check
npm run build
npm test
```

**Phase 1 specific:** integration tests MUST pass with a real Chromium install. Verify on a machine with `npx playwright install chromium` run.

**Phase 1.6:** run twice — once without `accessibility-checker-engine` installed (test skips), once with (test runs). Add CI job to cover the install-and-run case.

**Phase 2 specific:** all Phase 1 tests still green; the existing 492 Bundle 3 tests still green (we don't regress anything).

**Phase 3 specific:** `skeptic init` scaffolds the new example flow correctly (template copies via `templates/` → `dist/templates/`). README renders correctly on GitHub.

---

## Prioritization

**Must land before calling Bundle 3 "done":**
- Phase 1.1–1.5 (per-phase smokes + engine lifecycle + combined E2E).
- Phase 2.4 (audit-failure semantics) and 2.4a (IBM standard mapping) — both fix correctness bugs Codex caught during follow-up review.
- Phase 2.6 (URL token redaction MVP) — present privacy leak; ship the default-on minimum.
- Phase 3.1 (README observability section).

**Should land for polish:**
- Phase 1.6 (IBM dual-engine validation).
- Phase 2.1, 2.2, 2.5 (code quality cleanup).
- Phase 3.2 (example flow scaffold update).

**Can defer indefinitely:**
- Phase 2.3 (perf IIFE path defense — very rare regression path).
- Phase 3.3, 3.4 (docs cross-links).

**Roadmap:** Phase 4 items prioritized by user demand and capacity.

**Codex's Phase 4 ordering recommendation (backed by audit):**
1. **4.10 (JUnit `<property>` metrics)** — quickest win. JUnitReporter is isolated and unit-tested at `cli/src/reporter/junit-reporter.ts`; adding `<property>` rows is materially cheaper than other roadmap items.
2. **4.1 (LoAF assertions)** — data already captured in `metrics.performance.longAnimationFrames`; just need schema + parser.
3. **4.2 (A11y rule-level allowlist)** — high user ask once observability is in regular use.
4. **4.13 (GH Actions annotations)** — trivial, high-value for CI users.

Other Phase 4 items pick up as users surface them.

---

## Anti-scope

Items explicitly **not** planned here, even as roadmap:
- Replacing Playwright with a lighter runtime (out of charter).
- Multi-browser performance comparison (Chromium is the canonical target).
- Real-user monitoring / production telemetry ingestion (this is a test-time feature, not RUM).
- AI-driven violation triage (separate concern from the collector subsystem).
