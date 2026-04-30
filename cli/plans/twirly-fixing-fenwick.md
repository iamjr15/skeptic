# Plan: Close 5 SOTA-migration gaps from the audit

## Context

The 8-phase SOTA migration (`plans/frolicking-watching-kahn.md`) is implemented
but a thorough audit found 5 gaps where the spec wasn't fully met. They're the
items that would only manifest at first real release, so closing them now —
before tagging anything — is much cheaper than discovering them mid-publish.

The 5 gaps in priority order:

1. **Phase 6**: `cli/src/commands/init.ts:48` still calls
   `execSync("npx playwright install …")` and the failure message tells the
   user to run `npx playwright install` manually. The plan required routing
   through `runBrowsersInstall` so users on the no-Node binary path don't
   need npx.
2. **Phase 7**: `release.yml` `smoke-test` job runs the binary tarball
   directly. There's no job that does an `npm install` from a local
   registry to verify `optionalDependencies` actually resolves the right
   `skeptic-cli-bin-*` package and that the launcher routes through it. The
   plan called for a Verdaccio-based test as a publish gate.
3. **Phase 7**: `smoke-test` lacks an `skeptic test <fixture>` step. The plan
   wanted a minimal end-to-end run that exercises the sidecar Playwright
   load — the most thorough functional check, and the only one that would
   catch a sidecar regression that `--version` / `init` / `browsers install`
   would all miss.
4. **Phase 5**: `prompts.ts` only has a documenting comment for the cache
   boundary; the structural split into `STATIC_PREFIX_*` + `dynamicSuffix`
   exports never happened. Plan said to mark the structure now and defer
   only the actual `cachedContents` API wiring.
5. **Phase 6**: Equal Access binary-distribution limitation isn't
   documented. README has install instructions for
   `accessibility-checker-engine` but doesn't say "binary builds always
   degrade to axe-only; use npm path for Equal Access."

---

## Hard constraints (carry-overs from the parent plan)

- Stay on Node ≥22 runtime; no Bun migration.
- Don't break the green test suite (931 passing).
- Don't widen the canonical-four externals matrix (`playwright`,
  `playwright-core`, `better-sqlite3`, `oxc-resolver`).
- DCE patterns stay positive-branch (`if (FLAG) { import() } else { fail }`).
- Test fixtures' AI-client mocks return `AIResult { text, retryCount }`.

---

## Gap #1 — `init.ts` routes through `runBrowsersInstall`

**Goal**: a no-Node binary user running `skeptic init` should not hit `npx
playwright install`. The browser install must use the skeptic-internal helper.

### Steps

1. Modify `cli/src/commands/init.ts:45-58`. Replace the `execSync("npx
   playwright install …")` block with a dynamic-import call to
   `runBrowsersInstall`:
   ```ts
   logger.info("Installing Playwright browsers…");
   try {
     const { runBrowsersInstall } = await import("./browsers-install.js");
     await runBrowsersInstall(["chromium"], { withDeps: true });
     logger.success("Playwright Chromium installed");
   } catch (err) {
     logger.warn(
       "Failed to install Playwright browsers automatically.\n" +
       `  Run manually: ${chalk.cyan("skeptic browsers install --with-deps chromium")}`,
     );
   }
   ```
   - **Why dynamic import**: `runBrowsersInstall` ultimately loads
     `playwright-core/lib/server` via `loadPlaywrightCoreServer()`, which is
     the heavy SEA-aware async load path. Keeping it inside `init`'s action
     handler at module scope — rather than a top-of-file static import —
     keeps the bundler's existing tree-shaking honest and matches every
     other lazy-loaded command runner.
   - **Why `withDeps: true`**: matches the previous behavior verbatim
     (`--with-deps` was in the npx call). On macOS / Windows this is a no-op
     because `installDeps` only does work on Linux.
   - **Why no `cwd: dir` option**: `runBrowsersInstall` doesn't spawn a
     subprocess; it calls into Playwright's registry directly. The npm
     download cache and browser binary location are global
     (`~/.cache/ms-playwright`), not project-local — `cwd: dir` was a
     leftover that didn't matter.

2. Drop the now-unused `execSync` import (line 3): `import { execSync } from
   "node:child_process"`. Keep the rest of the imports.

3. The catch branch's warning text now points at `skeptic browsers install`,
   not `npx`. For users who do have Node, `npx playwright install` still
   works as a synonym — but the documented fallback is the skeptic command,
   so users without Node always have a working path.

### Risks & mitigations

- **What if `runBrowsersInstall` fails inside `init` and the catch swallows
  the error?** Same behavior as today — the npx block already wrapped its
  call in a `try`/`catch` that downgrades to a warning. The user gets a
  clear message about how to retry manually. Project scaffolding still
  succeeds.
- **What about the `node_modules/playwright-core/lib/server` resolution
  during dev (tsx)?** `loadPlaywrightCoreServer` already handles the dev
  path via `await import("playwright-core/lib/server" as string)`. No change.
- **Tests reference the npx string?** Grep for `"npx playwright install"`
  across `__tests__/`. If a test asserts on the warning content, update it.

### Verification

- `npm run check` → 0 errors.
- `npm run build` → succeeds; bundle size unchanged within ~50 KB.
- Manually: `node dist/skeptic.mjs init /tmp/skeptic-init-gap1` exercises the
  full path; expect the same scaffolding output and a successful Chromium
  install via the skeptic helper.
- `npm test` → 931 still pass.

### Files touched

- `cli/src/commands/init.ts` (Phase 6 of parent plan, gap #1)

---

## Gap #2 — Verdaccio-based install-from-tarball test in CI

**Goal**: catch `optionalDependencies` resolution regressions before publish.
Today's `smoke-test` runs the binary tarball directly; nothing verifies that
`npm install -g skeptic-cli` actually resolves the matching `skeptic-cli-bin-*`
package and that `bin/launcher.mjs` routes through it.

### Steps

1. Add a new job `install-from-tarball-test` to
   `.github/workflows/release.yml`. It runs after `binary-build` and before
   `publish`. Strategy: matrix per platform, like `smoke-test`. Each leg:
   - Spin up Verdaccio in the background on `localhost:4873`.
   - `npm pack` the main `cli/` package and every `cli-bin-*/` package.
   - `npm publish` each tarball to the local Verdaccio.
   - From a clean cwd: `npm install -g skeptic-cli --registry
     http://localhost:4873`.
   - Verify `which skeptic` resolves through `node_modules/.bin/skeptic` →
     `bin/launcher.mjs`.
   - Run `skeptic --version` and verify the output equals
     `${GITHUB_REF_NAME#v}` (proves the binary actually ran, not the JS
     fallback — the binary has the version baked in via tsup `define`).
   - Inspect `node_modules/skeptic-cli-bin-${platform}/skeptic` (or `skeptic.exe`)
     to confirm the platform-specific binary was installed.

2. Wire job dependencies: `install-from-tarball-test: needs: binary-build`,
   then `publish: needs: [smoke-test, install-from-tarball-test]` — replace
   the current `publish: needs: smoke-test` with the **array form**. Both
   must pass; dropping `smoke-test` from the array would lose the
   `--cookies` macOS-signed-`.node` check and the existing functional
   coverage. See step 4 below for the exact YAML.

3. Concrete YAML shape:
   ```yaml
   install-from-tarball-test:
     name: Install-from-tarball test (${{ matrix.target }})
     needs: binary-build
     runs-on: ${{ matrix.runner }}
     defaults:
       run:
         shell: bash
     strategy:
       fail-fast: false
       matrix: # same 5-platform list as binary-build
         include:
           - target: darwin-arm64
             runner: macos-14
           - target: darwin-x64
             runner: macos-13
           - target: linux-x64
             runner: ubuntu-22.04
           - target: linux-arm64
             runner: ubuntu-22.04-arm
           - target: win32-x64
             runner: windows-2022
     steps:
       - uses: actions/checkout@v4
       - uses: actions/setup-node@v4
         with:
           node-version: "25.5"
           cache: npm
           cache-dependency-path: cli/package-lock.json
       - name: Download all binary artifacts
         uses: actions/download-artifact@v4
         with:
           path: artifacts
       - name: Stage bin packages with binaries
         working-directory: cli
         run: |
           VERSION="${GITHUB_REF_NAME#v}"
           # Bump main package version. `npm version` writes the new value
           # but does NOT update `optionalDependencies.*` ranges referencing
           # sibling packages — those are pinned at "0.1.0" in
           # cli/package.json and must be rewritten to match the tag,
           # otherwise the install resolves an old (or missing) bin package.
           npm version --no-git-tag-version "$VERSION"
           node -e "
             const fs = require('fs');
             const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
             for (const k of Object.keys(p.optionalDependencies || {})) {
               if (k.startsWith('skeptic-cli-bin-')) p.optionalDependencies[k] = '$VERSION';
             }
             fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
           "
           for d in ../cli-bin-*; do
             (cd "$d" && npm version --no-git-tag-version "$VERSION")
             target="$(basename "$d" | sed 's/^cli-bin-//')"
             cp -R "../artifacts/skeptic-$target/cli-bin-$target/." "$d/"
           done
           npm ci && npm run build
       - name: Start Verdaccio
         run: |
           # CRITICAL: skeptic-cli + skeptic-cli-bin-* must NOT proxy to npmjs.
           # If Verdaccio tries to fetch them upstream first, it 404s and
           # then falls back to local — but on a re-publish (same version)
           # the upstream cache wins and our local tarball is shadowed.
           # The explicit "@skeptic-cli/**" + "skeptic-cli" + "skeptic-cli-bin-*"
           # rules above the catch-all "**" disable proxying for our own
           # packages.
           npx --yes verdaccio --config <(cat <<'YML'
           storage: ./verdaccio-storage
           uplinks:
             npmjs:
               url: https://registry.npmjs.org/
           packages:
             "skeptic-cli":
               access: $all
               publish: $all
             "skeptic-cli-bin-*":
               access: $all
               publish: $all
             "@*/*":
               access: $all
               publish: $all
               proxy: npmjs
             "**":
               access: $all
               publish: $all
               proxy: npmjs
           logs: { type: stdout, format: pretty, level: warn }
           YML
           ) &
           # Wait for the server to bind.
           timeout 30 bash -c 'until curl -fsS http://localhost:4873 >/dev/null; do sleep 1; done'
           # Configure npm to publish anonymously to the local registry.
           echo "//localhost:4873/:_authToken=fake-token" >> ~/.npmrc
           npm config set registry http://localhost:4873
       - name: Pack + publish all packages locally
         run: |
           ( cd cli && npm pack )
           for d in cli-bin-*; do (cd "$d" && npm pack); done
           for tgz in cli/*.tgz cli-bin-*/*.tgz; do
             npm publish "$tgz"
           done
       - name: Install + verify
         shell: bash
         run: |
           # Install in a scratch directory so we exercise the global
           # bin-link path without polluting the build tree.
           mkdir -p /tmp/skeptic-install-test && cd /tmp/skeptic-install-test
           npm install -g skeptic-cli
           VERSION="${GITHUB_REF_NAME#v}"
           STAMPED="$(skeptic --version)"
           if [[ "$STAMPED" != "$VERSION" ]]; then
             echo "::error::skeptic --version printed '$STAMPED', expected '$VERSION'"
             exit 1
           fi
           # Confirm the platform binary was actually installed.
           # `npm root -g` returns the global node_modules dir on every
           # platform (Unix: /usr/local/lib/node_modules,
           # Windows: %APPDATA%/npm/node_modules). The naïve
           # `npm prefix -g + /lib/node_modules` is Unix-only — Windows has
           # no `lib/` subdirectory under the prefix. Use `npm root -g`.
           NPM_ROOT="$(npm root -g)"
           BIN_PKG_DIR="$NPM_ROOT/skeptic-cli/node_modules/skeptic-cli-bin-${{ matrix.target }}"
           BIN_NAME="skeptic"
           [[ "$RUNNER_OS" == "Windows" ]] && BIN_NAME="skeptic.exe"
           if [[ ! -x "$BIN_PKG_DIR/$BIN_NAME" ]]; then
             echo "::error::Platform binary not installed at $BIN_PKG_DIR/$BIN_NAME"
             ls -la "$BIN_PKG_DIR" || true
             exit 1
           fi
   ```

4. Update `publish` job to depend on **both** gates. The current workflow has
   `publish: needs: smoke-test`. Replace with an array — both must pass before
   publish runs. Removing `smoke-test` from the dependency list would lose
   the existing checks (e.g. macOS-signed `.node` load, browsers install
   actually downloads). Both gates are cheap; both should block:
   ```yaml
   publish:
     needs: [smoke-test, install-from-tarball-test]
   ```

### Risks & mitigations

- **Verdaccio isn't bundled with Node**: solved by `npx --yes verdaccio`
  which downloads on-demand. Adds ~20 seconds per matrix leg.
- **`heredoc` in YAML inside heredoc gets ugly**: the
  `npx --yes verdaccio --config <(cat <<'YML' ... YML)` pattern uses
  process-substitution. Verified to work on bash 3.x (default macOS) and
  bash 4.x+; not available in pwsh — that's why the job sets
  `shell: bash` defaults.
- **Windows pathing**: `npm root -g` (used in the verify step above)
  returns the global `node_modules` path on every platform — Unix
  `/usr/local/lib/node_modules`, Windows
  `%APPDATA%\npm\node_modules`. Git Bash on Windows runners returns the
  Windows-style path which still works because we use `[[ -x … ]]` plus a
  `.exe` extension on Windows.
- **`heredoc <(…)` doesn't always survive `npm install -g` cleanly on
  Windows**: alternative is to write the verdaccio config to a file
  first, then `npx --yes verdaccio --config /tmp/verdaccio.yaml`. Pick that
  if Windows breaks.
- **Network calls during install**: Verdaccio proxies to npmjs for any
  unknown package, so the `skeptic-cli` install pulls real `playwright`,
  `playwright-core`, `better-sqlite3`, `oxc-resolver` from npm. That's slow
  (~30 seconds per install). Acceptable; this job is publish-blocking.

### Verification

- Locally: follow the exact steps from RELEASING.md's "Local dry-run"
  section. The plan codifies what's documented.
- In CI: tag a pre-release (`v0.0.0-test.1`), let the workflow run end-to-
  end with `npm publish --access public --tag test`. Confirm
  `install-from-tarball-test` runs and gates the publish job.

### Files touched

- `.github/workflows/release.yml`

---

## Gap #3 — `skeptic test <fixture>` step in smoke-test

**Goal**: the smoke test must exercise the actual main path that loads
Playwright through the sidecar. Today's smoke covers `--version`, `init`,
`browsers install`, `cookies list` — none of which exercise
`PlaywrightEngine.launch()` against the sidecar `node_modules/playwright`.

### Steps

1. After the existing `Smoke — browsers install` step in
   `.github/workflows/release.yml` (around line 246), add a fixture flow
   smoke. The simplest viable target: the `templates/example.flow.yaml`
   that `skeptic init` already drops into the project. After running `init`,
   the binary already has a working flow file at
   `/tmp/skeptic-smoke/tests/example.flow.yaml`.

   ```yaml
   - name: Smoke — skeptic test (sidecar Playwright load)
     run: |
       # Exercise the main test path: this loads playwright from the
       # sidecar node_modules/ via the SEA-aware loadPlaywright(), launches
       # Chromium, runs the example flow against example.com.
       #
       # Path note: previous smoke steps used the relative
       # ./cli-bin-${{ matrix.target }}/$BIN_NAME (the artifact lands at
       # the workflow-workspace root because actions/download-artifact
       # writes to the runner's cwd). This step changes cwd to
       # /tmp/skeptic-smoke (where the example flow lives), so the binary
       # path must be ABSOLUTE — anchor it to $GITHUB_WORKSPACE rather
       # than relative-walking out of /tmp.
       cd /tmp/skeptic-smoke
       "$GITHUB_WORKSPACE/cli-bin-${{ matrix.target }}/${{ steps.binname.outputs.name }}" test
   ```
   - **Why example.com**: the bundled `templates/example.flow.yaml` already
     navigates to `https://example.com` and asserts on "Example Domain".
     example.com is RFC 2606 reserved and serves a stable known body — no
     coordination with a fixture web server needed.
   - **Why `cd /tmp/skeptic-smoke`**: the test command resolves flows
     relative to the cwd (or `--config` directory). Our `init` ran with
     target `/tmp/skeptic-smoke`, so the flow lives there.
   - **Why `$GITHUB_WORKSPACE` absolute**: after `cd /tmp/skeptic-smoke`, a
     relative `../cli-bin-…` path resolves to `/cli-bin-…`, not the
     workspace root. `$GITHUB_WORKSPACE` is set by the runner to the
     checkout directory and works on all OSes. On Windows runners this
     translates to a Git-Bash-friendly POSIX path under
     `/d/a/skeptic/skeptic/...`.
   - **Why no `--ci` flag**: the runner is detected as CI automatically
     via `GITHUB_ACTIONS=true`, so cookies are off by default and the run
     is non-interactive.

2. Update the macOS-only step name and ordering — keep `cookies list` at
   the bottom since it's the macOS-specific signed-`.node` check, after
   the cross-platform `skeptic test`. Apply the same `$GITHUB_WORKSPACE`
   anchor to that step too if it relies on cwd staying at workspace root.

### Risks & mitigations

- **example.com is unreachable from runners?** Highly unlikely — it's RFC
  reserved and Microsoft/GitHub egress allows it. But add a small retry
  via `--retries 1` in the flow command if needed; defer for now.
- **Browser install was just done; can the test reuse it?** Yes —
  Playwright's registry stores browsers in `~/.cache/ms-playwright`, so
  the previous step's install satisfies this step.
- **`init`'s npx-replacement (gap #1) makes init slower?** Slightly,
  because the install actually runs through our path now. But that's also
  what we want — exercising init's full happy path on every smoke run.

### Verification

- After the workflow change, watch a pre-release run. The new step should
  spend ~5 seconds running the example flow and pass.
- If example.com's body changes (unlikely — RFC reserved), update
  `templates/example.flow.yaml` to match.

### Files touched

- `.github/workflows/release.yml`

---

## Gap #4 — Cache-boundary structural split in `prompts.ts`

**Goal**: each cacheable prompt is exported as `STATIC_PREFIX_X` +
`dynamicSuffix(args)`, with the combined string export kept for backwards
compatibility. This is the structural prep that lets us wire
`cachedContents` later without refactoring every consumer.

### Decision: which prompts to split

**Split rule (corrected from Codex Round 1)**: a `STATIC_PREFIX` must contain
**zero** placeholders. If the prompt has multiple placeholders, the prefix
ends BEFORE the first one and the dynamic suffix carries the entire
remainder (placeholders included, substituted by the suffix function). A
prefix containing an unsubstituted `{baseUrl}` would produce different
provider-cache keys per project — which defeats the cache and silently
poisons future cache wiring.

| Prompt | Split point | Notes |
|---|---|---|
| `VISUAL_ASSERTION_PROMPT` | No placeholders | Whole prompt is static. Re-export as `VISUAL_ASSERTION_STATIC_PREFIX = VISUAL_ASSERTION_PROMPT`; no `dynamicSuffix` needed. |
| `ASSERT_WITH_AI_PROMPT` | Before `{assertion}` | Single placeholder. Prefix ends just before the opening `"` of the assertion line; suffix carries `"{assertion}"\n\n…rest`. |
| `EXTRACT_TEXT_PROMPT` | Before `{query}` | Single placeholder. Same shape as above. |
| `GENERATE_FROM_DIFF_PROMPT` | Before first `{baseUrl}` | Three placeholder occurrences (`{baseUrl}` twice, `{diff}` once). Prefix is the intro paragraph only; suffix carries `Base URL: {baseUrl}\n…{diff}`. Suffix function takes `{ baseUrl, diff }` and substitutes both. |
| `GENERATE_FROM_DESCRIPTION_PROMPT` | Before first `{baseUrl}` | Three placeholder occurrences (`{baseUrl}` twice, `{description}` once). Suffix function takes `{ baseUrl, description }`. |
| `ANALYZE_FAILURE_PROMPT` | No (export-only, currently unused) | Exported for future use but the live code path in `assertion-evaluator.ts:44+` builds an inline string instead. Not on any per-step hot path. Skip the split; flag in the file comment that the export is dormant. |

### Steps

1. Modify `cli/src/ai/prompts.ts`. For each split prompt, define three
   exports:
   - `<NAME>_STATIC_PREFIX` — the constant text up to (but not including)
     the **first** placeholder. Contains zero placeholders.
     Newline-terminated.
   - `<name>DynamicSuffix(args): string` — a function returning the entire
     remainder of the prompt **after** the static prefix, with **all**
     placeholders substituted. The suffix MAY include text that today
     looks "static" if the prefix would otherwise contain an
     unsubstituted placeholder.
   - `<NAME>_PROMPT` — the existing combined string export, defined as
     `<NAME>_STATIC_PREFIX + <suffix template with placeholders intact>`.
     Preserves the backwards-compatible inline-`.replace(...)` consumer
     pattern byte-for-byte.

   Concrete shape for `ASSERT_WITH_AI_PROMPT` (single placeholder
   `{assertion}`):
   ```ts
   export const ASSERT_WITH_AI_STATIC_PREFIX =
     `You are a QA engineer reviewing a screenshot from an automated E2E test.\n\n` +
     `The user asserts: `;
   // === CACHE BOUNDARY ===
   export const assertWithAiDynamicSuffix = (assertion: string): string =>
     `"${assertion}"\n\n` +
     `Examine the screenshot and determine if this assertion passes or fails.\n` +
     /* … rest of the prompt verbatim … */ ``;
   // The combined export keeps placeholder semantics: pass the
   // placeholder text "{assertion}" so .replace() consumers still work.
   export const ASSERT_WITH_AI_PROMPT =
     ASSERT_WITH_AI_STATIC_PREFIX + assertWithAiDynamicSuffix("{assertion}");
   ```

   Concrete shape for `GENERATE_FROM_DIFF_PROMPT` (three placeholder
   occurrences: `{baseUrl}` twice, `{diff}` once). The prefix MUST end
   before the first `{baseUrl}` so the cache key doesn't depend on the
   project URL:
   ```ts
   export const GENERATE_FROM_DIFF_STATIC_PREFIX =
     `You are an adversarial QA engineer generating E2E test flows from ` +
     `code changes. Your goal is to BREAK the application, not just ` +
     `confirm it works. Think like a malicious user and a thorough QA ` +
     `engineer combined.\n\n`;
   // === CACHE BOUNDARY ===
   export const generateFromDiffDynamicSuffix = (
     args: { baseUrl: string; diff: string }
   ): string =>
     `Base URL: ${args.baseUrl}\n\n` +
     /* … the rest of the prompt verbatim, with both `{baseUrl}` and
        `{diff}` substituted. The two `{baseUrl}` occurrences (intro
        line and YAML example) are interpolated identically. … */
     `\n\nCode changes:\n${args.diff}`;
   export const GENERATE_FROM_DIFF_PROMPT =
     GENERATE_FROM_DIFF_STATIC_PREFIX +
     generateFromDiffDynamicSuffix({ baseUrl: "{baseUrl}", diff: "{diff}" });
   ```
   The combined export passes literal `"{baseUrl}"` and `"{diff}"` strings
   into the suffix function so the substitution is a no-op (the
   placeholders survive). Consumers' existing
   `.replace("{baseUrl}", url).replace("{diff}", actualDiff)` calls keep
   working byte-for-byte.

   Same shape for `GENERATE_FROM_DESCRIPTION_PROMPT` with
   `{ baseUrl, description }`.

   - **Boundary placement rule**: each prefix ends at the last character
     before the first `{` placeholder. The dynamic suffix carries
     **everything** after that point, including any "static-looking" text
     between placeholders. This guarantees zero placeholders in the
     prefix.
   - The `// === CACHE BOUNDARY ===` sentinel comment lives between
     prefix and suffix exports.

2. For `EXTRACT_TEXT_PROMPT` (single placeholder `{query}`): split before
   `{query}`, suffix takes `(query: string)`.

3. For `VISUAL_ASSERTION_PROMPT` (fully static, zero placeholders): just
   export `VISUAL_ASSERTION_STATIC_PREFIX = VISUAL_ASSERTION_PROMPT;`. No
   `dynamicSuffix` function needed; future cache wiring would pass the
   whole prefix and append nothing dynamic.

4. For `ANALYZE_FAILURE_PROMPT`: skip the split. The export is currently
   dormant — `assertion-evaluator.ts:44+` builds its own inline prompt
   instead of using this constant. Add a one-line comment to the existing
   export documenting this:
   ```ts
   // NOTE: exported for future use; assertion-evaluator.ts builds its
   // own inline prompt for analyzeFailure. Either wire this in (and
   // delete the inline version) or remove this export. Out of scope for
   // the cache-boundary split.
   export const ANALYZE_FAILURE_PROMPT = `…`;
   ```

5. Update the CACHE BOUNDARY MARKER comment block at the top of
   `prompts.ts`. It should now read:
   - "Each cacheable prompt is split into `<NAME>_STATIC_PREFIX` (zero
     placeholders) and `<name>DynamicSuffix(args)` (carries the entire
     remainder of the prompt with placeholders substituted)."
   - "The combined `<NAME>_PROMPT` export is retained for
     backwards-compatibility with consumers that use
     `.replace(placeholder, value)`."
   - "When prompts grow past 1024 tokens, the AI clients will start
     passing `_STATIC_PREFIX` to the provider's cache mechanism while
     still appending the dynamic suffix. The prefix being
     placeholder-free guarantees a stable cache key."

6. **No consumer changes** — `assertion-evaluator.ts` and `flow-generator.ts`
   keep using the combined `_PROMPT` exports verbatim. The prep is purely
   structural; the API wiring is deferred until prompts grow.

### Risks & mitigations

- **Existing tests assert on prompt content** (`prompts.test.ts:10-95`).
  All assertions check substrings against `GENERATE_FROM_DIFF_PROMPT` and
  `GENERATE_FROM_DESCRIPTION_PROMPT`. As long as the split preserves the
  combined prompt byte-for-byte, those tests keep passing.
- **Newline / whitespace at the split boundary**: this is the easiest
  thing to get wrong. Mitigation: write the new file with the prefix and
  suffix concatenated, then assert in a new test (one per split prompt)
  that the combined export equals
  `<NAME>_STATIC_PREFIX + <name>DynamicSuffix(<placeholder-args>)`. For
  multi-placeholder prompts the placeholder-args object passes the
  literal placeholder strings (`{ baseUrl: "{baseUrl}", diff: "{diff}" }`),
  which keeps `.replace()` consumers working unchanged.
- **Prefix must contain zero placeholders**: validated by an automated
  assertion in the test suite — `expect(<NAME>_STATIC_PREFIX).not.toMatch(/\{[a-zA-Z]+\}/)`
  for each prefix. Catches future regressions where someone adds a new
  placeholder to the intro paragraph.
- **OpenAI automatic prompt caching**: kicks in for shared prefixes ≥1024
  tokens. The split itself doesn't change anything that OpenAI sees today
  (still one combined message). Future work: explicitly mark the prefix
  block when wiring `cache_control` / `cachedContents`.

### Verification

- `npm run check` → 0 errors.
- `npm test -- prompts.test.ts` → all existing assertions pass + the new
  byte-equivalence assertion.
- Visual check: `diff <(node -e "import('./dist/skeptic.mjs')")
  <(previous-build)` — the bundle's prompt text should be byte-identical.

### Files touched

- `cli/src/ai/prompts.ts`
- `cli/__tests__/unit/ai/prompts.test.ts` (new byte-equivalence
  assertions)

---

## Gap #5 — Document Equal Access binary-distribution limitation

**Goal**: README explicitly states that the SEA binary always degrades to
axe-only, and users who need IBM Equal Access must use the npm install path.

### Steps

1. Find the existing Equal Access section in `cli/README.md` (lines 626-632
   per audit). It currently says:
   ```
   To enable IBM Equal Access dual-engine accessibility auditing, install the
   optional peer dependency:
       npm install accessibility-checker-engine
   Then set `observability.accessibilityDualEngine: true`. With it, axe-core
   runs first; IBM Equal Access runs alongside and contributes additional
   findings deduplicated by rule ID.
   ```

2. Add a binary-distribution caveat right after the install command:
   ```
   > **Binary distribution caveat**: standalone skeptic binaries (downloaded
   > from GitHub Releases or Homebrew) always degrade to axe-only. The
   > Equal Access engine resolves
   > `accessibility-checker-engine/ace.js` via `createRequire(import.meta.url)`,
   > which inside a SEA binary points at the binary itself rather than a
   > user's `node_modules/` — so the peer dependency can't be loaded even if
   > installed. If you need Equal Access, use `npm install -g skeptic-cli` (the
   > primary distribution).
   ```

3. No code change. This is documentation-only.

### Risks & mitigations

- **Future work could fix this**: SEA could embed `ace.js` as an asset
  and surface it via a SEA-aware loader. Not in scope; the limitation is
  small enough that documentation is the right answer for now.

### Verification

- Manually re-read the README section after the edit. Make sure the
  caveat reads naturally and doesn't break the surrounding paragraph
  structure.

### Files touched

- `cli/README.md`

---

## Sequencing

Phase ordering doesn't matter much — these are all small, independent fixes.
Recommended order:

1. Gap #1 (init.ts) — small code change, tests verify no regression.
2. Gap #4 (prompts.ts split) — pure refactor, byte-equivalence test gates
   it.
3. Gap #5 (README) — documentation only.
4. Gap #3 (skeptic test smoke step) — small YAML addition.
5. Gap #2 (Verdaccio job) — biggest YAML addition; do last so it doesn't
   block the smaller fixes.

Verification step (#56) runs after all five.

---

## Verification (full)

After all 5 gaps are closed:

- `cd cli && npm run check` — 0 type errors.
- `cd cli && npm run build` — bundle builds, no warnings beyond the
  pre-existing `"Stats"` unused-import notice.
- `cd cli && npm test` — 931 (or 932 with the new byte-equivalence
  assertion) passing.
- `node dist/skeptic.mjs init /tmp/skeptic-gap1` — verify the new
  `runBrowsersInstall` path executes; warning text mentions
  `skeptic browsers install` not `npx playwright install`.
- Workflow YAML: `actionlint` (or `gh workflow view release.yml`) — no
  syntax errors.

---

## Critical files index

| File | Gaps | Change |
|---|---|---|
| `cli/src/commands/init.ts` | 1 | Replace npx execSync with dynamic-imported runBrowsersInstall + update warning text |
| `cli/src/ai/prompts.ts` | 4 | Add `<NAME>_STATIC_PREFIX` + `<name>DynamicSuffix(args)` exports for 5 prompts; keep combined exports |
| `cli/__tests__/unit/ai/prompts.test.ts` | 4 | Add byte-equivalence assertions per split prompt |
| `cli/README.md` | 5 | Add SEA-binary Equal Access caveat |
| `.github/workflows/release.yml` | 2, 3 | Add `Smoke — skeptic test` step + new `install-from-tarball-test` job that gates `publish` |

---

## What's NOT in scope

- Wiring `cachedContents` / `cache_control` API calls (Phase 5 plan
  explicitly defers this; gap #4 only does the structural split).
- Embedding `accessibility-checker-engine/ace.js` as a SEA asset (gap #5
  documents the limitation rather than fixing it).
- Any change to the Phase 6.0 SEA spike requirement on Node 25.5+ — that
  remains a manual gate before tagging `v0.2.0`.
