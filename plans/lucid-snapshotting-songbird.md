# Plan: ARIA Snapshot-Ref Pattern (#31)

## Context

CSS selectors and bare text matchers break when class names change, IDs are removed, or DOM structure shifts. skeptic's element resolver (`cli/src/executor/element-resolver.ts:8-67`) walks role/text/label/placeholder/testid/CSS — every layer is **inferred from a single string**, with no semantic anchor that survives a refactor.

Expect's answer is the **ARIA snapshot-ref** pattern: capture an a11y tree, mint sequential refs (`e1`, `e2`, `e3`) as identifiers for interactive/named-content roles, expose the tree to the LLM as YAML with `[ref=eN]` annotations, and resolve refs at action time via `getByRole(role, { name, exact: true }).nth(idx)`. See `skeptic-refs/expect/packages/browser/src/browser.ts:309-404` (snapshot capture & ref assignment), `:376-382` (which roles get refs), `skeptic-refs/expect/packages/browser/src/utils/{create-locator,resolve-locator,resolve-nth-duplicates}.ts` (resolution), `skeptic-refs/expect/packages/browser/src/errors.ts:23-47` (RefNotFoundError, RefAmbiguousError, RefBlockedError, RefNotVisibleError), and `skeptic-refs/expect/packages/shared/src/prompts.ts:206-218` (snapshot_workflow prompt). Expect uses Playwright's **native** `page.locator(...).ariaSnapshot()` — no custom traversal.

**Refs are ephemeral.** They are sequential integers minted at snapshot time, not stable hashes. A new snapshot reassigns them. This is intentional: the LLM is told to re-snapshot after DOM-mutating actions; refs only need to live across the few steps between snapshots. skeptic should mirror this — don't try to make refs durable across runs.

**skeptic integration shape.** v1 ships ref support in the **same 9 selector-bearing handlers as plan #37** — `click`, `doubleClick`, `hover`, `assertVisible`, `assertNotVisible`, `waitForElement`, `copyTextFrom`, `assertText` (selector branch), `scrollUntilVisible` — because they share the `resolveSelectorArg` dispatch path. The existing `element-resolver.ts` doesn't need to know about refs; the new `resolveSelectorArg` (introduced by #37) gets an `@`-prefix branch that looks up the ref in `ctx.ariaRefs` and reconstructs the locator via `getByRole(role, { name }).nth(nth)`. A new step type `ariaSnapshot` populates the registry. The registry is `ExecutionContext`-scoped (per flow, not per process). Other selector-bearing handlers (`select`, `clearInput`, `scroll`, `randomX`, `assertScreenshot.cropOn`) currently use bespoke resolution and won't accept refs in v1 — tracked as v2 widening. **AI-generated tests are explicitly out of scope for v1**: the LLM doesn't see real snapshots at generation time, so blind ref emission is unreliable. The deferred `skeptic generate --refs` mode (Phase 4 below) waits for an interactive snapshot loop in a follow-up plan.

**Scope decisions:**
- **Use Playwright's actual API.** `Locator.ariaSnapshot({ mode: "ai" })` is the correct call (verified in installed types at `cli/node_modules/playwright-core/types/types.d.ts:12822`). The "ai" mode emits `[ref=eN]` annotations and snapshots iframes. **There is no `{ ref: true }` option** — earlier draft of this plan was wrong about that. skeptic doesn't need a fallback path; the installed Playwright (^1.52.0) supports the AI mode natively.
- **Refs are sequential**, not hash-based. Mirror Expect.
- **Snapshot is on-demand** via a new `ariaSnapshot:` step. No automatic snapshot per page change. The LLM (or human author) explicitly inserts the step. (This matches Expect's `snapshot_workflow` prompt at `prompts.ts:206-218`.)
- **Resolution reconstructs locators** from `(role, name, nth)`; we do **not** cache `Locator` instances. Mirrors `resolve-locator.ts:6-10`.
- **Format is Playwright-native YAML** (the output of `Locator.ariaSnapshot({ mode: "ai" })`), not a custom serialization. skeptic's contribution is the parser that extracts `[ref=eN]` annotations into the registry.
- **Error class is bespoke for ref-resolution failures** (`AriaRefError`) — covers `invalid_format`, `not_found`, `stale`. We do NOT replicate Expect's `RefBlockedError` / `RefNotVisibleError` / `ActionTimeoutError` because those are properties of the *action*, not the ref resolution — Playwright's existing locator behavior (`waitFor({ state: "visible" })`, action timeout) already surfaces them with appropriate messages. skeptic step handlers catch those as `StepResult.status: "failed"`, same as today.
- **Status convention: `"failed"`, not `"error"`.** Existing step handlers return `status: "failed"` on caught resolver errors (e.g., `cli/src/executor/step-handlers/click.ts:29`). `AriaRefError` thrown during selector resolution surfaces the same way — the handler catch block converts it to `status: "failed"` with the formatted message. (Earlier plan draft said `"error"`; corrected.)
- **AI-prompt integration deferred to a follow-up plan.** `skeptic generate --refs` was originally Phase 4 of this plan, but blind ref emission by the LLM (it doesn't see the actual snapshot at generation time) produces flows that work only by luck. Real ref-aware generation requires an *interactive* loop: launch the target URL → capture snapshot → feed YAML to LLM → take next action → re-snapshot → repeat. That's substantially more code and its own design problem. **Out of v1.** Document the manual usage pattern and let users add `ariaSnapshot:` + `@eN` by hand or via the `record` command (#26) when it gains snapshot-aware emission.

**Privacy & redaction (new section).** ARIA snapshots capture visible text content and accessible names of every element in scope — that includes user-typed form values, email addresses, names, account numbers visible on screen, etc. Embedding raw snapshot YAML in AI prompts (the deferred `--refs` workflow) or storing it in `ctx.variables` via `storeAs` is a data-exposure risk. v1 mitigations:

1. **`storeAs` is opt-in by name.** Users explicitly write `storeAs: someVar` to capture the snapshot — not implicit.
2. **Snapshot YAML is never auto-emitted to logs or reports.** `ctx.ariaSnapshotYaml` is in-memory only; reporters don't render it.
3. **Size cap.** If the captured YAML exceeds 256 KiB, truncate with a warning to logs. Prevents memory bloat on huge a11y trees.
4. **No automatic AI submission.** The deferred `--refs` flow would have sent snapshots to the LLM. With that path deferred, no AI prompt path embeds snapshots in v1. When the future plan adds it, the design must include explicit user opt-in (e.g., `ai.shareAriaSnapshots: true` config flag, defaulting to false) and a redaction layer (mask emails, phone numbers, anything matching a sensitive-PII regex).

**Out of scope:**
- Automatic re-snapshot on stale-ref. The error message instructs the user to re-snapshot; the executor doesn't try to recover. Matches Expect (`prompts.ts:212`).
- Cross-step ref persistence beyond the flow. The registry is in-memory and discarded at flow end.
- AI prompt integration (deferred per above).
- Composing refs with relational selectors (#37): e.g., `below: "@e3"`. **Defer** until both #31 and #37 ship. The `RelationalSelector` schema's string fields *would* accept `@eN` syntactically, but the relational resolver's `findCandidates` doesn't know about refs. Wiring them together is a small follow-up after both land.
- Refs in step handlers other than the 9 listed in plan #37 (`click`, `doubleClick`, `hover`, `assertVisible`, `assertNotVisible`, `waitForElement`, `copyTextFrom`, `assertText`, `scrollUntilVisible`). v1 ref support is **scoped to the same surface that plan #37 widens**, since both share the `resolveSelectorArg` dispatch. Other selector-bearing handlers (`select`, `clearInput`, `scroll`, `randomType`, `randomEmail`, `randomNumber`, `randomPhone`, `assertScreenshot.cropOn`) use their own resolution paths and would need separate widening — track as v2 follow-ups. Document this in the README so users know where refs work.

**Goal:** the 9 supported selector slots (listed above) accept `@e1`, `@e2`, … resolved against a context-scoped ref registry populated by an `ariaSnapshot:` step. Failures emit structured errors with re-snapshot guidance. AI ref-aware generation is deferred to a follow-up plan; v1 is for hand-authored flows.

---

## Phase 1 — Snapshot capture, ref minting, registry

### 1.1 Add `ariaSnapshot` to the command keys

**File:** `cli/src/parser/flow-schema.ts`

Append to `COMMAND_KEYS` (line 13-58, after `accessibilityAudit`):
```ts
"ariaSnapshot",
```

Add to the `Step` interface (line 72-164, alongside other commands):
```ts
ariaSnapshot?: boolean | { selector?: string; viewport?: boolean; storeAs?: string };
```

Add the matching zod schema entry inside `StepSchema` (line 185-393):
```ts
ariaSnapshot: z
  .union([
    z.boolean(),
    z.object({
      selector: z.string().optional(),    // scope to a subtree (default: "body")
      viewport: z.boolean().optional(),   // limit to in-viewport elements (default: false)
      storeAs: z.string().optional(),     // optional variable to store the YAML under
    }),
  ])
  .optional(),
```

`ariaSnapshot: true` (boolean shorthand) is the common case — capture the full body. The object form is for advanced users.

`AI_EXPOSED_COMMANDS` (line 67-69) already includes everything except `runScript`/`evalScript`; `ariaSnapshot` is added here implicitly. **Verify `AI_EXPOSED_COMMANDS` filter still excludes only the two unsafe commands** — no edit needed.

### 1.2 The ref registry

**File:** `cli/src/executor/context.ts` — add to `ExecutionContext`:

```ts
/** ARIA snapshot ref registry — populated by `ariaSnapshot` step, consumed by element-resolver's `@eN` branch. */
ariaRefs: Map<string, AriaRefEntry>;        // ref ("e1") → entry
ariaSnapshotYaml: string | null;            // last captured snapshot, embedded in error messages
```

Initialize both in the constructor (`ariaRefs = new Map()`, `ariaSnapshotYaml = null`).

**The `AriaRefEntry` type:**

```ts
export interface AriaRefEntry {
  ref: string;            // "e1"
  role: string;           // "button"
  name: string;           // "Sign in"
  nth: number;            // 0 if unique; 1+ if disambiguated
  scopeSelector: string;  // the snapshot's root selector (default: "body") — used so getByRole runs against the same root
}
```

Define this in a new module `cli/src/executor/aria-ref-types.ts` (small enough to live alongside the resolver, but kept separate so step handlers can import the type without dragging in the resolver implementation).

### 1.3 The snapshot step handler

**File:** `cli/src/executor/step-handlers/aria-snapshot.ts` (new)

```ts
import type { Page } from "playwright";
import type { ExecutionContext } from "../context.js";
import type { StepResult } from "../types.js";
import { captureAriaSnapshot } from "../aria-snapshot-capture.js";

export async function handleAriaSnapshot(
  page: Page,
  ctx: ExecutionContext,
  args: unknown,
): Promise<StepResult> {
  const start = performance.now();
  const opts = (typeof args === "object" && args !== null ? args : {}) as {
    selector?: string;
    viewport?: boolean;
    storeAs?: string;
  };

  try {
    const result = await captureAriaSnapshot(page, opts.selector ?? "body", {
      viewport: opts.viewport ?? false,
    });

    // Reset and refill the ctx-scoped registry. Each snapshot supersedes the prior one.
    ctx.ariaRefs.clear();
    for (const entry of result.entries) {
      ctx.ariaRefs.set(entry.ref, entry);
    }
    ctx.ariaSnapshotYaml = result.yaml;

    if (opts.storeAs) {
      ctx.variables.set(opts.storeAs, result.yaml);
    }

    return {
      command: "ariaSnapshot",
      args,
      status: "passed",
      duration_ms: Math.round(performance.now() - start),
    };
  } catch (err) {
    return {
      command: "ariaSnapshot",
      args,
      status: "error",
      duration_ms: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
```

Wire it into the step handler index at `cli/src/executor/step-handlers/index.ts` alongside the other handlers.

### 1.4 The capture module

**File:** `cli/src/executor/aria-snapshot-capture.ts` (new)

Owns the Playwright call, the YAML parsing, and the per-`(role, name)` nth-disambiguation. Public surface:

```ts
export interface CaptureResult {
  yaml: string;                     // the YAML with [ref=eN] annotations (Playwright's output, untouched)
  entries: AriaRefEntry[];          // structured entries extracted from the YAML (for the ctx registry)
}

export async function captureAriaSnapshot(
  page: Page,
  scopeSelector: string,
  opts: { viewport?: boolean },
): Promise<CaptureResult>;
```

**Implementation:**

1. Call Playwright: `const yaml = await page.locator(scopeSelector).ariaSnapshot({ mode: "ai" });`.

   The `"ai"` mode is documented at `cli/node_modules/playwright-core/types/types.d.ts:12822` — it returns a YAML string optimized for AI consumption with `[ref=eN]` annotations and iframe snapshots. The installed Playwright `^1.52.0` (verified in `cli/package.json`) supports this directly. No fallback or polyfill needed.

2. **Parse the annotated YAML** to extract entries. The output looks like:
   ```yaml
   - generic [ref=e1]:
     - heading "Sign in" [level=1] [ref=e2]
     - textbox "Email" [ref=e3]
     - textbox "Password" [ref=e4]
     - button "Sign in" [ref=e5]
   ```

   For each line matching `/- (\w+)\s*(?:"((?:[^"\\]|\\.)*)")?\s*(?:\[[^\]]*\])*\s*\[ref=(e\d+)\]/`:
   - Capture `role` (group 1), `name` (group 2, may be empty), `ref` (group 3).
   - Track `(role, name) → encounter count` across the parse to compute `nth`: first occurrence `nth=0`, second `nth=1`, etc. This is required so resolution via `getByRole(role, { name }).nth(nth)` reaches the correct element when names duplicate.
   - Build `AriaRefEntry { ref, role, name, nth, scopeSelector }`.

3. Return `{ yaml, entries }`. The `yaml` field is preserved verbatim for `storeAs` and (deferred) AI consumption.

**Viewport mode** (when `opts.viewport === true`): for v1, post-filter entries after capture by calling `boundingBox()` on each `getByRole(role, { name }).nth(nth)` reconstruction and dropping entries whose bounds fall outside the current viewport. The full YAML is still returned (unchanged) — only the registry entries are filtered. This is a **best-effort optimization** since post-filtering doesn't reduce the snapshot's byte size; it just shortens the list of usable refs. Document the behavior in README.

**Size cap.** If `yaml.length > 256 * 1024`, log a warning and truncate the registry build at the first 256 KiB worth of entries. The full YAML is still stored in `ctx.ariaSnapshotYaml` (truncated) so subsequent steps that reference late-numbered refs (`@e500` after the cap) get a clear "ref not found" message rather than silent miss. Tunable via env var `SKEPTIC_ARIA_SNAPSHOT_LIMIT_KB` for power users.

**No fallback / no version branching.** Earlier plan draft considered both `{ ref: true }` and a custom-mint fallback — both unnecessary. The actual API is `{ mode: "ai" }`, period.

### 1.5 Tests: `cli/__tests__/unit/executor/aria-snapshot-capture.test.ts`

- Capture a fixture page (Playwright `setContent`) with one button, one link, one heading; assert YAML contains `[ref=e1]`, `[ref=e2]`, `[ref=e3]` and that entries map correctly to roles/names.
- Two buttons with the same name: refs are sequential `e1, e2`; `entries[0].nth === 0`, `entries[1].nth === 1`.
- Heading without a name → no ref (content roles need names).
- `viewport: true` → only in-viewport elements get refs (use a tall page with a scrolled-off element; assert it's absent).
- `selector: "#main"` → only refs inside `#main`; entries don't include elements outside the scope.
- Size cap: capture against a synthetic 300 KiB+ snapshot; assert truncation warning is logged and registry only contains entries up to the byte limit.

Idiom: `cli/__tests__/unit/executor/step-handlers.test.ts` for the Page/Locator mocking patterns; `cli/__tests__/integration/` for tests that need a real Playwright page (use the existing integration harness if present, otherwise this test file may need to be `cli/__tests__/integration/aria-snapshot.test.ts` — verify the test directory convention for "needs a real browser").

---

## Phase 2 — Ref resolution at action time

### 2.1 Extend `element-resolver.ts` with the `@` branch

**File:** `cli/src/executor/element-resolver.ts:8-67`

Insert at the top of `resolveElement`, before the `testid=` branch:

```ts
// ARIA ref: "@e1" → look up in ctx.ariaRefs and reconstruct via getByRole
if (selector.startsWith("@e")) {
  // Note: this signature change requires threading ctx through resolveElement —
  // see 2.2 below.
  throw new Error("Internal error: @-prefixed selectors must go through resolveSelectorArg, not resolveElement");
}
```

The actual resolution can't happen here because `resolveElement` doesn't have `ctx`. The clean fix is in 2.2.

### 2.2 Route `@eN` through `resolveSelectorArg` (or its replacement)

The cleanest split:
- `resolveElement(page, selector)` — string-only, no ctx. Today's signature.
- `resolveSelectorArg(page, ctx, arg)` — context-aware, dispatches to bare-string / relational / ref.

Both are needed because `resolveElement` is the leaf-resolution primitive that the relational resolver also calls. **Strategy: introduce `resolveAriaRef` as a separate function**; `resolveSelectorArg` (added in plan #37) gets a third branch:

```ts
// In cli/src/executor/relational-resolver.ts (from #37) or a new top-level resolver module:
export async function resolveSelectorArg(
  page: Page,
  ctx: ExecutionContext,
  arg: SelectorArg,
): Promise<Locator> {
  if (typeof arg === "string") {
    if (arg.startsWith("@")) return resolveAriaRef(page, ctx, arg);
    return resolveElement(page, ctx.interpolate(arg));
  }
  return resolveRelational(page, ctx, arg);
}
```

**File:** `cli/src/executor/aria-ref-resolver.ts` (new)

```ts
import type { Page, Locator } from "playwright";
import type { ExecutionContext } from "./context.js";
import { AriaRefError } from "./aria-ref-error.js";

export async function resolveAriaRef(
  page: Page,
  ctx: ExecutionContext,
  selector: string,
): Promise<Locator> {
  const ref = selector.slice(1); // drop the "@"

  if (!/^e\d+$/.test(ref)) {
    throw new AriaRefError("invalid_format", { ref, selector });
  }

  const entry = ctx.ariaRefs.get(ref);
  if (!entry) {
    throw new AriaRefError("not_found", {
      ref,
      available: [...ctx.ariaRefs.keys()],
      hasSnapshot: ctx.ariaSnapshotYaml !== null,
    });
  }

  // Reconstruct the locator. Scope to entry.scopeSelector to mirror the snapshot's root.
  const scope = page.locator(entry.scopeSelector);

  // ALWAYS use .nth(entry.nth) — works for nth === 0 too. The previous draft used .first() for
  // nth=0 then post-checked total>1 → ambiguous, but that incorrectly fails for valid duplicate
  // cases: when 2 buttons "Save" exist, e1 has nth=0 (first) and e2 has nth=1 (second). Both are
  // valid. The post-check `total > 1 && nth === 0 → ambiguous` would fail e1 even though e1 IS
  // the first, which is exactly what the snapshot recorded.
  //
  // The role string must be a Playwright-recognized ARIA role; we trust the snapshot.
  // exact: true is required so disambiguation by name actually works (substring match would
  // accidentally collapse "Sign in" with "Sign in to your account").
  const allMatches = scope.getByRole(entry.role as Parameters<Page["getByRole"]>[0], {
    name: entry.name,
    exact: true,
  });
  const candidate = allMatches.nth(entry.nth);

  // Validate the candidate matched something. count() is needed because .nth(N) doesn't throw
  // on zero matches — it just returns a non-resolving locator.
  if ((await candidate.count()) === 0) {
    // Total may be 0 (the whole role+name vanished) or >0 but <= entry.nth (DOM shrunk).
    // Both cases are "stale" — the snapshot expected an Nth element that no longer exists.
    const total = await allMatches.count();
    throw new AriaRefError("stale", {
      ref,
      role: entry.role,
      name: entry.name,
      expectedNth: entry.nth,
      actualMatches: total,
    });
  }

  // Note: we don't try to detect "ambiguous" anymore. If the live page has MORE matches than the
  // snapshot recorded, .nth(entry.nth) still returns the correct one for the recorded position.
  // The only way ambiguity manifests is if a NEW element shifted positions — and that's a
  // generic stale-ref problem, not a separate error class. Drop the AriaRefErrorKind "ambiguous"
  // (see error-class update below).

  return candidate;
}
```

**Pitfall — `name: entry.name`** uses `exact: true`. Playwright's name matcher normalizes whitespace and trims. If the snapshot captures a button with name `"Sign in"` but the rendered ARIA name is `"Sign in "` (trailing space), `exact` may still match — but if it doesn't, that's a Playwright-version quirk we surface as `stale`, not a bug here.

**Pitfall — role types.** `Page["getByRole"]` is parameterized by a string-literal union of ARIA roles. The snapshot may include roles outside that union (e.g., custom roles). Cast via `as Parameters<...>[0]` and let Playwright reject at runtime. The error from Playwright bubbles up as `AriaRefError("stale", ...)` because `count()` returns 0.

### 2.3 The error class

**File:** `cli/src/executor/aria-ref-error.ts` (new)

```ts
export type AriaRefErrorKind =
  | "invalid_format"   // "@foo" or "@e" with no number
  | "not_found"        // ref absent from registry (no snapshot, or new snapshot missing it)
  | "stale";           // ref present in registry but live page has fewer matches than expectedNth

export class AriaRefError extends Error {
  constructor(
    public readonly kind: AriaRefErrorKind,
    public readonly meta: Record<string, unknown>,
  ) {
    super(formatAriaRefError(kind, meta));
    this.name = "AriaRefError";
  }
}

export function formatAriaRefError(kind: AriaRefErrorKind, meta: Record<string, unknown>): string {
  switch (kind) {
    case "invalid_format":
      return `Invalid ARIA ref "${meta["selector"]}". Expected "@eN" where N is a non-negative integer.`;
    case "not_found": {
      const available = (meta["available"] as string[] | undefined)?.length ?? 0;
      const hasSnapshot = meta["hasSnapshot"] === true;
      if (!hasSnapshot) {
        return `Ref "@${meta["ref"]}" referenced before any \`ariaSnapshot\` step ran. Add an \`- ariaSnapshot: true\` step earlier in the flow.`;
      }
      return `Ref "@${meta["ref"]}" not found in the current snapshot (${available} refs available). Re-run \`ariaSnapshot\` if the page has changed.`;
    }
    case "stale": {
      const expected = meta["expectedNth"];
      const actual = meta["actualMatches"];
      return (
        `Ref "@${meta["ref"]}" (role: ${meta["role"]}, name: ${meta["name"]}) is stale — ` +
        `the snapshot expected element nth=${expected}, but the live page has ${actual} matching element(s). ` +
        `Re-run \`ariaSnapshot\` if the page has changed.`
      );
    }
  }
}
```

**Three error kinds, not four.** Earlier draft had `ambiguous` as a separate kind; it's been collapsed into `stale` because the resolver now uses `.nth(entry.nth)` directly (which doesn't have an "is the nth element ambiguous?" question — it always returns the Nth match), and the only failure mode is "live page has too few matches." See the resolver comment in 2.2 for the full rationale.

**Action-error scope.** Beyond ref *resolution*, action-time issues (the resolved element exists but is occluded, off-screen, or the action times out) are surfaced by Playwright's existing `Locator.click()` / `Locator.waitFor()` rejection paths. Those bubble up to the step handler's existing catch block and produce `StepResult.status: "failed"` — same convention used today. skeptic doesn't replicate Expect's `RefBlockedError` / `RefNotVisibleError` / `ActionTimeoutError` because Playwright's stack traces and timeouts already carry the relevant detail.

**Why a new error class instead of plain `Error`:** step handlers can format these specially (Phase 3.2), and the AI-failure-analysis path (`--analyze`) can recognize them and inject a prompt suggestion to re-snapshot.

### 2.4 Tests: `cli/__tests__/unit/executor/aria-ref-resolver.test.ts`

Use `mockLocator()` idiom from `step-handlers.test.ts:7-33`. Mock the page and ctx.

- `@e1` resolves when registry has the entry; `getByRole` called with correct role/name/exact.
- `@e3` with `entry.nth === 2` calls `.nth(2)`.
- `@bad` → `AriaRefError("invalid_format")`.
- `@e1` when registry is empty (no snapshot taken) → `AriaRefError("not_found")` with `hasSnapshot: false` and the actionable message.
- `@e99` when registry has `e1`–`e3` only → `AriaRefError("not_found")` with the available count.
- `@e1` when registry exists but live count is 0 → `AriaRefError("stale")` with `meta.expectedNth=0`, `meta.actualMatches=0`.
- `@e2` with `entry.nth === 1` but live total is 1 → `AriaRefError("stale")` with `meta.expectedNth=1`, `meta.actualMatches=1` (DOM shrunk).
- `@e1` with `entry.nth === 0` and live total is 2 → resolves to first match correctly. NO `ambiguous` error fires (the "ambiguous when nth=0" check has been removed; .nth(0) always returns the first match, which is exactly what was recorded).
- `ctx.interpolate` is **not** applied to ref selectors (e.g., `@e1` is verbatim, no `${var}` substitution inside refs). Test by constructing a ctx with `variables` and asserting it isn't queried.

---

## Phase 3 — Wire handlers + reach plan #37's `resolveSelectorArg`

### 3.1 Handler dispatch

If plan #37 (composable selectors) lands first: `resolveSelectorArg` is the entry point and gets the `@`-prefix branch added there. This plan's 2.2 code is the canonical version.

If this plan (#31) lands first: introduce `resolveSelectorArg` *here* with two branches (string + `@e`), and #37 widens it to three branches later. Either way, the integration is additive.

**Order in this plan assumes #37 lands first.** If sequencing flips during implementation, move the `resolveSelectorArg` declaration from #37 into #31.

### 3.2 Step handlers

The 9 selector-bearing handlers from #37 (`click`, `doubleClick`, `hover`, `assertVisible`, `assertNotVisible`, `waitForElement`, `copyTextFrom`, `assertText`, `scrollUntilVisible`) all route through `resolveSelectorArg`. After 3.1, they handle `@eN` automatically — no per-handler change.

**Status convention** — `AriaRefError` thrown during resolution surfaces in the handler's catch block and produces `StepResult.status: "failed"` (matching the existing convention at e.g. `cli/src/executor/step-handlers/click.ts:29`, NOT `"error"`). Earlier plan draft incorrectly said `"error"`; corrected here. The user-visible distinction between "config issue" and "test failure" already lives in the formatted message via `formatAriaRefError` — duplicating it in the status field would diverge from the rest of the codebase for no benefit.

**Error formatting in handlers:** the existing pattern (from #37's 3.4) catches structured errors. Extend it to recognize `AriaRefError`:

```ts
const message =
  err instanceof AriaRefError
    ? err.message  // already pre-formatted by formatAriaRefError
    : err instanceof RelationalResolutionError
      ? formatRelationalError(err)
      : err instanceof Error
        ? err.message
        : String(err);
```

This drops the JSON blob from ref errors — they're already human-readable.

**Group B handlers (`assertNotVisible`, `waitForElement state="hidden"|"detached"`)** — `AriaRefError` of kind `not_found` (no snapshot taken, or ref absent) and `stale` (live page has fewer matches than recorded) are **NOT** classified as absence-success. A ref pointing nowhere is an authoring/staleness problem, not "the element isn't visible." `isAbsentError()` from #37's 3.2 must explicitly exclude `AriaRefError` from the absence-passes path:

```ts
function isAbsentError(err: unknown): boolean {
  if (err instanceof AriaRefError) return false;  // ref errors are never absence
  if (err instanceof RelationalResolutionError) {
    return err.kind === "no_leaf_match" || err.kind === "all_detached" || err.kind === "intersection_empty";
  }
  // ... bare-string path unchanged
}
```

Document this in the handler tests so the policy can't regress.

**v1 ref-supported handler scope.** Refs work in the **same 9 handlers as #37's relational selectors** because both share the `resolveSelectorArg` dispatch. The other selector-bearing step handlers (`select`, `clearInput`, `scroll`, `randomType`, `randomEmail`, `randomNumber`, `randomPhone`, `assertScreenshot.cropOn`) currently use bespoke resolution paths and would fail with `@eN` selectors. Document this scope explicitly in README; widening these other handlers is a v2 follow-up.

### 3.3 The `--analyze` failure analysis prompt

**File:** `cli/src/ai/prompts.ts` (`ANALYZE_FAILURE_PROMPT` at line 138-152)

Today the prompt asks the LLM to interpret a screenshot and an error string. With ref errors, the actionable suggestion is almost always "re-run snapshot." Add a one-line note to the prompt:

```diff
- 3. Suggested fix
+ 3. Suggested fix (note: if the error mentions an ARIA ref like "@e1" being stale or not found, the fix is almost always to insert an `- ariaSnapshot: true` step before the failing action)
```

Tests in `cli/__tests__/unit/ai/prompts.test.ts` (per `wiggly-floating-whistle.md` 5.7): assert the prompt contains the substring `"@e"` so this guidance can't drift away silently.

### 3.4 Tests: `cli/__tests__/unit/executor/aria-ref-handler-integration.test.ts`

For the 9 handlers, parametrize one test per handler asserting a `@e1` arg routes through `resolveSelectorArg` to the resolver. Mock the resolver; assert call args. (Behavior is covered in 2.4.)

One end-to-end test using `cli/__tests__/integration/`: a flow with `[{ navigate: "/login" }, { ariaSnapshot: true }, { click: "@e1" }]` against a fixture page where `@e1` is the Sign-in button. Assert the click happens.

---

## Phase 4 — AI generation: deferred to a follow-up plan

The original Phase 4 added `skeptic generate --refs` to make the LLM emit ref-aware flows. **Removed from v1.** Reasoning:

The LLM at generation time has no access to a real snapshot of the target page. It would have to *guess* ref numbers based on prose intuition ("the login button is probably `@e3`"), which produces flows that work only by accident. The right design is an **interactive generation loop**:

1. Load the target URL in a real browser
2. Capture a real `ariaSnapshot`
3. Send the actual YAML (with real refs) to the LLM
4. LLM proposes the next step
5. Execute it in the browser
6. Re-snapshot
7. Repeat until flow complete

That's substantially more code (orchestrator, browser session lifecycle inside `generate`, replay-vs-record-aware prompt) and effectively a new product feature. Track as a separate plan.

**Manual usage path (documented in v1 README):** users insert `- ariaSnapshot: true` then `- click: "@e1"` by hand. The `skeptic record` command (#26), once it lands, can also emit ref-based selectors when the recorder integrates with the snapshot capture (a v2 enhancement to #26). For now, refs are a power-user feature for human-authored flows.

No prompts, no flags, no `--refs` integration in v1. The MCP `generate_flow` tool stays unchanged.

---

## Phase 5 — Documentation

### 5.1 `cli/README.md`

Add a section:

```markdown
### ARIA snapshot-ref selectors

skeptic supports the ARIA snapshot-ref pattern (inspired by Expect) for building resilient selectors that survive DOM refactors:

\`\`\`yaml
- navigate: /login
- ariaSnapshot: true        # capture the a11y tree, mint refs e1, e2, ...
- click: "@e1"              # the first interactive element (e.g. username field)
- type: "alice"
- click: "@e3"              # the third interactive element (e.g. sign-in button)
\`\`\`

Refs are minted at snapshot time in document order. They cover interactive roles (button, link, textbox, …) and named content roles (heading, region, …).

After any DOM mutation, re-run \`ariaSnapshot\` — refs do not survive across snapshots.

**Supported step handlers (v1).** Refs work in: \`click\`, \`doubleClick\`, \`hover\`, \`assertVisible\`, \`assertNotVisible\`, \`waitForElement\`, \`copyTextFrom\`, \`assertText\` (selector branch), \`scrollUntilVisible\`. Other selector-bearing handlers (\`select\`, \`clearInput\`, \`scroll\`, \`randomType\`, \`randomEmail\`, \`randomNumber\`, \`randomPhone\`, \`assertScreenshot.cropOn\`) use \`@eN\` syntax with their existing resolution path and will currently fail; widening these to refs is tracked as a v2 enhancement.

**AI generation.** \`skeptic generate\` does **not** emit ref-based flows in v1 — the LLM doesn't see a real snapshot at generation time, so blind ref emission produces unreliable output. Refs are a power-user feature for hand-authored flows. A future release will add an interactive ref-aware generation mode that captures snapshots at runtime.

Common errors:
- **`Ref "@e1" referenced before any ariaSnapshot step ran`** — insert `- ariaSnapshot: true` earlier.
- **`Ref "@e3" not found in the current snapshot`** — the snapshot has fewer refs than expected; the page may have changed, or `@e3` was never minted.
- **`Ref "@e2" (role: button, name: "Save") is stale`** — the snapshot expected an Nth match, but the live page has fewer matches. Re-run `ariaSnapshot`.
```

### 5.2 Skill / agent docs

If skeptic has a skill for AI agents (`cli/templates/skill/...` based on `skeptic add skill`), add a one-paragraph note about the snapshot-ref pattern. Optional for v1.

---

## Critical Files to Modify

| File | Phase | Change |
|------|-------|--------|
| `cli/src/parser/flow-schema.ts` | 1.1 | Add `ariaSnapshot` command |
| `cli/src/executor/context.ts` | 1.2 | Add `ariaRefs`, `ariaSnapshotYaml` fields |
| `cli/src/executor/aria-ref-types.ts` | 1.2 | New file — `AriaRefEntry` type |
| `cli/src/executor/step-handlers/aria-snapshot.ts` | 1.3 | New handler |
| `cli/src/executor/step-handlers/index.ts` | 1.3 | Register handler |
| `cli/src/executor/aria-snapshot-capture.ts` | 1.4 | New module — calls `Locator.ariaSnapshot({ mode: "ai" })` and parses entries |
| `cli/package.json` | 1.4 | Bump playwright if pinned version <1.49 (separate PR if needed) |
| `cli/src/executor/element-resolver.ts` | 2.1 | Stub `@`-branch (delegates to `resolveSelectorArg`) |
| `cli/src/executor/aria-ref-resolver.ts` | 2.2 | New file — `resolveAriaRef` |
| `cli/src/executor/aria-ref-error.ts` | 2.3 | New file — `AriaRefError` class + formatter |
| `cli/src/executor/relational-resolver.ts` | 3.1 | Add `@`-branch to `resolveSelectorArg` (or define it here if #37 hasn't landed) |
| `cli/src/executor/step-handlers/click.ts` | 3.2 | Add `AriaRefError` case to error formatting |
| (8 other selector-bearing handlers) | 3.2 | Same pattern as click.ts |
| `cli/src/ai/prompts.ts` | 3.3 | `--analyze` hint about ref errors |
| `cli/README.md` | 5.1 | New section |

Plus 4 new test files (1.5, 2.4, 3.4 unit + 3.4 integration) and 1 update (`prompts.test.ts` for the `--analyze` hint). No new runtime dependencies — Playwright `^1.52.0` (already pinned) supports `ariaSnapshot({ mode: "ai" })` natively.

---

## Reused Utilities

- `resolveElement` — `cli/src/executor/element-resolver.ts:8` (string-fallback)
- `resolveSelectorArg` — `cli/src/executor/relational-resolver.ts` (#37 dependency; this plan extends it)
- `Page.locator(...).ariaSnapshot()` — Playwright native API
- `getByRole(role, { name, exact: true })` + `.nth(n)` — Playwright stable API
- `ExecutionContext.variables` (`Map<string, string>`) — `cli/src/executor/context.ts` (`storeAs` writes here)
- `StepResult` — `cli/src/executor/types.ts` (no schema change needed; `error` field carries pre-formatted message)
- `mockLocator()` idiom — `cli/__tests__/unit/executor/step-handlers.test.ts:7-33`
- Step-handler-error pattern from #37's 3.4 (`formatRelationalError`); this plan adds `AriaRefError` to the same dispatch

---

## Verification

```bash
cd cli
npm install                   # if playwright bumped in 1.4
npm run build
npm run check
npm test
```

**End-to-end smoke flows:**

```yaml
# Basic ref usage
- navigate: /login
- ariaSnapshot: true
- click: "@e1"
- type: "alice"
- click: "@e3"
- assertVisible: "@e1"

# Re-snapshot pattern
- navigate: /
- ariaSnapshot: true
- click: "@e2"          # opens a modal
- ariaSnapshot: true    # re-snapshot — modal's elements now numbered
- click: "@e1"          # the modal's first button

# Error path: ref without snapshot
- navigate: /
- click: "@e1"          # → step error: "referenced before any ariaSnapshot step"

# Error path: stale ref after page mutation
- navigate: /list
- ariaSnapshot: true
- click: "@e1"          # opens an item detail; URL changes
- click: "@e2"          # likely fails — page changed since snapshot
```

**Backwards compat:** every existing test must still pass without modification — bare-string selectors (#login, "Submit", "css=...") are untouched, and the `@`-branch only activates on selectors literally starting with `@e`.

**Stale-ref smoke test:** hand-author a flow with `ariaSnapshot: true` and `@e1` selectors; deliberately mutate the fixture page between the snapshot and a later step; assert the second `@e1` resolution surfaces a clean `AriaRefError("stale", ...)` message in the step result, NOT a silent flake or generic Playwright timeout. That's the value of the structured error path.

**Privacy/cap smoke test:** capture a snapshot on a page with form values typed in (e.g., enter a fake email/SSN, click a snapshot step). Inspect the YAML in `ctx.ariaSnapshotYaml` — confirm it contains the typed values (proving the privacy-leak risk is real and the redaction policy in Context exists for a reason). Then assert that `JSON.stringify(result)` returned by the step doesn't include the YAML — the registry's contents stay in-memory only, never leaking through `StepResult`.
