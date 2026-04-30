# Plan: SOTA Migration for skeptic CLI

## Context

skeptic CLI today is a 127-file, ~14.5k-LOC TypeScript project shipped via `tsc` emit
to a sprawled `dist/`, distributed solely as `npm i -g skeptic-cli` requiring Node ≥22.
Cold start is dominated by eager imports (`commands/test.ts` synchronously pulls
Playwright, chokidar, all reporters, all AI SDKs). There is no single binary
distribution. There is no bundling. Several SOTA architectural patterns from the
2026 Claude Code source-code analysis (async-generator streaming, withhold-and-recover,
death-spiral guard, build-time feature flags) are not adopted.

This plan brings skeptic to April-2026 SOTA for an AI-orchestrating, Playwright-driven
CLI without rewriting in Rust. The non-trivial decision is the runtime + binary
strategy. Three viable paths exist; we pick the one that minimises risk for a
Playwright-heavy CLI.

**Option A — Bun runtime end-to-end** (declined). Bun is a real, production-quality
JS runtime. Bun-compiled binaries work fine on macOS, Linux, and Windows for
non-Playwright workloads (Anthropic ships Claude Code this way; opencode and
others follow). For skeptic specifically, however, the *runtime + Playwright*
combination has known issues:
- **Bun #27977** (still open, last activity April 13 2026, four-plus confirms):
  on Windows, `chromium.launch()` hangs forever under Bun while working fine
  under Node. The bug is in Bun's `process/pipe` handling for Windows.
- **Bun #28450** (closed as duplicate of #9911, March 2026): on macOS,
  `connectOverCDP` via WebSocket times out under Bun until you swap Playwright's
  bundled `ws` for the host `ws` module (fix shipped in openclaw/playwright
  PR #307).
- **Microsoft Playwright #38095** (closed not-planned, Nov 2025): "Playwright does
  not test against Bun, so we are not ready to recommend it. Using it will be at
  your risk."
- **`better-sqlite3` ABI mismatch** under Bun (#19328) — only matters when
  `--cookies` is used.

The macOS/Linux issues have community workarounds, but Windows is unfixed. For a
CI-targeted CLI shipping `--trace`, network collectors, and cookies, that's an
unacceptable test-matrix gap.

**Option B — Bun-compile producing standalone binaries that bundle Bun + JS**
(possible, declined for v1). `bun build --compile` produces a single binary
embedding Bun + the bundled JS. Same Windows-Playwright caveat applies *at
runtime inside the binary*. Reconsiderable once Bun #27977 closes.

**Option C — Node runtime, modern bundle + binary tooling** (chosen). Stay on
Node ≥22, replace `tsc` with **tsup** for the shipped artifact, ship
**single-binary executables via Node SEA** in a CI matrix, distribute via
**GitHub Releases + npm optional-deps per-platform packages**, **lazy-load**
every command, and adopt the **Claude Code architectural patterns** that
translate cleanly to skeptic (death-spiral guard, withhold-and-recover, prompt
cache boundary, build-time feature flags). This sidesteps every Bun-runtime
caveat without giving up any of the wins (single binary, fast cold start, modern
bundling) that drove the question in the first place. Re-evaluate Option A or B
in 6 months when Bun #27977 closes.

Decisions confirmed with user:
- **Primary distribution: npm.** `npm install -g skeptic-cli` is the path the
  README leads with. npm reads `optionalDependencies`, picks the matching
  `skeptic-cli-bin-<platform>` package for the user's OS+arch, and the launcher
  shim spawns the platform binary (with bundled-JS fallback if the user's
  platform isn't covered). Same model esbuild/swc/turbo/biome use.
- **Secondary distribution: GitHub Releases + Homebrew.** For users who don't
  have Node at all, want zero launcher overhead (~30-50 ms cold start vs
  ~80-140 ms through the npm launcher), or just prefer `brew install`. Same
  binaries as the npm bin packages — re-uploaded to Releases as part of the
  same CI run.
- Rollout: phased PRs (one phase per PR, ship independently).
- macOS signing: yes, sign + notarize in CI (Apple Developer cert available).

---

## Current state (verified by exploration)

| Surface              | What's there today |
|----------------------|--------------------|
| Runtime              | Node ≥22, ESM, TypeScript 5.8 strict, ES2022 + Node16 modules |
| Entrypoint           | `cli/bin/skeptic.ts` (shebang `#!/usr/bin/env node`) → `cli/src/index.ts` |
| Build                | `tsc && cp -r templates dist/ && cp src/commands/recorder-script.js …` |
| CLI parser           | Commander 13 |
| TUI                  | Ink 7 + React 19 (uses `useSyncExternalStore`) |
| Schema               | Zod 3.24 |
| Browser              | Playwright 1.52 |
| Native deps          | `better-sqlite3@12.9` (cookies only, opt-in via `--cookies`) |
| Already-Rust dep     | `oxc-resolver@11.19` |
| Templates            | Loaded via `path.dirname(fileURLToPath(import.meta.url))` from `init.ts:9-10`, `guidance-loader.ts`, `record-session.ts:42-46` |
| Recorder script      | `cli/src/commands/recorder-script.js` raw JS, copied verbatim |
| Cold-start eager     | `index.ts` eagerly imports `init`, `test`, `generate`, `add`, `mcp`, `cookies` runners; `test.ts` eagerly imports `playwright`, `chokidar`, `chalk`, all 6 reporters, AI client factory |
| Already lazy         | `validate`, `comment`, `acp`, `record`, `audit`, plus OpenAI/Anthropic clients in factory |
| Patterns already in  | `raceWithHardTimeout` (`nested-executor.ts:119-145`), `ctx.abortReason` + `ctx.inTeardown` (`context.ts:37,40`), `MAX_LOOP_ITERATIONS=100` in `repeat.ts`, sliding-window proactive rate limit in `gemini-client.ts:59-76`, lazy AI provider loading in `client-factory.ts:33,37` |

---

## Hard constraints (from research)

These are baked into every decision below:

1. **Runtime stays Node ≥22.** Bun runtime + Playwright on Windows is broken
   (Bun #27977, open). On macOS/Linux it works with the openclaw `ws` workaround,
   but Microsoft does not officially test Bun. Skip the risk for now; revisit
   when Bun #27977 closes.
2. **tsup is the bundler.** esbuild-powered, dual-format if needed, mature, used by
   the same class of tools skeptic competes with. (Bun's bundler is also a viable
   alternative for the bundling step — both target Node output. tsup picked for
   ecosystem maturity, not because Bun's bundler is bad.)
3. **Canonical external matrix** (used everywhere — Phase 1 tsup config,
   Phase 6.1 SEA sidecar, Phase 7 npm bin packages):
   `playwright`, `playwright-core`, `better-sqlite3`, `oxc-resolver`. **Only
   these four.** All other previously-external packages (MCP SDK, ACP SDK,
   `@axe-core/playwright`) are bundled. Native bindings + filesystem-relative
   resource resolution force the four to stay external.
4. **Templates and `recorder-script.js` ship next to the bundle**, not inside it,
   except in SEA mode where they live in the SEA asset blob.
5. **Playwright browser binaries are never embedded.** First-run UX prints
   `skeptic browsers install chromium` if missing (skeptic's own subcommand —
   doesn't require Node/`npx`). For users who do have Node, `npx playwright
   install chromium` is documented as a synonym.
6. **Code transformations must respect `ctx.abortReason` cooperative cancellation.**
   Generators and refactors must not break the Bundle 1 invariants in `CLAUDE.md`.

---

## Phase 1 — Bundling: replace `tsc` emit with `tsup`

**Goal**: produce `cli/dist/skeptic.mjs` (single bundled ESM) + `cli/dist/templates/`
+ `cli/dist/recorder-script.js`. `tsc --noEmit` stays as the type-checker.

**Why first**: every other phase (cold-start, SEA, feature flags) builds on having
a single bundled artifact.

### Steps

1. Add dev dep: `tsup@^8`.

1. **First, create `cli/src/global.d.ts`** (an ambient declaration file with
   no imports/exports — must be a script, not a module — so its `declare`s are
   visible globally to all source files):
   ```ts
   // Build-time constants substituted by tsup `define`. Visible everywhere.
   declare const __SKEPTIC_FEATURE_AI_ASSERTIONS__: boolean;
   declare const __SKEPTIC_FEATURE_COOKIE_EXTRACTION__: boolean;
   declare const __SKEPTIC_FEATURE_RECORDING__: boolean;
   declare const __SKEPTIC_FEATURE_MCP__: boolean;
   declare const __SKEPTIC_FEATURE_ACP__: boolean;
   declare const __SKEPTIC_CLI_VERSION__: string;
   ```
   These are needed in Phase 1 (`__SKEPTIC_CLI_VERSION__` for the version
   fast-path landing in Phase 2) and Phase 5 (the feature flags). Establishing
   the file in Phase 1 lets phases 2 and 5 ship independently without
   forward-references.

2. Create `cli/tsup.config.ts`:
   - `entry: ["bin/skeptic.ts"]` (single entry; the bundler walks the import graph
     into `src/index.ts`).
   - `format: ["esm"]`, `target: "node22"`, `platform: "node"`.
   - `outDir: "dist"`, `outExtension: () => ({ js: ".mjs" })`.
   - `sourcemap: true`, `minify: false` (readable stack traces > a few KB savings).
   - `treeshake: true`, `splitting: false`.
   - **Declaration emit**: the public types live in `cli/src/index.ts`
     (`TestCommandOptions`, `GenerateCommandOptions`, etc., line 213+),
     not in `bin/skeptic.ts`. tsup's `dts: true` on a single entry only types
     that entry. Two options to preserve the published types contract:
     - **(Recommended)** Add a second tsup entry just for types:
       ```ts
       entry: ["bin/skeptic.ts", "src/index.ts"],
       dts: { entry: "src/index.ts" },  // emit dist/index.d.ts
       ```
       Then `package.json` `"types": "./dist/index.d.ts"`.
     - **(Alternative)** Drop the published-types claim. If no downstream
       consumes skeptic's exported types, `dts: false` is fine. Search dependents
       — current grep shows the type re-exports at `index.ts:213+` aren't used
       by sibling packages in this repo.
     Pick the recommended path unless we confirm no external consumer.
   - **Define version constant**:
     ```ts
     define: {
       __SKEPTIC_CLI_VERSION__: JSON.stringify(
         (await import("./package.json", { with: { type: "json" } })).default.version
       ),
     }
     ```
     This makes `__SKEPTIC_CLI_VERSION__` (declared in `global.d.ts`) substitute
     to a literal string at build time. Phase 2's version fast-path consumes it.

6. **Vitest define for `__SKEPTIC_CLI_VERSION__`** (so Phase 2 can ship before
   Phase 5). Update `cli/vitest.config.ts`:
   ```ts
   export default defineConfig({
     define: {
       __SKEPTIC_CLI_VERSION__: '"0.0.0-dev"',
     },
     test: { /* … existing … */ }
   });
   ```
   Phase 5 extends the same `define` with the feature flags. This way running
   `npm test` against Phase 1 + Phase 2 source (before Phase 5 lands) doesn't
   throw `ReferenceError: __SKEPTIC_CLI_VERSION__ is not defined`.
   - `banner: { js: "#!/usr/bin/env node" }`.
   - `external` (the canonical four, see Hard constraints above):
     `playwright`, `playwright-core`, `better-sqlite3`, `oxc-resolver`. **No
     others.** This is also the SEA sidecar list and the Phase 7 packaging
     list — single source of truth.
   - `noExternal` (bundle for tree-shaking): `commander`, `zod`, `yaml`, `glob`,
     `chokidar`, `chalk`, `figures`, `cli-truncate`, `string-width`, `pretty-ms`,
     `minimatch`, `web-vitals`, `@google/generative-ai`, `@faker-js/faker`,
     `fast-xml-parser`, `pixelmatch`, `pngjs`, `react`, `ink`, `ink-spinner`,
     `@modelcontextprotocol/sdk`, `@agentclientprotocol/sdk`,
     `@axe-core/playwright`. The MCP/ACP SDKs and axe-core are pure JS — they
     bundle cleanly. axe-core/playwright depends on `playwright` (external),
     which bundling preserves.
   - `esbuildOptions(options)`: `options.jsx = "automatic"; options.jsxImportSource = "react"`.
   - `onSuccess`: copy three groups of static assets into `dist/` so they
     ship with the published npm tarball (the JS fallback path needs
     filesystem-readable assets):
     1. `templates/` → `dist/templates/`
     2. `src/commands/recorder-script.js` → `dist/recorder-script.js`
     3. **`node_modules/web-vitals/dist/web-vitals.iife.js` →
        `dist/web-vitals.iife.js`** — needed because Phase 7 moves
        `web-vitals` to `devDependencies` (it's bundled into `skeptic.mjs`
        for the JS code path), but the IIFE script needs filesystem-readable
        asset bytes to inject into the page. The collector's resolution
        order becomes: (1) SEA asset, (2) sibling `dist/web-vitals.iife.js`,
        (3) `createRequire("web-vitals/...")` fallback (only available in
        dev/source-tree mode). Use `node:fs/promises.cp` for all three.

3. Update `cli/package.json` scripts (line 9-16):
   - `"build": "tsup"` (drop the `tsc && cp …` chain).
   - `"check": "tsc --noEmit"` (unchanged).
   - `"dev": "tsup --watch"` (replaces `tsc --watch`).
   - `"clean": "rm -rf dist"` (unchanged).

4. Update `cli/package.json` `bin` field:
   - `"skeptic": "./dist/skeptic.mjs"` (was `./dist/bin/skeptic.js`; tsup outputs flat
     under `dist/` from a single entry).

5. Update template path resolution to work in the bundled layout.
   - Create `cli/src/utils/asset-path.ts`:
     ```ts
     import path from "node:path";
     import { fileURLToPath } from "node:url";
     import { existsSync } from "node:fs";
     export const getTemplatesDir = (): string => {
       const here = path.dirname(fileURLToPath(import.meta.url));
       // Prod (bundled): dist/skeptic.mjs → dist/templates
       const bundled = path.join(here, "templates");
       if (existsSync(bundled)) return bundled;
       // Dev (tsx): cli/src/utils/asset-path.ts → cli/templates
       return path.resolve(here, "../../templates");
     };
     export const getRecorderScript = (): string => {
       const here = path.dirname(fileURLToPath(import.meta.url));
       const bundled = path.join(here, "recorder-script.js");
       if (existsSync(bundled)) return bundled;
       return path.resolve(here, "../commands/recorder-script.js");
     };
     ```
   - Replace existing template-path computation in:
     - `cli/src/commands/init.ts:9-10` → `import { getTemplatesDir } from "../utils/asset-path.js"; const TEMPLATES_DIR = getTemplatesDir();`
     - `cli/src/ai/guidance-loader.ts` (line that computes `__dirname`-based path)
     - `cli/src/commands/record-session.ts:42-46` → use `getRecorderScript()`.

### Risks & mitigations

- **React 19 / Ink JSX runtime resolution**: if tsup emits broken `react/jsx-runtime`
  imports, Ink screens crash on first render. Mitigation: smoke-test all
  TUI-rendering commands (`skeptic test --headed` with TTY) before merging. Fall back
  to marking `react` external if needed.
- **Dynamic `require()` in any bundled dep**: MCP/ACP SDKs are now bundled
  (canonical matrix above). If any of those uses `require(variable)`, it
  errors at build time → mark external case-by-case (and add to the
  canonical four).
- **Sourcemap size**: `.mjs.map` will be 3–5 MB. Acceptable; ship it.
- **Native binding lookups**: `better-sqlite3` resolves its `.node` via a
  build-machine-relative path inside its own loader; staying external preserves that.

### Verification

- `npm run build` → check `dist/skeptic.mjs` exists, `dist/templates/` populated,
  `dist/recorder-script.js` present.
- `node dist/skeptic.mjs --version` → prints `0.1.0`.
- `node dist/skeptic.mjs init /tmp/skeptic-init-test` → creates fixture project; templates
  copied correctly.
- `node dist/skeptic.mjs test cli/__tests__/integration/fixtures/...` → executes a known
  flow end-to-end.
- `npm run check` → no type errors.
- `npm test` → vitest passes (unchanged source on disk).

### What the user sees after Phase 1

`npm install -g skeptic-cli` continues to work. Cold start drops noticeably
(~250 ms → ~120 ms typical) from one-bundle resolution. `dist/` shrinks from sprawled
~4 MB to ~1.2 MB single file + assets.

**Effort: 1 day.**

---

## Phase 2 — Cold-start optimization: lazy commands + version fast path

**Goal**: `skeptic --version` and `skeptic --help` print and exit in <100 ms cold.

**Why second**: pure code change, no build-system dependency, ships value
immediately. Phase 5 (feature flags) will refine these dynamic-import sites further.

### Steps

1. **Version fast-path** in `cli/bin/skeptic.ts` BEFORE the static
   `import { program } from "../src/index.js"`. ESM static imports are hoisted,
   so the fast-path must live in the entrypoint module before any import that
   would pull in Commander + side-effect imports. Convert the existing static
   import to a dynamic one:
   ```ts
   #!/usr/bin/env node
   // Fast path: --version / --help short-circuit BEFORE any heavy import.
   if (process.argv.length === 3) {
     const a = process.argv[2];
     if (a === "--version" || a === "-V") {
       // Inject at build time via tsup `define` so the bundle has a literal.
       console.log(__SKEPTIC_CLI_VERSION__);
       process.exit(0);
     }
   }
   const { program } = await import("../src/index.js");
   await program.parseAsync(process.argv);
   ```
   Move the version literal into `cli/src/constants.ts` (export `CLI_VERSION`) so
   `program.version()` (`index.ts:26`) reads from one source. The bundler
   `define` substitutes `__SKEPTIC_CLI_VERSION__` to the JSON-stringified value of
   `package.json`.version at build time, eliminating a `package.json` read on
   the fast path.

2. **Lazy-load remaining eager command runners** in `cli/src/index.ts`:
   - Lines 3 (`runInit`), 4-5 (`runTest`), 6-7 (`runGenerate`), 8-9 (`runAddGitHubAction`,
     `runAddSkill`), 10 (`runMcp`), 11 (`runCookiesList`).
   - Convert each to the same pattern already used for `validate`/`comment`/`acp`/`record`/`audit`:
     ```ts
     // Before
     import { runInit } from "./commands/init.js";
     program.command("init").action(async (dir) => { await runInit(dir); });

     // After
     import type { /* options */ } from "./commands/init.js";
     program.command("init").action(async (dir) => {
       const { runInit } = await import("./commands/init.js");
       await runInit(dir);
     });
     ```
   - `import type` is erased; only types stay at the top.

3. **Lazy-load inside `cli/src/commands/test.ts`**:
   - `chokidar` (line 4) → only when `opts.watch` is true. Move `await import("chokidar")`
     into the watch branch.
   - Reporters `JsonReporter`, `JUnitReporter`, `HtmlReporter`, `SlackReporter`,
     `WebhookReporter` → load only the ones the user actually selected via `--reporter`.
     Keep `ConsoleReporter` eager (almost always used). The `InkReporter` is already
     lazy at line ~340.
   - `createAIClient`: do **not** gate solely on `opts.analyze`. The AI client
     at `test.ts:201` is passed into the engine at `:226` and used by step
     handlers `assertWithAI`, `assertNoDefects`, **`extractTextWithAI`**
     (verified at `flow-schema.ts:94` + `step-handlers/index.ts:123`) via
     `ctx.aiClient`. Instead, after parsing flows + hooks but before engine
     launch, **recursively scan** all step trees including the
     composite-handler bodies, **both config-level AND per-flow hooks**, and
     conservatively assume AI is used when a `runFlow.file:` reference points
     to an unscanned subflow.

     Per-flow hooks are at `flow.metadata.onFlowStart` /
     `flow.metadata.onFlowComplete` (per `flow-schema.ts:556`), and the merge
     in `test.ts:474` combines them with config-level hooks. The scanner must
     walk both:

     ```ts
     // cli/src/commands/test.ts (new helper, before engine launch)
     import type { Step } from "../parser/flow-schema.js";
     import type { NormalizedStep } from "../parser/step-normalizer.js";
     import { normalizeStep } from "../parser/step-normalizer.js";

     const AI_COMMANDS = new Set<string>([
       "assertWithAI", "assertNoDefects", "extractTextWithAI",
     ]);

     // Walk a NormalizedStep tree (recursive into composite commands).
     const normalizedUsesAI = (step: NormalizedStep): boolean => {
       if (AI_COMMANDS.has(step.command)) return true;
       const args = step.args as { commands?: Step[] } | undefined;
       const nested = args?.commands;
       if (Array.isArray(nested)) {
         return nested.some(s => normalizedUsesAI(normalizeStep(s)));
       }
       // Conservative: runFlow with a file reference might import AI.
       // Schema allows BOTH `runFlow: "subflow.yaml"` (string shorthand) AND
       // `runFlow: { file: "..." }` (object form). The handler normalizes
       // strings to `{ file: args }` (run-flow.ts:26). Treat both as
       // potentially-AI.
       if (step.command === "runFlow") {
         if (typeof step.args === "string") return true;
         const runFlowArgs = step.args as { file?: string } | undefined;
         if (runFlowArgs?.file) return true;
       }
       return false;
     };

     // Walk raw Step (used for hooks which are pre-normalize).
     const rawUsesAI = (step: Step): boolean =>
       normalizedUsesAI(normalizeStep(step));

     const flowsUseAI = flows.some(f =>
       f.steps.some(rawUsesAI) ||
       (f.metadata.onFlowStart ?? []).some(rawUsesAI) ||
       (f.metadata.onFlowComplete ?? []).some(rawUsesAI)
     );
     const configHooksUseAI =
       (config.hooks?.onFlowStart ?? []).some(rawUsesAI) ||
       (config.hooks?.onFlowComplete ?? []).some(rawUsesAI);

     const aiClient = (opts.analyze || flowsUseAI || configHooksUseAI)
       ? await createAIClient(config.ai)
       : undefined;
     ```

     **Verified type contract** (Codex Round 4 correction): `ResolvedFlow.steps`
     is raw `Step[]` per `flow-schema.ts:565` (`z.array(StepSchema)`).
     Normalization happens later in `flowToInput` at `test.ts:483`. So
     `f.steps`, `f.metadata.onFlowStart`, and `f.metadata.onFlowComplete` all
     go through `rawUsesAI`. `normalizedUsesAI` is reserved for already-
     normalized step trees encountered during recursion (i.e., the body of a
     composite handler that's already been normalized).

     **Conservative `runFlow.file` handling**: rather than recursively reading
     subflow files at startup (which would defeat the cold-start optimization),
     we treat any `runFlow: { file: ... }` as "might contain AI." False
     positive: a non-AI subflow causes the AI client to load. This is
     acceptable because (a) most projects either use AI throughout or not at
     all, and (b) the SDK load is ~50 ms.
   - `PlaywrightEngine` stays eager (always needed for non-`--dry-run`).

### Risks & mitigations

- **Type narrowing across async boundaries**: keep `import type` at top of files for
  TS narrowing, separate from runtime `await import()`.
- **Lazy first-use latency**: the first `skeptic test` invocation pays a one-time
  load cost. Negligible compared to Playwright launch (~1.5 s).
- **Help text aggregation**: Commander's `--help` walks subcommand metadata. As
  long as `program.command(...).description(...).option(...)` chains run
  synchronously (they do), help still works without loading action handlers.

### Verification

- `time skeptic --version` → <50 ms warm, <100 ms cold.
- `time skeptic --help` → <150 ms.
- `time skeptic test --help` → <200 ms (slightly more — Commander synthesizes from
  declared options without executing actions).
- All existing integration tests pass; vitest suite unchanged.

### What the user sees after Phase 2

`skeptic --version` and `skeptic --help` are near-instant. Other commands shave 200–400 ms
of cold start each. `skeptic test` first invocation is unchanged on the hot path.

**Effort: 0.5 day.**

---

## Phase 3 — Death-spiral guard for `runFlow` recursion

**Goal**: a recursive subflow chain (A → B → A or A → A) fails loudly with a clear
error instead of crashing Node with a stack-overflow trace.

**Why third**: pure correctness fix, S effort, isolates a known footgun before
binary distribution makes stack-overflow crashes harder to debug for users.

### Steps

1. Modify `cli/src/executor/context.ts` (around lines 6-90):
   - Add instance fields:
     ```ts
     runFlowDepth = 0;
     runFlowStack: string[] = [];
     ```
   - Document them in the same block as `abortReason`/`inTeardown` so the next
     reader sees they're part of the executor invariants.

2. Modify `cli/src/executor/step-handlers/run-flow.ts`. The handler has two
   code branches (verified at `run-flow.ts:14-16, 49-79`): the `file:` form
   and an inline `commands:` form. **Important schema constraint** (verified
   at `flow-schema.ts:340-352`): the runFlow object form Zod schema **requires
   `file`** — `{ commands: [...] }` without `file` will not parse. So a
   user-authored cycle can only happen through the file branch. The handler's
   inline branch only fires when both `file:` and `commands:` are present
   (in which case `commands:` wins, line 57).

   This means the cycle/depth guard must focus on the **file path identity**;
   pure inline cycles are not expressible through valid YAML and don't need a
   separate test scenario. The guard still needs to wrap the whole handler
   body and run **before** any ctx mutation:
   - Add at top: `const MAX_RUN_FLOW_DEPTH = 10;`
   - **Restructure the handler** so the depth/cycle check runs before
     `parsed.env` mutations (currently at lines 49-52). Today's order is:
     `when check → env mutation → file/inline branch → executeNestedSteps`.
     New order: `when check → identity computation → cycle/depth guard →
     push stack → env mutation (inside try) → branch → executeNestedSteps →
     finally pop+restore`.
   - Identity logic:
     ```ts
     // Compute identity ONLY for the file-loading branch (cycle detection
     // doesn't apply when commands: takes precedence over file: in the
     // handler at run-flow.ts:57 — the file is never read).
     let identity: string | null = null;
     if (!parsed.commands && parsed.file) {
       const filePath = path.resolve(ctx.sourceDir, parsed.file);
       try {
         identity = fs.realpathSync.native(filePath);
       } catch {
         identity = filePath; // file doesn't exist — propagate to existing error
       }
     }
     // Inline `commands` form: cycle detection is a no-op (the file isn't
     // read anyway). Depth cap still applies to prevent runaway nesting.

     if (identity && ctx.runFlowStack.includes(identity)) {
       return failResult(`runFlow: cycle detected: ${[...ctx.runFlowStack, identity].join(" → ")}`);
     }
     if (ctx.runFlowDepth >= MAX_RUN_FLOW_DEPTH) {
       return failResult(`runFlow: depth ${MAX_RUN_FLOW_DEPTH} exceeded`);
     }
     ```
   - **Preserve env on failure**: snapshot affected variable values BEFORE
     setting them, restore in `finally`. `ctx.setVariable` mutates in place; we
     don't want a failed sub-flow to leak env changes back to the caller.
     ```ts
     ctx.runFlowDepth++;
     if (identity) ctx.runFlowStack.push(identity);
     const envSnapshot = parsed.env
       ? Object.fromEntries(Object.keys(parsed.env).map(k => [k, ctx.getVariable(k)]))
       : null;
     try {
       if (parsed.env) {
         for (const [k, v] of Object.entries(parsed.env)) ctx.setVariable(k, v);
       }
       // existing branch logic + executeNestedSteps
     } finally {
       ctx.runFlowDepth--;
       if (identity) ctx.runFlowStack.pop();
       if (envSnapshot) {
         for (const [k, v] of Object.entries(envSnapshot)) {
           if (v === undefined) ctx.deleteVariable(k);
           else ctx.setVariable(k, v);
         }
       }
     }
     ```
   - If `ctx.deleteVariable` doesn't exist, add it to `context.ts`. Verify
     the variables map's API in `context.ts:8`.

3. Add unit tests under `cli/__tests__/unit/executor/run-flow.test.ts`:
   - `runFlow A → A` (self-cycle, file form) returns failure with cycle error.
   - `runFlow A → B → A` (file-form chain) returns failure with cycle error
     including all three identities.
   - `runFlow` chain of length 11 returns failure with depth error.
   - Linear chain of length 10 succeeds.
   - **Env restoration**: a sub-flow that sets env vars and then fails leaves
     the parent's env unchanged.
   - Failure midway through the chain still decrements depth (verify via the
     `finally`).
   - (Skipped: pure inline-form cycle scenario — not expressible via the
     current `runFlow` Zod schema which requires `file` in object form.)

### Risks & mitigations

- **Legitimate deep flow trees** could theoretically hit depth=10. If reports come
  in, surface `MAX_RUN_FLOW_DEPTH` via `cli/src/config/schema.ts` and read at
  engine init. Defer until a real user hits it.
- **Symlinks** might evade cycle detection by absolute path. Acceptable — the
  error message still points the user at the right thing, and `path.resolve` already
  normalizes `..`/`.`.

### Verification

- New unit tests pass.
- All existing executor tests pass.
- Manual: create `tests/loop.flow.yaml` that `runFlow:`s itself; run
  `skeptic test tests/loop.flow.yaml`; confirm graceful failure.

### What the user sees after Phase 3

Recursive subflow includes fail in <10 ms with a clear message and cycle path,
instead of a 50-frame stack trace.

**Effort: 0.5 day.**

---

## Phase 4 — Withhold-and-recover for AI errors

**Goal**: AI assertion calls retry transient failures (429, 503, 529) silently and
downscale screenshots on context-length errors, surfacing only un-recoverable
errors to the user.

**Why fourth**: directly improves CI reliability. The retry-policy module is the
single most leveraged file change for AI-heavy runs.

### Steps

1. Create `cli/src/ai/retry-policy.ts`:
   - **Define the structured error type** that all clients will throw and the
     classifier will read. `withRetry` cannot classify errors that are bare
     `Error` instances:
     ```ts
     export class ProviderError extends Error {
       constructor(
         message: string,
         public readonly provider: "gemini" | "anthropic" | "openai",
         public readonly status: number,
         public readonly body: unknown,
         public readonly retryAfterMs: number | null,
       ) { super(message); this.name = "ProviderError"; }
     }
     ```
   - `classifyError(err: ProviderError): { kind: "rate-limit" | "overload" | "context-length" | "fatal"; retryAfterMs?: number }`
     - **Gemini**: `status === 429` + `Retry-After` → `rate-limit`. `status === 400`
       with `body.error?.message` matching `/exceeds.*input token limit|content too large/i`
       → `context-length`. `status === 413` → `context-length`. `status >= 500` → `overload`.
     - **Anthropic**: `status === 429` → `rate-limit` (read `retry-after`).
       `status === 529` (overloaded) or `503` → `overload`. `status === 400`
       with `body.error?.type === "invalid_request_error"` and
       `/input length .* exceeds/i` in the message → `context-length`. `status === 413`
       → `context-length`.
     - **OpenAI**: `status === 429` w/ `body.error?.code === "rate_limit_exceeded"` → `rate-limit`;
       `status === 400` w/ `body.error?.code === "context_length_exceeded"` → `context-length`;
       `status === 413` (payload too large) → `context-length`; `status >= 500` → `overload`.
     - Default: `fatal`.

     The pattern: each provider reports context overflow differently — Gemini
     uses prose in `message`, Anthropic uses `error.type` + `message`, OpenAI
     uses `error.code`. All three accept `413` for payload-too-large which is
     the same recovery (downscale). Test fixtures should include one example
     of each shape.
   - `withRetry<T>(fn: () => Promise<T>, opts: { maxAttempts?: number; logger?: Logger; onContextLengthError?: () => Promise<boolean> }): Promise<{ result: T; retryCount: number }>`
     - Default: 3 attempts, exponential backoff 250 → 500 → 1000 ms, honor `Retry-After`.
     - Returns retry count alongside the result for telemetry.
     - Logs at `debug` level (no UI noise).
     - `context-length` triggers `onContextLengthError()` once; returns `true`
       if a downscale was actually applied (so retry happens), `false` otherwise
       (no point retrying without a payload change).
   - Pure logic, no I/O, easy to unit-test.

2. Modify `cli/src/ai/gemini-client.ts`:
   - Wrap `model.generateContent` calls (line 31, line 49) in `withRetry(...)`.
   - **Throw `ProviderError`** by parsing the Gemini SDK error shape: errors come
     through as `GoogleGenerativeAIFetchError` with `.status`, `.statusText`, and
     `.errorDetails`. Map to `ProviderError`.
   - Pass an `onContextLengthError` callback that downscales the image buffer.
     **Implementation**: use `pngjs` to decode → 2× nearest-neighbor downscale
     in a tight pixel loop → encode. Concrete code:
     ```ts
     export const downscalePng = (input: Buffer): Buffer | null => {
       try {
         const src = PNG.sync.read(input);
         const w2 = Math.max(1, Math.floor(src.width / 2));
         const h2 = Math.max(1, Math.floor(src.height / 2));
         const dst = new PNG({ width: w2, height: h2 });
         for (let y = 0; y < h2; y++) {
           for (let x = 0; x < w2; x++) {
             const sx = x * 2, sy = y * 2;
             const si = (sy * src.width + sx) * 4;
             const di = (y * w2 + x) * 4;
             dst.data[di]   = src.data[si];
             dst.data[di+1] = src.data[si+1];
             dst.data[di+2] = src.data[si+2];
             dst.data[di+3] = src.data[si+3];
           }
         }
         return PNG.sync.write(dst);
       } catch { return null; }
     };
     ```
     If `downscalePng` returns `null`, the callback returns `false` and retry
     stops.
   - The existing `waitForRateLimit` (line 59-76) stays — it's the proactive guard.

3. Modify `cli/src/ai/anthropic-client.ts`:
   - Read `response.status`, `response.headers.get("retry-after")`, body before
     deciding to throw. Throw `ProviderError` instead of `new Error(...)`.
     Wrap the fetch call in `withRetry`.
   - Map `error.type === "overloaded_error"` → `overload`.
   - **Wire the same `onContextLengthError` downscale callback** as Gemini
     (mutates the image buffer reference and returns `true` if downscale
     applied). Anthropic's vision API has the same payload-size constraint;
     uniform recovery across providers is the goal.

4. Modify `cli/src/ai/openai-client.ts`:
   - Same shape as Anthropic. Honor `Retry-After`. Throw `ProviderError`.
   - **Wire the same `onContextLengthError` downscale callback** as
     Gemini/Anthropic. OpenAI's `400 context_length_exceeded` and
     `413 payload_too_large` both recover the same way.

5. `cli/src/ai/assertion-evaluator.ts` — no behavior changes. The existing
   `try/catch` at line ~56-58 already handles final fatals correctly for
   `--analyze`.

6. **Thread retry counts through to `StepResult.warnings`**. Verified:
   `FlowResult` does NOT have a `warnings` field — only `StepResult` does at
   `types.ts:21`. The current `AIClient` interface (`ai-client.ts:9-13`)
   returns `Promise<string>`, with no slot for retry metadata. Two changes:

   a. **Change the `AIClient` interface** to return structured results:
      ```ts
      // cli/src/ai/ai-client.ts
      export interface AIResult {
        text: string;
        retryCount: number;
      }
      export interface AIClient {
        readonly provider: AIProvider;  // existing — keep, used by security.ts:22 etc.
        analyzeImage(buf: Buffer, prompt: string, t?: number): Promise<AIResult>;
        generateText(prompt: string, system?: string, t?: number): Promise<AIResult>;
      }
      ```
      Update all three providers (`gemini-client.ts`, `anthropic-client.ts`,
      `openai-client.ts`) to wrap their results: `{ text, retryCount: result.retryCount }`.

      **Also update `cli/src/ai/types.ts`** (verified: defines
      `AIAssertionResult` at line 1 and `AIExtractionResult` at line 14, neither
      currently has `retryCount`):
      ```ts
      export interface AIAssertionResult {
        // …existing fields…
        retryCount?: number;  // populated by withRetry; absent for tests/mocks
      }
      export interface AIExtractionResult {
        // …existing fields…
        retryCount?: number;
      }
      ```

      Update `cli/src/ai/assertion-evaluator.ts:10` (`evaluateAssertion`,
      `evaluateDefects`, `extractText`, `analyzeFailure`) to:
      - Read `.text` from the new `AIResult` structure (was bare `string`).
      - Forward `.retryCount` onto the returned `AIAssertionResult` /
        `AIExtractionResult`.

      Update `cli/src/executor/step-handlers/assert-with-ai.ts` (and siblings
      `assert-no-defects.ts`, **`extract-text-ai.ts`** — verified actual
      filename, NOT `extract-text-with-ai.ts`) to consume the retry count
      from the evaluator's return.

      **Also update `cli/src/ai/flow-generator.ts`** (verified at lines 174 and
      205): both call sites use `client.generateText(...)` and treat the result
      as a string (line 205 calls `.trim()` on the result). Update to read
      `.text` from the new `AIResult` shape:
      ```ts
      // Was: const raw = await client.generateText(prompt, system);
      const result = await client.generateText(prompt, system);
      const raw = result.text;
      // Optionally surface result.retryCount in CLI output for `skeptic generate`.
      ```
      Same pattern at line 205 (where `.trim()` was applied directly):
      `const raw = (await client.generateText(prompt, system)).text.trim();`

      **Update AI client tests and any mocks** to return `{ text, retryCount }`
      instead of bare strings. Search test fixtures for `analyzeImage` /
      `generateText` mocks.

   b. **Surface retry count via `appendWarning`** in the step handler:
      ```ts
      const evalResult = await evaluateAssertion(ctx.aiClient, screenshot, assertion);
      const stepResult: StepResult = { /* … existing fields … */ };
      if (evalResult.retryCount > 0) {
        appendWarning(stepResult, `AI retried ${evalResult.retryCount}× before success`);
      }
      ```
      Reporters already render `StepResult.warnings` (no reporter changes
      needed).

   This is a breaking change to the internal `AIClient` interface — any
   third-party code using it would need to update. Acceptable since the
   interface is internal.

### Risks & mitigations

- **Retry storms** during a real provider outage: cap at 3 attempts, then fail.
  Don't retry `4xx` other than `429` / `413` / `400-context-length`.
- **Latency spikes**: 250+500+1000 ms backoff plus the original failed call adds
  ~2 s to a single AI step. Document in CLAUDE.md / config docs.
- **Logging during retry**: `logger.debug` only. Don't pollute normal output.
- **Downscale failure**: if `pngjs` can't parse (corrupt buffer), surface the
  original error.

### Verification

- New unit tests for `classifyError` and `withRetry` (mock fetch).
- Integration test: a Gemini call against a mock server that returns `429` once,
  then `200`; verify single visible call from caller's POV.
- Manual: run a flow that hits `assertWithAI` with a tiny rate-limit (e.g.,
  `geminiRpm: 1` in config); confirm retries don't surface.

### What the user sees after Phase 4

Transient AI failures stop turning green CI red. `assertWithAI` becomes
visibly more reliable.

**Effort: 1 day.**

---

## Phase 5 — Build-time feature flags + cache-boundary marker

**Goal**: smaller, more focused binaries by build-time-eliminating optional features
(`AI_ASSERTIONS`, `COOKIE_EXTRACTION`, `RECORDING`, `MCP`, `ACP`). Mark prompt
cache boundaries for future explicit caching when prompts grow past 1024 tokens.

**Why fifth**: requires Phase 1 (bundler with `define`) and Phase 2 (lazy imports)
to be in place. Pays off in Phase 6 (binary builds) by trimming binary size.

### Steps

1. **`cli/src/global.d.ts`** is already created in Phase 1 — its
   `__SKEPTIC_FEATURE_*__` declarations are visible globally. Verify this still
   works by running `tsc --noEmit` after the gates are added in Step 4 below.

2. Create `cli/src/feature-flags.ts`. **Critical for tree-shaking**: esbuild
   only tree-shakes branches gated on **direct** `if (BARE_IDENTIFIER)` checks,
   not on object property access like `if (FEATURES.X)`. Verified by Codex's
   test: `--define:__SKEPTIC_FEATURE_ACP__=false` eliminates `if
   (__SKEPTIC_FEATURE_ACP__)` but NOT `if (FEATURES.ACP)` (the latter compiles
   to a runtime property read).

   The `feature-flags.ts` module relies on the ambient declarations from
   `global.d.ts`:
   ```ts
   // cli/src/feature-flags.ts — uses ambient __SKEPTIC_FEATURE_*__ from global.d.ts.

   // In dev (tsx), define is not applied — fall back to globalThis or true.
   const env = (k: string, fallback: boolean): boolean => {
     const g = (globalThis as Record<string, unknown>)[k];
     return typeof g === "boolean" ? g : fallback;
   };

   // FEATURES is for read-only inspection (e.g., `skeptic --features` output).
   // It does NOT participate in tree-shaking — gates must use the bare
   // __SKEPTIC_FEATURE_*__ identifiers directly.
   export const FEATURES = {
     AI_ASSERTIONS:
       typeof __SKEPTIC_FEATURE_AI_ASSERTIONS__ !== "undefined"
         ? __SKEPTIC_FEATURE_AI_ASSERTIONS__
         : env("__SKEPTIC_FEATURE_AI_ASSERTIONS__", true),
     COOKIE_EXTRACTION:
       typeof __SKEPTIC_FEATURE_COOKIE_EXTRACTION__ !== "undefined"
         ? __SKEPTIC_FEATURE_COOKIE_EXTRACTION__
         : env("__SKEPTIC_FEATURE_COOKIE_EXTRACTION__", true),
     RECORDING:
       typeof __SKEPTIC_FEATURE_RECORDING__ !== "undefined"
         ? __SKEPTIC_FEATURE_RECORDING__
         : env("__SKEPTIC_FEATURE_RECORDING__", true),
     MCP:
       typeof __SKEPTIC_FEATURE_MCP__ !== "undefined"
         ? __SKEPTIC_FEATURE_MCP__
         : env("__SKEPTIC_FEATURE_MCP__", true),
     ACP:
       typeof __SKEPTIC_FEATURE_ACP__ !== "undefined"
         ? __SKEPTIC_FEATURE_ACP__
         : env("__SKEPTIC_FEATURE_ACP__", true),
   } as const;
   ```
   - Document the contract: gate dead-code paths using
     `if (__SKEPTIC_FEATURE_AI_ASSERTIONS__) { … }` directly. `FEATURES.X`
     access works at runtime but does NOT trigger esbuild dead-code
     elimination. Use `FEATURES` only for non-DCE inspection (e.g., the
     `skeptic --features` output).

3. **Extend** `cli/tsup.config.ts` `define` (it already includes
   `__SKEPTIC_CLI_VERSION__` from Phase 1 — DON'T replace, MERGE):
   ```ts
   define: {
     __SKEPTIC_CLI_VERSION__: /* from Phase 1, keep */,
     __SKEPTIC_FEATURE_AI_ASSERTIONS__: process.env.SKEPTIC_FEATURE_AI_ASSERTIONS ?? "true",
     __SKEPTIC_FEATURE_COOKIE_EXTRACTION__: process.env.SKEPTIC_FEATURE_COOKIE_EXTRACTION ?? "true",
     __SKEPTIC_FEATURE_RECORDING__: process.env.SKEPTIC_FEATURE_RECORDING ?? "true",
     __SKEPTIC_FEATURE_MCP__: process.env.SKEPTIC_FEATURE_MCP ?? "true",
     __SKEPTIC_FEATURE_ACP__: process.env.SKEPTIC_FEATURE_ACP ?? "true",
   }
   ```
   - Default builds enable everything. CI builds for slim variants set env vars
     before `npm run build`.

   **Critical — runtime defines for dev/test**: bare `__SKEPTIC_FEATURE_*__`
   identifiers don't exist at runtime in unbundled paths (vitest, tsx). They
   MUST be defined for unbundled execution or every gated check throws
   `ReferenceError`. Two places to wire this:

   - `cli/vitest.config.ts` — add a `define` block:
     ```ts
     export default defineConfig({
       define: {
         __SKEPTIC_CLI_VERSION__: '"0.0.0-dev"',
         __SKEPTIC_FEATURE_AI_ASSERTIONS__: "true",
         __SKEPTIC_FEATURE_COOKIE_EXTRACTION__: "true",
         __SKEPTIC_FEATURE_RECORDING__: "true",
         __SKEPTIC_FEATURE_MCP__: "true",
         __SKEPTIC_FEATURE_ACP__: "true",
       },
       test: { globals: true, /* … existing … */ }
     });
     ```
     Vitest reuses Vite's `define` mechanism to substitute identifiers.
   - For ad-hoc `tsx`/`node --import tsx` runs, document a small bootstrap:
     `cli/bin/dev.ts` (new file) that sets every build-time global on
     `globalThis` BEFORE importing `skeptic.ts`:
     ```ts
     // cli/bin/dev.ts
     const g = globalThis as Record<string, unknown>;
     g.__SKEPTIC_CLI_VERSION__ = "0.0.0-dev";
     g.__SKEPTIC_FEATURE_AI_ASSERTIONS__ = true;
     g.__SKEPTIC_FEATURE_COOKIE_EXTRACTION__ = true;
     g.__SKEPTIC_FEATURE_RECORDING__ = true;
     g.__SKEPTIC_FEATURE_MCP__ = true;
     g.__SKEPTIC_FEATURE_ACP__ = true;
     await import("./skeptic.ts");
     ```
     Devs invoke `tsx bin/dev.ts <args>` instead of `tsx bin/skeptic.ts`.
     Mention this in CLAUDE.md.
   - The `feature-flags.ts` `globalThis` fallback covers reads of `FEATURES.X`
     in dev, but bare identifiers like `if (__SKEPTIC_FEATURE_ACP__)` need the
     `define`. The two are not interchangeable — `define` is the only way to
     make bare identifiers work in unbundled execution.

4. Gate dynamic imports using **positive-branch** bare-identifier checks
   (esbuild only DCEs the dynamic import when it lives inside the positive
   branch of a literal-false `if`. The `if (!flag) { exit } ; import()`
   pattern leaves the import outside the dead branch and esbuild preserves
   it):
   - `cli/src/index.ts:178` (acp):
     ```ts
     .action(async () => {
       if (__SKEPTIC_FEATURE_ACP__) {
         const { runAcp } = await import("./commands/acp.js");
         await runAcp();
       } else {
         console.error("acp not built into this binary");
         process.exit(1);
       }
     });
     ```
     When `__SKEPTIC_FEATURE_ACP__` is `define`'d to `false`, esbuild folds to
     `if (false) { … } else { console.error … exit(1); }` and tree-shakes
     the truthy branch, removing both the dynamic import and the `acp.ts`
     chunk it would otherwise pull in.
   - `cli/src/index.ts:163` (comment) — keep always-on.
   - `cli/src/index.ts` mcp action — same positive-branch pattern with
     `__SKEPTIC_FEATURE_MCP__`.
   - `cli/src/index.ts` record action — same positive-branch pattern with
     `__SKEPTIC_FEATURE_RECORDING__`.
   - **All other gates below follow the same positive-branch pattern**:
     `if (FEATURE) { /* do thing including dynamic imports */ } else { /* fail */ }`.
   - **Cookie extraction — gate ALL three entry points** so a slim build
     genuinely drops `better-sqlite3` and the extractor module:
     - `cli/src/executor/playwright-engine.ts:14` (extractAndInjectCookies) —
       convert static import to dynamic gated by
       `if (__SKEPTIC_FEATURE_COOKIE_EXTRACTION__)`.
     - `cli/src/commands/record-session.ts:6` (extractAndInjectCookies) —
       same conversion, gated.
     - `cli/src/commands/cookies.ts:2` (`detectBrowsers`) — same conversion,
       gated with positive-branch pattern:
       ```ts
       export const runCookiesList = async () => {
         if (__SKEPTIC_FEATURE_COOKIE_EXTRACTION__) {
           // detectBrowsers lives in extractor.ts (verified via grep).
           const { detectBrowsers } = await import("../cookies/extractor.js");
           // … rest of command
         } else {
           console.error("skeptic cookies: not built into this binary.");
           process.exit(2);
         }
       };
       ```
     **Plus explicit user-facing failure for `--cookies`**: in `test.ts` and
     `record-session.ts` action handlers, fail loudly BEFORE browser launch
     if the flag is off:
     ```ts
     if (opts.cookies && !__SKEPTIC_FEATURE_COOKIE_EXTRACTION__) {
       console.error("--cookies: cookie extraction is not built into this binary.");
       console.error("Install via npm for cookie support: `npm i -g skeptic-cli`");
       process.exit(2);
     }
     ```
     Without this, a slim build would silently skip cookies — confusing UX.
   - `cli/src/ai/client-factory.ts` — **gate the entire factory** with bare
     identifier. Verified at `client-factory.ts:2` that `GeminiClient` is
     currently a static import; convert it to dynamic so the
     `@google/generative-ai` SDK is also tree-shaken when AI is disabled.
     **Important**: don't return `undefined` for "AI not built in" — current
     callers (`generate.ts:42`, `security.ts:22`) interpret `undefined` as "no
     API key configured" and emit a misleading message. Throw a structured
     error instead:
     ```ts
     export class AIFeatureNotBuiltError extends Error {
       constructor() {
         super("AI assertions not built into this binary. " +
               "Install via npm for AI support: `npm i -g skeptic-cli`");
         this.name = "AIFeatureNotBuiltError";
       }
     }

     // PSEUDO-SKETCH — preserve the real factory's existing semantics:
     // - optional `config` param; default provider derivation
     // - API-key resolution from env (GEMINI_API_KEY etc.) with empty-string
     //   fallback behavior preserved
     // - model + maxRequestsPerMinute computation
     // - constructor call shapes (e.g. `new GeminiClient(apiKey, model, maxRpm)`,
     //   NOT `new GeminiClient(config.gemini)`).
     // The change is structural — wrap the EXISTING factory body in the
     // positive-branch DCE pattern and convert the static `GeminiClient`
     // import to dynamic. Don't rewrite the constructor calls.
     ```ts
     export const createAIClient = async (config?: AIConfig) => {
       if (__SKEPTIC_FEATURE_AI_ASSERTIONS__) {
         // … existing factory logic from client-factory.ts:17+ verbatim,
         // except: replace `import { GeminiClient } from "./gemini-client.js"`
         // (top of file) with `const { GeminiClient } = await import("./gemini-client.js")`
         // inside the gemini case so the SDK only loads when requested AND
         // can be tree-shaken when AI is disabled.
       } else {
         throw new AIFeatureNotBuiltError();
       }
     };
     ```
     **Note**: positive-branch pattern is mandatory — `if (!flag) throw; await
     import(...)` would NOT trigger esbuild DCE (the dynamic import lives
     outside the dead branch and stays in the bundle).
     **All callers of `createAIClient` need to handle `AIFeatureNotBuiltError`**:
     - `cli/src/commands/test.ts` (the AI-scanner branch, Phase 2 step 3): wrap
       the call in `try/catch` and `process.exit(2)` on the typed error.
     - `cli/src/commands/generate.ts:42`: same pattern — `skeptic generate`
       always needs AI, so a slim build should refuse cleanly.
     - **`cli/src/commands/mcp.ts:171`** (`run_flow`, `run_test`): currently
       calls `createAIClient` unconditionally per session. **Lazy-create AI
       only when the actually-running flow needs it** — reuse the AI scanner
       from Phase 2: scan the flow's normalized step tree before launching
       the engine, only call `createAIClient` if AI commands are present.
       Non-AI flows must continue to work in a slim build. For
       `generate_flow` tool (`mcp.ts:246`), AI is mandatory: catch
       `AIFeatureNotBuiltError` and return `{ isError: true, content:
       [{ type: "text", text: e.message }] }`.
     - **`cli/src/commands/acp.ts:125`** (`newSession`): currently calls
       `createAIClient` during session init. **Defer AI creation** to the
       per-prompt handler at `acp.ts:338` (`generateFromDescription`). Empty
       sessions and non-AI test runs must succeed in slim builds. **For ACP
       `run_flow` / `run_test` dispatch paths**: apply the same flow-scanner
       pattern as `test.ts` and MCP — only call `createAIClient` if the
       selected flow + per-flow hooks + config hooks have AI commands. The
       ACP dispatcher currently passes `session.aiClient` into
       `buildMcpEngineOptions`; replace that with a per-call lazy creation.
       On AI prompts (`generate_flow`) in slim builds, return an ACP error
       response, not a session crash.
     - `cli/src/ai/security.ts:36`: this validates AI config presence. With
       the new error class, ensure security.ts re-throws (not swallows)
       `AIFeatureNotBuiltError` so the caller sees the original message.
     The pattern at every CLI command boundary:
     ```ts
     let aiClient: AIClient | undefined;
     try {
       aiClient = await createAIClient(config.ai);
     } catch (e) {
       if (e instanceof AIFeatureNotBuiltError) {
         console.error(e.message);
         process.exit(2);
       }
       throw e;
     }
     ```
     This produces a clear error at every entry point, not an inscrutable
     "no API key" stub message.

5. Add `skeptic --features` flag to `cli/src/index.ts` that prints
   `JSON.stringify(FEATURES, null, 2)`. `FEATURES` is fine here because it's
   not gating any dead code — it's just being serialized for display. The
   tree-shaking constraint above only applies to gates that should remove
   code from the bundle.

6. Cache-boundary marker for prompts (Pattern 4 from research):
   - `cli/src/ai/prompts.ts`: split each cacheable prompt into `STATIC_PREFIX_X`
     and `dynamicSuffix(args)` exports. Insert sentinel comment
     `// === CACHE BOUNDARY ===` between them. Keep combined string export for
     backwards compat.
   - Targets: `VISUAL_ASSERTION_PROMPT`, `ASSERT_WITH_AI_PROMPT`,
     `GENERATE_FROM_DIFF_PROMPT`. Skip `EXTRACT_TEXT_PROMPT` (too short).
   - **Defer the actual `cachedContents` API wiring**. Today's prompts are <1024
     tokens; below Gemini/Anthropic minimums. Mark the structure now; wire when
     prompts grow past the threshold.

### Risks & mitigations

- **Build-time vs runtime confusion**: document loudly in `feature-flags.ts` that
  `feature()` is bake-at-build, not dynamic. For runtime gating, read
  `process.env` directly.
- **Dev mode (tsx)**: `globalThis.__SKEPTIC_FEATURES__` fallback returns `true` for
  every flag, so devs see all features.
- **Flag matrix explosion**: only one canonical build for v1 (everything on). The
  slim variants come later if a real demand surfaces.
- **Prompt restructure breaks tests**: AI assertion tests use the full prompt
  string. Update them to consume the combined export.

### Verification

- Default build (`npm run build`) → `node dist/skeptic.mjs --features` prints all
  five as `true`.
- Slim build (`SKEPTIC_FEATURE_AI_ASSERTIONS=false npm run build`) → `--features`
  shows AI false. Inspect `dist/skeptic.mjs` size — should drop ~500-800 KB
  (Gemini + Anthropic + OpenAI SDK chunks gone).
- Run `skeptic test` against a flow with `assertWithAI` against the slim build →
  fails with a clear "AI assertions not built into this binary" error, not a
  crash.

### What the user sees after Phase 5

Default `skeptic-cli` continues to ship everything. Future slim builds (e.g.,
`skeptic-cli-slim` for CI users who don't need AI) become possible.

**Effort: 1 day.**

---

## Phase 6 — Single-binary distribution via Node SEA + macOS signing

**Goal**: produce signed `skeptic-darwin-arm64`, `skeptic-darwin-x64`, `skeptic-linux-x64`,
`skeptic-linux-arm64`, `skeptic-windows-x64.exe` from a CI matrix on tag push. Upload to
GitHub Releases.

**Why sixth**: depends on Phase 1 (bundle), Phase 5 (feature-aware build is in place
for slim variants later). User has confirmed Apple Developer cert is available.

**Critical SEA constraints (verified against Node SEA docs + commits)**:

- **`mainFormat: "module"` requires Node 25.5+.** Default is `commonjs`. skeptic
  bundles to `dist/skeptic.mjs` (ESM), so this is mandatory. ESM SEA support
  landed in Node commit `2d874df` (Feb 2026, available in v25.5+). **Node 24
  SEA only supports CommonJS** — Phase 6/7 jobs must therefore use Node 25.5+,
  not Node 24 as initially drafted.
- **`useCodeCache: true` was incompatible with `mainFormat: "module"`** until
  Node commit `9ff27fd` (March 25 2026). Be conservative: set
  `useCodeCache: false` initially and only flip when the Phase 6.0 spike
  proves it works on the target Node version.
- **Dynamic `import()` from filesystem is blocked in SEA** (Node PR #62771
  open, not merged). With tsup `splitting: false`, esbuild inlines dynamic
  imports into the same bundle, so `await import("./commands/init.js")`
  resolves to in-bundle code rather than a filesystem path. The Phase 6.0
  spike verifies this.
- **CRITICAL: `import` and `require` of *external* modules from filesystem
  are blocked in SEA.** Per Node SEA docs, the injected main script's
  `import`/`require` resolves only built-ins by default. This is the showstopper
  for the "sibling `node_modules/`" strategy without explicit work.

  Per the canonical external matrix above, exactly four packages remain
  external in SEA: `playwright`, `playwright-core`, `better-sqlite3`,
  `oxc-resolver`. All other previously-external packages (MCP SDK, ACP SDK,
  axe-core/playwright) are now bundled — their value imports become
  in-bundle references and don't need `requireExternal`.

  **Exhaustive list of external value-import sites that need SEA-aware
  conversion** (every site below must be converted before the SEA spike
  declares success):

  - **`playwright` / `playwright-core`**:
    - `cli/src/executor/playwright-engine.ts:3` — `chromium, firefox, webkit`
      (the **main test execution path**; missing this breaks `skeptic test`).
    - `cli/src/commands/record-session.ts:4` — `chromium`.
    - `cli/src/cookies/extractor.ts:3` — `BrowserContext` (type only —
      erased, fine).
    - `cli/src/commands/browsers-install.ts` (NEW for Phase 6, see step 4
      below) — uses `playwright-core/lib/server`'s
      `registry.install` + `registry.installDeps` (mirrors the CLI flow).
  - **`better-sqlite3`**: `cli/src/cookies/{chromium,firefox}.ts:4` —
    `Database` default import.
  - **`oxc-resolver`**: verified static value import at
    `cli/src/ai/coverage/import-graph.ts:5`. Convert to SEA-aware
    `requireExternal("oxc-resolver")` pattern (same shape as the playwright
    conversions). The Phase 1 tsup config already keeps `oxc-resolver`
    external, so the sidecar `node_modules/` ships it; the runtime only needs
    the SEA-aware accessor.

  **Special case — `web-vitals.iife.js`**: verified at
  `performance-collector.ts:14-25`, this file is read from disk via
  `createRequire("web-vitals")` + sibling-file read, then injected into the
  page. In SEA, both the createRequire-to-filesystem AND the file read fail.
  Cleanest path: **embed `web-vitals.iife.js` as a SEA asset** (it's a
  static file we inject into the page, not a JS module we import in our
  process). Add to `sea-config.json` `assets`:
  ```json
  "web-vitals.iife.js": "node_modules/web-vitals/dist/web-vitals.iife.js"
  ```
  Update `performance-collector.ts` to use a 3-tier resolution: (1) if
  `isSea()`, read from SEA asset; (2) else, check for
  `dist/web-vitals.iife.js` sibling (Phase 1 onSuccess copies it there);
  (3) else, fall back to `createRequire("web-vitals/...")` (dev / source-tree
  mode). This works for the SEA binary AND the published npm JS-fallback
  AND local dev. **Add a JS-fallback smoke test for `assertPerformance`**
  in CI to catch regressions where the published tarball lacks
  `dist/web-vitals.iife.js`.

  **Solution**: in SEA mode, replace these static imports with a
  `module.createRequire()` bound to a known sibling `node_modules/` directory:
  ```ts
  // cli/src/utils/sea-require.ts (new)
  import { isSea } from "node:sea";
  import { createRequire } from "node:module";
  import { dirname, join } from "node:path";

  const seaRequire = isSea()
    ? createRequire(join(dirname(process.execPath), "node_modules/_pkg.js"))
    : null;

  export const requireExternal = <T>(specifier: string): T => {
    if (seaRequire) return seaRequire(specifier) as T;
    throw new Error(`requireExternal called outside SEA for ${specifier}`);
  };
  ```
  Then in each call site that imports an external, use a build-time check:
  ```ts
  // record-session.ts (SEA-aware version)
  let chromium: typeof import("playwright")["chromium"];
  if (isSea()) {
    chromium = requireExternal<typeof import("playwright")>("playwright").chromium;
  } else {
    ({ chromium } = await import("playwright"));
  }
  ```
  This is invasive — every external import site needs the same treatment.
  **The Phase 6.0 spike must validate this approach end-to-end** before Phase 6.1
  invests in CI. If the spike proves the createRequire pattern brittle, Phase 6
  flips to the **Phase 6 Fallback** path (bottom of this section).

### Phase 6.0 — SEA spike (BLOCKING for the rest of Phase 6)

Before committing to Phase 7's optional-dependency CI architecture, prove SEA
works end-to-end for skeptic's shape. **Do this as a stand-alone exploration PR
with no production wiring.** Use **Node 25.5+** (Node 24 only supports CJS SEA
which is incompatible with our ESM bundle).

1. Take the Phase 1 bundle output as input.
2. Write a minimal `sea-config.json` with `mainFormat: "module"`,
   `useCodeCache: false`, two test assets.
3. Implement `cli/src/utils/sea-require.ts` per the constraint section above.
4. Convert **ALL** external value-import sites listed in the constraint
   section to the SEA-aware `requireExternal` pattern. Single sweep —
   partial conversion will hit runtime errors as soon as a non-converted
   path executes:
   - `cli/src/executor/playwright-engine.ts:3` (the **primary** path —
     `chromium`/`firefox`/`webkit` are mandatory for `skeptic test`).
   - `cli/src/commands/record-session.ts:4` (`chromium` for `skeptic record`).
   - `cli/src/cookies/chromium.ts:4` (`Database` for `skeptic --cookies`).
   - `cli/src/cookies/firefox.ts:4` (`Database` for `skeptic --cookies`).
   - `cli/src/commands/browsers-install.ts` (NEW from step 4 of Phase 6.1 —
     `playwright-core/lib/server` for `skeptic browsers install`).
   - **`cli/src/ai/coverage/import-graph.ts:5`** — verified static value
     import of `oxc-resolver`. Same `requireExternal` treatment.
5. Build an SEA binary on macOS, Linux, Windows. Run:
   - `skeptic --version` — verify the build-time `__SKEPTIC_CLI_VERSION__`
     constant is baked in and printed.
   - `skeptic init /tmp/x` — verifies template asset extraction via
     `node:sea.getAsset`.
   - **`skeptic test path/to/fixture.flow.yaml`** — verifies the `chromium` /
     `firefox` / `webkit` `requireExternal("playwright")` pattern in
     `playwright-engine.ts` works. **This is the primary success criterion.**
   - `skeptic record /tmp/r.yaml` — verifies the recorder-script SEA extraction.
   - Verify `await import()` calls inside the bundled output resolve correctly
     (in-bundle inlined references, not filesystem paths).
6. **Decision point**:
   - **If `requireExternal` works for all four canonical externals**
     (`playwright`, `playwright-core`, `better-sqlite3`, `oxc-resolver`) →
     proceed with Phase 6.1 below.
   - **If anything breaks** → flip to **Phase 6 Fallback** (no SEA, ship a
     "fat tarball" instead).

### Phase 6 Fallback (if SEA doesn't pan out in 6.0)

Skip Node SEA entirely. Ship a **fat tarball** distribution that's still a
"single download" for users:

- `skeptic-darwin-arm64.tar.gz` containing:
  - A small `skeptic` shell script (or `skeptic.cmd` for Windows) that runs
    `node ./cli.mjs "$@"`
  - `cli.mjs` (the bundled output)
  - `node_modules/` with the canonical four externals: `playwright`,
    `playwright-core`, `better-sqlite3`, `oxc-resolver`. (MCP/ACP SDKs and
    `@axe-core/playwright` are bundled into `cli.mjs`.)
  - `templates/`, `recorder-script.js`, **`web-vitals.iife.js`** (copied from
    `node_modules/web-vitals/dist/`). The fallback's
    `performance-collector.ts` reads it as a sibling asset via the same
    helper used in SEA mode, so `assertPerformance` works in both
    distributions. Fallback smoke test must include an `assertPerformance`
    flow to catch regressions.
  - `node` binary itself (~80 MB) — copied from the build matrix's Node 25.5+
    install, eliminating the user's "install Node" requirement
- `xattr/codesign/notarize` paths apply to `node` as the actual signed
  artifact (it's already signed by Node.js project — re-sign if necessary
  after copy).

This is what `pkg` and `nexe` do under the hood. It's larger (~110 MB) but
**works today** without any SEA constraint debugging. Trade-off: the user
sees `node` running in process listings rather than `skeptic`. Acceptable for v1.

If Phase 6.0 succeeds, this fallback is deferred. If it fails, Phase 6.1
becomes "fat tarball" instead of SEA, and Phase 7 packages the tarball
contents into npm `skeptic-cli-bin-<plat>` packages just the same.

### Phase 6.1 — Production SEA build

1. Create `cli/sea-config.json`. **Note**: on Node 25.5+, `output` in the
   config is the **final binary path**, not a preparation blob (Codex Round 3
   correction confirmed via Node 25 docs). The legacy
   `--experimental-sea-config` flow used a blob; that's a different code path.
   Phase 6.1 commits to Node 25.5+ and skips the legacy postject path entirely:
   ```json
   {
     "main": "dist/skeptic.mjs",
     "output": "dist/skeptic",
     "mainFormat": "module",
     "disableExperimentalSEAWarning": true,
     "useSnapshot": false,
     "useCodeCache": false,
     "assets": {
       "templates/skeptic.config.yaml": "dist/templates/skeptic.config.yaml",
       "templates/example.flow.yaml": "dist/templates/example.flow.yaml",
       "templates/relational-selectors.flow.yaml": "dist/templates/relational-selectors.flow.yaml",
       "recorder-script.js": "dist/recorder-script.js",
       "web-vitals.iife.js": "node_modules/web-vitals/dist/web-vitals.iife.js"
     }
   }
   ```
   Generate the full `assets` map programmatically via a small
   `scripts/gen-sea-config.mjs` that walks `dist/templates/**` (handles all
   `guidance/*.md` files) AND adds `web-vitals.iife.js` from
   `node_modules/web-vitals/dist/`. `useCodeCache` defaults to `false` until Phase 6.0
   confirms the Node version supports `useCodeCache: true` with
   `mainFormat: "module"` (commit `9ff27fd`, March 2026, may not be in stable
   Node 25.5 release; flip if available).

2. Create `cli/scripts/build-sea.sh`:
   - Accept `--out` (the final binary path) and reads platform from `uname`.
   - **Path-robust invocation** — derive directories from the script's own
     location:
     ```sh
     SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
     CLI_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
     ```
   - **Generate a temp config with ABSOLUTE paths**. Node SEA docs state that
     non-absolute paths inside the config are resolved relative to the current
     working directory (NOT relative to the config file). To make
     `build-sea.sh` cwd-agnostic, `scripts/gen-sea-config.mjs` writes a
     `dist/sea-config.absolute.json` with absolute `main`, `output`, and every
     `assets` value. The tracked `cli/sea-config.json` (relative paths) stays
     readable for humans; the absolute version is generated at build time:
     ```sh
     node "$CLI_DIR/scripts/gen-sea-config.mjs" \
       --base "$CLI_DIR" \
       --output "$OUT" \
       > "$CLI_DIR/dist/sea-config.absolute.json"
     ```
   - **Single-step Node 25.5+ build**:
     ```sh
     node --build-sea "$CLI_DIR/dist/sea-config.absolute.json"
     ```
     This emits the final binary at `$OUT`. No `--experimental-sea-config`,
     no `postject`, no manual blob handling. **Critical**: this path requires
     Node 25.5+; CI must pin `actions/setup-node@v4` with `node-version: '25.5'`
     or higher.
   - macOS only: `codesign --remove-signature "$OUT"` before re-signing (the
     `node --build-sea` output may inherit Node's own signature, which must be
     stripped before our codesign).
   - **No legacy postject path** for the ESM SEA build. If a future requirement
     forces Node 24 (CJS-only SEA), that becomes a separate, parallel
     `build-sea-cjs.sh` script using a CJS-bundled output. Out of scope for v1.

3. Update `cli/src/utils/asset-path.ts` to consume SEA assets when running inside
   a SEA binary:
   ```ts
   import { isSea, getAsset } from "node:sea";
   export const readTemplate = (relPath: string): Buffer => {
     if (isSea()) {
       const blob = getAsset(`templates/${relPath}`);
       return Buffer.from(blob);
     }
     return readFileSync(path.join(getTemplatesDir(), relPath));
   };
   ```
   - Update `cli/src/commands/init.ts` to use `readTemplate` instead of
     `fs.copyFileSync(path.join(TEMPLATES_DIR, ...), dest)` →
     `fs.writeFileSync(dest, readTemplate(...))`.
   - Update `cli/src/ai/guidance-loader.ts` similarly.
   - For the recorder script, in SEA mode extract once per process to a
     **secure private temp directory** (Codex security correction: avoid
     predictable `skeptic-recorder-${pid}.js` paths in shared `os.tmpdir()`):
     ```ts
     // record-session.ts
     let cachedRecorderPath: string | null = null;
     export const getRecorderScriptPath = async (): Promise<string> => {
       if (isSea()) {
         if (cachedRecorderPath) return cachedRecorderPath;
         const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skeptic-rec-"));
         const filePath = path.join(dir, "recorder-script.js");
         const data = Buffer.from(getAsset("recorder-script.js"));
         await fs.writeFile(filePath, data, { mode: 0o600 });
         cachedRecorderPath = filePath;
         // Best-effort cleanup on exit
         process.on("exit", () => {
           try { rmSync(dir, { recursive: true, force: true }); } catch {}
         });
         return filePath;
       }
       return getRecorderScript();
     };
     ```
     `fs.mkdtemp` creates a uniquely-named private directory (mode 0700 by
     default on POSIX), eliminating the predictable-path pre-creation attack.

4. **Playwright browser binaries**: explicitly NOT embedded. **No-Node users
   can't run `npx playwright install`**, so skeptic exposes its own subcommand
   that runs Playwright's installer logic through `playwright-core`'s exported
   server API (in the sidecar `node_modules/`).
   - Add `skeptic browsers install [--with-deps] [chromium|firefox|webkit|all]`
     to `cli/src/index.ts`. New file `cli/src/commands/browsers-install.ts`
     uses **`playwright-core/lib/server`** (a documented export, verified at
     `cli/node_modules/playwright-core/package.json` exports `./lib/server`)
     and calls `registry.install(executables, { force })`; for `--with-deps`,
     calls `registry.installDeps(executables, dryRun)` BEFORE `install` (mirrors
     the CLI flow at `installActions.js:123`). **In SEA mode**, this
     resolves via `requireExternal("playwright-core/lib/server")` because
     dynamic `import()` from filesystem is blocked in SEA.
     ```ts
     // cli/src/commands/browsers-install.ts (sketch)
     import { isSea } from "node:sea";
     export const runBrowsersInstall = async (
       args: string[], opts: { withDeps?: boolean; dryRun?: boolean }
     ) => {
       const server = isSea()
         ? requireExternal<typeof import("playwright-core/lib/server")>(
             "playwright-core/lib/server")
         : await import("playwright-core/lib/server");
       // Mirror the playwright CLI install flow exactly. Order matters:
       //  1. resolveBrowsers → Executable[]
       //  2. installDeps (only if --with-deps) — host packages BEFORE binaries
       //  3. registry.install(executables, { force }) — actual download
       //  4. validateHostRequirementsForExecutablesIfNeeded — best-effort warn
       // resolveBrowsers does not special-case "all" — empty array means
       // "install defaults" per registry/index.js. Normalize before passing.
       const normalizedArgs = args.includes("all") ? [] : args;
       const executables = server.registry.resolveBrowsers(normalizedArgs, {});
       if (opts.withDeps) {
         await server.registry.installDeps(executables, !!opts.dryRun);
       }
       await server.registry.install(executables, { force: false });
       try {
         await server.registry.validateHostRequirementsForExecutablesIfNeeded(
           executables, "javascript"
         );
       } catch (e) {
         (e as Error).name = "Playwright Host validation warning";
         console.error(e);
       }
     };
     ```
     Verified against `playwright-core/lib/server/registry/index.js:979`
     (the `install(executables, { force })` signature) and
     `lib/cli/installActions.js:119-148` (the CLI's call pattern: deps →
     install → validate). Do NOT call `installBrowsersForNpmInstall` — it's a
     different code path with different shape.
     The wrong path `playwright/lib/cli/cli.js` is NOT a public export —
     verified by reading `playwright/package.json` exports. Use
     `playwright-core/lib/server` instead.
   - Add `cli/src/utils/playwright-precheck.ts`: on first invocation of any
     command that needs a browser (`test`, `record` — **NOT `audit`**;
     verified at `audit.ts:8` that `runAudit` only runs package quality
     scripts and doesn't launch a browser), check
     `~/.cache/ms-playwright` (or platform equivalent via
     `playwright-core/lib/server`'s `registry`). If missing, print:
     ```
     skeptic needs Playwright browsers (one-time, ~300 MB).
     Run: skeptic browsers install chromium

     For automated/CI use:
     PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/skeptic-browsers skeptic browsers install chromium
     ```
     and exit code 2.
   - For users who already have Node + npm, `npx playwright install chromium`
     remains a working synonym (it does the same thing). Document as
     optional, not primary.
   - **Update `cli/src/commands/init.ts:49`**: it currently shells out to
     `npx playwright install --with-deps chromium`. Replace with a call to
     the new `runBrowsersInstall` function (or its core helper that doesn't
     re-spawn a process). On the no-Node binary install path, this avoids
     the `npx` requirement. Wrap in try/catch so the `init` command still
     succeeds end-to-end if the browser install fails (current behavior).
     Update the warning text from `Run manually: npx playwright install ...`
     to `Run manually: skeptic browsers install chromium`.
   - Document this in `README.md` "Installation" section.

5. **External modules in SEA**: After Phase 1's matrix refinement, tsup marks
   only `playwright`, `playwright-core`, `better-sqlite3`, `oxc-resolver` as
   external. The SEA binary's sibling `node_modules/` ships with these and
   only these. Pure-JS MCP/ACP SDKs + axe-core/playwright are in-bundle —
   no SEA conversion needed for them, no sidecar entry.

   Distribution becomes a small tarball (`skeptic-darwin-arm64.tar.gz`)
   containing the binary + a tightly-scoped `node_modules/` with ~4 packages
   (~25 MB unpacked). Still orders of magnitude smaller than shipping
   Playwright's browser binaries. Document this in the install instructions.

6. **`better-sqlite3` `.node` binding** in SEA: feature-flag gating from Phase 5
   handles the slim case (binary ships without cookie support). For default
   (full) binary builds, the static value imports at `cookies/{chromium,firefox}.ts:4`
   must use the SEA-aware pattern (consistent with Phase 6.0 step 4):
   ```ts
   // cli/src/cookies/chromium.ts (SEA-aware)
   import { isSea } from "node:sea";
   let Database: typeof import("better-sqlite3").default;
   try {
     Database = isSea()
       ? requireExternal<typeof import("better-sqlite3")>("better-sqlite3").default
       : (await import("better-sqlite3")).default;
   } catch {
     console.error("Cookie extraction unavailable: better-sqlite3 not loadable.");
     process.exit(2);
   }
   ```
   The dynamic `await import()` path applies to non-SEA (npm install)
   distribution. The SEA path uses `requireExternal` because dynamic
   `import()` from filesystem is blocked in SEA. The `try/catch` covers
   ABI-mismatch crashes on either path.
   - Document in README that `--cookies` requires the sidecar `node_modules/`
     to contain a `better-sqlite3` build that's ABI-compatible with the SEA
     binary's bundled Node version. CI builds cover this; manually-rebuilt
     binaries may need attention.

7. macOS signing + notarization. Two scope considerations:

   **a) Sign the SEA binary itself**:
   ```sh
   codesign --force --options runtime --timestamp \
     --sign "$APPLE_DEVELOPER_ID" "$OUT"
   ```

   **b) Sign native `.node` addons in the sidecar `node_modules/`**. macOS
   Hardened Runtime enforces library validation: any dynamically-loaded
   `.node` (e.g., `better-sqlite3.node` in the sidecar) must be either
   Apple-signed, signed by the same Team ID as the loading executable, or
   the loader must have the `com.apple.security.cs.disable-library-validation`
   entitlement. Otherwise `Database` import crashes on macOS at first use of
   `--cookies`.

   Two paths:
   - **(Recommended)** Sign every `.node` in the sidecar with the same
     Developer ID:
     ```sh
     find cli-bin-darwin-arm64/node_modules -name "*.node" | while read f; do
       codesign --force --options runtime --timestamp --sign "$APPLE_DEVELOPER_ID" "$f"
     done
     ```
   - **(Alternative)** Add the disable-library-validation entitlement to
     the SEA binary's `codesign` invocation via an entitlements plist.
     Less safe but simpler. Document the trade-off.

   **c) Zip + notarize**. **`notarytool submit` rejects raw binaries — it
   only accepts UDIF disk images, signed flat installer packages, or zip
   files.** Zip the entire `cli-bin-darwin-arm64/` directory (binary +
   sidecar) so notarization covers both:
   ```sh
   # Zip directory containing binary + signed sidecar
   ditto -c -k --keepParent cli-bin-darwin-arm64 cli-bin-darwin-arm64.zip

   xcrun notarytool submit cli-bin-darwin-arm64.zip \
     --apple-id "$APPLE_ID" \
     --team-id "$APPLE_TEAM_ID" \
     --password "$APPLE_APP_PASSWORD" \
     --wait

   # Stapler does NOT work on raw binaries (only .app/.dmg/.pkg).
   # Notarization ticket lives on Apple servers; Gatekeeper fetches at
   # first run. Document that the tarball ships unstapled and requires
   # internet on first launch for Gatekeeper validation.
   ```

   **d) Smoke-test `--cookies` on a signed/notarized macOS build** before
   declaring the release ready. A `--cookies` flow that fails to load
   `better-sqlite3.node` is the canonical missed-signing symptom.

8. **Equal Access (`accessibility-checker-engine`) — degraded in binary
   builds**. The optional IBM Equal Access path resolves
   `accessibility-checker-engine/ace.js` via
   `createRequire(import.meta.url)` at
   `cli/src/observability/collectors/accessibility-collector.ts:238`. In SEA
   ESM, `import.meta.url` points at the executable, and filesystem
   `import()` is constrained, so the binary will always degrade to
   axe-only even if the user has the npm peer installed. **Document this as
   a known limitation of the binary distribution**: users who need IBM
   Equal Access should use the npm install path. Adding sidecar resolution
   for an optional peer adds complexity for a small audience; defer.

9. Add Windows code-signing only if a cert is available later. Document the
   "Windows SmartScreen → click More info → Run anyway" workaround for
   unsigned builds in v1.

### Risks & mitigations

- **macOS arm64 SEA needs an arm64 Node**: `setup-node` on `macos-14` provides this;
  validate in CI before declaring complete.
- **Notarization can take 5-15 min** per binary: parallel-submit and `--wait`.
- **Binary size** ~80-110 MB per platform (Node runtime is the bulk). Acceptable
  for a dev tool.
- **SEA + better-sqlite3**: native bindings can't be embedded directly. Gating
  via feature flag in Phase 5 + dynamic-import + clean error handles this.
- **First-run Playwright install UX**: a clear, copy-paste-able instruction is the
  cheapest fix. Don't try to embed Playwright's installer logic.

### Verification

- Phase 6.0 spike validates: ESM SEA works, dynamic imports inside the bundle
  resolve, externals load from sibling `node_modules/`, asset extraction works.
- Local: `bash cli/scripts/build-sea.sh --out=/tmp/skeptic-test` (platform from
  `uname`).
- `/tmp/skeptic-test --version` prints `0.1.0` from the build-time `define`.
- `/tmp/skeptic-test init /tmp/skeptic-init` produces a valid project (templates
  extracted from SEA blob).
- `/tmp/skeptic-test test` against a known fixture, with `playwright` +
  `better-sqlite3` available next to the binary in `node_modules/` and browsers
  pre-installed, passes.
- `/tmp/skeptic-test test` without browsers prints the friendly precheck error.
- macOS: signed binary in zipped form passes `notarytool submit --wait`. Tarball
  containing binary + `node_modules/` opens without Gatekeeper dialog on a
  fresh user account (first run requires internet for ticket fetch).
- Confirm that the recorder script extraction creates a fresh
  `skeptic-rec-XXXXXX/` directory each process and cleans up on exit.

### What the user sees after Phase 6

Local builds produce a tarball (`skeptic-darwin-arm64.tar.gz` ≈ ~110 MB
containing the Node-SEA binary and a small `node_modules/` with `playwright`
+ `better-sqlite3`). A developer can hand the tarball to a colleague who
extracts it and runs `./skeptic --version` without Node installed. First-run
browser install is `./skeptic browsers install chromium` (uses the binary's
own bundled Playwright; no Node/npx needed).

**Effort: 3-4 days** (revised up from 2-3 to account for Phase 6.0 spike and
the sibling `node_modules` packaging).

---

## Phase 7 — npm `optionalDependencies` per-platform packages + CI matrix

**Goal**: `npm i -g skeptic-cli` is the **primary** distribution — it
automatically downloads the matching platform binary via
`optionalDependencies`. Direct binary downloads (GitHub Releases / Homebrew)
are a secondary path for users without Node or who want zero launcher
overhead. GitHub Actions builds, signs, and publishes everything on tag push;
the binaries used by npm bin packages and the binaries on Releases are the
same artifacts.

**Scope of cold-start improvement** (honest about the npm path's overhead):
- **Direct binary** (GitHub Releases, Homebrew): no Node launcher; binary
  starts directly. `skeptic --version` cold ~30-50 ms (Node SEA process startup
  + version fast-path).
- **npm-installed**: `skeptic` resolves to `bin/launcher.mjs`, a tiny Node
  script that `spawnSync`s the platform binary. This adds Node's own
  startup (~50-90 ms typical) on top of the binary's startup. **Total npm
  cold start ~80-140 ms**, still much better than today's ~250 ms but NOT
  the same as direct-binary speed.
- For npm users who want zero launcher overhead, document that they can use
  the GitHub Release binary or Homebrew tap directly. Removing the launcher
  entirely would require a postinstall script that mutates `node_modules/.bin`
  symlinks to point at the platform binary directly — possible but
  npm-tooling-fragile (some CI setups, frozen lockfiles, and Yarn PnP
  break). Defer that optimization.

**Why seventh**: depends on Phase 6 (binaries exist and are signed). This is the
"one-touch release" capstone.

### Steps

1. **Per-platform npm packages**: create five sibling packages alongside `cli/`:
   - `cli-bin-darwin-arm64/`
   - `cli-bin-darwin-x64/`
   - `cli-bin-linux-x64/`
   - `cli-bin-linux-arm64/`
   - `cli-bin-win32-x64/`

   Each contains:
   - `package.json` with `"name": "skeptic-cli-bin-<platform>"`, version matching
     `skeptic-cli`, `os` and `cpu` filters, `bin` field pointing at the embedded
     binary, and `dependencies` + `bundleDependencies` for the canonical four
     externals so the sidecar `node_modules/` ships inside the npm tarball
     (especially critical for `better-sqlite3` whose native binding must be
     built against the SEA Node version, not the user's Node).

     **Critical — version pinning**: `bundleDependencies` packages exact
     declared versions. The plan must NOT use placeholder semver ranges that
     diverge from the version actually built and tested. Generate each
     bin-package's `dependencies` by reading the resolved versions from
     `cli/package-lock.json` at CI time (a small `scripts/gen-bin-package.mjs`
     does this). At time of writing the lockfile resolves
     `playwright@1.59.1`, but that floats with `^1.52.0` in the root — pin
     the root to an exact version when shipping bin packages OR derive from
     the lockfile, NEVER hardcode in the plan.

     Example shape (illustrative — actual versions come from the lockfile):
     ```json
     {
       "name": "skeptic-cli-bin-darwin-arm64",
       "version": "0.1.0",
       "os": ["darwin"],
       "cpu": ["arm64"],
       "bin": { "skeptic-bin": "./skeptic" },
       "dependencies": {
         "playwright": "<resolved-from-lockfile>",
         "playwright-core": "<resolved-from-lockfile>",
         "better-sqlite3": "<resolved-from-lockfile>",
         "oxc-resolver": "<resolved-from-lockfile>"
       },
       "bundleDependencies": [
         "playwright",
         "playwright-core",
         "better-sqlite3",
         "oxc-resolver"
       ]
     }
     ```
     Add `cli/scripts/gen-bin-package.mjs` to the Critical Files Index.
     Smoke-test job confirms the sidecar version matches what `skeptic test`
     was built against.
   - The platform's binary (filled in by CI before publish).
   - A pre-built `node_modules/` containing the four bundled deps (CI
     `npm install --omit=dev` in each bin package directory before
     `npm publish`).
   - A small `README.md`.

   This is the **same pattern esbuild, swc, turbo, biome use**. npm install picks
   exactly one based on host `os` and `cpu`. `bundleDependencies` is npm's
   documented mechanism for preserving `node_modules/` inside the packed
   tarball.

2. Update `cli/package.json`. **Critical — main-package dependency policy**:
   today's `cli/package.json` lists ~27 runtime dependencies. After Phase 1
   bundling, most are bundled into `dist/skeptic.mjs` and **must NOT remain
   declared dependencies** of the published main package (otherwise `npm i -g
   skeptic-cli` re-installs them globally and triggers user-Node native builds
   for `better-sqlite3` even though the prebuilt platform binary already
   ships its own sidecar):
   - **Move to `devDependencies`** all packages that are bundled per Phase 1
     (commander, zod, yaml, glob, chokidar, chalk, figures, cli-truncate,
     string-width, pretty-ms, minimatch, web-vitals, @google/generative-ai,
     @faker-js/faker, fast-xml-parser, pixelmatch, pngjs, react, ink,
     ink-spinner, @modelcontextprotocol/sdk, @agentclientprotocol/sdk,
     @axe-core/playwright). They're needed at build time but not at install
     time.
   - **Keep in `dependencies`** ONLY `playwright`, `playwright-core`, and
     `oxc-resolver` (three of the canonical four). `better-sqlite3` goes
     **only** to `optionalDependencies` (see next bullet). Putting it in
     both `dependencies` and `optionalDependencies` is contradictory; npm's
     `optionalDependencies` overrides duplicate `dependencies` entries.
   - **Decision**: should `better-sqlite3` be `optional` for the JS
     fallback? Recommendation: yes — declare it as `optionalDependencies`
     on the main package so users on platforms without a prebuilt binding
     can still install (cookies degrade with the existing `try/catch`
     gating from Phase 6.1 step 6). Document in README.

   Combined `cli/package.json` shape:
   ```json
   {
     "name": "skeptic-cli",
     "bin": { "skeptic": "./bin/launcher.mjs" },
     "files": ["dist", "bin/launcher.mjs", "templates", "README.md"],
     "dependencies": {
       "playwright": "<resolved>",
       "playwright-core": "<resolved>",
       "oxc-resolver": "<resolved>"
     },
     "optionalDependencies": {
       "better-sqlite3": "<resolved>",
       "skeptic-cli-bin-darwin-arm64": "0.1.0",
       "skeptic-cli-bin-darwin-x64": "0.1.0",
       "skeptic-cli-bin-linux-x64": "0.1.0",
       "skeptic-cli-bin-linux-arm64": "0.1.0",
       "skeptic-cli-bin-win32-x64": "0.1.0"
     },
     "devDependencies": {
       /* … all bundled packages moved here, plus existing dev deps … */
     }
   }
   ```
   Bump version of all packages (`cli` + 5x `cli-bin-*`) in lockstep at
   release time. The `npm pack --dry-run` assertion (step 4 below) verifies
   this layout.

3. **Add a separate published shim** at `cli/bin/launcher.mjs` (NEW; not
   processed by tsup — pure hand-written ESM). This file dispatches to the
   per-platform binary, falling back to the bundled JS if no binary is
   available:
   ```js
   #!/usr/bin/env node
   import { spawnSync } from "node:child_process";
   import { createRequire } from "node:module";
   import { fileURLToPath, pathToFileURL } from "node:url";
   import { dirname, join } from "node:path";

   const require = createRequire(import.meta.url);
   const platform = `${process.platform}-${process.arch}`;
   const pkgName = `skeptic-cli-bin-${platform}`;

   try {
     const binName = process.platform === "win32" ? "skeptic.exe" : "skeptic";
     const binPath = require.resolve(`${pkgName}/${binName}`);
     const result = spawnSync(binPath, process.argv.slice(2), { stdio: "inherit" });
     process.exit(result.status ?? 1);
   } catch {
     // No platform binary available. Fall back to the bundled JS.
     // On Windows, ESM import() rejects raw `C:\...` paths — must convert
     // to a file:// URL first.
     const here = dirname(fileURLToPath(import.meta.url));
     const fallback = join(here, "..", "dist", "skeptic.mjs");
     await import(pathToFileURL(fallback).href);
   }
   ```
   - `bin/launcher.mjs` is **separate** from `bin/skeptic.ts` (the tsup runtime
     entry which becomes the bundled JS at `dist/skeptic.mjs`). The launcher
     and the bundled JS are two distinct files. The launcher imports the
     bundle as a fallback; it does NOT recurse into itself.

4. Update `cli/package.json`:
   ```json
   "bin": { "skeptic": "./bin/launcher.mjs" },
   "files": ["dist", "bin/launcher.mjs", "templates", "README.md"],
   ```
   - **Critical**: add `bin/launcher.mjs` to `files` (current `files` is
     `["dist", "templates", "README.md"]` — verified at `package.json:20-24`),
     otherwise the launcher won't be in the published tarball and the `bin`
     entry will be broken.
   - Add `npm pack --dry-run` assertion to CI: confirm `bin/launcher.mjs` and
     `dist/skeptic.mjs` both appear in the listed files.
   - The `optionalDependencies` block remains as in step 2.

5. **Create `.github/workflows/release.yml`**. Repo root has no `package.json`
   — every npm step needs `working-directory: cli`:
   - Trigger: `on: push: tags: ['v*']`.
   - Jobs:
     1. **`bundle`** (single, ubuntu-22.04): checkout → setup Node **25.5**
        (required for ESM SEA; Node 24 only supports CJS SEA which is
        incompatible with our ESM bundle).
        **Bump versions BEFORE build** (critical — the build bakes
        `__SKEPTIC_CLI_VERSION__` from `package.json`):
        ```sh
        cd cli
        npm version --no-git-tag-version "${GITHUB_REF_NAME#v}"
        # Also bump every cli-bin-*/package.json to the same version.
        for d in ../cli-bin-*; do
          (cd "$d" && npm version --no-git-tag-version "${GITHUB_REF_NAME#v}")
        done
        npm ci && npm run build
        ```
        Upload `cli/dist/` as artifact. Add `npm pack --dry-run` to validate
        the published layout before binary builds. **Assert** `node
        cli/dist/skeptic.mjs --version` outputs `${GITHUB_REF_NAME#v}` before
        the artifact is uploaded (catches version-stamping regressions).
     2. **`binary-build`** (matrix: macos-14 [arm64], macos-13 [x64],
        ubuntu-22.04 [x64], ubuntu-22.04-arm [arm64], windows-2022 [x64]).
        **All steps in this job set `shell: bash`** because the Windows
        runner's default shell is `pwsh`, which doesn't understand the POSIX
        `BIN_NAME=` and `bash scripts/...` invocations below. `bash` is
        available on all GitHub-hosted runners (Git Bash on Windows):
        - Download bundle artifact into `cli/dist/`.
        - Setup Node **25.5+** for SEA build (or 22+ if Phase 6.0 picked the
          fat-tarball fallback path).
        - **Run `npm ci` in `cli/`** so `gen-sea-config.mjs` can find
          `node_modules/web-vitals/dist/web-vitals.iife.js`. Alternative:
          have the `bundle` job copy `web-vitals.iife.js` into `cli/dist/`
          at the end and source it from there in `gen-sea-config.mjs`. Pick
          the npm-ci path; it's simpler.
        - In `cli/`:
          - Compute platform-specific binary name:
            ```sh
            BIN_NAME="skeptic"
            [ "$RUNNER_OS" = "Windows" ] && BIN_NAME="skeptic.exe"
            ```
          - **If Phase 6.0 spike succeeded with SEA**:
            `bash scripts/build-sea.sh --out=../cli-bin-<plat>/$BIN_NAME`
          - **If using fat-tarball fallback**:
            `bash scripts/build-tarball.sh --out=../cli-bin-<plat>/`
            (script handles platform: emits `skeptic.exe` + `skeptic.cmd` shim
            on Windows, `skeptic` shell script elsewhere).
        - Smoke tests, tarball contents, and the launcher's `binName`
          resolution all use the same `skeptic` / `skeptic.exe` convention.
        - Stage `node_modules/` with the canonical four externals: `playwright`,
          `playwright-core`, `better-sqlite3`, `oxc-resolver`. (MCP/ACP SDKs
          and `@axe-core/playwright` are bundled into the binary, not staged
          here.)
        - macOS: full signing pipeline:
          - `codesign` the SEA binary (or `node` in fat-tarball) with
            Hardened Runtime + Developer ID + timestamp.
          - **`codesign` every `.node` in the sidecar** (see Phase 6.1
            step 7b):
            ```sh
            find ../cli-bin-<plat>/node_modules -name "*.node" | \
              while read f; do
                codesign --force --options runtime --timestamp \
                  --sign "$APPLE_DEVELOPER_ID" "$f"
              done
            ```
          - `ditto` the entire `cli-bin-<plat>/` to a `.zip`.
          - `notarytool submit … --wait`.
        - Tarball: `tar -czf skeptic-<plat>.tar.gz cli-bin-<plat>/`.
        - Upload tarball + raw binary as artifacts.
     3. **`smoke-test`** (depends on `binary-build`, runs per platform on
        a clean runner with no global Node):
        - Extract tarball.
        - **`skeptic --version`** — verifies binary launches and the SEA blob
          loads.
        - **`skeptic init /tmp/skeptic-init`** — verifies template extraction.
        - **`skeptic browsers install chromium`** — verifies sidecar
          `playwright-core` loads via `requireExternal` AND the install
          actually completes against `~/.cache/ms-playwright`.
        - **`skeptic test /tmp/skeptic-init/tests/example.flow.yaml`** — minimal
          end-to-end test against a fixture; verifies sidecar
          `playwright`/`better-sqlite3` load, asset extraction, and engine
          dispatch.
        - **macOS only**: rerun the above against the signed/notarized
          binary, plus `skeptic test --cookies` to verify the signed `.node`
          (better-sqlite3) loads under Hardened Runtime.
        - Failing any of these blocks the publish job below.
     4. **`publish-tarball-to-tarball-registry`** (depends on `smoke-test`):
        - Place each tarball at `cli-bin-<plat>/` ready for npm publish.
        - Each `cli-bin-<plat>/package.json` references its own bin via the
          extracted-tarball layout (i.e., the npm package contains the
          tarball OR contains the pre-extracted `skeptic` + `node_modules/`;
          pick the latter for simpler `bin` resolution at install time).
     5. **`install-from-tarball-test`**: on a clean runner, run a **local
        Verdaccio registry** (or pack all packages and chain-install with
        `--install-strategy=hoisted`) so the platform-specific
        `skeptic-cli-bin-*` is actually resolved as an `optionalDependencies`
        match. Steps:
        ```sh
        # 1. Pack every package
        ( cd cli && npm pack )
        for d in cli-bin-*; do (cd "$d" && npm pack); done

        # 2. Spin up Verdaccio + publish all tarballs to it
        npx verdaccio &
        npm set registry http://localhost:4873
        for tgz in cli/*.tgz cli-bin-*/*.tgz; do
          npm publish --registry http://localhost:4873 "$tgz"
        done

        # 3. Install from local registry, verify launcher routes to binary
        npm i -g skeptic-cli --registry http://localhost:4873
        # On macOS arm64, this should pull skeptic-cli-bin-darwin-arm64.
        which skeptic && skeptic --version
        # Confirm it ran the binary, not the JS fallback (check output or
        # presence of platform-specific node_modules/skeptic-cli-bin-*).
        ```
        Without this, the test installing only the main tarball would always
        fall back to JS and we'd never catch a bin-package regression.
     6. **`publish`** (depends on `install-from-tarball-test`):
        - Bump versions in each `package.json` to match the tag.
        - `npm publish` each `cli-bin-*` package (with `--access public`).
        - `cd cli && npm publish` (the main package which references the
          published optional deps).
        - `gh release create $TAG cli-bin-*/skeptic-*.tar.gz` with checksums.

6. **Create `.github/workflows/ci.yml`** (PR + main). Same `working-directory: cli`
   constraint:
   - Matrix: `node: [22, 24]`, `os: [macos-14, ubuntu-22.04, windows-2022]`.
   - All steps run in `cli/`: `npm ci` → `npm run check` → `npm run build` →
     `npm test`.
   - Cache `~/.cache/ms-playwright` between runs for the integration tests that
     launch real Chromium.

7. **Required GitHub secrets**:
   - `NPM_TOKEN` (for `npm publish`).
   - `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`, `APPLE_DEVELOPER_ID_CERT_BASE64`,
     `APPLE_DEVELOPER_ID_CERT_PASSWORD` (for sign + notarize).
   - Document setup steps in `cli/RELEASING.md`.

### Risks & mitigations

- **`optionalDependencies` semantics on offline / corporate registries**: warnings
  print but install succeeds; the JS fallback in the shim covers it. Test in a
  registry-pinned environment before declaring done.
- **Symlink on Windows**: npm handles `bin` field cross-platform; the shim
  pattern avoids the manual symlink dance.
- **Version drift between cli and cli-bin packages**: a single `npm version` from
  the root with a workspace orchestration script keeps them lockstep.
- **macOS notarization can fail intermittently**: retry once on `notarytool`
  errors before failing the job.
- **First user install on an unlisted platform** (e.g., FreeBSD): falls back to JS
  bundle. Document supported platforms.

### Verification

- Tag a pre-release: `git tag v0.2.0-rc.1 && git push --tags`.
- Watch the workflow: bundle → 5x sea-build → 5x sign → publish.
- Validate Releases page has 5 binaries + checksums.
- `npm dist-tag add skeptic-cli@0.2.0-rc.1 next` so prod isn't affected.
- Test install: `npm i -g skeptic-cli@next` on macOS arm64 → `which skeptic` resolves
  via the launcher shim, which spawns the binary from
  `skeptic-cli-bin-darwin-arm64/skeptic`. `skeptic --version` prints `0.2.0-rc.1`
  in ~80-140 ms (npm-launcher path).
- Direct download (Homebrew or `gh release download`): `./skeptic --version`
  in ~30-50 ms (no launcher).
- Test fallback: install on a platform without a bin package → `skeptic --version`
  still works via the JS shim.

### What the user sees after Phase 7

`git tag v0.2.0 && git push --tags` → 12 minutes later, npm has the new
`skeptic-cli` package + 5 `skeptic-cli-bin-*` packages (the primary distribution),
GitHub Releases has the same 5 signed binaries + checksums as a secondary
download path, and Homebrew tap (when added) auto-bumps via formula PR.

Recommended install (the README leads with this):
```sh
npm install -g skeptic-cli
skeptic browsers install chromium  # one-time, ~300 MB Playwright browsers
skeptic init
```

Power-user path (no Node required):
```sh
# macOS
brew install iamjr15/tap/skeptic
# or any platform
gh release download --pattern 'skeptic-*.tar.gz' && tar -xzf skeptic-*.tar.gz
```

Cold start: ~30-50 ms direct-binary, ~80-140 ms npm-launcher (Node startup
tax). Both are vastly better than today's ~250 ms unbundled-tsc-emit start.

**Effort: 1.5 days.**

---

## Phase 8 (optional) — Async-generator at run-orchestrator boundary

**Goal**: future-proof for cancellation hotkeys (Ctrl-C → "stop after current
flow"). Low impact today; non-blocking polish.

**Why optional**: per the architectural research, migrating the engine itself to
async generators is invasive and the existing `useSyncExternalStore` already
provides streaming UX. The win is concentrated at the run-orchestrator boundary
where Ctrl-C cancellation could become a one-liner `gen.return()` instead of
plumbing a flag through the orchestrator.

### Steps (sketch — ship only if a real need surfaces)

1. In `cli/src/commands/test.ts` around the main flow-running loop, introduce
   `async function* runFlows(): AsyncGenerator<RunEvent>` that yields
   `flow:start`, `flow:complete`, `run:complete` events.
2. `runFlow` itself stays callback-driven; the generator wraps it.
3. Ink reporter consumes via `for await (const ev of gen) { dispatch(ev); }` in
   addition to the existing per-step callbacks.
4. Add a Ctrl-C handler that calls `gen.return()` to gracefully stop after the
   in-flight flow.

### Effort: 0.5 day if shipped. Defer indefinitely.

---

## Patterns explicitly NOT adopted (and why)

- **Switch runtime to Bun**: blocked by Bun #27977 (Playwright `chromium.launch()`
  hangs on Windows, still open April 2026). macOS/Linux work with the openclaw
  `ws`-shim workaround, but Microsoft doesn't officially test Bun and the
  Windows test-matrix gap is unacceptable for a CI tool. Re-evaluate when
  #27977 closes. Note: Bun-compiled binaries themselves run fine cross-platform
  for non-Playwright workloads (Claude Code is the proof point); the constraint
  is specifically Bun-runtime + Playwright.
- **Switch CLI parser to CrustJS or similar**: alpha framework risk; Commander 13
  is fine. Free wins from CrustJS (cross-platform binary distribution) are
  obtained via Phase 7.
- **Replace Zod 3 with Valibot or ArkType**: parsing happens once per run, not
  hot-path. Zod 4 upgrade is a free win (do it casually) but no architectural
  payoff.
- **Replace `better-sqlite3` with `bun:sqlite`**: only relevant if migrating
  runtime to Bun, which we're not.
- **Rewrite executor in Rust via NAPI-RS**: profiling has not shown CPU-bound hot
  paths. skeptic is I/O-bound on Playwright + LLM calls, not on JS execution.
- **Stagehand-style action caching for LLM**: skeptic doesn't have actions to cache
  (LLM fires per-assertion against a unique screenshot, not per-step against a
  reusable DOM mapping).
- **Migrate engine to async generators**: invasive, low ROI given existing
  streaming via `useSyncExternalStore`. Phase 8 captures the only narrow case
  worth it.

---

## Verification strategy (end-to-end)

After all phases:

1. `npm run check` → no type errors.
2. `npm run build` → produces `dist/skeptic.mjs` + `dist/templates/` + `dist/recorder-script.js`.
3. `npm test` → vitest passes.
4. `bash cli/scripts/build-sea.sh --platform=$(uname -s)-$(uname -m) --out=/tmp/skeptic-test` →
   produces a working binary locally.
5. `time skeptic --version` cold → <100 ms.
6. `time skeptic --help` cold → <150 ms.
7. `skeptic init /tmp/x && cd /tmp/x && skeptic test` against a fixture flow → passes.
8. `skeptic test` against a flow with `assertWithAI` and a forced Gemini 429 →
   retries silently and passes.
9. `skeptic test` against a recursive `runFlow:` chain → fails cleanly with cycle
   error in <100 ms.
10. `git tag v0.2.0-rc.1 && git push --tags` → CI produces 5 signed binaries +
    npm publishes everything.
11. `npm i -g skeptic-cli@next` on a fresh macOS arm64 machine → binary works,
    Gatekeeper does not block.

---

## Sequencing & shipping order

| Phase | Title                                                  | Effort | Ship as |
|-------|--------------------------------------------------------|--------|---------|
| 1     | Bundling: replace `tsc` emit with tsup                | 1 d    | PR #1   |
| 2     | Cold-start: lazy commands + version fast path          | 0.5 d  | PR #2   |
| 3     | Death-spiral guard for `runFlow` (file form, depth)   | 1 d    | PR #3   |
| 4     | Withhold-and-recover for AI errors (`ProviderError`)   | 1.5 d  | PR #4   |
| 5     | Build-time feature flags + cache-boundary marker       | 1 d    | PR #5   |
| 6.0   | SEA spike: prove ESM + dynamic imports + externals     | 1 d    | PR #6a  |
| 6.1   | Single-binary via Node SEA + macOS sign + zip-notarize | 2-3 d  | PR #6b  |
| 7     | npm optional-deps + GitHub Actions release matrix      | 2 d    | PR #7   |
| 8     | (Optional) Async-generator at orchestrator boundary    | 0.5 d  | Deferred|

**Total: ~10 engineering days, 8 PRs over ~3-4 weeks at a normal cadence.**
(Up from initial 7 days estimate after Codex Round 1 surfaced SEA spike
requirement and AI-retry `ProviderError` plumbing.)

Each phase is independently shippable. If any phase reveals a deeper issue, halt
there and reassess; downstream phases assume the upstream artifact but don't
share state.

---

## Critical files index

For implementers, the changes concentrate in these files:

| File                                                          | Phases    | Why |
|---------------------------------------------------------------|-----------|-----|
| `cli/package.json`                                            | 1, 7       | Build script, bin field, optionalDependencies, engines |
| `cli/tsup.config.ts` (NEW)                                    | 1, 5       | Bundler config, externals, `define` for `__SKEPTIC_FEATURE_*__` |
| `cli/bin/skeptic.ts`                                            | 2          | Version fast-path BEFORE static import (tsup runtime entry — becomes `dist/skeptic.mjs` after bundling). Phase 7's binary shim is a separate file (`bin/launcher.mjs`). |
| `cli/src/index.ts`                                            | 2, 5       | Lazy command imports, feature gates |
| `cli/src/constants.ts`                                        | 2          | `CLI_VERSION` constant |
| `cli/src/commands/test.ts`                                    | 2, 5       | Lazy reporter / chokidar / scan-flows-for-AI gating |
| `cli/src/utils/asset-path.ts` (NEW)                           | 1, 6       | Templates + recorder script resolution, SEA-aware |
| `cli/src/utils/sea-require.ts` (NEW)                          | 6          | `createRequire`-bound to sibling `node_modules/` for external value imports inside SEA |
| `cli/src/commands/init.ts`                                    | 1, 6       | Use asset-path helper, handle SEA assets |
| `cli/src/ai/guidance-loader.ts`                               | 1, 6       | Use asset-path helper, handle SEA assets |
| `cli/src/commands/record-session.ts`                          | 1, 6       | `fs.mkdtemp`-based secure temp recorder script extraction; `requireExternal("playwright")` in SEA mode |
| `cli/src/executor/playwright-engine.ts`                       | 5, 6       | `requireExternal("playwright")` for `chromium`/`firefox`/`webkit` in SEA mode (the **main test path**) |
| `cli/src/executor/context.ts`                                 | 3          | Add `runFlowDepth`, `runFlowStack`; verify `deleteVariable` exists |
| `cli/src/executor/step-handlers/run-flow.ts`                  | 3          | Cycle/depth guard scoped to `file:` form (schema requires file); env-restore on failure |
| `cli/__tests__/unit/executor/run-flow.test.ts` (NEW)          | 3          | Cycle, depth, env-restoration tests (file form only — schema disallows pure inline) |
| `cli/src/ai/retry-policy.ts` (NEW)                            | 4          | `ProviderError` class, `classifyError`, `withRetry`, `downscalePng` |
| `cli/src/ai/ai-client.ts`                                     | 4          | **Breaking interface change**: methods return `AIResult { text, retryCount }` instead of bare `string` |
| `cli/src/ai/types.ts`                                         | 4          | Add optional `retryCount` to `AIAssertionResult` + `AIExtractionResult` |
| `cli/src/ai/assertion-evaluator.ts`                           | 4          | Read `.text`, forward `.retryCount` to callers |
| `cli/src/executor/step-handlers/{assert-with-ai,assert-no-defects,extract-text-ai}.ts` | 4 | Consume `retryCount` and call `appendWarning` (verified filename `extract-text-ai.ts`, not `-with-ai`) |
| `cli/src/ai/flow-generator.ts`                                | 4          | Read `.text` from new `AIResult` shape (lines 174 + 205); .trim() on `.text`, not the wrapper |
| `cli/src/ai/gemini-client.ts`                                 | 4, 5       | Throw `ProviderError`, wrap in `withRetry`, return `AIResult`, future cache-boundary hook |
| `cli/src/ai/anthropic-client.ts`                              | 4, 5       | Throw `ProviderError`, retry policy, return `AIResult`, cache_control marker |
| `cli/src/ai/openai-client.ts`                                 | 4          | Throw `ProviderError`, retry policy, return `AIResult` |
| `cli/src/ai/prompts.ts`                                       | 5          | STATIC_PREFIX / dynamicSuffix split + boundary sentinel |
| `cli/src/global.d.ts` (NEW, Phase 1)                          | 1, 2, 5    | Ambient declarations for `__SKEPTIC_FEATURE_*__` + `__SKEPTIC_CLI_VERSION__` constants. Created in Phase 1 so Phases 2 + 5 can ship independently. |
| `cli/src/feature-flags.ts` (NEW)                              | 5          | `FEATURES` const for read-only inspection (does NOT participate in DCE — gates use bare `__SKEPTIC_FEATURE_*__` directly) |
| `cli/src/ai/client-factory.ts`                                | 5          | Throw `AIFeatureNotBuiltError` (NEW exported class) when `__SKEPTIC_FEATURE_AI_ASSERTIONS__` is `false`; convert `GeminiClient` static import to dynamic. **Bare identifier gate** for DCE. |
| `cli/src/commands/{generate,test}.ts` + `cli/src/commands/{mcp,acp}.ts` | 5 | Catch `AIFeatureNotBuiltError` at every `createAIClient` call site; CLI exits 2; MCP/ACP return protocol-friendly error |
| `cli/vitest.config.ts`                                        | 5          | Add `define` block for all `__SKEPTIC_FEATURE_*__` and `__SKEPTIC_CLI_VERSION__` so vitest runs unbundled tests against gated source |
| `cli/bin/dev.ts` (NEW)                                        | 5          | Dev bootstrap: sets `globalThis.__SKEPTIC_FEATURE_*__ = true` then imports `skeptic.ts`; usage `tsx bin/dev.ts <args>` |
| `cli/bin/launcher.mjs` (NEW, Phase 7)                         | 7          | Per-platform binary dispatcher with JS fallback (separate from tsup-bundled `dist/skeptic.mjs`) |
| `cli/src/cookies/{chromium,firefox}.ts`                       | 5, 6       | `isSea() ? requireExternal : await import` for `better-sqlite3`; module body gated by `__SKEPTIC_FEATURE_COOKIE_EXTRACTION__` |
| `cli/src/commands/cookies.ts`                                 | 5          | `skeptic cookies list` body gated by `if (__SKEPTIC_FEATURE_COOKIE_EXTRACTION__)`; dynamic-import `detectBrowsers` |
| `cli/src/commands/record-session.ts`                          | 1, 5, 6    | Dynamic-import + gate `extractAndInjectCookies`; explicit `--cookies` failure in slim builds |
| `cli/src/executor/playwright-engine.ts`                       | 5, 6       | Conditional cookie injection (`if (__SKEPTIC_FEATURE_COOKIE_EXTRACTION__)`); SEA `requireExternal` for playwright |
| `cli/src/commands/test.ts`                                    | 5          | Explicit `--cookies` rejection in slim builds (exit 2 with clear error); AIFeatureNotBuiltError handler |
| `cli/sea-config.json` (NEW)                                   | 6          | SEA assets manifest with `mainFormat: "module"`, `useCodeCache: false`. Includes `web-vitals.iife.js` as embedded asset. |
| `cli/src/observability/collectors/performance-collector.ts`   | 6          | Read `web-vitals.iife.js` from SEA asset in SEA mode; from disk via `createRequire` otherwise |
| `cli/scripts/gen-sea-config.mjs` (NEW)                        | 6          | Build-time generator that walks `dist/templates/**` |
| `cli/scripts/build-sea.sh` (NEW)                              | 6          | Single-step `node --build-sea` (Node 25.5+) + zip-then-notarize on macOS |
| `cli/scripts/build-tarball.sh` (NEW, fallback only)           | 6          | Fat-tarball build (Node binary + bundle + node_modules) if SEA spike fails |
| `cli/src/utils/playwright-precheck.ts` (NEW)                  | 6          | First-run browser-install detection (uses `playwright-core/lib/server` registry) |
| `cli/src/commands/browsers-install.ts` (NEW)                  | 6          | `skeptic browsers install` — invokes `registry.install` + `registry.installDeps` from `playwright-core/lib/server` (mirrors playwright CLI); `requireExternal` in SEA mode |
| `cli-bin-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,win32-x64}/` (NEW) | 7 | Per-platform npm packages with binary + sibling `node_modules/` |
| `.github/workflows/release.yml` (NEW)                         | 7          | Tag-driven multi-platform build + publish; `working-directory: cli` |
| `.github/workflows/ci.yml` (NEW)                              | 7          | PR + main branch CI matrix; `working-directory: cli` |
| `cli/RELEASING.md` (NEW)                                      | 7          | Release runbook + secret setup |

---

## Open questions / future work (parking lot)

- **Bun runtime re-evaluation**: track Bun #27977 (Windows `chromium.launch()`
  hang). Once that closes and Playwright's `ws`-shim issue (#28450 / #9911) is
  resolved upstream rather than via patch, re-evaluate moving skeptic's runtime to
  Bun. Expected wins: ~50% faster cold start, Bun-compile single-binary
  distribution (replacing Node SEA's complexity), `bun:sqlite` (replacing
  better-sqlite3 native dep). Estimated re-evaluation window: Q4 2026.
- Zod 4 upgrade: free win, mechanical, can be done in any phase after type-check
  is happy.
- `MAX_RUN_FLOW_DEPTH` configurable via `skeptic.config.yaml` if a real user hits the
  default of 10.
- Slim binary variants (e.g., `skeptic-cli-slim` without AI) — defer until demand
  surfaces.
- Action caching for `skeptic generate --diff` LLM output — defer until repeat
  invocations become a measurable cost.
- Windows code-signing once a cert is purchased.
