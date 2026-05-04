# Plan: Bundle 2 — Dev-ergonomics CLI (`skeptic validate` + `load_guidance`)

## Context

Bundle 2 ships two dev-ergonomics features from the competitive analysis (`docs/competitive-analysis-maestro-expect.md`): YAML syntax validation (#42, Maestro) and domain-specific guidance loading (#33, Expect).

**Upstream reference — Maestro `check-syntax`:**

- Entrypoint: `skeptic-refs/maestro/maestro-cli/src/main/java/maestro/cli/command/CheckSyntaxCommand.kt:10-40`. Single-file only (`index = "0"`, not variadic); stdin via `-`.
- Exit codes: `0` success, `1` error (via `App.kt:157` exception handler).
- Error rendering: colorized red by PicoCLI (`App.kt:141-143`); format `~> title / ~ / ~path:line / inline`; `YamlCommandReader.kt:128-162`.
- "Did you mean": Levenshtein distance, threshold 3, in `MaestroFlowParser.kt:302-315,431-441`. Candidate set is (prefix/substring hits ∪ edit-distance ≤ 3), distinct, sorted by distance.
- Scope: YAML parse errors + command-list syntax + unknown commands + schema. Does **not** execute.

**Upstream reference — Expect `load_guidance`:**

- Design intent: `skeptic-refs/expect/.specs/agent-domain-guidance.md:3-19,115-126`. On-demand loading avoids preamble bloat (~2k tokens saved per run); agent fetches only domains it hits.
- 8 domains: `animation`, `accessibility`, `performance`, `design`, `security`, `seo`, `responsive`, `react`. File pattern: `packages/browser/src/mcp/resources/{domain}/rule.md`.
- File shape: YAML frontmatter (`name`, `description`, `version`) + markdown body (checklist + prose). Excerpt: `packages/browser/src/mcp/resources/design/rule.md:1-40`.
- Implementation: Expect exposes these as **MCP resources** (`packages/browser/src/mcp/rules-resources.ts:5-99`) with a resource-listing prompt. Content is build-time bundled via Vite's `__RULES_CONTENT__` global (`packages/browser/scripts/build-rules-content.js:5-32`).
- Trigger guidance: prompt says "fetch the matching resource before writing code" when the task domain is recognized (`rules-resources.ts:10-12`).

**skeptic's current state — integration points:**

- **Flow parser** (`cli/src/parser/flow-parser.ts:13-95`): `parseFlowFile` / `parseFlowString` are throw-based (`FlowParseError` at `:97-105`). Zod issues are formatted into the message string and lost. We need structured errors for per-issue "did you mean" annotations.
- **Step registry** (`cli/src/parser/flow-schema.ts:13-54`): `COMMAND_KEYS` is the canonical source of truth for all valid step command names. This is the Levenshtein candidate set.
- **Glob resolver** (`cli/src/parser/glob-resolver.ts`): already exposes `resolveFlows(patterns)`. We'll reuse for the `validate` command.
- **Current `--dry-run`** (`cli/src/commands/test.ts:142-148`): thin — logs count + per-flow lines. Relies on `resolveFlows` (which throws on first bad file). Worth sharing the success-summary formatting with `validate`; full reuse isn't possible because `validate` needs error-tolerant parsing that `resolveFlows` doesn't provide.
- **CLI registration** (`cli/src/index.ts:37-149`): flat `program.command(...).option(...).action(...)` pattern. Insert `validate` between `test` (line 79) and `generate` (line 81).
- **MCP tools** (`cli/src/commands/mcp.ts:25-115`): 6 tools today; `ListToolsRequestSchema` returns an array, `CallToolRequestSchema` dispatches via `switch(name)`. Add `load_guidance` as tool #7.
- **AI client system param** (`cli/src/ai/ai-client.ts:9-13`): `generateText(prompt, system?, temperature?)` signature — all three providers support it. `flow-generator.ts:119-123,144-148` currently call without `system`. Guidance text threads in here.
- **Walk-up idiom** (`cli/src/config/loader.ts:104-114`): directory traversal for config discovery. Mirror this pattern for per-project guidance overrides at `.skeptic/guidance/<domain>.md`.

**Goal:** `skeptic validate [files...]` validates YAML flows with Maestro-quality error messages + Levenshtein suggestions; `load_guidance` MCP tool (and `skeptic generate --guidance`) lets the AI layer pull domain-specific rules on demand. All changes integrate cleanly with existing parser/MCP/generator; no breaking changes to public API.

**Out of scope:**

- Migrating `load_guidance` from MCP tool → MCP resource. Expect's implementation uses resources; skeptic's MCP server today is tool-only. Ship as a tool for symmetry with existing `validate_flow`, `run_flow`, etc. Can revisit if/when we expose any other resources.
- Auto-recognition of domain from flow content (e.g. scanning for `animation:` keys). Triggering is the agent's job — we provide the tool, the agent picks the domain.
- Build-time bundling of guidance. skeptic has no bundler (raw `tsc` emit); we ship markdown files via the existing `cp -r templates dist/` step and read them at runtime with `fs.readFileSync`. Token cost of reading markdown lazily is negligible.
- Visual rendering of a "did you mean" box (Maestro uses ANSI box drawing via `YamlCommandReader.kt:128-162`). skeptic's `logger` + `chalk` are enough; skip the heavy box chars.

**Security model for filesystem-loaded guidance:**

`.skeptic/guidance/<domain>.md` overrides are a **trust-elevation surface** — they flow into the AI `system` prompt. Mitigations (not blockers):

1. Every override load logs a warning line: `[skeptic] ⚠ Using guidance override: <abs-path> (builtin superseded)`. Makes the behavior discoverable.
2. `load_guidance` MCP response returns structured JSON including `source` (`"builtin"` or the absolute override path), so AI agents can see exactly what they loaded.
3. Overrides are **opt-in per invocation** for `skeptic generate` — the flag `--guidance animation` triggers lookup; without the flag, no filesystem reads.

We do **not** require an extra `--allow-override` flag today (too noisy for a feature with no known exploit path), but the plan is structured so it can be added without redesigning — just gate `findUserGuidance` behind a config/CLI bool.

---

## Phase 1 — Levenshtein utility + `findSimilar`

### 1.1 Add `cli/src/utils/levenshtein.ts`

New module. Mirrors the algorithm at `MaestroFlowParser.kt:302-315` plus the candidate-assembly from `:431-441`.

```ts
/**
 * Levenshtein edit distance between two strings.
 * Classic DP, O(m*n) time / O(m*n) space — fine for vocabulary <100.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1]
        ? dp[i - 1]![j - 1]!
        : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

/**
 * Return the subset of `candidates` similar to `input`.
 * Similarity = Levenshtein ≤ threshold OR (len(input)≥3 AND prefix/substring match).
 * Sorted by distance asc. De-duped. Empty array if no matches.
 */
export function findSimilar(
  input: string,
  candidates: readonly string[],
  threshold: number = 3,
): string[] {
  const inputLower = input.toLowerCase();
  const withDistance = candidates.map((c) => ({
    candidate: c,
    distance: levenshtein(inputLower, c.toLowerCase()),
    substring:
      input.length >= 3 &&
      (c.toLowerCase().includes(inputLower) || inputLower.includes(c.toLowerCase())),
  }));
  const matches = withDistance.filter((x) => x.distance <= threshold || x.substring);
  matches.sort((a, b) => a.distance - b.distance);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    if (!seen.has(m.candidate)) {
      seen.add(m.candidate);
      out.push(m.candidate);
    }
  }
  return out;
}
```

**Why threshold 3, not 2:** Matches Maestro exactly (`MaestroFlowParser.kt:431`). For our step names (avg length ~12 chars), threshold 3 catches typos like `assertVisibl`→`assertVisible` and `cliks`→`click` without firing on genuinely unrelated names like `scroll`→`select`.

**Why separate `substring` branch:** mirrors Maestro's "prefix/substring match (commands < 3 chars excluded)" heuristic. A user typing `Visible` gets `assertVisible` + `assertNotVisible` even though the distance is >3.

### 1.2 Tests — `cli/__tests__/unit/utils/levenshtein.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { levenshtein, findSimilar } from "../../../src/utils/levenshtein.js";

describe("levenshtein", () => {
  it("returns 0 for equal strings", () => expect(levenshtein("foo", "foo")).toBe(0));
  it("returns length for empty inputs", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });
  it("handles single-char diffs", () => expect(levenshtein("click", "clik")).toBe(1));
  it("handles transpositions as 2", () => expect(levenshtein("ab", "ba")).toBe(2));
});

describe("findSimilar", () => {
  const commands = ["navigate", "click", "type", "assertVisible", "assertNotVisible", "scroll"] as const;

  it("finds exact single match", () => {
    expect(findSimilar("clik", commands)).toEqual(["click"]);
  });
  it("finds multiple matches sorted by distance", () => {
    const matches = findSimilar("assertVisibl", commands);
    expect(matches[0]).toBe("assertVisible");
  });
  it("returns empty when no match within threshold", () => {
    expect(findSimilar("xyzqwerty", commands)).toEqual([]);
  });
  it("is case-insensitive", () => {
    expect(findSimilar("CLICK", commands)).toContain("click");
  });
  it("respects custom threshold", () => {
    expect(findSimilar("foobar", ["navigate"], 2)).toEqual([]);
    expect(findSimilar("foobar", ["navigate"], 10)).toContain("navigate");
  });
});
```

**Exit criteria:** `npm test -- utils/levenshtein.test.ts` green. `npm run check` green.

---

## Phase 2 — Parser returns structured validation results

### 2.1 Add `validateFlowString` / `validateFlowFile` to `flow-parser.ts`

Today `parseFlowString` throws `FlowParseError` with Zod issues **stringified into `.message`**. The `validate` command needs the structured Zod issues to (a) print per-issue line refs and (b) attach "did you mean" suggestions to specific unknown-command errors.

**Strategy:** add a non-throwing `validateFlowString(content, filePath)` that returns a result-union, and have `parseFlowString` delegate to it. Zero breakage for existing callers.

**File:** `cli/src/parser/flow-parser.ts`

Add a new issue shape + result type:

```ts
export interface ValidationIssue {
  /** Human-readable "where" ("metadata", "step 3", "yaml") */
  scope: string;
  /** Zod-style path into the failing node, empty array if YAML-level */
  path: (string | number)[];
  message: string;
  /** Best-guess line number, or undefined if not computable. 1-indexed. */
  line?: number;
  /** If this issue is a literal-mismatch on a command key (unknown step name), the bad key. */
  unknownCommand?: string;
}

export type ValidationResult =
  | { success: true; flow: ResolvedFlow }
  | { success: false; errors: ValidationIssue[] };

export function validateFlowString(
  content: string,
  filePath: string = "<inline>",
): ValidationResult { /* ... */ }

export function validateFlowFile(filePath: string): ValidationResult {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return validateFlowString(content, filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, errors: [{ scope: "fs", path: [], message }] };
  }
}
```

**YAML syntax errors** — collect all parser errors from all documents (not just the first), capped to avoid cascade spam. `yaml` v2's `doc.errors` is already an array per document; one syntax error can produce many downstream errors, so limit to 5 per doc.

```ts
const yamlErrors: ValidationIssue[] = [];
for (const doc of docs) {
  for (const e of doc.errors.slice(0, 5)) {
    const line = e.linePos?.[0]?.line;
    yamlErrors.push({ scope: "yaml", path: [], message: e.message, ...(line !== undefined && { line }) });
  }
  if (doc.errors.length > 5) {
    yamlErrors.push({ scope: "yaml", path: [], message: `... (${doc.errors.length - 5} more YAML errors suppressed)` });
  }
}
if (yamlErrors.length > 0) {
  return { success: false, errors: yamlErrors };
}
```

**Metadata issues** — map Zod issues to `ValidationIssue`s with `scope: "metadata"`.

**Step issues** — `StepSchema` is a plain non-strict `z.object` (`flow-schema.ts:146-351`), so Zod accepts extra keys silently. We need **independent unknown-key detection** on the raw step, for **every** step (not just the zero-command case). Codex's round-1 callout: `{ click: "#x", cliks: "#y" }` must surface `cliks` as an unknown key even though the schema passes.

**`flow-schema.ts` exports the already-defined `SHARED_KEYS` set** (`flow-schema.ts:136-144`) plus a derived `KNOWN_STEP_KEYS`:

```ts
// flow-schema.ts — change `const SHARED_KEYS` to `export const SHARED_KEYS`
export const KNOWN_STEP_KEYS: ReadonlySet<string> = new Set<string>([
  ...COMMAND_KEYS,
  ...SHARED_KEYS,
]);
```

Step-validation loop:

```ts
for (let i = 0; i < rawSteps.length; i++) {
  const raw = rawSteps[i];
  const stepResult = StepSchema.safeParse(raw);

  const rawKeys = raw && typeof raw === "object" && !Array.isArray(raw)
    ? Object.keys(raw as object)
    : [];
  const unknownKeys = rawKeys.filter((k) => !KNOWN_STEP_KEYS.has(k));

  // Unknown-key issues — reported even when the schema otherwise passes.
  for (const uk of unknownKeys) {
    errors.push({
      scope: `step ${i + 1}`,
      path: [uk],
      message: `Unknown key '${uk}'`,
      unknownCommand: uk, // triggers "did you mean" against COMMAND_KEYS in the formatter
    });
  }

  // Zod-reported issues (schema violations inside known keys + the refine result).
  if (!stepResult.success) {
    for (const issue of stepResult.error.issues) {
      errors.push({
        scope: `step ${i + 1}`,
        path: issue.path,
        message: issue.message,
      });
    }
  }
}

// success path: only return flow if BOTH schema passed AND no unknown keys.
if (errors.length > 0) return { success: false, errors };
```

**Key change from round 1:** unknown-key detection is now orthogonal to schema success. A step with `{ click: "#x", cliks: "#y" }` produces one unknown-key issue for `cliks` (with `unknownCommand: "cliks"` → "Did you mean: click?") **and** the existing refine error ("Each step must have exactly one command key") if the schema catches it.

**Side-effect for `parseFlowString`:** a step with a valid command plus an extra unknown key used to succeed silently. After this change, it becomes an error — a behavior change. This is intentional: the code was tolerating typos. Add a regression test that asserts the old fixture `malformed-bad-step.yaml` (`- flyTo: "the moon"`) still fails with a non-empty error list, and add a new fixture covering the `{ click, cliks }` mixed case.

### 2.2 Have `parseFlowString` delegate

```ts
export function parseFlowString(content: string, filePath: string = "<inline>"): ResolvedFlow {
  const result = validateFlowString(content, filePath);
  if (!result.success) {
    const msg = result.errors
      .map((e) => `  - ${e.scope}${e.path.length ? `.${e.path.join(".")}` : ""}: ${e.message}`)
      .join("\n");
    throw new FlowParseError(filePath, msg);
  }
  return result.flow;
}
```

The error-message formatting preserves the current throw-path shape so existing tests continue to pass. Zero regression.

### 2.3 Tests — augment `cli/__tests__/unit/parser/flow-parser.test.ts` (exists)

Add cases for the new function:

- `validateFlowString` returns `success: true` with valid flow (uses existing `valid-login.yaml` fixture).
- Returns structured `errors[]` for YAML syntax errors with `line` populated.
- Multi-error YAML file: returns multiple YAML issues; asserts cap of 5.
- Returns structured `errors[]` for Zod metadata failures with `scope: "metadata"` (reuse `malformed-no-name.yaml`).
- Returns `errors[]` with `unknownCommand` populated when a step has only an unknown key (reuse `malformed-bad-step.yaml` — `flyTo`).
- **NEW (Codex round-1 fix):** `{ click: "#x", cliks: "#y" }` case produces a `cliks` unknown-key issue (new fixture `mixed-typo.yaml`). This is the gap the plan had in round 1.
- `parseFlowString` still throws on the same inputs (regression — existing line 57-60 test).

**Exit criteria:** `npm test -- parser/` green. Existing parser tests unchanged.

---

## Phase 2.5 — Extract `resolveFlowPaths` from `glob-resolver.ts`

Codex round 1 flagged that reimplementing glob inside `validate.ts` creates drift from `skeptic test`. Fix: pull out just the file-discovery step from `resolveFlows` so both commands share it.

**File:** `cli/src/parser/glob-resolver.ts`

```ts
/**
 * Resolve glob patterns to absolute flow file paths (no parsing).
 * Shared between `skeptic test` (which then calls parseFlowFile strictly)
 * and `skeptic validate` (which parses tolerantly via validateFlowFile).
 */
export async function resolveFlowPaths(
  patterns: string | string[],
  cwd: string = process.cwd(),
): Promise<string[]> {
  const patternList = Array.isArray(patterns) ? patterns : [patterns];
  const filePaths = new Set<string>();
  for (const pattern of patternList) {
    const matches = await glob(pattern, { cwd, absolute: true, nodir: true });
    for (const m of matches) filePaths.add(path.resolve(m));
  }
  return [...filePaths].sort();
}

export async function resolveFlows(
  patterns: string | string[],
  cwd: string = process.cwd(),
): Promise<ResolvedFlow[]> {
  const paths = await resolveFlowPaths(patterns, cwd);
  if (paths.length === 0) {
    const patternList = Array.isArray(patterns) ? patterns : [patterns];
    logger.warn(`No flow files matched patterns: ${patternList.join(", ")}`);
    return [];
  }
  logger.debug(`Resolved ${paths.length} flow file(s)`);
  return paths.map((fp) => parseFlowFile(fp));
}
```

Pure refactor — `resolveFlows` keeps same signature + behavior. Validate uses `resolveFlowPaths` for the dedupe/cwd/`nodir` semantics parity the round-1 review called out.

**Scope note (Codex round-4 clarification):** Phase 2.5 extracts a shared helper — both `resolveFlows` and `resolveFlowPaths` accept a `cwd` parameter. The caller decides the cwd. `skeptic test` continues passing the default (`process.cwd()`), preserving existing behavior. `skeptic validate` passes a config-anchored cwd (Phase 3). Fixing `skeptic test`'s cwd anchoring is **out of scope for Bundle 2** — a latent bug that predates this work. Track as a separate follow-up after Bundle 2 ships.

**Exit criteria:** `npm test -- parser/` green. No `skeptic test` regressions.

---

## Phase 2.55 — `loadConfigWithMeta` helper

Codex round 4: auto-discovered configs (no `--config` flag, `loadConfig` walks up from cwd) also need their directory surfaced so validate can anchor globs correctly. The fix: expose the resolved config path alongside the parsed config.

**File:** `cli/src/config/loader.ts`

Split the existing `loadConfig` into a thin wrapper + a richer variant:

```ts
export interface LoadConfigResult {
  config: skepticConfig;
  /** Absolute path to the config file, or null if none was found. */
  configPath: string | null;
}

export function loadConfigWithMeta(opts: LoadConfigOptions = {}): LoadConfigResult {
  const configPath = opts.configPath
    ? path.resolve(opts.configPath)
    : findConfigFile(process.cwd());

  let raw: Record<string, unknown> = {};
  if (configPath) {
    // ...existing body of loadConfig from lines 31-62, reading configPath instead of filePath...
  }
  // (env overrides, CLI overrides, interpolate, safeParse — identical to current)

  return { config: result.data, configPath };
}

export function loadConfig(opts: LoadConfigOptions = {}): skepticConfig {
  return loadConfigWithMeta(opts).config;
}
```

All 6 existing callers (`cli/src/commands/{add,mcp,test,generate}.ts`) continue using `loadConfig` unchanged — zero-change refactor.

**Exit criteria:** `npm run check` green. Existing config tests pass unchanged. New: one unit test that `loadConfigWithMeta` returns `{ config, configPath: null }` when no config file exists, and returns the absolute path when a config is found (both via `--config` explicit and via walk-up).

---

## Phase 2.6 — `logger.errorRaw` helper

Codex round 3 flagged that `logger.raw` is info-gated, so `--quiet` (which raises level to `error`) silences per-file validation errors. Fix: add a minimal error-level-gated variant that matches `raw`'s unprefixed shape.

**File:** `cli/src/utils/logger.ts` — add one method to the `logger` object:

```ts
export const logger = {
  // ...existing methods...

  /** Like raw(), but gated at error level so --quiet still shows it. */
  errorRaw(...args: unknown[]): void {
    if (shouldLog("error")) console.error(...args);
  },
};
```

Uses `console.error` (stderr) so tooling that pipes stdout-only output (e.g. `skeptic validate | less`) still sees the errors on the terminal. Matches how `logger.error` already writes to stderr.

**Exit criteria:** tsc green. Unit test optional (it's 2 lines) — covered by Phase 3's validate tests anyway (assertion: `--quiet` suppresses success lines but not failure blocks).

---

## Phase 3 — `skeptic validate` command

### 3.1 `cli/src/commands/validate-core.ts` — shared formatting

Tiny module, pure functions. Consumed by `validate` + `test --dry-run`.

```ts
import chalk from "chalk";
import type { ResolvedFlow } from "../parser/flow-schema.js";
import type { ValidationIssue } from "../parser/flow-parser.js";
import { findSimilar } from "../utils/levenshtein.js";
import { COMMAND_KEYS } from "../parser/flow-schema.js";

export interface FileReport {
  filePath: string;
  ok: true;
  flow: ResolvedFlow;
} | {
  filePath: string;
  ok: false;
  errors: ValidationIssue[];
}

/** One line per flow: "✓ flow-name (12 steps)" */
export const formatFlowSummary = (flow: ResolvedFlow): string =>
  `  ${chalk.green("✓")} ${chalk.cyan(flow.metadata.name)} ${chalk.dim(`(${flow.steps.length} steps)`)}`;

/** Full per-file error block with Did-you-mean footers */
export const formatFileErrors = (filePath: string, errors: ValidationIssue[]): string => {
  const header = `${chalk.red("✗")} ${chalk.bold(filePath)}`;
  const body = errors.map((e) => {
    const loc = e.line !== undefined ? `:${e.line}` : "";
    const pathSuffix = e.path.length ? `.${e.path.join(".")}` : "";
    const main = `    ${chalk.dim(e.scope + pathSuffix + loc)} ${e.message}`;
    if (e.unknownCommand) {
      const suggestions = findSimilar(e.unknownCommand, COMMAND_KEYS);
      if (suggestions.length === 1) {
        return main + `\n      ${chalk.yellow("→ Did you mean")} ${chalk.cyan(suggestions[0])}${chalk.yellow("?")}`;
      }
      if (suggestions.length > 1) {
        return main + `\n      ${chalk.yellow("→ Did you mean one of:")} ${suggestions.slice(0, 5).map((s) => chalk.cyan(s)).join(", ")}`;
      }
    }
    return main;
  }).join("\n");
  return header + "\n" + body;
};
```

### 3.2 `cli/src/commands/validate.ts`

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfigWithMeta } from "../config/loader.js";
import { resolveFlowPaths } from "../parser/glob-resolver.js";
import { validateFlowFile, validateFlowString } from "../parser/flow-parser.js";
import type { ResolvedFlow } from "../parser/flow-schema.js";
import type { ValidationIssue } from "../parser/flow-parser.js";
import { formatFileErrors, formatFlowSummary } from "./validate-core.js";
import { logger } from "../utils/logger.js";

export interface ValidateCommandOptions {
  config?: string;
}

export async function runValidate(
  patterns: string[] | undefined,
  opts: ValidateCommandOptions = {},
): Promise<void> {
  // Stdin path: `skeptic validate -`
  const useStdin = patterns?.length === 1 && patterns[0] === "-";

  type FileItem = { path: string; content?: string };
  let files: FileItem[];

  if (useStdin) {
    const content = fs.readFileSync(0, "utf-8");
    files = [{ path: "<stdin>", content }];
  } else {
    // Precedence for the default pattern list:
    //   1. explicit CLI args (patterns) — resolved against process.cwd()
    //   2. config.tests from skeptic.config.yaml — resolved against path.dirname(resolved config path)
    //
    // config.tests is `string | string[]` (schema.ts:74) — normalize before use (Codex round-2 fix).
    // Relative patterns MUST anchor to the config file's directory, whether the config was passed
    // explicitly via --config OR auto-discovered by walk-up (Codex round-3 + round-4 fix).
    let effective: string[];
    let globCwd: string = process.cwd();
    if (patterns && patterns.length > 0) {
      effective = patterns;
    } else {
      const { config, configPath } = loadConfigWithMeta(
        opts.config ? { configPath: opts.config } : {},
      );
      effective = Array.isArray(config.tests) ? config.tests : [config.tests];
      if (configPath) {
        globCwd = path.dirname(configPath); // already absolute (loader resolves or finds)
      }
    }

    const resolved = await resolveFlowPaths(effective, globCwd);
    if (resolved.length === 0) {
      logger.error(`No flow files matched: ${effective.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    files = resolved.map((p) => ({ path: p }));
  }

  const failed: { filePath: string; errors: ValidationIssue[] }[] = [];
  const passed: { filePath: string; flow: ResolvedFlow }[] = [];

  for (const file of files) {
    const result = file.content !== undefined
      ? validateFlowString(file.content, file.path)
      : validateFlowFile(file.path);
    if (result.success) {
      passed.push({ filePath: file.path, flow: result.flow });
    } else {
      failed.push({ filePath: file.path, errors: result.errors });
    }
  }

  // Report failures first (loud), then successes (quiet).
  // Failures use logger.errorRaw (new, error-level gated, no prefix) so --quiet still shows
  // them — Codex round-3 fix: raw suppressed failure diagnostics entirely under --quiet.
  // Successes use logger.raw (info-level gated) — hidden under --quiet, shown normally.
  for (const f of failed) {
    logger.errorRaw(formatFileErrors(f.filePath, f.errors));
    logger.errorRaw("");
  }
  for (const p of passed) {
    logger.raw(formatFlowSummary(p.flow));
  }

  const total = files.length;
  if (failed.length > 0) {
    logger.error(`${failed.length}/${total} file(s) failed validation`);
    process.exitCode = 1;
  } else {
    logger.success(`${total}/${total} file(s) valid`);
  }
}
```

**Key decisions:**

- **Variadic + globs.** Better than Maestro's single-file-only.
- **`--config` is wired** (Codex round-1 fix): respected when no explicit args. Defaults cascade: CLI args → `config.tests` → `tests/**/*.yaml`.
- **Stdin via `-`.** Matches Maestro (`CheckSyntaxCommand.kt` accepts `-`).
- **Shares file discovery with `skeptic test`** via the new `resolveFlowPaths` — identical cwd/dedupe/nodir semantics (Codex round-1 fix).
- **Keep-going on errors.** Better DX than short-circuit. Report every invalid file.
- **Exit code 0 / 1** matches Maestro.
- **No `--strict` flag.** The schema is the schema.

### 3.3 Register in `cli/src/index.ts`

Between `test` command (`index.ts:79`) and `generate` command (`:81`):

```ts
program
  .command("validate")
  .description("Validate YAML flow syntax without running the browser")
  .argument("[files...]", "flow files or globs (default: tests/**/*.yaml). Use '-' for stdin.")
  .option("-c, --config <path>", "path to config file")
  .action(async (files: string[], cmdOpts: ValidateCommandOptions) => {
    const { runValidate } = await import("./commands/validate.js");
    await runValidate(files.length > 0 ? files : undefined, cmdOpts);
  });
```

Use dynamic import to match the pattern `audit` uses (`index.ts:147`) — keeps cold-start fast.

### 3.4 Wire `test --dry-run` to reuse formatter

**File:** `cli/src/commands/test.ts:141-148` — swap the existing `logger.info` loop for the shared formatter, using `logger.raw` (Codex round-2 fix — respects `--quiet`):

```ts
if (opts.dryRun) {
  logger.success(`Dry run: ${filtered.length} flow(s) parsed successfully`);
  for (const flow of filtered) {
    logger.raw(formatFlowSummary(flow));
  }
  return;
}
```

Trivial change. Delivers on the "share with --dry-run" directive without forcing re-parse.

### 3.5 Tests — `cli/__tests__/unit/commands/validate.test.ts`

Model after `cli/__tests__/unit/commands/add.test.ts`. Use fixtures under `cli/__tests__/fixtures/flows/` (create subdir if missing):

- `valid-minimal.yaml` — two-doc, one step, happy path.
- `invalid-yaml-syntax.yaml` — `name: : :` to force YAML parse error.
- `unknown-command.yaml` — step `- { cliks: "#foo" }` — expect "Did you mean: click".
- `missing-name.yaml` — metadata missing `name`.

Tests:

1. Validates a valid flow — exit 0, success log present.
2. Reports YAML syntax errors with line number (if `yaml` lib provides one).
3. Prints "Did you mean `click`?" for `cliks`.
4. Keeps going: given 2 valid + 1 invalid, reports all; exit 1.
5. Empty glob → error + exit 1.
6. Stdin input (use `process.stdin` mock or `vi.spyOn(fs, 'readFileSync')`).

Spy on `console.log` to capture output; use `vi.spyOn(process, "exitCode", "set")` or check `process.exitCode` after.

**Exit criteria:** `npm test -- validate`. `npm run build && ./dist/bin/skeptic.js validate __tests__/fixtures/flows/valid-minimal.yaml` shows green check. `npm run check` green.

---

## Phase 4 — Domain guidance markdown files

### 4.1 Create `cli/templates/guidance/` with 8 domain files

Use `templates/` (not `src/ai/guidance/`) so the existing build step `cp -r templates dist/` (`package.json:10`) ships them automatically. Zero build-script change needed.

Files:

```
cli/templates/guidance/
  animation.md
  accessibility.md
  performance.md
  design.md
  security.md
  seo.md
  responsive.md
  react.md
```

Each file mirrors Expect's shape — frontmatter + checklist. Content is **E2E-testing-specific** (skeptic is a test tool; Expect is broader). Example for `accessibility.md`:

```markdown
---
name: accessibility
description: WCAG-adjacent quality checks for E2E tests — visible focus, hit targets, contrast, keyboard reachability.
version: 1.0.0
---

# Accessibility Testing Guidance

Use these checks alongside `assertNoDefects` / `assertWithAI` when your flow targets user-facing interactive surfaces.

## Things worth asserting

- [ ] Every interactive target is at least 44×44 px (tap target) or 24×24 css-px + 8px spacing (pointer).
- [ ] `aria-label` / visible text exists on every `button`, `a`, `[role="button"]` the flow touches.
- [ ] Focus is visible after Tab or `press: Tab` — either a browser ring or a custom `:focus-visible` style.
- [ ] Forms have a `<label>` (or `aria-label`) wired to each input.
- [ ] Error messages live in `[role="alert"]` or `aria-live="polite"` so screen readers pick them up.

## Flow patterns

When you're testing a keyboard-only path, assert both:
\`\`\`yaml
- press: Tab
- assertVisible: "[data-testid=cta]:focus-visible"
\`\`\`

Avoid `click:` on an `<a href>` — prefer `press: Enter` after focus so you catch broken keyboard handlers.

## Red flags — file a bug

- An interactive element with `role="button"` but no `tabindex`.
- `aria-hidden="true"` on a container that holds focusable children.
- Focus lands on the `<body>` after a modal closes — means the opener wasn't re-focused.
```

Content for each domain follows this shape: frontmatter + "things worth asserting" (checklist) + "flow patterns" (YAML snippets using real skeptic steps) + "red flags". Length target: 30-60 lines per file. I will write each one fresh — not copy Expect's, which is framework-agnostic; skeptic's ties to concrete YAML step names.

**Key realism check:** I will **not** invent checks that require skeptic features that don't exist (e.g. axe-core integration, Lighthouse). Content must be actionable with the current `COMMAND_KEYS`.

### 4.2 Tests — None for Phase 4

The files are static content; tested via Phase 5's loader + MCP tests. Adding tests for their mere existence is noise.

**Exit criteria:** 8 files exist in `cli/templates/guidance/`. `npm run build` includes them under `dist/templates/guidance/`.

---

## Phase 5 — `guidance-loader` + `load_guidance` MCP tool

### 5.1 `cli/src/ai/guidance-loader.ts`

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findSimilar } from "../utils/levenshtein.js";
import { logger } from "../utils/logger.js";

export const GUIDANCE_DOMAINS = [
  "animation",
  "accessibility",
  "performance",
  "design",
  "security",
  "seo",
  "responsive",
  "react",
] as const;

export type GuidanceDomain = (typeof GUIDANCE_DOMAINS)[number];

export interface GuidanceLoadResult {
  domain: GuidanceDomain;
  /** "builtin" or absolute path to user override */
  source: "builtin" | string;
  content: string;
}

/**
 * Walk up from `from` looking for `.skeptic/guidance/<domain>.md`.
 * Returns the absolute path if found, else null. Mirrors findConfigFile in config/loader.ts.
 */
function findUserGuidance(from: string, domain: string): string | null {
  let dir = path.resolve(from);
  const root = path.parse(dir).root;
  while (dir !== root) {
    const candidate = path.join(dir, ".skeptic", "guidance", `${domain}.md`);
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

function builtinDir(): string {
  // Dual-mode lookup (Codex round-2 fix):
  //   - Compiled: here = cli/dist/ai/ → cli/dist/templates/guidance/
  //   - Source (vitest reads src/*.ts): here = cli/src/ai/ → cli/templates/guidance/
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distPath = path.resolve(here, "..", "templates", "guidance");
  if (fs.existsSync(distPath)) return distPath;

  const srcPath = path.resolve(here, "..", "..", "templates", "guidance");
  if (fs.existsSync(srcPath)) return srcPath;

  throw new Error(
    `Bundled guidance directory not found. Looked in:\n  ${distPath}\n  ${srcPath}\n` +
    "Run 'npm run build' in cli/, or verify cli/templates/guidance/ exists.",
  );
}

export function isGuidanceDomain(s: string): s is GuidanceDomain {
  return (GUIDANCE_DOMAINS as readonly string[]).includes(s);
}

export function loadGuidance(
  domain: string,
  opts: { cwd?: string } = {},
): GuidanceLoadResult {
  if (!isGuidanceDomain(domain)) {
    const suggestions = findSimilar(domain, GUIDANCE_DOMAINS);
    const hint = suggestions.length === 1
      ? ` Did you mean '${suggestions[0]}'?`
      : suggestions.length > 1
        ? ` Did you mean one of: ${suggestions.join(", ")}?`
        : "";
    throw new Error(
      `Unknown guidance domain '${domain}'.${hint} Available: ${GUIDANCE_DOMAINS.join(", ")}`,
    );
  }

  const override = findUserGuidance(opts.cwd ?? process.cwd(), domain);
  if (override) {
    // Visibility: overrides feed the AI `system` prompt — warn every time.
    logger.warn(`Using guidance override: ${override} (builtin superseded)`);
    return { domain, source: override, content: fs.readFileSync(override, "utf-8") };
  }

  const builtin = path.join(builtinDir(), `${domain}.md`);
  if (!fs.existsSync(builtin)) {
    throw new Error(`Bundled guidance missing: ${builtin} — run 'npm run build' in cli/`);
  }
  return { domain, source: "builtin", content: fs.readFileSync(builtin, "utf-8") };
}
```

**Why eager `fs.readFileSync` (not cache):** Called at most once per domain per MCP session; no measurable cost vs. code complexity.

**Why walk-up for overrides:** Matches `findConfigFile` at `config/loader.ts:104-114`. Users working in a subdirectory of a project get the same override as users at the repo root.

**Why `builtinDir()` uses `import.meta.url`, not `__dirname`:** `"type": "module"` in `package.json` → no `__dirname`. Must use `fileURLToPath`.

### 5.2 Register `load_guidance` tool in `cli/src/commands/mcp.ts`

Two places: the tools list (after line 92) and the dispatch switch (after line 111).

```ts
// In tools list:
{
  name: "load_guidance",
  description:
    "Load domain-specific testing guidance for one of 8 domains (animation, accessibility, performance, design, security, seo, responsive, react). " +
    "Call when the task or failing flow targets that domain — don't preload.",
  inputSchema: {
    type: "object" as const,
    properties: {
      domain: {
        type: "string",
        description: "One of: animation, accessibility, performance, design, security, seo, responsive, react",
      },
    },
    required: ["domain"],
  },
},
```

```ts
// In switch:
case "load_guidance":
  return handleLoadGuidance(args as Record<string, unknown>);
```

Handler (Codex round-1 fix — now returns structured JSON so agents can see `source`):

```ts
async function handleLoadGuidance(args: Record<string, unknown>) {
  try {
    const domain = String(args["domain"] ?? "");
    const result = loadGuidance(domain);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          domain: result.domain,
          source: result.source,            // "builtin" | absolute override path
          content: result.content,
        }, null, 2),
      }],
    };
  } catch (err) {
    return {
      content: [{
        type: "text" as const,
        text: err instanceof Error ? err.message : String(err),
      }],
      isError: true,
    };
  }
}
```

**Why JSON-wrap:** lets the AI agent audit whether the guidance came from a builtin (safe) or a filesystem override (trust-elevation path). The round-1 review correctly flagged that hiding `source` creates a prompt-injection surface. Documenting it in the MCP response makes the threat visible without blocking the feature.

**Override warning in loader:** `loadGuidance` itself emits a `logger.warn` line when `source !== "builtin"`. Output:

```
[skeptic] ⚠ Using guidance override: /path/to/.skeptic/guidance/animation.md (builtin superseded)
```

This is also visible to `skeptic generate --guidance ...` users — not just MCP callers.

### 5.3 Tests — `cli/__tests__/unit/ai/guidance-loader.test.ts`

1. `loadGuidance("accessibility")` returns builtin content — check for a known string from the file (e.g. `"Accessibility Testing Guidance"`).
2. **All 8 domains are loadable AND each has a well-formed frontmatter + non-empty body** (Codex round-1 fix for issue #6). Iterate `GUIDANCE_DOMAINS`; for each, assert (a) `loadGuidance` succeeds, (b) content starts with `---\n`, (c) frontmatter includes `name:` and `description:` lines, (d) body length after frontmatter > 100 chars. This catches missing/corrupt builtin files at test time, not prompt-degradation time.
3. Unknown domain throws with "Did you mean" hint for near-match (e.g. `"acessibility"` → "Did you mean 'accessibility'?").
4. Unknown domain with no near-match throws with just the Available list (e.g. `"xyz"` → no "did you mean" prefix).
5. User override: stage a temp dir with `.skeptic/guidance/accessibility.md`, pass `cwd` → content returned from the override, `source` equals the override path.
6. **Override emits a warning log** (Codex round-1 fix for issue #1). Spy on `logger.warn`; load with an override staged; assert warn was called with a message containing `"guidance override"` and the override's absolute path.

### 5.4 Tests — `cli/__tests__/unit/commands/mcp.test.ts` additions

Extend the existing file. Key additions:

1. **Update existing tool-count assertion:** `expect(toolNames).toHaveLength(6)` at line 56 becomes `toHaveLength(7)`; add `expect(toolNames).toContain("load_guidance")`.
2. **`load_guidance` returns structured JSON:** call the tool with `{ domain: "animation" }`, parse `response.content[0].text` as JSON, assert `{ domain: "animation", source: "builtin", content: expect.stringContaining("# Animation Testing Guidance") }`.
3. **Unknown-domain path returns `isError: true`** with the "Did you mean" hint in the message text.

**Exit criteria:** `npm test -- ai/guidance-loader` and `npm test -- commands/mcp` green. `npm run check` green. `npm run build` produces `dist/templates/guidance/*.md` (8 files).

---

## Phase 6 — `skeptic generate --guidance <list>`

### 6.1 Thread optional `system` through `flow-generator.ts`

**File:** `cli/src/ai/flow-generator.ts`

Add an optional `system` param to both exported functions and pass through to `client.generateText`:

```ts
export async function generateFromDiff(
  client: AIClient,
  target: "changes" | "unstaged" | "branch",
  baseUrl: string,
  baseBranch: string = "main",
  excludePaths: string[] = [],
  system?: string,
): Promise<string[]> {
  // ...existing body...
  const raw = await client.generateText(prompt, system);
  // ...existing body...
}

export async function generateFromDescription(
  client: AIClient,
  description: string,
  baseUrl: string,
  system?: string,
): Promise<string> {
  // ...existing body...
  const raw = (await client.generateText(prompt, system)).trim();
  // ...existing body...
}
```

Additive params — all existing callers unaffected.

### 6.2 Add `--guidance` to `generate` command

**File:** `cli/src/index.ts:82-95`

```ts
program
  .command("generate")
  // ...existing options...
  .option(
    "--guidance <domains>",
    "comma-separated domain guidance to attach (e.g. animation,accessibility)",
  )
  // ...existing action...
```

**File:** `cli/src/commands/generate.ts`

Add field, parse, load guidance, pass through:

```ts
export interface GenerateCommandOptions {
  // ...existing fields...
  guidance?: string;
}

// Inside runGenerate, before the try/catch that calls generators:
let systemPrompt: string | undefined;
if (opts.guidance) {
  const domains = opts.guidance.split(",").map((d) => d.trim()).filter(Boolean);

  // Anchor override walk-up to the config file's directory so guidance + config resolve
  // against the same project root. Covers both explicit --config and walk-up discovery
  // (Codex round-2 + round-4 fix).
  const { configPath } = loadConfigWithMeta(opts.config ? { configPath: opts.config } : {});
  const guidanceCwd = configPath ? path.dirname(configPath) : process.cwd();

  const blocks: string[] = [];
  for (const d of domains) {
    try {
      const result = loadGuidance(d, { cwd: guidanceCwd });
      blocks.push(result.content);
      logger.info(`  Attached guidance: ${chalk.cyan(d)} (${result.source === "builtin" ? "builtin" : "override"})`);
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  }
  systemPrompt = blocks.join("\n\n---\n\n");
}

// Then in the two call sites, pass systemPrompt:
yamlOutputs = await generateFromDiff(client, target, baseUrl, config.ai?.baseBranch ?? "main", config.ai?.excludePaths ?? [], systemPrompt);
// and:
const yaml = await generateFromDescription(client, opts.message, baseUrl, systemPrompt);
```

### 6.3 Tests — extend `cli/__tests__/unit/commands/generate.test.ts`

- `--guidance accessibility` → `generateFromDescription` receives a system prompt containing `"Accessibility Testing Guidance"`. Mock `client.generateText` to capture args.
- `--guidance nope` → exit 1 with "Unknown guidance domain" error.
- `--guidance animation,performance` → system prompt contains both headers + `---` separator.

**Exit criteria:** `npm test -- generate` green. `npm run build && ./dist/bin/skeptic.js generate --message "..." --guidance accessibility` runs (manual smoke).

---

## Phase 7 — Audit + ship

### 7.1 Full test run

```bash
cd cli
npm run check    # tsc --noEmit across everything
npm test         # full vitest suite
npm run build    # emit + copy templates
```

All three green. No skipped tests. No new warnings.

### 7.2 Manual smoke

```bash
cd cli
./dist/bin/skeptic.js validate __tests__/fixtures/flows/valid-minimal.yaml
./dist/bin/skeptic.js validate __tests__/fixtures/flows/unknown-command.yaml    # expect exit 1 + "Did you mean"
./dist/bin/skeptic.js mcp         # stdio server; in another shell, verify load_guidance is listed
```

### 7.3 Verify no regressions in adjacent features

- `skeptic test --dry-run` against an existing project still prints the flow list correctly (now via `formatFlowSummary`).
- `skeptic generate --message "..."` (no `--guidance`) still works — proves optional system param doesn't leak.
- `skeptic mcp` tool list reports 7 tools (was 6) — confirm via `ListTools` in a test.

### 7.4 Mark TODO entries

Update the bundle-2 entry in whatever backlog doc exists (likely `tasks/todo.md`) to reflect #33 + #42 as shipped.

**Exit criteria:** `git status` clean except Bundle 2 files. All three build/check/test green. Manual smoke commands produce expected output.

---

## File manifest

### New files

- `cli/src/utils/levenshtein.ts` — shared util
- `cli/src/commands/validate.ts` — command entrypoint
- `cli/src/commands/validate-core.ts` — shared formatters
- `cli/src/ai/guidance-loader.ts` — loader + walk-up override
- `cli/templates/guidance/{animation,accessibility,performance,design,security,seo,responsive,react}.md` — 8 files
- `cli/__tests__/unit/utils/levenshtein.test.ts`
- `cli/__tests__/unit/commands/validate.test.ts`
- `cli/__tests__/unit/ai/guidance-loader.test.ts`
- `cli/__tests__/fixtures/flows/{valid-minimal,invalid-yaml-syntax,unknown-command,missing-name}.yaml`

### Modified files

- `cli/src/parser/flow-parser.ts` — add `validateFlowString` / `validateFlowFile` / `ValidationIssue`; `parseFlowString` delegates
- `cli/src/parser/flow-schema.ts` — export existing `SHARED_KEYS` (drop `const` → `export const`) + add derived `KNOWN_STEP_KEYS`
- `cli/src/parser/glob-resolver.ts` — extract `resolveFlowPaths` (Codex round-1 fix); `resolveFlows` delegates
- `cli/src/config/loader.ts` — add `loadConfigWithMeta` returning `{ config, configPath }` (Codex round-4 fix); `loadConfig` delegates
- `cli/src/utils/logger.ts` — add `errorRaw` helper (Codex round-3 fix)
- `cli/src/commands/test.ts` — `--dry-run` uses `formatFlowSummary`
- `cli/src/commands/generate.ts` — `--guidance` flag + thread system prompt
- `cli/src/ai/flow-generator.ts` — optional `system` param on both exports
- `cli/src/commands/mcp.ts` — register `load_guidance` + handler (returns structured `{domain,source,content}` JSON)
- `cli/src/index.ts` — register `validate` command + `--guidance` on `generate`
- `cli/__tests__/unit/parser/flow-parser.test.ts` — cases for `validateFlowString` including `{click, cliks}` mixed-typo case
- `cli/__tests__/unit/commands/mcp.test.ts` — cases for `load_guidance` (JSON shape + unknown-domain error); update `toHaveLength(6)` → `toHaveLength(7)`
- `cli/__tests__/unit/commands/generate.test.ts` — cases for `--guidance`

### New test fixture

- `cli/__tests__/fixtures/flows/mixed-typo.yaml` — step with both a valid `click` key AND an unknown `cliks` key. Validates Codex's round-1 concern.

### Unchanged (but touched in analysis, worth calling out)

- Existing 6 MCP tools — `validate_flow`'s spec overlaps mildly with the new CLI `validate` but is string-based and used inside MCP callers; no reason to deprecate.
- AI client `generateText` signatures — already accept `system`, no change.
- Existing fixtures (`malformed-bad-step.yaml`, `malformed-no-name.yaml`, etc.) reused — no new fixtures except `mixed-typo.yaml`.

---

## Codex review history

### Round 1 — all 6 issues applied

1. **Prompt-injection surface for guidance overrides** → `source` surfaced in MCP JSON response; `logger.warn` on every override load; security model documented in Context.
2. **Unknown-key detection only at `commandCount === 0`** → Phase 2 rewritten to detect every unknown key independently of schema success; `{ click, cliks }` surfaces `cliks`; new `mixed-typo.yaml` fixture.
3. **`--config` declared but unused** → Phase 3 threads `opts.config` through `loadConfig()`.
4. **Drift from `skeptic test` file-discovery** → Phase 2.5 extracts `resolveFlowPaths`.
5. **First-error-only YAML reporting** → Phase 2 collects all YAML errors, capped 5/doc.
6. **No builtin-guidance validation** → Phase 5.3 test iterates all 8 domains.

### Round 2 — all 4 issues applied

1. **`builtinDir()` path was wrong for vitest source-mode** → `guidance-loader.ts` now probes both `cli/dist/templates/guidance/` (prod) and `cli/templates/guidance/` (source/test) and picks whichever exists, with a clear error if neither does.
2. **`config.tests` is `string | string[]`, not `string[]`** → Phase 3 normalizes via `Array.isArray(config.tests) ? config.tests : [config.tests]` before use. Dead fallback removed; the schema default guarantees non-empty.
3. **`console.log` bypasses `--quiet`** → Phase 3 + test.ts `--dry-run` both emit through `logger.raw` (respects log level). Formatters stay pure string-returning functions.
4. **`loadGuidance` walk-up ignores `--config` dir** → Phase 6 computes `guidanceCwd = path.dirname(path.resolve(opts.config))` when `--config` is passed and threads it as `loadGuidance(d, { cwd: guidanceCwd })`. Config + guidance now anchor to the same project root.

### Round 3 — both issues applied

1. **`config.tests` globs still anchored to `process.cwd()`** → Phase 3 now passes `globCwd = path.dirname(path.resolve(opts.config))` to `resolveFlowPaths` when `--config` is set, so relative patterns in the config resolve against its directory. Matches the round-2 fix for guidance overrides — same anchoring bug was still present on the flow-discovery side.
2. **`logger.raw` hides failure diagnostics under `--quiet`** → New Phase 2.6 adds `logger.errorRaw` (error-level gated, unprefixed, writes to stderr). Failure blocks go through `errorRaw` (visible under `--quiet`); success lines stay on `raw` (hidden under `--quiet`, shown normally). Round-2 fix was half-right — the gate was respected but dropped diagnostics with the bathwater.

### Round 4 — 1 issue applied + 1 scope clarification

1. **Config anchoring only worked for explicit `--config`, not auto-discovery** → New Phase 2.55 adds `loadConfigWithMeta(opts)` that returns `{ config, configPath }`. Phase 3 (validate) and Phase 6 (generate --guidance) both use it so the anchoring works whether the config comes from `--config` or from `loadConfig`'s walk-up. Zero-impact refactor — existing `loadConfig` callers untouched.
2. **Phase 2.5 "shared parity" claim was overstated** → Clarified inline: Phase 2.5 shares the `resolveFlowPaths` helper's API; the cwd-anchoring behavior is a caller-side choice. `skeptic validate` gets the new behavior in Bundle 2; `skeptic test` preserves its existing (latent-bug) behavior and is explicitly out of Bundle 2 scope. Tracked as follow-up.
