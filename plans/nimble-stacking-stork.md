# Plan: Composable Relational Selectors (#37)

## Context

skeptic's element resolver (`cli/src/executor/element-resolver.ts:8-67`) walks a fixed strategy chain — explicit prefixes (`testid=`, `css=`, `role=`) → role-by-name (button/link/heading) → text → label → placeholder → testid → CSS. Every call returns a single `Locator` from a single bare-string input. That works for "click the Submit button" but breaks for layouts where the human description is relational: "the button below the email field," "the icon to the right of the search bar," "the Add button inside the cart panel."

Maestro's solution is the **`ElementFilter`** abstraction — `(List<TreeNode>) -> List<TreeNode>` — composed via `compose()` (sequential fold) and `intersect()` (set intersection), with bounding-box geometry for spatial predicates and recursive child-pointer traversal for hierarchical ones. See `skeptic-refs/maestro/maestro-client/src/main/java/maestro/Filters.kt:27` (the typealias), `:153-165` (spatial predicates), `:185-205` (hierarchical), `:33-36` (INDEX_COMPARATOR for ambiguity), and `skeptic-refs/maestro/maestro-orchestra/src/main/java/maestro/orchestra/Orchestra.kt:1390-1537` (the orchestrator that intersects basic + relational filters). YAML schema lives at `skeptic-refs/maestro/maestro-orchestra/src/main/java/maestro/orchestra/yaml/YamlElementSelector.kt:25-55` — a flat object with optional fields per relational primitive, recursively typed via `YamlElementSelectorUnion`.

**Why this is harder than a Kotlin port suggests.** Maestro snapshots the entire view hierarchy synchronously into `TreeNode`s with bounds baked in. Playwright's `Locator` is **lazy and async** — `boundingBox()` is a Promise, not a property. A naive port that calls `boundingBox()` inside every filter predicate ends up with O(filters × candidates) awaits. The clean translation is a **shadow-snapshot pattern**: materialize candidates → batch-resolve bounds via `Promise.all(boundingBox)` → build a `ShadowNode[]` array (synchronous from then on) → apply filter functions synchronously → resolve back to a `Locator` for the winner.

**Scope decisions baked into this plan:**
- Maestro's six relational primitives ship: `above`, `below`, `leftOf`, `rightOf`, `childOf`, `containsChild`. **No `near`** (Maestro doesn't ship it; user can compose `below` + distance tiebreaker).
- **No `containsDescendants`** in v1. It requires arbitrary-depth child filtering and the AI-prompt-coverage cost isn't worth a feature most users won't reach for. Add later if asked.
- Spatial filters use **strict** Y/X comparison plus a **distance tiebreaker** when multiple candidates match (Euclidean center-to-center, Maestro's exact heuristic — `Filters.kt:25-34, 180`). No tolerance bands.
- Filter object form is supported only on **interaction commands that already resolve elements**: `click`, `doubleClick`, `hover`, `assertVisible`, `assertNotVisible`, `assertText` (selector branch), `copyTextFrom`, `scrollUntilVisible`, `waitForElement`. Other commands (e.g., `select`, `type`) keep their existing string-only or selector-only shapes; widening them is a follow-up.
- Filter object form is **mutually exclusive** with bare-string form within a single step. No mixed `click: "Submit"` + `below: "Email"` — that combination would land at the YAML parser as two keys on the same step, which `StepSchema` already rejects via the "exactly one command key" refinement (`flow-schema.ts:394-405`). The relational form goes inside the command's value: `click: { below: "Email", text: "Submit" }`.

**Goal:** any of the listed commands accepts both a bare string (existing behavior, unchanged) and a `RelationalSelector` object whose fields combine via set-intersection over a candidate pool. The candidate pool is the existing element-resolver chain applied to the leaf fields (`text`, `id`, `role`, `testid`).

**Out of scope:** ARIA snapshot-ref refs as targets of relational filters (e.g., `below: "@e3"`). That cross-cuts with #31 and is called out explicitly in #31's plan as an "after both ship" follow-up.

---

## Phase 1 — Selector type, schema, and parser plumbing

### 1.1 Define `RelationalSelector`

**File:** `cli/src/parser/flow-schema.ts` (new section, place after `ConditionSchema` at line 4 and before `COMMAND_KEYS` at line 13)

```ts
const LEAF_FIELDS = ["text", "id", "role", "testid", "css"] as const;
type LeafField = (typeof LEAF_FIELDS)[number];

/**
 * `RelationalSelector` — leaf fields plus optional spatial/hierarchical constraints.
 * Each constraint is itself a `RelationalSelectorOrString` so they can nest.
 *
 * Example:
 *   click:
 *     text: "Submit"           # leaf
 *     below: "Username"        # spatial (string shorthand → leaf {text: "Username"})
 *     childOf: { id: "form" }  # hierarchical (nested RelationalSelector)
 *
 * Hard requirement: at least one leaf field MUST be present. Pure-relational selectors
 * like `{ below: "X" }` are intentionally rejected — without a leaf, the candidate pool
 * would be undefined, and the resolver has no anchor for the spatial filter to apply against.
 *
 * Note: `.strict()` rejects unknown keys at parse time so typos like `belwo` fail loudly
 * rather than silently dropping the constraint and resolving against the leaf alone.
 */
const RelationalSelectorOrStringSchema: z.ZodType<RelationalSelector | string> = z.lazy(() =>
  z.union([z.string(), RelationalSelectorSchema]),
);

export const RelationalSelectorSchema: z.ZodType<RelationalSelector> = z.lazy(() =>
  z
    .object({
      text: z.string().optional(),       // exact text match (getByText with exact: true)
      id: z.string().optional(),         // [id="..."] with safe attribute escaping
      role: z.string().optional(),       // ARIA role (with optional name via `text`)
      testid: z.string().optional(),     // data-testid (getByTestId)
      css: z.string().optional(),        // raw Playwright/CSS selector escape hatch
      above: RelationalSelectorOrStringSchema.optional(),
      below: RelationalSelectorOrStringSchema.optional(),
      leftOf: RelationalSelectorOrStringSchema.optional(),
      rightOf: RelationalSelectorOrStringSchema.optional(),
      childOf: RelationalSelectorOrStringSchema.optional(),
      containsChild: RelationalSelectorOrStringSchema.optional(),
      index: z.number().int().nonnegative().optional(), // 0-based pick of the sorted candidates
    })
    .strict()
    .refine(
      (s) => LEAF_FIELDS.some((f) => s[f as LeafField] !== undefined),
      { message: `Relational selector must specify at least one leaf field: ${LEAF_FIELDS.join(", ")}` },
    ),
);

export interface RelationalSelector {
  text?: string;
  id?: string;
  role?: string;
  testid?: string;
  css?: string;
  above?: RelationalSelector | string;
  below?: RelationalSelector | string;
  leftOf?: RelationalSelector | string;
  rightOf?: RelationalSelector | string;
  childOf?: RelationalSelector | string;
  containsChild?: RelationalSelector | string;
  index?: number;
}

/** Public union — accept a bare string (existing behavior) or a relational object. */
export const SelectorArgSchema = z.union([z.string(), RelationalSelectorSchema]);
export type SelectorArg = string | RelationalSelector;
```

**Type guard, exported from the same file (placed after the schema):**

```ts
export const isRelationalSelector = (s: SelectorArg): s is RelationalSelector =>
  typeof s === "object" && s !== null;
```

**Why require a leaf field.** Pure-relational selectors like `{ below: "X" }` would mean "any element on the page below X" — without a leaf, the candidate pool is the entire DOM (or undefined, depending on implementation choice). The first interpretation is unbounded and slow; the second is a runtime null. Either way, the user almost never means "any DOM node below X" — they mean "the button below X" or "the input below X." Forcing a leaf turns ambiguous YAML into a clear parse error at the right layer.

**Why `.strict()`.** Zod's default object behavior strips unknown keys silently. With a typo like `{ text: "Submit", belwo: "Email" }`, the misspelled `belwo` would vanish during parse and the relational filter would never apply — the click would land on the *first* "Submit" found anywhere, not the one below "Email." `.strict()` makes typos fail at parse time with a helpful "unrecognized key" error.

### 1.2 Widen the step schema for the affected commands

**File:** `cli/src/parser/flow-schema.ts`

The widening is split into two groups by semantics: **positive resolution** (find an element to interact with) and **negative/state resolution** (assert absence or wait for state). The latter need different handler logic — see Phase 3.

**Group A — positive resolution (7 commands):** `click`, `doubleClick`, `hover`, `assertVisible`, `copyTextFrom` (selector branch), `assertText` (selector branch), `scrollUntilVisible` (selector branch).

**Group B — negative/state resolution (2 commands):** `assertNotVisible`, `waitForElement`.

For Group A — replace each affected line in the `Step` interface (lines 73-164). Example for `click`:
```ts
click?: SelectorArg;            // was: string;
```

`copyTextFrom` already takes `string | { selector: string; variable?: string }`. Widen the inner `selector` to `SelectorArg`:
```ts
copyTextFrom?: SelectorArg | { selector: SelectorArg; variable?: string };
```

`scrollUntilVisible` similarly:
```ts
scrollUntilVisible?:
  | SelectorArg
  | { selector: SelectorArg; direction?: "up" | "down"; maxScrolls?: number; scrollAmount?: number };
```

`assertText` keeps its disambiguation but the selector form widens:
```ts
assertText?: string | { selector: SelectorArg; text: string };
```

**Group B — assertNotVisible & waitForElement.** Both need to widen but **must not** trigger the resolver-throws-on-no-candidates failure path that Group A relies on. The schema widening is:

```ts
assertNotVisible?: SelectorArg;
waitForElement?:
  | SelectorArg
  | { selector: SelectorArg; state?: "visible" | "hidden" | "attached" | "detached"; timeout?: number };
```

**Pre-existing bug — `waitForElement` schema/handler mismatch.** Today the schema declares `waitForElement?: string` (`flow-schema.ts:82, 202`) but the handler at `wait-for-element.ts:6-27` already accepts `{ selector, state?, timeout? }` via runtime type-check. Users writing the object form are bypassing schema validation. This widening fixes the inconsistency: schema and handler converge on the same shape.

**v1 limitation: relational `waitForElement` only supports `state: "visible"` or `state: "hidden"`.** The relational resolver materializes bounds via `boundingBox()` to apply spatial filters; for elements that are attached but not laid out (e.g., `display: none`), `boundingBox()` returns `null`, which the resolver treats as `all_detached`. This conflates "hidden but attached" with "detached," which is fine for `state: "hidden"` (Playwright treats them the same) but BREAKS `state: "detached"` and `state: "attached"`:

- `state: "detached"`: a hidden-but-attached candidate would resolver-fail as "all_detached" → handler-success — wrong (the element is still in the DOM).
- `state: "attached"`: a hidden-but-attached candidate would resolver-fail as "all_detached" → if Group B's absence-passes path is wired, handler-pass — wrong (the element exists).

For v1, **reject `state: "attached"|"detached"` with a relational selector at runtime** in the `waitForElement` handler:

```ts
if (state === "attached" || state === "detached") {
  if (typeof selector !== "string") {
    return failResult(start, new Error(
      `waitForElement state="${state}" is not supported with relational selectors in v1. Use a bare-string selector or state="visible"/"hidden".`,
    ));
  }
}
```

Bare-string `waitForElement: { selector: "X", state: "attached" }` continues to work via the existing `resolveElement` + `waitFor` path. Document this as a v2 follow-up: add an attachment-aware resolver path that uses `Locator.count()` (cheap, no bounds materialization) for attached/detached states.

**Zod schemas (lines 188-292)** — corresponding widening using `SelectorArgSchema` instead of `z.string()` at each affected entry. `copyTextFrom`'s union becomes `z.union([SelectorArgSchema, z.object({ selector: SelectorArgSchema, variable: z.string().optional() })])`. Same shape for `scrollUntilVisible` and `assertText`. For `waitForElement`:
```ts
waitForElement: z
  .union([
    SelectorArgSchema,
    z.object({
      selector: SelectorArgSchema,
      state: z.enum(["visible", "hidden", "attached", "detached"]).optional(),
      timeout: z.number().positive().optional(),
    }),
  ])
  .optional(),
```

(The schema accepts all four states; the v1 limitation is enforced at the handler level so the error message is contextual rather than a generic schema rejection.)

**Important: `step-normalizer.ts` interpolation interaction.** `cli/src/parser/step-normalizer.ts` walks step args and applies `${var}` interpolation to strings. The current normalizer assumes string-typed args; once args become objects, the normalizer must walk recursively or skip the relational branches. **Add a check in `step-normalizer.ts`:** if `args` is an object with relational fields, leave it untouched at normalize time. Interpolation moves to **resolve time** in 2.4, where `ctx.interpolate` is invoked on each leaf string field as the candidate pool is built. This keeps normalize-vs-resolve separation clean. (Tests in 5.1 lock this in.)

### 1.3 Update `KNOWN_STEP_KEYS` only if new top-level keys are added

Nothing changes — `RelationalSelector` is a value type, not new top-level step keys. The existing `KNOWN_STEP_KEYS` set (`flow-schema.ts:180-183`) is unaffected.

### 1.4 Test: `cli/__tests__/unit/parser/relational-selector-schema.test.ts`

- Bare-string `click: "Submit"` parses unchanged (regression).
- Relational `click: { text: "Submit", below: "Email" }` parses; types match.
- **Pure-relational `click: { below: "Email" }` is REJECTED** with the leaf-field error message.
- Empty object `click: {}` rejected.
- **Typo handling** — `click: { text: "Submit", belwo: "Email" }` rejected by `.strict()` with an "unrecognized key" error mentioning `belwo`. Same for `rightof` (lowercase variant), `child` (incomplete), `containschild` (lowercase variant).
- String shorthand inside a relation: `click: { text: "OK", below: "Username" }` — the inner `below` is still a `string` (not yet expanded); that expansion happens at resolve time.
- Nested relational: `click: { text: "X", childOf: { id: "form", below: "Y" } }` — recursive parse works; the nested `{ id: "form", below: "Y" }` itself satisfies the leaf requirement (has `id`).
- **Nested without leaf** — `click: { text: "X", childOf: { below: "Y" } }` rejected at the nested level (the inner relational has no leaf).
- Negative `index: -1` rejected; `index: 0` accepted.
- `assertText: { selector: { text: "OK", below: "Hint" }, text: "Confirmed" }` parses.
- `waitForElement: { selector: { text: "Loading" }, state: "hidden", timeout: 5000 }` parses (locks in the schema/handler convergence).
- `waitForElement: { selector: "X", state: "invalid" }` rejected (enum validation).
- Two leaf fields together (`{ text: "X", testid: "y" }`) parse — they'll be intersected at resolve time.

Idiom: `cli/__tests__/unit/parser/flow-schema.test.ts` (existing).

---

## Phase 2 — Resolver: shadow-snapshot, filters, intersection

### 2.1 New module: `cli/src/executor/relational-resolver.ts`

This module owns the materialization-and-filter pipeline. It consumes a `RelationalSelector`, queries Playwright for the candidate pool, resolves bounds in one batched pass, applies filter functions over a synchronous shadow array, and returns the winning `Locator` (or throws with a structured error). It does NOT replace `element-resolver.ts` — bare-string resolution stays there. The relational resolver delegates leaf resolution to a new helper `findCandidates` (which mirrors element-resolver's chain but returns a `Locator[]` of all matches, not just `.first()`).

**Public API:**

```ts
import type { Page, Locator } from "playwright";
import type { RelationalSelector, SelectorArg } from "../parser/flow-schema.js";
import type { ExecutionContext } from "./context.js";

/** Canonical entry: bare string → element-resolver.resolveElement; object → resolveRelational. */
export async function resolveSelectorArg(
  page: Page,
  ctx: ExecutionContext,
  arg: SelectorArg,
): Promise<Locator>;

/** Public for tests; the relational pipeline. */
export async function resolveRelational(
  page: Page,
  ctx: ExecutionContext,
  selector: RelationalSelector,
): Promise<Locator>;
```

**Internal data shape:**

```ts
interface ShadowNode {
  locator: Locator;
  bounds: { x: number; y: number; width: number; height: number };
  centerX: number;
  centerY: number;
}
```

### 2.2 Candidate pool for leaf fields

```ts
async function findCandidates(
  page: Page,
  ctx: ExecutionContext,
  leaf: Pick<RelationalSelector, "text" | "id" | "role" | "testid" | "css">,
): Promise<Locator[]>
```

For each leaf field present, build a `Locator` and intersect via `locator.and()`:

| Field | Locator |
|---|---|
| `text` | `page.getByText(text, { exact: true })` |
| `id` | `page.locator(\`[id=${JSON.stringify(id)}]\`)` |
| `role` | `page.getByRole(role)` *(name comes from `text` if both present — handled below)* |
| `testid` | `page.getByTestId(testid)` |
| `css` | `page.locator(css)` |

**Safe attribute escaping for `id`.** `JSON.stringify` produces a JS-quoted string with `"` and `\` escaped — `JSON.stringify("foo")` → `'"foo"'`, `JSON.stringify('a"b')` → `'"a\\"b"'`. Substituted into the attribute selector this yields `[id="foo"]` and `[id="a\"b"]`, both of which CSS attribute syntax accepts. This handles the practical-input set: quotes, backslashes, brackets, spaces, and printable Unicode.

**Limitations** — JSON's escapes are NOT exactly CSS's. JSON encodes `\n` as `\n`, but CSS attribute strings use `\A` (or `\00000A`) for newlines, and other control characters need similar hex escapes. **Control characters and newlines in `id` values are not supported** by the relational `id` field; if a user has an exotic ID, they should use the `css:` field with hand-written `[id="..."]` syntax. Document this in the README and in `cli/src/parser/flow-schema.ts` next to the `RelationalSelector.id` field. Tests in 2.8 cover the supported set explicitly and assert that an `id` containing a `\n` is rejected with a clear error (or document the failure mode and skip the test).

**Why not `CSS.escape`?** It's a browser global, not a Node API. Polyfilling it adds a dep we don't need for the practical input set. If users hit the control-char limitation often, a v2 enhancement is to inline a small CSS-quoted-string escaper (~15 lines) without adding a runtime dep.

**`role` typing.** Playwright's `getByRole(role)` takes a string-literal union of ~80 ARIA roles, not an arbitrary `string`. The schema accepts `role: z.string()` for ergonomics (users write `role: "button"` directly in YAML), but at the call site we must cast: `page.getByRole(role as Parameters<Page["getByRole"]>[0], ...)`. Mirror the existing pattern at `element-resolver.ts:34`. If Playwright rejects the role string at runtime, the `findCandidates` try/catch in 2.2 wraps it as `RelationalResolutionError("invalid_selector", ...)` with Playwright's message in `meta.innerError`. (Alternative: inline a zod enum for the 80 roles. Mechanical but verbose; defer.)

**`role` + `text` fast path:** if both `role` and `text` are present, use `page.getByRole(role, { name: text, exact: true })` directly (skip the `.and()` step). This is what users mean and Playwright optimizes for it.

**Combine multiple fields:** when more than one of `id`/`testid`/`css` is set alongside `text`, chain via `loc1.and(loc2)`. Playwright's `Locator.and()` returns a locator that matches both. Apply `await locator.all()` at the end to get a `Locator[]` of all matches.

**Interpolation:** apply `ctx.interpolate(value)` to every string field BEFORE building the locator. This is where 1.2's normalize-time deferral pays off.

**Empty pool:** if `(await locator.all()).length === 0`, return `[]`. Caller (`resolveRelational`) handles the "no candidates" failure with a structured error.

**Wrapping Playwright synchronous throws.** `page.getByRole(role)` rejects unknown role strings synchronously with a TypeError; `page.locator(css)` rejects malformed CSS strings synchronously with `Error: Unsupported token`. These throws would otherwise leak past `findCandidates` and crash the resolver. Wrap each per-field locator construction in a try/catch and surface the error structurally:

```ts
async function findCandidates(
  page: Page,
  ctx: ExecutionContext,
  leaf: Pick<RelationalSelector, "text" | "id" | "role" | "testid" | "css">,
): Promise<Locator[]> {
  let combined: Locator | null = null;
  const fastRoleName = leaf.role !== undefined && leaf.text !== undefined;

  try {
    if (fastRoleName) {
      combined = page.getByRole(
        leaf.role! as Parameters<Page["getByRole"]>[0],
        { name: ctx.interpolate(leaf.text!), exact: true },
      );
    } else {
      if (leaf.text !== undefined) {
        const t = ctx.interpolate(leaf.text);
        combined = mergeAnd(combined, page.getByText(t, { exact: true }));
      }
      if (leaf.role !== undefined) {
        combined = mergeAnd(
          combined,
          page.getByRole(leaf.role as Parameters<Page["getByRole"]>[0]),
        );
      }
    }
    if (leaf.id !== undefined) {
      combined = mergeAnd(combined, page.locator(`[id=${JSON.stringify(ctx.interpolate(leaf.id))}]`));
    }
    if (leaf.testid !== undefined) {
      combined = mergeAnd(combined, page.getByTestId(ctx.interpolate(leaf.testid)));
    }
    if (leaf.css !== undefined) {
      combined = mergeAnd(combined, page.locator(ctx.interpolate(leaf.css)));
    }
  } catch (err) {
    // Invalid role string, malformed css, or any other Playwright-level rejection during locator
    // construction. This is an AUTHORING error, NOT an absence — surface as `invalid_selector`
    // so negative assertions don't silently pass on malformed input.
    throw new RelationalResolutionError("invalid_selector", { ...leaf } as RelationalSelector, {
      innerError: err instanceof Error ? err.message : String(err),
    });
  }

  if (combined === null) {
    // Should be unreachable given the schema's leaf-required refine, but guard anyway.
    throw new RelationalResolutionError("no_leaf_match", { ...leaf } as RelationalSelector);
  }

  try {
    return await combined.all();
  } catch (err) {
    // Some leaf forms (e.g., css with `:has-text` and unbalanced parens) defer their syntax error
    // until `.all()` is called. Also an authoring error → `invalid_selector`.
    throw new RelationalResolutionError("invalid_selector", { ...leaf } as RelationalSelector, {
      innerError: err instanceof Error ? err.message : String(err),
    });
  }
}

const mergeAnd = (acc: Locator | null, next: Locator): Locator => (acc === null ? next : acc.and(next));
```

This is what makes the "invalid role surfaces as `RelationalResolutionError("invalid_selector")`" claim in 2.8 actually true — without these wraps, the error would leak. Tests in 2.8 spy on the resolver and assert the wrapping for both invalid role and invalid css. Crucially the `invalid_selector` kind is **excluded** from `isAbsentError()` (3.2) so negative assertions don't silently pass on malformed input.

### 2.3 Materialize bounds in one batch

```ts
async function materialize(candidates: Locator[]): Promise<ShadowNode[]> {
  const boxes = await Promise.all(
    candidates.map((loc) =>
      loc.boundingBox().catch(() => null), // detached/hidden → skip
    ),
  );
  const nodes: ShadowNode[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const b = boxes[i];
    if (!b) continue;
    nodes.push({
      locator: candidates[i]!,
      bounds: b,
      centerX: b.x + b.width / 2,
      centerY: b.y + b.height / 2,
    });
  }
  return nodes;
}
```

**Pitfall — auto-waiting.** `boundingBox()` doesn't auto-wait for the element to be attached/visible. If the page is mid-render, you can race. `Locator.all()` returns the current matches at call time, which is also race-prone. Mitigation: callers (`click`/etc.) already auto-wait via Playwright's `actionability` check before the click; the pre-resolution race only matters if NO candidate is matchable at the moment of resolution, in which case the error message says so and the user sees a normal flake. Don't add a global retry loop in the resolver — that's the step's `retry:` block territory.

**Pitfall — viewport boundaries.** `boundingBox()` returns coordinates relative to the page (not the viewport). That's actually what we want for spatial comparisons (an element scrolled off-screen still has a defined position relative to its sibling). No change needed.

### 2.4 Filter functions

```ts
type ShadowFilter = (nodes: ShadowNode[]) => ShadowNode[];

const above   = (ref: ShadowNode): ShadowFilter => (ns) => ns.filter((n) => n.centerY < ref.centerY);
const below   = (ref: ShadowNode): ShadowFilter => (ns) => ns.filter((n) => n.centerY > ref.centerY);
const leftOf  = (ref: ShadowNode): ShadowFilter => (ns) => ns.filter((n) => n.centerX < ref.centerX);
const rightOf = (ref: ShadowNode): ShadowFilter => (ns) => ns.filter((n) => n.centerX > ref.centerX);
```

**Why centers, not edges?** Maestro uses `bounds.y` (top edge) for `below`. That works for non-overlapping elements but breaks when the reference element extends below the candidate (e.g., a tall sidebar). Centers are the more forgiving and intuitive heuristic — "below" means "the center is lower." Document this divergence from Maestro in the module-level comment so the next reader doesn't think it's a bug. (If users complain, swap to edges in v2; the tests in 5.2 lock the chosen behavior in.)

**Distance tiebreaker** (Maestro's `Filters.kt:33-36, 180`):

```ts
const sortByDistance = (ref: ShadowNode): ShadowFilter => (ns) =>
  [...ns].sort((a, b) => {
    const da = Math.hypot(a.centerX - ref.centerX, a.centerY - ref.centerY);
    const db = Math.hypot(b.centerX - ref.centerX, b.centerY - ref.centerY);
    return da - db;
  });
```

Applied **after** all spatial filters fold, before `index` selection.

### 2.5 Hierarchical filters: `childOf`, `containsChild`

```ts
const childOf = (parent: ShadowNode): ShadowFilter => (ns) =>
  ns.filter(
    (n) =>
      n.bounds.x >= parent.bounds.x &&
      n.bounds.y >= parent.bounds.y &&
      n.bounds.x + n.bounds.width  <= parent.bounds.x + parent.bounds.width &&
      n.bounds.y + n.bounds.height <= parent.bounds.y + parent.bounds.height,
  );

const containsChild = (child: ShadowNode): ShadowFilter => (ns) =>
  ns.filter(
    (n) =>
      child.bounds.x >= n.bounds.x &&
      child.bounds.y >= n.bounds.y &&
      child.bounds.x + child.bounds.width  <= n.bounds.x + n.bounds.width &&
      child.bounds.y + child.bounds.height <= n.bounds.y + n.bounds.height,
  );
```

**Geometric, not DOM-hierarchy, containment.** Maestro uses parent/child pointers in TreeNode (`maestro-client/src/main/java/maestro/Filters.kt:185-205, TreeNode.kt:24`). Replicating that in Playwright requires either an a11y-tree dump (slow, partial) or a CSS-ancestor query (`element.closest(parentSelector)`). Both add complexity. Geometric containment is the **simpler, less-correct** choice; document it as a known limitation. 90% of real cases ("button inside the modal") work either way because modals are visually contained. The `<dialog>`-with-portal-rendered-children case fails — accept that.

**Future enhancement (not v1):** when `childOf` / `containsChild` is given, fall back to DOM ancestor check via Playwright `evaluate()` if geometric containment yields zero candidates. Defer.

### 2.6 The orchestrator: `resolveRelational`

```ts
export async function resolveRelational(
  page: Page,
  ctx: ExecutionContext,
  selector: RelationalSelector,
): Promise<Locator> {
  // Step 1: candidate pool from leaf fields
  const candidates = await findCandidates(page, ctx, selector);
  if (candidates.length === 0) {
    throw new RelationalResolutionError("no_leaf_match", selector);
  }

  // Step 2: materialize bounds
  const allNodes = await materialize(candidates);
  if (allNodes.length === 0) {
    throw new RelationalResolutionError("all_detached", selector);
  }

  // Step 3: resolve relational reference targets (recursive, single ShadowNode each).
  //
  // String refs are EXPANDED to `{ text: s }` and routed through the relational pipeline
  // (NOT through `resolveElement`). This is required so that ambiguous refs sort by Y-then-X
  // document order and pick the first — consistent with the docs and tests. If we delegated
  // strings to `resolveElement`, the "first match" would be in element-resolver chain order
  // (role-button → role-link → text → ...), not document order, which makes the spatial
  // semantics inconsistent.
  //
  // Refs always resolve to the FIRST match by Y-then-X — this is intentional v1 behavior,
  // mirroring Maestro (Filters.kt:33-36 INDEX_COMPARATOR). When the reference selector is
  // ambiguous, users force disambiguation by giving the ref its own `index` field.
  //
  // Errors from the inner resolution MUST be wrapped — otherwise an "element not found"
  // error from element-resolver leaks out as the outer failure, hiding which constraint
  // caused the problem. Wrap every inner failure as `reference_detached` regardless of cause.
  const refOrUndefined = async (
    field: keyof RelationalSelector,
    s: SelectorArg | undefined,
  ): Promise<ShadowNode | undefined> => {
    if (s === undefined) return undefined;

    // Expand string shorthand into a relational leaf so we route through the same pipeline.
    const refSelector: RelationalSelector = typeof s === "string" ? { text: s } : s;

    let refLocator: Locator;
    try {
      // Recursively resolve through the relational pipeline. resolveRelational already applies
      // the Y-then-X document-order tiebreaker via the no-relational-ref branch of step 5.
      refLocator = await resolveRelational(page, ctx, refSelector);
    } catch (innerErr) {
      throw new RelationalResolutionError("reference_detached", selector, {
        field,
        innerError: innerErr instanceof Error ? innerErr.message : String(innerErr),
      });
    }
    const [ref] = await materialize([refLocator]);
    if (!ref) {
      throw new RelationalResolutionError("reference_detached", selector, { field });
    }
    return ref;
  };

  const [aboveRef, belowRef, leftOfRef, rightOfRef, childOfRef, containsChildRef] = await Promise.all([
    refOrUndefined("above", selector.above),
    refOrUndefined("below", selector.below),
    refOrUndefined("leftOf", selector.leftOf),
    refOrUndefined("rightOf", selector.rightOf),
    refOrUndefined("childOf", selector.childOf),
    refOrUndefined("containsChild", selector.containsChild),
  ]);

  // Step 4: apply filters in fixed order — spatial first, hierarchical, then sort by primary spatial ref distance
  let nodes = allNodes;
  if (aboveRef)         nodes = above(aboveRef)(nodes);
  if (belowRef)         nodes = below(belowRef)(nodes);
  if (leftOfRef)        nodes = leftOf(leftOfRef)(nodes);
  if (rightOfRef)       nodes = rightOf(rightOfRef)(nodes);
  if (childOfRef)       nodes = childOf(childOfRef)(nodes);
  if (containsChildRef) nodes = containsChild(containsChildRef)(nodes);

  if (nodes.length === 0) {
    throw new RelationalResolutionError("intersection_empty", selector);
  }

  // Step 5: sort by distance to the *primary* spatial reference, falling back to document order.
  // Primary = first non-undefined among [below, above, rightOf, leftOf, childOf, containsChild].
  const primaryRef =
    belowRef ?? aboveRef ?? rightOfRef ?? leftOfRef ?? childOfRef ?? containsChildRef;
  if (primaryRef) {
    nodes = sortByDistance(primaryRef)(nodes);
  } else {
    // No relational ref at all — pick by document order via Y-then-X (mirrors Maestro INDEX_COMPARATOR).
    nodes = [...nodes].sort((a, b) => a.centerY - b.centerY || a.centerX - b.centerX);
  }

  // Step 6: explicit index, else first.
  const idx = selector.index ?? 0;
  if (idx >= nodes.length) {
    throw new RelationalResolutionError("index_out_of_range", selector, { matched: nodes.length, index: idx });
  }
  return nodes[idx]!.locator;
}
```

**Order of filter application** is **not commutative for sort-by-distance**, but each filter is independently composable for the boolean predicate part. The "primary ref" choice exists because Maestro composes spatial filters via `intersect()` and then sorts by distance to the **first** spatial reference (`Orchestra.kt:1418-1453`). We mirror that: `below` wins precedence over `above` if both are set. The order [below, above, rightOf, leftOf, childOf, containsChild] is documented in the module comment.

**Error class:**
```ts
export type RelationalErrorKind =
  | "no_leaf_match"        // valid selector, zero candidates matched on the page
  | "all_detached"         // candidates matched but none had bounds (hidden/off-tree)
  | "reference_detached"   // a relational reference target couldn't resolve
  | "intersection_empty"   // candidates filtered down to zero by relational constraints
  | "index_out_of_range"   // explicit index exceeds the matched candidate count
  | "invalid_selector";    // the selector itself is malformed (bad role, bad css, etc.)

export class RelationalResolutionError extends Error {
  constructor(
    public readonly kind: RelationalErrorKind,
    public readonly selector: RelationalSelector,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(`Relational resolution failed (${kind}): ${JSON.stringify(selector)}${meta ? ` ${JSON.stringify(meta)}` : ""}`);
    this.name = "RelationalResolutionError";
  }
}
```

**Why a distinct `invalid_selector` kind.** Group B handlers (`assertNotVisible`, `waitForElement state="hidden"`) treat `no_leaf_match`, `all_detached`, and `intersection_empty` as **absence success** — the assertion "this element is not visible" passes when no element exists. But a *malformed* selector is an authoring error, not absence; passing on `assertNotVisible: { css: "button[" }` (unbalanced bracket) or `{ role: "made-up" }` would silently hide bugs. The `invalid_selector` kind keeps these failures distinct so `isAbsentError()` (Phase 3.2) can exclude them.

Step handlers that catch this error format the user-facing message (in 3.x). The error class is exported so other modules (#26 record's selector synthesis) can react.

### 2.7 Top-level `resolveSelectorArg`

```ts
export async function resolveSelectorArg(
  page: Page,
  ctx: ExecutionContext,
  arg: SelectorArg,
): Promise<Locator> {
  if (typeof arg === "string") {
    // Existing behavior — preserve it byte-for-byte by delegating.
    const { resolveElement } = await import("./element-resolver.js");
    return resolveElement(page, ctx.interpolate(arg));
  }
  return resolveRelational(page, ctx, arg);
}
```

Note the dynamic import to avoid circular dependency (`element-resolver.ts` doesn't need to know about relational, but `relational-resolver.ts` falls back to it for string leaves and refs). Alternatively: refactor `resolveElement` to be plain function + wire both via a tiny `resolver/index.ts` barrel — simpler but two-file change. **Pick dynamic import** for v1; the cost is negligible (Node's module cache makes it a single load).

### 2.8 Tests: `cli/__tests__/unit/executor/relational-resolver.test.ts`

Use the existing locator-mocking idiom in `cli/__tests__/unit/executor/step-handlers.test.ts:7-33`. Add a `mockShadowNode(x, y, w, h)` factory.

- Pure leaf: `{ text: "Submit" }` → returns a single locator.
- `{ text: "Submit", testid: "btn-submit" }` → uses `Locator.and()`.
- `{ role: "button", text: "Submit" }` → uses `getByRole("button", { name: "Submit", exact: true })` (verify the args of the call).
- `below: "Email"` filters out candidates with centerY ≤ ref.centerY.
- `below + rightOf` intersects; only candidates satisfying both pass.
- Distance tiebreaker: 3 candidates below a ref, varying distances; closest wins (asserts the order of returned `Locator[]` after sort).
- `index: 1` picks second candidate after sort.
- `index: 5` against 3 matches → `RelationalResolutionError` with `kind: "index_out_of_range"`, `meta.matched: 3`.
- `childOf` geometric containment: candidate inside ref bounds passes; candidate outside fails.
- `containsChild`: candidate whose bounds enclose child passes.
- Empty leaf pool → `RelationalResolutionError` `kind: "no_leaf_match"`.
- Reference selector resolves to nothing (e.g., `below: "NonExistent"`) → `RelationalResolutionError` `kind: "reference_detached"` with `meta.field === "below"`. The outer wrapper IS the relational error; the inner element-resolver "Could not find element" message lives in `meta.innerError`.
- Reference selector ambiguous (e.g., 3 elements match `below: "Username"`) — picks first by Y-then-X document order. Assert that the FIRST occurrence is the chosen ref. Document this as v1 behavior; users force disambiguation by giving the ref selector its own `index` field.
- Recursive nesting: `{ text: "X", childOf: { id: "form", below: "Heading" } }` — the inner ref evaluates first; assert call order via mock.
- `ctx.interpolate` is called on every string leaf field (`text: "${user}"` becomes `text: "Alice"` before locator construction).
- **id escaping (supported set)**: leaf `{ id: 'a"b' }` → resolved selector contains `[id="a\"b"]` (use a spy on `page.locator` to capture the string; assert exact match). Cover: backslash (`a\\b`), bracket (`a]b`), space (`a b`), printable unicode.
- **id escaping (limitations)**: leaf `{ id: "a\nb" }` (newline in id) — assert the resolver either throws a clear "control characters not supported" error OR resolves to the literal `[id="a\nb"]` string (which CSS may interpret differently than expected). Lock the chosen behavior in. The README must document the limitation.
- **role typing**: leaf `{ role: "made-up-role" }` is accepted by zod but Playwright rejects at runtime → relational resolver surfaces as `RelationalResolutionError("invalid_selector", ...)`. The error message preserves Playwright's complaint in `meta.innerError`. **Critically**: assert that this error is NOT classified as absent by `isAbsentError()` — negative assertions (`assertNotVisible`, `waitForElement state="hidden"`) must surface this as a failure.
- **invalid css**: leaf `{ css: "button[" }` (unbalanced bracket) → `RelationalResolutionError("invalid_selector", ...)`, also NOT classified as absent.

---

## Phase 3 — Wire step handlers to the new resolver

### 3.1 Group A — positive resolution (7 handlers)

Each handler currently calls `resolveElement(page, selector)` with a string. Replace with `resolveSelectorArg(page, ctx, args)` where `args` may now be an object.

| Handler | File | Current call | Notes |
|---|---|---|---|
| `click` | `cli/src/executor/step-handlers/click.ts:20` | `resolveElement(page, selector)` | Drop the `typeof args === "string"` guard at lines 13-18; treat any non-undefined `args` as `SelectorArg` and let zod-validated input do the work. |
| `doubleClick` | `cli/src/executor/step-handlers/double-click.ts` | same | same |
| `hover` | `cli/src/executor/step-handlers/hover.ts` | same | same |
| `assertVisible` | `cli/src/executor/step-handlers/assert-visible.ts` | same | same |
| `assertText` | `cli/src/executor/step-handlers/assert-text.ts` | resolves `args.selector` (object branch) | Selector branch: widen and call `resolveSelectorArg`. |
| `copyTextFrom` | `cli/src/executor/step-handlers/copy-text-from.ts` | resolves `args.selector` | Selector branch: `await resolveSelectorArg(page, ctx, args.selector)`. |
| `scrollUntilVisible` | `cli/src/executor/step-handlers/scroll-until-visible.ts` | resolves `args.selector` in scroll loop | Same widening. The scroll loop re-resolves on each tick — correct, since positions change. Note: relational resolution adds `boundingBox()` calls per candidate; `maxScrolls` default of 20 stays put. |

**Common pattern (replaces lines 12-22 in `click.ts`):**
```ts
const arg = args as SelectorArg;            // validated upstream by StepSchema
const element = await resolveSelectorArg(page, ctx, arg);
ctx.lastElement = element;
await element.click();
```

The existing `ctx.interpolate(args)` call becomes redundant (`resolveSelectorArg` does it for both string and object cases). Remove it.

### 3.2 Group B — negative/state resolution (2 handlers)

`assertNotVisible` and `waitForElement` (with `state: "hidden" | "detached"`) need different semantics: **"element not found" is a SUCCESS, not a failure.** The current `assertNotVisible` handler at `assert-not-visible.ts:23-29` exploits Playwright's `waitFor({ state: "hidden" })` which already passes when the element doesn't exist. Group A's relational resolver throws `RelationalResolutionError("no_leaf_match"|"all_detached"|"intersection_empty")` when it finds nothing — for these handlers, we must catch those errors and treat them as a passing assertion.

**`assertNotVisible` rewrite** (`cli/src/executor/step-handlers/assert-not-visible.ts`):

```ts
export async function handleAssertNotVisible(
  page: Page,
  ctx: ExecutionContext,
  args: unknown,
): Promise<StepResult> {
  const start = performance.now();
  const arg = args as SelectorArg;

  try {
    let locator: Locator;
    try {
      locator = await resolveSelectorArg(page, ctx, arg);
    } catch (err) {
      if (isAbsentError(err)) {
        // Element not present in the page — that's a passing assertion.
        return passResult(start);
      }
      throw err;
    }
    // Element resolved. Wait for it to become hidden (or absent post-resolve).
    await locator.waitFor({ state: "hidden", timeout: 10_000 });
    return passResult(start);
  } catch (err) {
    return failResult(start, err);
  }
}

function isAbsentError(err: unknown): boolean {
  if (err instanceof RelationalResolutionError) {
    // INTENTIONALLY EXCLUDES `invalid_selector` and `index_out_of_range` and `reference_detached`.
    // - invalid_selector: the user's selector is malformed → authoring error, must NOT pass.
    // - index_out_of_range: candidates exist; the user's index is wrong → authoring error.
    // - reference_detached: the relational target couldn't resolve → ambiguous; surface as failure.
    return err.kind === "no_leaf_match" ||
           err.kind === "all_detached" ||
           err.kind === "intersection_empty";
  }
  // Bare-string path: resolveElement throws "Could not find element matching..." with the message
  // pattern at element-resolver.ts:64-66. Match by message prefix to avoid coupling to error class.
  if (err instanceof Error && /^(No element found|Could not find element)/.test(err.message)) {
    return true;
  }
  return false;
}

function passResult(start: number): StepResult {
  return {
    command: "assert-not-visible",
    args: undefined,  // handler retains real args via closure; signature unchanged
    status: "passed",
    duration_ms: Math.round(performance.now() - start),
  };
}
```

(Sketch — the actual code will pass `args` through; this is the structural shape.)

**`waitForElement` rewrite** (`cli/src/executor/step-handlers/wait-for-element.ts`): same pattern, but **with the v1 attached/detached guard from Phase 1.2** before any resolution work, and the absence-passes path only when `state === "hidden"`. For `state === "visible"` (default), positive-resolution semantics apply.

```ts
const { selector, state, timeout } = parseArgs(args);

// v1 limitation: relational selectors don't support attached/detached states
// (resolver materializes bounds, conflating hidden-attached with detached).
if ((state === "attached" || state === "detached") && typeof selector !== "string") {
  return failResult(start, new Error(
    `waitForElement state="${state}" is not supported with relational selectors in v1. ` +
    `Use a bare-string selector or state="visible"/"hidden".`,
  ));
}

const isAbsenceState = state === "hidden" || state === "detached";

let locator: Locator;
try {
  locator = await resolveSelectorArg(page, ctx, selector);
} catch (err) {
  if (isAbsenceState && isAbsentError(err)) return passResult(start);
  throw err;
}
await locator.waitFor({ state: state ?? "visible", timeout: timeout ?? 30_000 });
return passResult(start);
```

Note `state === "detached"` is allowed in the absence-passes branch only when the selector is a bare string (the guard above ensures that). For relational + detached, the guard rejects before reaching the resolver.

`parseArgs` is updated to accept the widened object form. The existing duck-typing at `wait-for-element.ts:12-27` is replaced with a zod-validated dispatch (relying on schema validation upstream).

### 3.3 Error message formatting in handlers

Each affected handler's `catch` block renders `err.message` directly today. With `RelationalResolutionError`, the JSON-encoded selector blob is noisy. Format it specially:

```ts
// In each handler's catch, before the existing error rendering:
const message =
  err instanceof RelationalResolutionError
    ? formatRelationalError(err)
    : err instanceof Error
      ? err.message
      : String(err);
```

Add `formatRelationalError(err)` to `relational-resolver.ts`:

```ts
export function formatRelationalError(err: RelationalResolutionError): string {
  const sel = JSON.stringify(err.selector);
  switch (err.kind) {
    case "no_leaf_match":       return `No elements found matching ${sel}`;
    case "all_detached":        return `Elements found but all detached/hidden for ${sel}`;
    case "reference_detached": {
      const field = err.meta?.["field"];
      const inner = err.meta?.["innerError"];
      const fieldNote = field ? ` (field: ${field})` : "";
      const innerNote = inner ? ` — inner: ${inner}` : "";
      return `Reference selector inside ${sel} matched no element${fieldNote}${innerNote}`;
    }
    case "intersection_empty":  return `No element satisfies all relational constraints in ${sel}`;
    case "index_out_of_range":  return `Index ${err.meta?.["index"]} out of range — only ${err.meta?.["matched"]} candidates matched ${sel}`;
    case "invalid_selector": {
      const inner = err.meta?.["innerError"];
      return `Malformed selector ${sel}${inner ? ` — ${inner}` : ""}. Check the selector syntax (role name, css, etc.).`;
    }
  }
}
```

### 3.4 Tests: `cli/__tests__/unit/executor/relational-handler-integration.test.ts`

For each of the 9 widened handlers, one happy-path test asserting the relational object reaches `resolveSelectorArg`. Use a single shared mock (`vi.mock("../../../src/executor/relational-resolver.ts")`) — assert call args, not behavior (covered in 2.8).

For `click`, `assertVisible`, `copyTextFrom`: also one error-path test asserting the formatted message is human-readable, not raw JSON.

**Specific to `assertNotVisible`:**
- Bare-string: element absent → pass (regression from existing behavior).
- Bare-string: element visible → fail.
- Relational: `assertNotVisible: { text: "Error", below: "Header" }`, no candidate matching the leaf → pass.
- Relational: candidate matches leaf and visible → fail.
- Relational: candidate matches leaf but `below` constraint excludes it (intersection empty) → pass.
- **Malformed selector: `assertNotVisible: { css: "button[" }` → FAIL** with the `invalid_selector` formatted message. The malformed-input case must NOT silently pass on negative assertions.
- **Made-up role: `assertNotVisible: { role: "made-up-role" }` → FAIL** with `invalid_selector`.

**Specific to `waitForElement`:**
- Object form `{ selector: "X", state: "visible" }`: element absent → fail.
- Object form `{ selector: "X", state: "hidden" }`: element absent → pass.
- Object form `{ selector: { text: "Loading", below: "Form" }, state: "hidden" }`: relational resolution finds nothing → pass.
- Object form with relational selector + state visible + element absent → fail.
- **v1 limitation guard — `{ selector: { text: "X" }, state: "attached" }`**: handler returns `failed` with the v1 limitation error message; resolver is NOT called.
- **v1 limitation guard — `{ selector: { text: "X" }, state: "detached" }`**: handler returns `failed` with the v1 limitation error message; resolver is NOT called.
- Bare-string + `{ selector: "#x", state: "attached" }`: continues to use the existing path; element present → pass; element absent → fail.
- Bare-string + `{ selector: "#x", state: "detached" }`: continues to use the existing path; element absent → pass.

---

## Phase 4 — Documentation, prompt exposure, examples

### 4.1 `cli/README.md` — selector docs

Add a section under selectors:

```markdown
### Relational selectors

skeptic supports composable relational selectors inspired by Maestro:

\`\`\`yaml
- click:
    text: "Submit"
    below: "Email address"
- click:
    role: "button"
    rightOf: "icon-search"
- click:
    testid: "save"
    childOf: { id: "edit-form" }
- click:
    text: "Add"
    containsChild: { text: "Cart" }
\`\`\`

Available relational fields:
- `above`, `below`, `leftOf`, `rightOf` — spatial (compares element centers)
- `childOf`, `containsChild` — geometric containment
- `index` — explicit pick when multiple elements match (0-based, default 0)

Each relational reference can itself be a string (shorthand for `text:`) or a nested object.

The leaf identifies the candidate pool: `text`, `id`, `role`, `testid`, or `css`. Multiple leaf fields combine via `Locator.and()`. When `role` and `text` are both present, they map to `getByRole(role, { name: text, exact: true })`.

Distance tiebreaker: when multiple candidates satisfy the constraints, the closest one (Euclidean center-to-center) wins. Override with explicit `index: N`.
```

### 4.2 AI prompt awareness

**File:** `cli/src/ai/prompts.ts`

The relational form is intentionally **not** advertised to the LLM in v1. AI-generated tests stay on bare-string selectors so we don't bloat the prompt or have the LLM hallucinate plausible-but-wrong relational structures. Add a short note in `GENERATE_FROM_DIFF_PROMPT` (line 60+) under the existing "Use descriptive selectors" guidance:

```diff
- Use descriptive selectors (text content, labels, test-ids) rather than brittle CSS selectors.
+ Use descriptive selectors (text content, labels, test-ids) rather than brittle CSS selectors. Stick to bare-string selectors; relational selectors are reserved for human-authored flows.
```

(Apply the same edit to `GENERATE_FROM_DESCRIPTION_PROMPT` at line 134.)

Tests for prompts (`cli/__tests__/unit/ai/prompts.test.ts` — exists per `wiggly-floating-whistle.md` 5.7): add an assertion that neither prompt mentions `below`, `above`, `childOf`, or `containsChild`. Locks the policy in.

### 4.3 Example flow

Add `cli/templates/examples/relational-selectors.yaml` demonstrating all six relational primitives. Wire into `init` if the existing init writes example flows — check `cli/src/commands/init.ts` for the pattern. Skip if init only writes a config; this is just a docs-adjacent file.

---

## Critical Files to Modify

| File | Phase | Change |
|------|-------|--------|
| `cli/src/parser/flow-schema.ts` | 1.1, 1.2 | Add `RelationalSelector`, `SelectorArg`, `isRelationalSelector`; widen 9 step types |
| `cli/src/parser/step-normalizer.ts` | 1.2 | Skip object-arg interpolation (defer to resolve time) |
| `cli/src/executor/relational-resolver.ts` | 2.1-2.7 | New file — shadow-snapshot pipeline + filters + orchestrator + error class |
| `cli/src/executor/element-resolver.ts` | 2.7 | Unchanged structurally; ensure `resolveElement` is exported as a plain function (already is at line 8) |
| `cli/src/executor/step-handlers/click.ts` | 3.1, 3.4 | `resolveSelectorArg` + `formatRelationalError` |
| `cli/src/executor/step-handlers/double-click.ts` | 3.1, 3.4 | same |
| `cli/src/executor/step-handlers/hover.ts` | 3.1, 3.4 | same |
| `cli/src/executor/step-handlers/assert-visible.ts` | 3.1, 3.4 | same |
| `cli/src/executor/step-handlers/assert-not-visible.ts` | 3.1, 3.4 | same |
| `cli/src/executor/step-handlers/wait-for-element.ts` | 3.1, 3.4 | same |
| `cli/src/executor/step-handlers/copy-text-from.ts` | 3.1, 3.4 | Selector branch |
| `cli/src/executor/step-handlers/assert-text.ts` | 3.2, 3.4 | Selector branch widening |
| `cli/src/executor/step-handlers/scroll-until-visible.ts` | 3.3, 3.4 | Selector branch widening |
| `cli/src/ai/prompts.ts` | 4.2 | One-line note on each prompt |
| `cli/README.md` | 4.1 | Relational selectors section |
| `cli/templates/examples/relational-selectors.yaml` | 4.3 | New example flow |

Plus 3 new test files (1.4, 2.8, 3.5) and 1 update (`prompts.test.ts`). No new dependencies.

---

## Reused Utilities

- `resolveElement` — `cli/src/executor/element-resolver.ts:8` (string-path delegate target)
- `ExecutionContext.interpolate` — `cli/src/executor/context.ts` (string interpolation, called per leaf)
- `Locator.and()`, `Locator.boundingBox()`, `Locator.all()` — Playwright stable API
- `StepSchema` refines for "exactly one command key" / "softTimeout < hardTimeout" — `flow-schema.ts:394-428` (untouched; relational object lives inside one command's value, doesn't add new keys)
- `mockLocator()` idiom — `cli/__tests__/unit/executor/step-handlers.test.ts:7-33`
- `normalizeStep` — `cli/src/parser/step-normalizer.ts` (skip-object-args change is the only update)

---

## Verification

```bash
cd cli
npm run build                 # strict TS — type widening must compile
npm run check                 # tsc --noEmit
npm test                      # vitest — new + existing
```

**Smoke flows (end-to-end):**

```yaml
# Spatial
- navigate: /forms/registration
- click:
    text: "Save"
    below: "Email address"

# Hierarchical
- navigate: /cart
- click:
    text: "Remove"
    childOf: { testid: "cart-item-2" }

# Compound
- click:
    role: "button"
    text: "Add"
    rightOf: "Quantity"
    below: "Total"

# Tiebreaker
- navigate: /list
- click:
    text: "Edit"
    index: 2     # third "Edit" button in document order

# Negative — should fail with "intersection_empty" (button is above, not below)
- click:
    text: "Logout"
    below: "Footer"
```

Run against a local fixture page (`cli/__tests__/fixtures/relational.html` — to add) that lays out elements in a known geometric arrangement; the smoke test validates each primitive resolves to the correct `data-testid`.

**Backwards compat:** every existing test in `cli/__tests__/` that uses bare-string selectors must still pass without modification — that's the regression bar.
