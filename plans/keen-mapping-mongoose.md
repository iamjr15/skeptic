# Plan: Test Coverage via Import Graph (#32)

## Context

skeptic's `skeptic generate --diff` (`cli/src/commands/generate.ts:78-99`) sends a git diff to the LLM and asks for adversarial test flows. The prompt at `cli/src/ai/prompts.ts:60-101` (`GENERATE_FROM_DIFF_PROMPT`) tells the model to think like a malicious user — empty inputs, XSS, boundary values, etc. — but it has **no signal about which changed files already have test coverage**. Result: the model generates redundant tests for well-covered code while gaps elsewhere stay uncovered.

Expect's solution is to build an **import graph** of the project, identify which source files are reachable from existing test files, and inject a coverage-annotated file listing into the AI prompt. See `skeptic-refs/expect/packages/<scope>/test-coverage.ts:103-129` (`oxc-resolver` setup), `:9-46` (regex import extraction — three patterns total), `:48-70` (BFS transitive traversal with visited-set cycle handling), `:187-191, 207-230` (test-file discovery + coverage map build), and `skeptic-refs/expect/packages/shared/src/prompts.ts:90-113` (the prompt formatter that emits `[covered] src/foo.ts (tested by: …)` and `[no test] src/bar.ts` lines, plus the directive *"Prioritize browser-testing files WITHOUT existing test coverage"*).

**Key translation points and where skeptic diverges:**

1. **Entry points are different.** Expect uses **test files** as graph entry points and asks "what does this test transitively import?" skeptic's tests are YAML — they don't import source code, they hit URLs. So skeptic's notion of "covered" is: *some flow's `navigate:` URL serves a route that transitively imports this source file*. This requires URL-to-route-handler resolution, which is framework-specific (Next.js `app/` vs `pages/`, Remix, plain SSR).

2. **skeptic has no convention for tests.** Expect can detect tests by filename (`*.spec.ts`); skeptic can't. skeptic's "tests" are the YAML flows the user has written, discovered via the existing `cli/src/parser/glob-resolver.ts`.

3. **`oxc-resolver` is solid; reuse it.** Expect's choice of `oxc-resolver` (vs Node's `enhanced-resolve` or hand-rolling tsconfig path resolution) is correct — fast, tsconfig-aware, ESM/CJS-aware. skeptic will adopt it as a direct dependency.

4. **Naive regex import extraction is fragile but ships.** Expect uses three regex patterns to find import specifiers, sidestepping AST parsing for speed. This misses dynamic imports (`import(\`foo-\${variant}\`)`) and conditional re-exports. **Choice for skeptic:** start with regex (mirror Expect), accept the false-negative rate, and document the limitation. AST upgrade is a v2 enhancement.

**Two routing-resolution strategies — pick one before writing code:**

- **Strategy A (heuristic, framework-agnostic):** for each flow's `navigate:` URL, look for source files whose paths plausibly serve it. Heuristic: the URL path components match the file path. e.g., `/users/profile` → `app/users/profile/page.tsx` OR `pages/users/profile.tsx` OR `src/routes/users/profile.tsx`. Walk a few common conventions; report the union. Cheap, ~80% accurate, no framework detection required.
- **Strategy B (framework-aware):** detect Next.js / Remix / Vite via package.json + presence of well-known files; use the framework's actual route-resolution rules. More accurate, more code, more brittle to framework version changes.

**Pick Strategy A for v1.** Reasoning: the LLM consuming the coverage signal doesn't need 100% accuracy. A `[covered]` annotation that's right 80% of the time is far better than no annotation at all. If we get it wrong on a flow, the LLM might skip a file that needed a test or write a redundant one — neither is a regression vs today (no coverage signal at all). Strategy B is a v2 follow-up if user feedback shows the heuristic is too noisy.

**Goal:** `skeptic generate --diff [--target …]` injects a coverage-annotated changed-file list into the LLM prompt when **(a)** the project has at least one flow file (`config.tests` glob resolves to ≥1 result) and **(b)** the diff includes ≥1 source file. The LLM is instructed to prioritize flows for `[no test]` files.

**Scope: `--diff` only.** `--message` (description-driven generation) does NOT inject coverage — there is no diff to scope it against, and the LLM doesn't know which files the user's prose maps to. Don't try to infer; the signal would be too noisy to be useful. Coverage is purely a `--diff` enrichment.

**Out of scope:**
- Per-line coverage. We're at file granularity only — no branch tracking, no instrumentation.
- Live runtime tracing (e.g., what files a Next.js dev server actually loaded for a request). Static analysis only.
- Generating tests for backend-only files (e.g., `*.api.ts` route handlers). Browser-tested, UI-rendering files are the target. Backend files are excluded by extension filter in 1.4.
- Storing coverage state across runs. Each `generate` invocation rebuilds the graph from scratch. ~1-2 second cost on a medium repo (5k files); acceptable.
- Replacing the existing `excludePaths` filter in `flow-generator.ts:8`. Coverage analysis runs on the **post-filter** set, so excluded files (`*.env`, `secrets/`, etc.) never enter the graph.

---

## Phase 1 — Build the import graph

### 1.1 New module: `cli/src/ai/coverage/import-graph.ts`

Public surface:

```ts
export interface ImportGraph {
  /** Map of absolute source file path → list of absolute paths it imports (resolved). */
  edges: Map<string, string[]>;
  /** All files scanned. Stable across calls in a single `generate` run. */
  files: string[];
}

export async function buildImportGraph(
  projectRoot: string,
  opts?: {
    extensions?: string[];
    ignore?: string[];           // glob patterns merged with DEFAULT_IGNORE_PATTERNS for the directory walker
    excludePaths?: string[];     // ai.excludePaths — applied via shared matchExcludePath helper
  },
): Promise<ImportGraph>;
```

**Default extensions:** `[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]`. CSS/JSON/etc. are ignored — they don't have imports we care about.

**Default ignore patterns** (defined as a module-level constant and merged with caller-supplied `opts.ignore`):

```ts
export const DEFAULT_IGNORE_PATTERNS: string[] = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/out/**",
  "**/.skeptic/**",
  "**/.git/**",
  "**/coverage/**",
];
```

These are **glob patterns** matched via `minimatch`, NOT substring checks. Earlier draft used `abs.includes(pattern)` which would let `"node_modules"` match a project file at `node_modules-test/foo.ts`. Use `minimatch(relPath, pattern, { dot: true })` against project-root-relative paths for correctness.

`buildImportGraph` always merges defaults: `const allIgnores = [...DEFAULT_IGNORE_PATTERNS, ...(opts.ignore ?? [])]`. This is the bug the round-1 review flagged.

Plus respect `.gitignore` (use `git ls-files` like Expect does at `test-coverage.ts:187`).

**Implementation:**

```ts
import { ResolverFactory } from "oxc-resolver";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { minimatch } from "minimatch";
import { matchExcludePath } from "../security.js"; // shared helper, exported per "Shared exclusion semantics" below

const IMPORT_PATTERNS = [
  // ES module: import x from "y"; import { x } from "y"; import * as x from "y";
  /\bimport\s+(?:[\w$*\s,{}]+\s+from\s+)?['"`]([^'"`]+)['"`]/g,
  // CommonJS: const x = require("y")
  /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  // Re-exports: export { x } from "y"; export * from "y";
  /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"`]([^'"`]+)['"`]/g,
];

export async function buildImportGraph(
  projectRoot: string,
  opts: { extensions?: string[]; ignore?: string[]; excludePaths?: string[] } = {},
): Promise<ImportGraph> {
  const extensions = opts.extensions ?? [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
  // Merge defaults (treated as glob patterns for the directory walker) with caller-supplied
  // ignore patterns. excludePaths is the ai.excludePaths config — applied via the SHARED helper
  // matchExcludePath (see "Shared exclusion semantics" below) for parity with diff filtering.
  const ignorePatterns = [...DEFAULT_IGNORE_PATTERNS, ...(opts.ignore ?? [])];
  const excludePaths = opts.excludePaths ?? [];

  const tsconfigPath = findTsconfig(projectRoot);
  const resolver = new ResolverFactory({
    tsconfig: tsconfigPath ? { configFile: tsconfigPath, references: "auto" } : undefined,
    extensions,
    mainFields: ["module", "main"],
    conditionNames: ["import", "require", "default"],
  });

  // Two-step filter: first the directory-walker ignore globs (DEFAULT + opts.ignore),
  // then the user's ai.excludePaths via the shared helper.
  const walkerFiles = listProjectFiles(projectRoot, extensions, ignorePatterns);
  const files = walkerFiles.filter(
    (abs) => !matchExcludePath(path.relative(projectRoot, abs), excludePaths),
  );
  // fileSet is used during edge resolution to ensure excluded files cannot re-enter the graph
  // via someone else's import. Without this, src/page.tsx → src/secrets/foo.ts edges would be
  // recorded even though src/secrets/foo.ts was excluded from `files`.
  const fileSet = new Set(files);

  const edges = new Map<string, string[]>();
  for (const file of files) {
    const content = readFileSafe(file);
    if (!content) continue;
    const specifiers = extractImportSpecifiers(content);
    const resolved: string[] = [];
    const dir = path.dirname(file);
    for (const spec of specifiers) {
      // Earlier draft used isLocalImport() to skip non-relative specifiers, but that drops
      // valid TypeScript path aliases like "@components/Button", "@/utils", "src/foo", "#imports".
      // oxc-resolver knows how to resolve all of them via tsconfig paths and exports maps.
      // Strategy: try to resolve EVERYTHING; filter post-resolve to project-internal files only.
      try {
        const r = resolver.sync(dir, spec);
        // Three filters: (1) inside projectRoot, (2) not in node_modules, (3) PASSED THE EARLIER
        // file-list filtering — i.e., the import target is itself in the allowed file set.
        // Without filter (3), an excluded file like src/secrets/foo.ts would re-enter the graph
        // as the destination of another file's import edge, defeating ai.excludePaths.
        if (
          r.path &&
          !r.path.includes("/node_modules/") &&
          r.path.startsWith(projectRoot) &&
          fileSet.has(r.path)
        ) {
          resolved.push(r.path);
        }
      } catch {
        // Resolver failure — likely an external package or a runtime-dynamic import we can't
        // statically resolve. Skip silently; the graph is intentionally lossy here.
      }
    }
    edges.set(file, resolved);
  }

  return { edges, files };
}

function listProjectFiles(root: string, extensions: string[], ignore: string[]): string[] {
  // Use `git ls-files` if available (handles .gitignore for free); fall back to recursive readdir.
  // Filter via minimatch on project-relative paths — substring match is wrong (would let
  // "node_modules-test" pretend to be "node_modules").
  const filterByIgnore = (relPath: string): boolean =>
    !ignore.some((pattern) => minimatch(relPath, pattern, { dot: true }));

  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .filter(Boolean)
      .filter((rel) => extensions.includes(path.extname(rel)))
      .filter(filterByIgnore)
      .map((rel) => path.resolve(root, rel));
  } catch {
    return walkDir(root, extensions, ignore);
  }
}

function walkDir(root: string, exts: string[], ignore: string[]): string[] {
  // Use minimatch on root-relative paths for prune decisions. Substring `full.includes(pattern)`
  // is wrong (lets `node_modules-test` masquerade as `node_modules`) AND inconsistent with the
  // git-ls-files path's filter. Same matcher as `filterByIgnore` in listProjectFiles.
  const isIgnored = (relPath: string): boolean =>
    ignore.some((pattern) => minimatch(relPath, pattern, { dot: true }));

  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      const rel = path.relative(root, full);
      if (isIgnored(rel)) continue;
      if (e.isDirectory()) {
        stack.push(full);
      } else if (exts.includes(path.extname(e.name))) {
        out.push(full);
      }
    }
  }
  return out;
}

function findTsconfig(root: string): string | null {
  const cands = ["tsconfig.json", "jsconfig.json"];
  for (const name of cands) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readFileSafe(p: string): string | null {
  try { return fs.readFileSync(p, "utf-8"); } catch { return null; }
}

function extractImportSpecifiers(content: string): string[] {
  const out: string[] = [];
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;  // global regex — reset between calls
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      out.push(m[1]!);
    }
  }
  return out;
}

// isLocalImport removed — see "Strategy" comment in buildImportGraph above.
```

**Pitfalls:**
- **`oxc-resolver` may throw on synthetic module specifiers.** Wrap `resolver.sync` in try/catch; treat throws as unresolvable (skip).
- **Cycle handling lives in the consumer (`getReachable`)**, not the graph builder. The graph is a directed forward-edge structure; cycles are edges, not infinite loops.
- **TypeScript path aliases (`@/foo`)** are handled by `oxc-resolver` IF `tsconfig.json` is found. If `tsconfig.json` is in a subdirectory (monorepo), the resolver won't pick it up — document the limitation.

### 1.1.1 Shared exclusion semantics — refactor `filterDiffPaths` matcher into a reusable helper

`cli/src/ai/security.ts:79` (the `filterDiffPaths` matcher) uses a specific normalization: trailing-`/` patterns become `pattern + "**"`, and matching uses `minimatch(filePath, pattern, { matchBase: true, dot: true })`. The default `ai.excludePaths` (`["*.env*", "secrets/", "*.key", "*.pem"]`) only behaves correctly under those exact options. If the graph filter uses different options, `secrets/foo.ts` is excluded from the diff but appears in the graph — the user thinks they excluded it everywhere but the coverage section reveals which other files import it.

**Fix:** extract the matcher into a shared helper that both call sites use.

**File:** `cli/src/ai/security.ts` — add export:

```ts
export function matchExcludePath(filePath: string, excludePatterns: string[]): boolean {
  if (excludePatterns.length === 0) return false;
  for (const raw of excludePatterns) {
    const pattern = raw.endsWith("/") ? `${raw}**` : raw;
    if (minimatch(filePath, pattern, { matchBase: true, dot: true })) return true;
  }
  return false;
}
```

Then `filterDiffPaths` (security.ts:79 — the inline matcher) becomes a one-liner: `if (matchExcludePath(filePath, excludePatterns)) skip = true;`. The graph builder uses the same helper. Both callers see identical behavior for `secrets/`, `*.env*`, `*.key`, etc.

This is a small refactor (~10 lines) bundled into the same PR; tests in `cli/__tests__/unit/ai/security.test.ts` continue to pass against `filterDiffPaths` because the wrapping shape is unchanged.

### 1.2 Reachability traversal

Same module:

```ts
/**
 * Compute the set of files transitively reachable from a starting set, following forward edges.
 * Used both for "from this entry point, what does it pull in?" (forward) and, by reversing the edges,
 * "what files reach this changed file?" (backward).
 */
export function getReachable(graph: ImportGraph, starts: string[]): Set<string> {
  const visited = new Set<string>();
  const stack = [...starts];
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (visited.has(f)) continue;
    visited.add(f);
    const out = graph.edges.get(f);
    if (out) stack.push(...out);
  }
  return visited;
}
```

**Cycle handling: visited-set, identical to Expect's `getTransitiveDependencies` at `test-coverage.ts:48-70`.**

### 1.3 Reverse-edge index

For coverage queries we need the **reverse** direction: "from this changed file, which test entry points reach it?" Compute once, cache:

```ts
export function reverseGraph(graph: ImportGraph): Map<string, string[]> {
  const rev = new Map<string, string[]>();
  for (const [from, tos] of graph.edges) {
    for (const to of tos) {
      const arr = rev.get(to) ?? [];
      arr.push(from);
      rev.set(to, arr);
    }
  }
  return rev;
}
```

Reverse-traversal:
```ts
export function getReachableReverse(rev: Map<string, string[]>, starts: string[]): Set<string> {
  // Mirror of getReachable, against the reversed graph.
  const visited = new Set<string>();
  const stack = [...starts];
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (visited.has(f)) continue;
    visited.add(f);
    const out = rev.get(f);
    if (out) stack.push(...out);
  }
  return visited;
}
```

### 1.4 Tests: `cli/__tests__/unit/ai/coverage/import-graph.test.ts`

Use a fixture directory under `cli/__tests__/fixtures/import-graph/`:

```
cli/__tests__/fixtures/import-graph/
  src/
    a.ts          // imports ./b
    b.ts          // imports ./c
    c.ts          // imports nothing
    cycle1.ts     // imports ./cycle2
    cycle2.ts     // imports ./cycle1
    dyn.ts        // import("./" + x) — dynamic
  tsconfig.json
```

Tests:
- `buildImportGraph(fixtureRoot)` returns edges where `a.ts → [b.ts]`, `b.ts → [c.ts]`, `c.ts → []`.
- `getReachable(graph, [a.ts])` returns `{a.ts, b.ts, c.ts}`.
- Cycle: `getReachable(graph, [cycle1.ts])` returns `{cycle1.ts, cycle2.ts}` and terminates (no infinite loop).
- Dynamic import is **not** detected (regex misses it) — assert `dyn.ts → []`. Documents the known limitation; flagged in docs.
- Reverse: `getReachableReverse(rev, [c.ts])` returns `{c.ts, b.ts, a.ts}`.
- TS path alias: add `paths: { "@/*": ["src/*"] }` to fixture tsconfig and a file `app.ts` with `import "@/a"`. Assert resolution.
- node_modules excluded: a file imports `"react"` — not in edges (not a local import).

Idiom: vitest patterns in `cli/__tests__/unit/`.

---

## Phase 2 — Map flows to source files

### 2.1 New module: `cli/src/ai/coverage/route-resolver.ts`

**Goal:** given a YAML flow file, return the list of source files (relative to project root) plausibly serving its `navigate:` URLs.

Public:
```ts
export interface RouteCandidate {
  url: string;       // the URL this candidate addresses
  files: string[];   // absolute paths of plausible route handlers/pages
}

/** Build a route index from the import-graph's file universe. Call once per coverage build. */
export function buildRouteIndex(
  projectRoot: string,
  graphFiles: ReadonlySet<string>,
): RouteIndexEntry[];

/** Resolve all `navigate:` URLs in a flow against a pre-built route index. */
export function resolveRoutesForFlow(
  flow: ResolvedFlow,
  routeIndex: RouteIndexEntry[],
  baseUrl: string | undefined,
): RouteCandidate[];

/** Recursive walk for navigate URLs across nested commands (repeat/retry/runFlow.commands). */
export function collectNavigateUrls(steps: Step[]): string[];
```

**Implementation (Strategy A — heuristic, route-index lookup):**

The earlier draft enumerated candidates with substituted segments — `/users/123` produced `app/users/[123]/page.tsx`, which is wrong because real Next.js files use `[id]`/`[slug]`/etc. as the dynamic-segment marker, not the value. The fixed approach: **build a route index from `graph.files`** (one-time pass) and match URL segments against the index's normalized routes.

```ts
import { minimatch } from "minimatch";

const ROUTE_DIRS = ["app", "pages", "src/app", "src/pages", "src/routes", "routes"];
// Match either "page.ext" at the END of the relative path (handles app/page.tsx) OR
// "/page.ext" / "/index.ext" preceded by a directory (handles app/users/page.tsx).
const PAGE_FILE_RE = /(?:^|\/)(page|index)\.(tsx|ts|jsx|js)$/;
const PAGES_LEAF_RE = /\.(tsx|ts|jsx|js)$/;

export type CatchAllKind =
  | false                  // not a catch-all
  | "required"             // [...slug] — at least 1 extra segment required
  | "optional";            // [[...slug]] — 0 or more extra segments

export interface RouteIndexEntry {
  segments: string[];      // normalized: literal segments OR "*" for dynamic [param] / "**" sentinel for catch-alls
  catchAll: CatchAllKind;
  file: string;             // absolute path
  layoutFiles?: string[];   // app-router parent layouts (page.tsx siblings up the tree)
}

/** Build a route index once from the graph's file list. */
export function buildRouteIndex(root: string, graphFiles: ReadonlySet<string>): RouteIndexEntry[] {
  const entries: RouteIndexEntry[] = [];
  for (const file of graphFiles) {
    const rel = path.relative(root, file);
    for (const dir of ROUTE_DIRS) {
      const prefix = dir + path.sep;
      if (!rel.startsWith(prefix)) continue;
      const inside = rel.slice(prefix.length);

      // App-router files (page.{tsx,ts,jsx,js} or root index.{...}). PAGE_FILE_RE handles BOTH:
      //   - "page.tsx" alone (matches at start)            → app/page.tsx → segments []
      //   - "users/page.tsx" / "users/[id]/page.tsx"        → segments ["users"], ["users", "*"]
      // Skip layout/loading/error/template — they're not routes themselves.
      if (PAGE_FILE_RE.test(inside)) {
        const dirParts = inside.replace(PAGE_FILE_RE, "").split(path.sep).filter(Boolean);
        const { segments, catchAll } = normalizeRouteSegments(dirParts);
        // Determine whether this is in an "app/..." dir for layout collection.
        const isAppRouter = dir === "app" || dir === "src/app";
        entries.push({
          segments,
          catchAll,
          file,
          layoutFiles: isAppRouter ? collectAppLayouts(root, dir, dirParts, graphFiles) : undefined,
        });
        continue;
      }
      // Pages-router: pages/users/profile.tsx → segments ["users", "profile"].
      // Skip _app, _document, _error, api/* (handler files), and any leaf already matched above.
      if (
        PAGES_LEAF_RE.test(inside) &&
        !inside.split(path.sep).some((seg) => seg.startsWith("_")) &&
        !inside.startsWith("api/") &&
        !inside.startsWith(`api${path.sep}`)
      ) {
        const stem = inside.replace(PAGES_LEAF_RE, "");
        const parts = stem.split(path.sep).filter(Boolean);
        // pages-index: pages/index.tsx → "" segments; pages/users/index.tsx → ["users"]
        const dirParts = parts[parts.length - 1] === "index" ? parts.slice(0, -1) : parts;
        const { segments, catchAll } = normalizeRouteSegments(dirParts);
        entries.push({ segments, catchAll, file });
      }
    }
  }
  return entries;
}

/**
 * Convert dynamic-segment markers to placeholder forms:
 *   - `[id]`        → "*" (single-segment dynamic)
 *   - `[...slug]`   → "**" placeholder + catchAll: "required" (one or more segments)
 *   - `[[...slug]]` → "**" placeholder + catchAll: "optional" (zero or more segments)
 *
 * Catch-all markers can only appear in the LAST segment per Next.js routing rules.
 */
function normalizeRouteSegments(parts: string[]): { segments: string[]; catchAll: CatchAllKind } {
  let catchAll: CatchAllKind = false;
  const out: string[] = [];
  for (const p of parts) {
    if (p.startsWith("[[...") && p.endsWith("]]")) { catchAll = "optional"; out.push("**"); }
    else if (p.startsWith("[...") && p.endsWith("]")) { catchAll = "required"; out.push("**"); }
    else if (p.startsWith("[") && p.endsWith("]")) { out.push("*"); }
    else { out.push(p); }
  }
  return { segments: out, catchAll };
}

/** For Next.js app-router, climb directories collecting layout.tsx siblings (parents are also exercised). */
function collectAppLayouts(
  root: string, baseDir: string, dirParts: string[], graphFiles: ReadonlySet<string>,
): string[] {
  const layouts: string[] = [];
  for (let i = 0; i <= dirParts.length; i++) {
    const seg = dirParts.slice(0, i);
    for (const ext of ["tsx", "ts", "jsx", "js"]) {
      const candidate = path.resolve(root, baseDir, ...seg, `layout.${ext}`);
      if (graphFiles.has(candidate)) layouts.push(candidate);
    }
  }
  return layouts;
}

/** Match a URL's path segments against the index. */
function findMatchingEntries(index: RouteIndexEntry[], urlSegments: string[]): RouteIndexEntry[] {
  return index.filter((entry) => matchesSegments(entry, urlSegments));
}

function matchesSegments(entry: RouteIndexEntry, urlSegments: string[]): boolean {
  if (entry.catchAll === false) {
    // Static + single-segment-dynamic — segment counts must match exactly.
    if (entry.segments.length !== urlSegments.length) return false;
    for (let i = 0; i < entry.segments.length; i++) {
      if (entry.segments[i] !== "*" && entry.segments[i] !== urlSegments[i]) return false;
    }
    return true;
  }
  // Catch-all: last segment is "**" (consumes 0+ for optional, 1+ for required).
  const fixedLen = entry.segments.length - 1;
  // Match the prefix segments (everything before the catch-all).
  if (urlSegments.length < fixedLen) return false;
  for (let i = 0; i < fixedLen; i++) {
    if (entry.segments[i] !== "*" && entry.segments[i] !== urlSegments[i]) return false;
  }
  const remaining = urlSegments.length - fixedLen;
  if (entry.catchAll === "required" && remaining < 1) return false;
  // optional and required (with remaining >= 1) both pass.
  return true;
}

/** Recursively collect every `navigate:` URL from a flow's step tree (handles repeat/retry/runFlow.commands). */
export function collectNavigateUrls(steps: Step[]): string[] {
  const urls: string[] = [];
  for (const step of steps) {
    if (typeof step.navigate === "string") urls.push(step.navigate);
    if (step.repeat?.commands) urls.push(...collectNavigateUrls(step.repeat.commands));
    if (step.retry?.commands) urls.push(...collectNavigateUrls(step.retry.commands));
    if (typeof step.runFlow === "object" && step.runFlow?.commands) {
      urls.push(...collectNavigateUrls(step.runFlow.commands));
    }
  }
  return urls;
}

export function resolveRoutesForFlow(
  flow: ResolvedFlow,
  routeIndex: RouteIndexEntry[],
  baseUrl: string | undefined,
): RouteCandidate[] {
  const out: RouteCandidate[] = [];
  const flowBase = flow.metadata.url ?? baseUrl ?? "http://placeholder.local";

  let baseOrigin: string | null = null;
  try { baseOrigin = new URL(flowBase).origin; } catch { /* unparseable base — fall through */ }

  for (const url of collectNavigateUrls(flow.steps)) {
    let parsed: URL;
    try {
      parsed = new URL(url, flowBase);
    } catch {
      continue;
    }
    // Skip off-origin URLs — a flow visiting https://accounts.google.com/login should NOT
    // accidentally mark a local /login page as covered. Only count URLs whose origin matches
    // the flow's base (or, if the base origin couldn't be parsed, accept everything as a
    // best-effort fallback).
    if (baseOrigin !== null && parsed.origin !== baseOrigin) {
      continue;
    }
    const urlSegments = parsed.pathname.split("/").filter(Boolean);
    const matches = findMatchingEntries(routeIndex, urlSegments);
    const files: string[] = [];
    for (const m of matches) {
      files.push(m.file);
      if (m.layoutFiles) files.push(...m.layoutFiles);
    }
    out.push({ url, files });
  }
  return out;
}
```

**Why route index instead of segment substitution:** the index lookup is O(routes × url-segments) per URL — small in absolute terms (a typical app has <200 routes, each with <10 segments). Substituting `[123]`-style placeholders is wrong for any real framework, and trying every-segment-as-dynamic produces false positives that bloat coverage. The index approach is the standard route-matching algorithm; we're just running it ourselves instead of asking Next.js.

**App-router parent layouts.** A page at `app/users/[id]/page.tsx` is rendered along with `app/layout.tsx` and `app/users/layout.tsx`. The flow exercises all three, so all three contribute to coverage. `collectAppLayouts` walks the path and adds existing `layout.{tsx,ts,jsx,js}` files to the entry. (Pages router doesn't have layouts; this only fires for `ROUTE_DIRS` containing `app/...`.)

**Nested-step navigate URLs.** Flows often use `repeat:`, `retry:`, or inline `runFlow.commands` to wrap navigations. `collectNavigateUrls` walks recursively. (Hooked-flow `runFlow: file: "x.yaml"` — without inline commands — is a follow-up; resolving that requires loading the referenced flow, which adds I/O complexity.)

**Performance.** Route index built once via `buildRouteIndex`; `findMatchingEntries` is O(routes) per URL. `graphFiles` is passed as `ReadonlySet<string>` for O(1) membership.

### 2.2 Tests: `cli/__tests__/unit/ai/coverage/route-resolver.test.ts`

Fixture: `cli/__tests__/fixtures/route-resolver-app/` with:
- `app/page.tsx`
- `app/layout.tsx`
- `app/users/page.tsx`
- `app/users/layout.tsx`
- `app/users/[id]/page.tsx`
- `app/blog/[...slug]/page.tsx`
- `pages/legacy.tsx`
- `pages/index.tsx`

- **buildRouteIndex** populates entries for each page file with normalized segments (`["users", "*"]` for `[id]`, `catchAll: true` for `[...slug]`).
- `navigate: /` → matches `app/page.tsx`. Layouts: `app/layout.tsx` is appended.
- `navigate: /users` → matches `app/users/page.tsx`. Layouts: `app/layout.tsx` + `app/users/layout.tsx`.
- `navigate: /users/123` → matches `app/users/[id]/page.tsx`. Layouts: both parents.
- `navigate: /blog/2024/foo` → matches `app/blog/[...slug]/page.tsx` via required catchAll.
- `navigate: /blog` → does NOT match `app/blog/[...slug]/page.tsx` (required catch-all needs ≥1 trailing segment).
- For a fixture with `app/optional/[[...slug]]/page.tsx`: `navigate: /optional` → matches (optional catch-all accepts 0 segments). `navigate: /optional/foo` → also matches.
- `app/page.tsx` (root app-router page) → buildRouteIndex correctly creates an entry with `segments: []`. Test that `navigate: /` matches this entry (regression bar for the PAGE_FILE_RE fix).
- `navigate: /legacy` → matches `pages/legacy.tsx`. (No app-router layouts since this is pages-router.)
- `navigate: /nonexistent` → empty list.
- **Off-origin absolute URL: `navigate: https://accounts.google.com/login`** → SKIPPED. The URL parses fine, but its origin doesn't match the flow's base origin, so it's not counted (matches the v1 fix from round 2). Asserts that the local `/login` route is NOT marked as covered by this flow.
- **Same-origin absolute URL: `navigate: http://localhost:3000/users`** with `flow.metadata.url = "http://localhost:3000"` → matched normally (same origin).
- **Query-string only: `navigate: ?utm=foo`** → relative URL parsed against `flow.metadata.url ?? baseUrl`; pathname extracted; matched.
- **Nested-step traversal**: a flow with `repeat: { commands: [{ navigate: "/users" }] }` → `collectNavigateUrls` returns `["/users"]`; route resolution proceeds normally.
- **runFlow.commands inline**: a flow with `runFlow: { file: "x.yaml", commands: [{ navigate: "/foo" }] }` → URL collected.
- **runFlow.file (no commands)**: NOT followed (out of v1 scope, would require recursive flow loading).
- **Multiple `navigate` steps** → each contributes its candidates.

---

## Phase 3 — Build the coverage report

### 3.1 New module: `cli/src/ai/coverage/coverage-builder.ts`

Stitches everything together: build graph, pick entry points (flow files), resolve URLs to source files, traverse forward edges from those source files to compute the "covered" set.

Public:
```ts
export interface CoverageReport {
  /** Map: source file (absolute path) → list of flow file paths that reach it. */
  coveredBy: Map<string, string[]>;
  /** All scanned source files (snapshot for prompt rendering). */
  allFiles: string[];
  /** True iff the project has at least one flow file. False signals "skip injection". */
  hasFlows: boolean;
}

export async function buildCoverageReport(opts: {
  projectRoot: string;
  flowGlob: string | string[];      // accept the union — config.tests is `string | string[]`
  configDir?: string;               // anchor for relative flow globs (when a config file is loaded)
  baseUrl?: string;                 // used as URL parsing base for navigate steps without flow.metadata.url
  excludePaths?: string[];           // ai.excludePaths — apply to graph and coverage scan, not just diff
}): Promise<CoverageReport>;
```

Implementation:

```ts
export async function buildCoverageReport(opts: {
  projectRoot: string;
  flowGlob: string | string[];
  configDir?: string;
  baseUrl?: string;
  excludePaths?: string[];
}): Promise<CoverageReport> {
  // resolveFlowPaths accepts patterns + a cwd STRING (NOT an options object) — verified at
  // cli/src/parser/glob-resolver.ts:12-15. Anchor relative globs to configDir when a config
  // file was loaded; otherwise fall back to process.cwd() (matches the helper's default).
  const flowPaths = await resolveFlowPaths(opts.flowGlob, opts.configDir ?? process.cwd());
  if (flowPaths.length === 0) {
    return { coveredBy: new Map(), allFiles: [], hasFlows: false };
  }

  // Best-effort flow loading: skip files that fail to parse. A single broken flow shouldn't
  // wipe out coverage signal for the entire generate run.
  const flows: ResolvedFlow[] = [];
  for (const filePath of flowPaths) {
    try {
      const flow = parseFlowFile(filePath);
      flows.push({ ...flow, filePath });
    } catch (err) {
      logger.debug(`[coverage] Skipping unparseable flow ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (flows.length === 0) {
    return { coveredBy: new Map(), allFiles: [], hasFlows: false };
  }

  // Pass excludePaths into the graph build so excluded files NEVER enter the universe.
  // (Earlier draft applied excludePaths only at the diff layer; that left the graph polluted
  // with files the user explicitly opted out of, and let those files appear as coverage parents
  // for changed files.) Use the dedicated `excludePaths` opt — NOT `ignore` — so the shared
  // matchExcludePath helper applies (semantically equivalent to filterDiffPaths).
  const graph = await buildImportGraph(opts.projectRoot, {
    excludePaths: opts.excludePaths,
  });
  const fileSet = new Set(graph.files);

  // Build the route index ONCE per coverage build (shared across flows).
  const routeIndex = buildRouteIndex(opts.projectRoot, fileSet);

  const coveredBy = new Map<string, string[]>();
  for (const flow of flows) {
    const candidates = resolveRoutesForFlow(flow, routeIndex, opts.baseUrl);
    const entryFiles = new Set<string>();
    for (const c of candidates) {
      for (const f of c.files) entryFiles.add(f);
    }
    // Walk imports from each entry file
    const reachable = getReachable(graph, [...entryFiles]);
    for (const file of reachable) {
      const arr = coveredBy.get(file) ?? [];
      if (!arr.includes(flow.filePath)) arr.push(flow.filePath);
      coveredBy.set(file, arr);
    }
  }

  return { coveredBy, allFiles: graph.files, hasFlows: true };
}
```

**Threading `excludePaths` to the graph builder.** `buildImportGraph(root, { ignore })` already accepts the option from 1.1; the merge with `DEFAULT_IGNORE_PATTERNS` happens inside that function. The user's `ai.excludePaths` from config (e.g., `["secrets/", "*.env*"]`) is now applied at BOTH the diff filtering layer (existing behavior in `flow-generator.ts`) AND the graph scan layer (new). Same patterns mean the same files are excluded everywhere.

**`resolveFlowPaths` instead of `resolveFlows`.** `resolveFlows` calls `parseFlowFile` internally and would throw on the first broken flow file. `resolveFlowPaths` (separate utility, smaller scope) returns just the paths; we then iterate, parse with try/catch, and skip failures with a debug log. Need to verify `resolveFlowPaths` exists in `cli/src/parser/glob-resolver.ts` — if it doesn't, add it as part of this plan (~10 LOC sibling to `resolveFlows`).

**Performance:** for a 5k-file repo with 50 flows, this is ~5k file reads + 50 traversals (each visits some subset of the graph). Total <2s on modern hardware. Not cached across `generate` calls — each invocation rebuilds. Document and accept.

### 3.2 Tests: `cli/__tests__/unit/ai/coverage/coverage-builder.test.ts`

- Project with no flows → `hasFlows: false`, empty maps.
- One flow with `navigate: /users` and a graph where `app/users/page.tsx → src/users.ts → src/db.ts` → `coveredBy` contains all three with the flow as the value.
- Two flows covering overlapping files → union of coverage; each flow listed in the value array.
- Changed file `src/lonely.ts` not reached by any flow → not in `coveredBy`.
- **Invalid flow tolerance**: 3 flow files in the glob, one is malformed YAML — assert `hasFlows: true`, the broken one is skipped with a debug log, the other two contribute coverage normally. Critical regression bar: "one bad flow doesn't kill coverage."
- **`flowGlob: string[]`**: pass `["flows/*.yaml", "tests/*.yaml"]` — both globs resolve and contribute.
- **`configDir` anchoring**: pass relative glob `tests/**/*.yaml` with `configDir: /tmp/fixture` — flows are found under `/tmp/fixture/tests/`, not `process.cwd()/tests/`.
- **`excludePaths` propagation**: pass `excludePaths: ["src/secrets/**"]` — the graph build EXCLUDES `src/secrets/foo.ts` even if a flow's route resolves to it; the coverage map omits `src/secrets/foo.ts` entirely.
- **`baseUrl` for navigate parsing**: a flow with `navigate: ?utm=foo` (no leading slash) — coverage attribution uses the passed `baseUrl` to resolve the URL; matches `app/page.tsx`.

---

## Phase 4 — Filter to changed files; format prompt

### 4.1 Extract a small helper module so tests can import directly

**File:** `cli/src/ai/coverage/coverage-prompt.ts` (new — separate from `flow-generator.ts` and from `coverage-builder.ts`)

The earlier draft kept `formatCoverageSection` and `extractDiffPaths` inline in `flow-generator.ts`. Then test 4.5 lived in `coverage/format-coverage.test.ts` and would have to either re-export the helpers from `flow-generator.ts` or use awkward private access. Splitting the helpers into their own module makes the tests trivial.

```ts
// cli/src/ai/coverage/coverage-prompt.ts
import * as path from "node:path";
import type { CoverageReport } from "./coverage-builder.js";

/**
 * Extract the absolute paths of files mentioned in a unified-diff string.
 * Project-root-relative paths in the diff become absolute via path.resolve(projectRoot, …).
 */
export function extractDiffPaths(diff: string, projectRoot: string): string[] {
  const lines = diff.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) out.push(path.resolve(projectRoot, m[2]!));
  }
  return out;
}

/**
 * Filter changed files to UI-rendering ones (skip API handlers, configs, type-only files).
 * Heuristic — falls back to "include if extension matches and basename doesn't smell wrong".
 */
export function isUIFile(absPath: string): boolean {
  const base = path.basename(absPath);
  if (base.match(/\.(api|config|d|test|spec)\.[tj]sx?$/)) return false;
  return /\.(tsx|jsx|ts|js)$/.test(absPath);
}

export function formatCoverageSection(
  report: CoverageReport,
  changedFiles: string[],
  cwd: string = process.cwd(),
): string {
  const lines: string[] = [];
  lines.push("## Coverage of changed files\n");
  let coveredCount = 0;
  for (const file of changedFiles) {
    const flows = report.coveredBy.get(file);
    const rel = path.relative(cwd, file);
    if (flows && flows.length > 0) {
      coveredCount++;
      const flowRels = flows.map((f) => path.relative(cwd, f));
      lines.push(`[covered] ${rel} (tested by: ${flowRels.join(", ")})`);
    } else {
      lines.push(`[no test] ${rel}`);
    }
  }
  const total = changedFiles.length;
  const pct = total > 0 ? Math.round((coveredCount / total) * 100) : 0;
  lines.unshift(`Test coverage of changed files: ${pct}% (${coveredCount}/${total} files have flows)\n`);
  lines.push("\n**Prioritize generating flows for `[no test]` files. Skip files already covered unless the diff exposes new edge cases.**");
  return lines.join("\n");
}
```

`flow-generator.ts` (Phase 4.2 below) imports `formatCoverageSection`, `extractDiffPaths`, and `isUIFile` from this module. Tests in 4.5 also import from this module. No private-access workarounds.

### 4.2 Wire into `generateFromDiff`

**File:** `cli/src/ai/flow-generator.ts:51-138`

Add an optional parameter for coverage. The opts shape mirrors `buildCoverageReport`'s signature so the call site is a one-line passthrough:

```ts
import {
  buildCoverageReport,
  type CoverageReport,
} from "./coverage/coverage-builder.js";
import {
  extractDiffPaths,
  formatCoverageSection,
  isUIFile,
} from "./coverage/coverage-prompt.js";

export async function generateFromDiff(
  client: AIClient,
  target: "changes" | "unstaged" | "branch",
  baseUrl: string,
  baseBranch: string = "main",
  excludePaths: string[] = [],
  system?: string,
  opts: {
    useRefs?: boolean;
    coverage?: {
      projectRoot: string;
      flowGlob: string | string[];
      configDir?: string;
    };
  } = {},
): Promise<string[]>
```

After the `MAX_DIFF_CHARS` truncation (line 114-118), before `prompt` construction:

```ts
let coverageSection = "";
if (opts.coverage) {
  try {
    const report = await buildCoverageReport({
      projectRoot: opts.coverage.projectRoot,
      flowGlob: opts.coverage.flowGlob,
      configDir: opts.coverage.configDir,
      baseUrl,
      excludePaths,                 // share the same list applied to the diff
    });
    if (report.hasFlows) {
      const changedFiles = extractDiffPaths(diff, opts.coverage.projectRoot);
      const uiFiles = changedFiles.filter(isUIFile);
      if (uiFiles.length > 0) {
        coverageSection = "\n\n" + formatCoverageSection(report, uiFiles) + "\n";
      }
    }
  } catch (err) {
    logger.debug(`[generate] Coverage analysis failed: ${err instanceof Error ? err.message : String(err)}. Proceeding without coverage signal.`);
    // Best-effort: never fail the whole generate run because coverage is broken.
  }
}

const prompt = GENERATE_FROM_DIFF_PROMPT
  .replace("{baseUrl}", baseUrl)
  .replace("{diff}", diff + coverageSection);
```

**The coverage section sits inside the diff substitution** so we don't change the prompt template structure. The LLM sees the diff, then a clearly-marked "Coverage of changed files" section.

**Why best-effort.** Coverage is a *hint*, not a correctness layer. If `oxc-resolver` throws or the file scan times out, we should still generate flows — just without the coverage signal. Document this in the module comment and keep the try/catch.

**`excludePaths` propagation.** The same `excludePaths` list passed to the existing `filterDiffPaths` (`flow-generator.ts:8, 105`) is now ALSO threaded into `buildCoverageReport` → `buildImportGraph`. Files the user excluded from the diff are also excluded from the import graph and coverage scan, so we don't accidentally surface a `[covered]` annotation for a flow that exercises an excluded file.

### 4.3 `--no-coverage` flag

The `--diff` path adds coverage automatically when flows exist. Some users may want to skip it (debugging, perf, or principled rejection). Add a flag:

**File:** `cli/src/index.ts:94-112`

```ts
.option("--no-coverage", "skip the coverage analysis injected into AI prompts")
```

**File:** `cli/src/commands/generate.ts:14-25`

```ts
coverage?: boolean;   // false when --no-coverage; default true (Commander's --no-* convention)
```

**File:** `cli/src/commands/generate.ts:27-30, 81-99` — anchor to configDir, pass coverage opts conditionally:

```ts
// Use loadConfigWithMeta to get configPath (whether the user passed --config or it was discovered).
// configDir is the directory that contains skeptic.config.yaml; relative globs in config.tests
// resolve against it. When no config file exists, fall back to process.cwd().
const meta = loadConfigWithMeta(opts.config ? { configPath: opts.config } : {});
const config = meta.config;
const configDir = meta.configPath ? path.dirname(meta.configPath) : process.cwd();
const projectRoot = configDir;  // for coverage purposes — graph scan + route index live here

// ... existing systemPrompt + AI client code ...

// In the --diff branch (line 81-88):
const coverageOpts = opts.coverage !== false
  ? {
      projectRoot,
      flowGlob: config.tests,        // string | string[] — buildCoverageReport accepts both
      configDir,
    }
  : undefined;
yamlOutputs = await generateFromDiff(
  client,
  target,
  baseUrl,
  config.ai?.baseBranch ?? "main",
  config.ai?.excludePaths ?? [],
  systemPrompt,
  { coverage: coverageOpts /* + useRefs from #31 if that lands */ },
);
```

`config.tests` is `string | string[]` per `cli/src/config/schema.ts:114`. The `buildCoverageReport` signature in 3.1 accepts the union — no narrowing needed at the call site.

**Why `loadConfigWithMeta`.** `cli/src/commands/generate.ts:51-53` already uses `loadConfigWithMeta` for the guidance-cwd derivation. We're just hoisting that call to be the single place config is loaded, so configDir threads consistently into both guidance loading AND coverage analysis. The earlier `loadConfig` call at line 28 becomes redundant; replace it with the meta version.

### 4.4 `generateFromDescription` — coverage doesn't make sense

The `--message` path doesn't have a diff. Skip coverage entirely there. The signature stays unchanged. Leave a comment in the module:

```ts
// generateFromDescription does NOT inject coverage — there is no diff to scope it against,
// and inferring relevant files from natural-language prose would be too noisy to be useful.
// Users wanting coverage signal should use --diff instead. (Goal section in the plan.)
```

`runGenerate` only passes `coverage: …` to `generateFromDiff`; the `generateFromDescription` call site in `generate.ts:91` doesn't get the opts bag.

### 4.5 Tests: `cli/__tests__/unit/ai/coverage/format-coverage.test.ts`

- `formatCoverageSection` with mixed coverage → output contains `[covered]` and `[no test]` lines, percentage, and the "Prioritize" directive.
- 100% coverage → percentage shows `100%`.
- Empty changed-files → percentage `0%`, no per-file lines, but the "Prioritize" directive remains.
- Long flow file paths are relativized (start with `./` or just `flows/...`).
- Section is nested under `## Coverage of changed files\n`.

**File:** `cli/__tests__/unit/ai/flow-generator-coverage.test.ts`

End-to-end mock: stub `client.generateText`, build a coverage fixture (small graph, one fixture flow), call `generateFromDiff` with `coverage: { projectRoot, flowGlob }`. Assert the prompt the mock receives contains `[covered]` and `[no test]` annotations.

Negative tests:
- No flows in project → no coverage section in prompt (just the diff).
- Coverage build throws (mock `buildCoverageReport`) → `generate` still succeeds; logger.debug fires; prompt has no coverage section.
- `--no-coverage` → coverage section absent regardless.
- All changed files filtered out by `isUIFile` (e.g., diff is just `.api.ts`) → no coverage section.

---

## Phase 5 — Documentation

### 5.1 `cli/README.md`

Update the `skeptic generate` section:

```markdown
### Test coverage signal

When you run \`skeptic generate --diff\` in a project that contains existing flow files (matching \`config.tests\`), skeptic builds an import graph of your source code, walks it from each flow's \`navigate:\` URLs, and tells the LLM which changed files are already covered by flows and which are not:

\`\`\`
Test coverage of changed files: 60% (3/5 files have flows)

[covered] src/components/login.tsx (tested by: flows/login.yaml, flows/auth-flows.yaml)
[covered] src/lib/auth.ts (tested by: flows/login.yaml)
[covered] src/api/users.ts (tested by: flows/profile.yaml)
[no test] src/components/profile-edit.tsx
[no test] src/lib/permissions.ts

Prioritize generating flows for [no test] files.
\`\`\`

The LLM uses this signal to focus on uncovered code instead of duplicating coverage.

**Notes:**
- Coverage is determined by static analysis (\`oxc-resolver\` + naive regex on imports). Dynamic imports (\`import(\\\`foo-\\\${x}\\\`)\`) are not detected.
- URL → source file mapping is heuristic — it tries Next.js \`app/\`, \`pages/\`, and \`src/routes/\` conventions plus single-segment dynamic routes (\`[id]\`).
- API route handlers (\`*.api.ts\`), config files, and type-only files are excluded from analysis.
- Pass \`--no-coverage\` to skip the analysis (e.g., for debugging or performance).
```

---

## Critical Files to Modify

| File | Phase | Change |
|------|-------|--------|
| `cli/package.json` | 1.1 | Add `oxc-resolver ^11.x` (verify latest stable; pin major) |
| `cli/package-lock.json` | 1.1 | Regenerated |
| `cli/src/ai/coverage/import-graph.ts` | 1.1, 1.2, 1.3 | New file — graph build with `DEFAULT_IGNORE_PATTERNS` + minimatch, traversal, reverse |
| `cli/src/ai/coverage/route-resolver.ts` | 2.1 | New file — `buildRouteIndex`, `resolveRoutesForFlow`, `collectNavigateUrls` (recursive), app-router layout collection |
| `cli/src/ai/coverage/coverage-builder.ts` | 3.1 | New file — orchestrator; accepts `string \| string[]` glob, configDir, baseUrl, excludePaths; uses `resolveFlowPaths` + per-flow try/catch |
| `cli/src/ai/coverage/coverage-prompt.ts` | 4.1 | New file — `extractDiffPaths`, `formatCoverageSection`, `isUIFile` (extracted so tests can import directly) |
| `cli/src/parser/glob-resolver.ts` | (existing) | `resolveFlowPaths(patterns, cwd?)` already exists at line 12 — used directly, no change needed |
| `cli/src/ai/security.ts` | 1.1.1 | Extract `matchExcludePath` helper (~10 lines); replace inline matcher in `filterDiffPaths` |
| `cli/src/ai/flow-generator.ts` | 4.2, 4.4 | Add coverage opt; injection into diff prompt; doc comment on `generateFromDescription` |
| `cli/src/index.ts` | 4.3 | `--no-coverage` flag |
| `cli/src/commands/generate.ts` | 4.3 | Thread coverage opt to `generateFromDiff` |
| `cli/README.md` | 5.1 | New section under `generate` |

Plus 5 new test files (1.4, 2.2, 3.2, 4.5 ×2). Test fixtures under `cli/__tests__/fixtures/import-graph/` and `cli/__tests__/fixtures/route-resolver-app/`.

---

## Reused Utilities

- `loadConfig`, `config.tests` — `cli/src/config/loader.ts`, `cli/src/config/schema.ts`
- `resolveFlows` — `cli/src/parser/glob-resolver.ts` (returns `ResolvedFlow[]`)
- `ResolvedFlow.steps` and `step.navigate` — `cli/src/parser/flow-schema.ts`
- `filterDiffPaths` — `cli/src/ai/security.ts` (already runs before our coverage code in the pipeline)
- `logger.{debug,warn,error}` — `cli/src/utils/logger.ts`
- `execFileSync("git", ["ls-files", ...])` pattern — `cli/src/ai/flow-generator.ts:78-95` (already established for git ops)

---

## Verification

```bash
cd cli
npm install
npm run build
npm run check
npm test
```

**Smoke test:**

1. Set up a small Next.js fixture or use an existing skeptic-test project with at least 2 flows.
2. Make a change to a source file that's covered by a flow:
   ```bash
   echo "// touch" >> src/components/login.tsx
   git add -p && git diff --cached
   ```
3. Run with debug logging:
   ```bash
   skeptic -v generate --diff --target changes
   ```
4. In the verbose output, confirm the prompt sent to the LLM contains a `## Coverage of changed files` section with a `[covered]` line for `login.tsx`.
5. Make a change to an uncovered file (`src/lib/permissions.ts` if it exists, or create one):
   ```bash
   echo "export const x = 1;" > src/lib/permissions.ts
   git add -A
   ```
6. Run again — confirm the prompt has `[no test]` for `permissions.ts` and `[covered]` for `login.tsx`.
7. Run `skeptic generate --diff --no-coverage` — confirm no coverage section in the prompt.
8. Run on a project with **no** flows (`tests/` empty) — confirm no coverage section, no errors.

**Performance check:** time `skeptic generate --diff` on the largest test repo available. Coverage analysis should add <2s vs the no-coverage baseline. If it's slower, the bottleneck is `buildImportGraph` — consider caching across runs in v2 (or surfacing the slowdown in the docs as a known cost).

**Failure-resilience check:** in a project with a malformed `tsconfig.json`, run `skeptic generate --diff`. The coverage build should fail gracefully (`logger.debug`), the prompt should omit the coverage section, and the rest of `generate` should succeed. This is the "best-effort" guarantee.
