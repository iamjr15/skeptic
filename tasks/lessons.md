# Lessons Learned

## Bug Patterns

### 1. Don't release resources in `finally` blocks when retry is possible
**File:** `backend/app/adapters/inbound/api/v1/recording_controller.py`
**Pattern:** A `finally` block released the Steel browser session even on validation errors (400 "No interactions recorded"). This made user retry impossible — the session was already gone.
**Fix:** Move resource release (session cleanup) to the **success path only**. Keep only lock/mutex cleanup in `finally`.
**Rule:** If a resource might be needed for retry after a non-fatal error, don't release it in `finally`. Only release on success or unrecoverable failure.

### 2. Rebuild Docker images after adding Python dependencies
**Pattern:** Added `steel-sdk>=0.16.0` to `pyproject.toml` but didn't rebuild Docker image. Container crashed with `ModuleNotFoundError: No module named 'steel'`.
**Fix:** `docker compose build api` before `docker compose up -d api`.
**Rule:** After modifying `pyproject.toml` or `requirements.txt`, always rebuild affected Docker images.

## Testing Patterns

### 3. Chrome remote debugging for authenticated frontend testing
**Pattern:** Google OAuth blocks Playwright/automated browsers ("This browser or app may not be secure"). Cannot authenticate via agent-browser.
**Fix:** Use Chrome 144+ remote debugging: enable at `chrome://inspect/#remote-debugging` (starts server on port 9222), then connect with `agent-browser --auto-connect`.
**Rule:** For testing frontends that require real OAuth (Google, etc.), connect to user's existing authenticated Chrome via remote debugging.

### 4. Baseline-delta teardown strategy
**Pattern:** Tests create resources (test cases, sessions) that must be cleaned up without deleting pre-existing data.
**Fix:** Snapshot existing IDs before tests (`baseline`), after tests compute delta with `comm -23 <(current | sort) <(baseline | sort)`, delete only the delta.
**Rule:** Always snapshot before, diff after. Never bulk-delete.

### 5. Empty allowed_domains means "deny all" (not "allow all")
**File:** `backend/app/domain/services/url_validator.py`
**Pattern:** `_is_allowed_domain()` returns False when `allowed_domains` is empty. Tested with `start_url: "https://example.com"` and got 400 because the test project had no allowed domains configured.
**Rule:** When testing URL validation, check the project's `allowed_domains` first. Empty list = all non-localhost URLs rejected.

## skeptic CLI / Plan Implementation Patterns

### 6. Playwright `Locator.ariaSnapshot` mode argument is `"ai"`, not `{ ref: true }`
**File:** `cli/src/executor/aria-snapshot-capture.ts`
**Pattern:** Earlier draft of plan #31 referenced a `{ ref: true }` option. Playwright's actual API is `{ mode: "ai" }`. The "ai" mode emits `[ref=eN]` annotations and snapshots iframes; the default mode emits no refs.
**Rule:** When porting an external pattern (Expect's snapshot-ref), always re-verify the Playwright API surface in `cli/node_modules/playwright-core/types/types.d.ts`. Don't trust draft plan text — the API may have shifted.

### 7. `.nth(0)` is correct for nth=0; never special-case it
**File:** `cli/src/executor/aria-ref-resolver.ts`
**Pattern:** Tempting to write `if (nth === 0) loc.first() else loc.nth(n)`. This breaks duplicate disambiguation: when two buttons share a name, e1 (nth=0) and e2 (nth=1) both need `.nth(N)`. A first/post-check `total > 1 → ambiguous` would incorrectly fail e1 when 2 matches exist.
**Rule:** For Playwright locator indexing, always use `.nth(N)` directly. The "ambiguous" error class is unnecessary if you use the recorded position; the only failure mode is "live page has fewer matches than recorded" (= stale).

### 8. Negative assertions must NOT treat resolver errors as absence-success unless they're truly absence
**File:** `cli/src/executor/step-handlers/assert-not-visible.ts`
**Pattern:** `assertNotVisible: "@e1"` with no prior `ariaSnapshot` step would silently pass if `isAbsentError` treated AriaRefError as absence. A missing/stale ref is an authoring/staleness problem, not "the element isn't visible."
**Rule:** When adding a new structured error class, audit `isAbsentError` (and any equivalent absence-classifier) and explicitly EXCLUDE the new class. Default to "not absence" — the wrong answer here is a false-positive green test.

### 9. Snapshot YAML may contain typed-in PII — never log it
**File:** `cli/src/executor/aria-snapshot-capture.ts`, `cli/src/executor/context.ts`
**Pattern:** ARIA snapshots include accessible names of every element in scope: form values, email addresses, etc. Embedding raw YAML in logs/reporters/StepResult would leak user data.
**Rule:** Stash large user-derived blobs on the execution context as in-memory-only state. Make export opt-in (e.g., explicit `storeAs:` field). Cap size at a sensible default (256 KiB), env-tunable for power users.

### 10. Defensive guard in primitives prevents confusing fallback-chain errors
**File:** `cli/src/executor/element-resolver.ts`
**Pattern:** If `@e1` accidentally reached `resolveElement` (the bare-string auto-detect chain), the user would get "Could not find element matching '@e1'" — completely unhelpful. The fix at the dispatcher level (resolveSelectorArg) is correct, but the primitive should also throw an internal-error explainer.
**Rule:** When the dispatcher routes around a primitive, add a sentinel throw in the primitive itself. Defense in depth catches future callers that bypass the dispatcher.

### 11. Playwright `ariaSnapshot({ mode: "ai" })` mints refs starting at `e2`, not `e1`
**File:** `cli/__tests__/integration/aria-snapshot.test.ts`
**Pattern:** Plan #31 assumed refs are 1-indexed (`@e1` for the first interactive element). In practice, Playwright reserves `e1` internally and the first ref-eligible child of the snapshot's root gets `e2`. For a body-scope snapshot of `<body><button>Sign in</button></body>`, the YAML is `- button "Sign in" [ref=e2]`.
**Rule:** When writing tests against `ariaSnapshot` output, never hardcode `@e1` as "the first element." Probe the actual YAML once with a quick playwright script before pinning ref numbers in test fixtures.

### 12. tsc with `rootDir: "."` emits to `dist/src/`, not `dist/`
**File:** `cli/package.json`, `cli/tsconfig.json`
**Pattern:** Plan #26 specified the build copy step as `cp src/commands/recorder-script.js dist/commands/recorder-script.js`. The build failed: `cp: dist/commands/recorder-script.js: No such file or directory`. The tsconfig's `rootDir: "."` (combined with includes from both `bin/` and `src/`) makes tsc preserve the source-tree prefix in the output — so the actual emit path is `dist/src/commands/`, not `dist/commands/`. The `RECORDER_SCRIPT_PATH` resolution at runtime (`path.dirname(fileURLToPath(import.meta.url))`) computes correctly from the compiled-file location, so it follows the same `dist/src/commands/` layout.
**Rule:** Before writing a `cp` step that targets a tsc emit path, run `tsc` once and `ls dist/` to confirm where files actually land. tsc's `rootDir` controls this — `rootDir: "src"` flattens `dist/`, `rootDir: "."` (or omitted with multiple top-level includes) preserves prefixes.

### 13. Playwright `addInitScript` doesn't reliably re-run after `page.setContent` on a fresh page
**File:** `cli/__tests__/integration/commands/record-script.test.ts`
**Pattern:** Init scripts registered via `context.addInitScript` are supposed to run on every navigation. With a freshly-opened page (still on the implicit `about:blank` after `newPage()`), `page.setContent(html)` doesn't always trigger a navigation event the init-script machinery recognizes — the script never installs and `window.__skeptic_recorder_installed` stays undefined. The four integration tests captured zero events on the first run.
**Fix:** Use `page.goto(\`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}\`)` instead. Data-URL navigation is unambiguous and consistently fires init scripts. Pair with `await page.waitForFunction(() => window.__skeptic_recorder_installed === true)` for an explicit ready signal so tests don't race the script install.
**Rule:** When writing Playwright integration tests for `addInitScript` behavior, never use `setContent` on a page that started life on `about:blank`. Use `goto` with a data URL or a real HTTP origin, and probe a script-side install flag before driving interactions.

### 14. Recorder dedup must compare ALL identity fields, not just selector+value
**File:** `cli/src/commands/record-session.ts` (`normalizeAndDedup`)
**Pattern:** Naive dedup checks `last.type === action.type && last.selector === action.selector && last.value === action.value`. For `openPage` events that all carry `selector === undefined` and `value === undefined` but distinct `url` fields, this drops legitimate distinct popups within the 200ms window. Same hazard for `press` events (different `key`).
**Rule:** Dedup keys for an action stream must include EVERY identity-bearing field of the action shape — for skeptic's recorder that's `type + selector + value + url + key`. When you add a new field to a captured-action shape, audit the dedup predicate and add the field to the comparison.

### 15. `oxc-resolver` defaults `symlinks: true` — set `false` so resolver output matches non-realpathed file lists
**File:** `cli/src/ai/coverage/import-graph.ts`
**Pattern:** Plan #32's coverage-builder tests failed only inside `mkdtempSync` directories on macOS. `git ls-files` (and `fs.readdirSync`) preserve the symlinked `/var/folders/.../tmp-xxx/...` path; oxc-resolver realpaths to `/private/var/folders/...`. The `fileSet.has(target)` membership check then fails for every imported edge because the strings don't match. Symptom: `coveredBy` map is non-empty for the directly-navigated page but empty for everything its imports touch — making the test pass for "page covered" but fail for "transitive coverage." Same hazard would hit users who keep their repo behind a symlink (dotfiles, monorepo-linked packages).
**Rule:** When you instantiate `ResolverFactory`, pass `symlinks: false` so resolver output matches whatever path representation your file enumerator emits. Don't realpath the project root to "fix" it — `git ls-files` returns symlinked paths, and you want consistency with the source of truth.

### 16. Test-mocking `node:child_process.execFileSync` globally pollutes ALL git callers, including indirect ones
**File:** `cli/__tests__/unit/ai/flow-generator-coverage.test.ts`
**Pattern:** `vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }))` was set up to control `git diff` output for the flow-generator. But `buildImportGraph` (called transitively from `generateFromDiff` when coverage is enabled) ALSO invokes `execFileSync("git", ["ls-files", ...])`. The dumb fallthrough returned the diff string AS IF IT WERE the file list, so `walkDir` was never reached and the graph was empty. Resulting symptom: `[no test]` for every changed file even though the fixture had a matching flow.
**Rule:** When mocking `execFileSync` globally, branch on `args[0]` for every git subcommand reachable from the code under test — not just the ones you care about. Throw for the unhandled subcommands so the production code's try/catch fallback (e.g., `git ls-files` → `walkDir`) kicks in cleanly. Audit transitive callers before declaring the mock complete.

### 17. Commander `--no-X` flips the option to `false`, but you still must check `=== false` (not `!opts.X`)
**File:** `cli/src/commands/generate.ts`
**Pattern:** `--no-coverage` makes Commander set `opts.coverage = false`. Default value is `true` (Commander's default for `--no-*` boolean flags). The natural-feeling guard `if (!opts.coverage)` would also strip coverage when the flag is undefined or any falsy value — but with the default-on convention, undefined means "the flag wasn't passed, run with coverage." Use `opts.coverage === false` to explicitly mean "user passed --no-coverage."
**Rule:** For Commander `--no-*` flags, gate behavior with `=== false`, not `!`. Document the field as "false when --no-X; default true" in the options interface so future readers know the convention applies.

### 18. `@agentclientprotocol/sdk` constructor takes `(toAgent: factory, stream: Stream)` — not a config object with `onSessionPrompt`-style handlers
**File:** `cli/src/commands/acp.ts`
**Pattern:** Plan #27 sketched the SDK API as `new AgentSideConnection({ onInitialize, onSessionPrompt, onSessionCancel })` with a separate `connection.connect({ stdin, stdout })` call. The actual SDK (`@agentclientprotocol/sdk@0.20.0`) takes a factory `toAgent: (conn) => Agent` and a `Stream` produced by `acp.ndJsonStream(stdoutWebWritable, stdinWebReadable)`. Connection is established in the constructor; you await `connection.closed` for the lifetime guard. The agent class implements the `Agent` interface — methods `initialize`, `newSession`, `prompt`, `cancel`, `authenticate` — not `on*` callbacks.
Four more SDK shape mismatches between the plan and the actual code:
  1. **No `acp.CancelledError` class.** Cancellation is your own AbortController; on `cancel()`, abort + force-close engines, then in `prompt()`'s catch block test `signal.aborted` to choose the cancel branch.
  2. **`StopReason` union has NO `"error"` variant** — it's `"end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"`. Tool-level failure surfaces via the final `tool_call_update.status: "failed"`; the prompt response stays `end_turn`.
  3. **`ToolCallStatus` union has NO `"cancelled"` variant** — it's `"pending" | "in_progress" | "completed" | "failed"`. The plan's "emit final tool_call_update with status=cancelled" instruction can't be honored as written; emit `status: "failed"` with text `"Cancelled by user."` instead. The cancel signal goes via the `PromptResponse.stopReason: "cancelled"` (which `StopReason` does have).
  4. **`SessionUpdate` discriminator is nested.** Notifications go through `connection.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call", ... } })` — the outer field is `update`, the inner discriminator is `sessionUpdate`. Plan and SDK agree on the inner name; the wrapping `update` is easy to miss.
**Rule:** Always read `node_modules/<sdk>/dist/index.d.ts` (and the example agent under `dist/examples/`) before writing handler skeletons. Plan-level "treat names as placeholders" is not a substitute for reading the schema — pre-flight gate is non-negotiable: install the SDK, then read the `.d.ts` for `AgentSideConnection`, `Agent`, `Stream`, `SessionNotification`, `StopReason`, before drafting handler code.

### 19. ACP server mode must redirect logger to stderr BEFORE the SDK opens transport — stdout is the NDJSON channel
**File:** `cli/src/utils/logger.ts`, `cli/src/utils/log-stdio.ts`, `cli/src/commands/acp.ts`
**Pattern:** skeptic's logger writes `info`/`success`/`raw` to `console.log` (stdout) by default. ACP frames JSON-RPC over stdout, so any stray log corrupts the stream and clients fail to parse. Fix: add a `setStream(stream)` override on the logger so `format(...args) + "\n"` is written to the override stream instead of `console.*`. Then in `runAcp()`, call `redirectStdoutLogsToStderr()` BEFORE `new AgentSideConnection(...)`. Tested via `cat acp.stdout | jq -c '.'` — every line must parse, with all log output captured to stderr.
**Rule:** Any new long-running stdio protocol surface (MCP-style server, ACP server, future LSP, etc.) must own stdout exclusively. The logger module needs a stream-override hook so each protocol command can divert log output up front. Adding `setStream` once and reusing it scales better than per-command monkey-patching.

### 21. DOM-visible ≠ screen-visible: WebGL preloaders silently break "passing" screenshot evidence
**File:** `cli/src/executor/step-handlers/screenshot.ts`, `cli/src/executor/visual-settle.ts`
**Pattern:** A flow `navigate → assertVisible(text) → screenshot` can pass while the screenshot is solid black if the page has a WebGL/canvas preloader (e.g. `preloader-shader.js`). `assertVisible` checks DOM presence; `page.screenshot` reads the compositor; the canvas paints black until the load handler completes. Reproduced on `jigyansurout.com` — old runs produced a 4 255-byte 1280×720 all-black PNG while the test reported PASS.
**Fix:** Two-part. (a) Visual-settle helper that runs `networkidle` (capped) + double-RAF + optional pixel-stability poll *before* screenshots. (b) Two-flag blank-frame detector (variance + size) that warns on default and fails under `--observability`. Settle is opt-in to keep the fast path zero-cost.
**Rule:** Default screenshot pipelines should not assume DOM-visible ⇒ screen-visible. If the asserted text is behind a preloader/animation, the screenshot can lie. Surface the lie via diagnostics; don't let "silent green" hide bad evidence.

### 22. Playwright `recordVideo` silently clamps to ~800w when `size` is omitted
**File:** `cli/src/executor/playwright-engine.ts`
**Pattern:** `context.newContext({ recordVideo: { dir: ... } })` defaults to 800×450 video regardless of the configured `viewport: { width: 1280, height: 720 }`. The recorded WebM is small (~3 KB on a 2-second flow) and useless for diagnostics. Confirmed in benchmark — old skeptic recorded 800×450 / 3 178 bytes vs Expect's 1.8 MB at 1920×1080.
**Fix:** Always pass `recordVideo.size: viewport` (or an explicit `videoSize` engine option) when `--video` is on. After the fix the same flow produces a 124 KB 1280×720 webm; under `--observability` (with pre-finalize settle), 256 KB.
**Rule:** When you set `recordVideo.dir`, ALWAYS set `recordVideo.size` explicitly. Never trust the default. This is the single line of code that makes video evidence useful.

### 23. JS try/finally CAN'T mutate a fresh object literal returned from try
**File:** `cli/src/executor/playwright-engine.ts`
**Pattern:** Old code shape `try { ... return { name, ...artifacts }; } finally { /* compute tracePath */ }` — the finally fires after the return statement constructs the literal, but it has no handle to that object, so `tracePath` set in finally goes nowhere. The trace file ended up on disk but wasn't surfaced to reporters. Tracked through with a Node REPL repro: a `return { x: 1 }` literal is unreachable from finally; only `let r = { ... }; return r;` allows finally-mutation because the reference handle survives.
**Fix:** Hoist `let result: FlowResult` to the top of `runFlow`, populate it inline, mutate from finally only for the *cleanup* path (page/context close), and move trace-stop INTO the try block before sidecar writes. Single `return result;` at end-of-try.
**Rule:** Any time you want a finally to influence the returned value, hoist a `let` and return it explicitly. Don't return object literals from functions that need post-return finalization.

### 24. Sidecar finalization order matters: each must run AFTER everything it documents
**File:** `cli/src/executor/playwright-engine.ts`
**Pattern:** `flow.json` (a per-flow slice of `results.json`) was originally written before `tracing.stop()` ran in finally — meaning the sidecar didn't include the trace path it should reflect. Codex caught this on round 2 of the plan review. Fix: explicit ordered block inside the try — collector snapshots → optional pre-video settle → video.saveAs → tracing.stop → perf-trace.md → console.json → network.json → flow.json LAST → return. Finally is reserved for page/context cleanup only.
**Rule:** When writing summary artifacts that reference other artifacts, the summary always goes last in the finalization sequence. Document the order with a comment-block; future maintainers will refactor pieces and reorder unless the dependency is explicit.

### 25. Use `defaultsForReports` for opt-in defaults — don't try to detect "user omitted the field" via Zod
**File:** `cli/src/config/schema.ts`, `cli/src/commands/test.ts`
**Pattern:** First draft tried "if `observability.collectors` was omitted, auto-attach perf+net+console". Zod's `.default([])` erases the difference between "user explicitly set `[]`" and "user omitted the field"; `parsed.observability.collectors === []` covers both. So the heuristic was unreliable. Codex flagged this on round 1.
**Fix:** Add an explicit `defaultsForReports: "none" | "passive" | "full"` knob. The merge logic in `commands/test.ts` always applies it (union with explicit `collectors`); user opts out by setting `defaultsForReports: "none"`. Cleaner than presence-detection, survives schema migrations, easy to test.
**Rule:** Don't lean on "did the user set this field?" semantics with Zod defaults. Use an explicit policy enum instead.

### 26. Console-text redaction needs more than URL scrubbing — it's free-form text
**File:** `cli/src/observability/url-redact.ts` (`redactConsoleText`)
**Pattern:** When adding console-message capture, the first impulse was "reuse `redactUrl` like the network collector does." But console messages contain free-form text — JWTs in the body, `Bearer` tokens in headers logged by app code, `password=hunter2` debug strings, email addresses. URL redaction misses all of those.
**Fix:** Layered regex pipeline: JWT pattern (`eyJ...`) → `Bearer <token>` → credential `key=value` / `"key":"value"` for password/token/secret/api-key (NOT including `authorization`/`auth` — those collide with the Bearer pattern) → email local-part (keep domain for diagnostic context) → URLs in text (delegate to `redactUrl`). Truncate to 4 KB. Default ON; opt-out logs a startup warning.
**Rule:** Console capture is a free-form-text PII surface, not a URL surface. Treat it that way. Default to redacting; the cost of a false-positive mask is much lower than the cost of leaking a token into a CI report.

### 27. Adding a `passed-with-warning` status would ripple through 12+ call sites — use diagnostics + status flips instead
**File:** `cli/src/executor/types.ts`, `cli/src/executor/step-handlers/screenshot.ts`
**Pattern:** Initial draft proposed a new `StepResult.status` value `"passed-with-warning"` for blank-frame warnings. Codex correctly flagged that the existing 4-value enum (`passed | failed | error | skipped`) is checked in 12+ places — `test.ts` pass/fail tallies, JUnit, retry, bail, TUI, etc. Adding a value silently breaks every `status === "passed"` consumer.
**Fix:** Don't extend the enum. Add structured `result.diagnostics: Array<{ kind, message, meta? }>` alongside `warnings`. Under `blankFrameDetection: "warn"` the step stays `"passed"` + adds a diagnostic. Under `"fail"` the existing `"failed"` transition handles propagation through every consumer with no cross-cutting changes.
**Rule:** Adding a new value to a widely-checked enum is a refactor of every callsite. Prefer structured side-channel data (`diagnostics[]`, `warnings[]`) over enum extension; flip status only when the existing transitions already cover the call sites you need.

### 28. `--observability` is a single-flag profile; CLI alias plumbing needs explicit merge logic in Commander
**File:** `cli/src/index.ts`, `cli/src/commands/test.ts`
**Pattern:** Wanted `--observability` and `--observe` to be aliases. Commander's `option(...)` API doesn't have a built-in boolean alias: `--observability, --observe` declared in one option treats the second as a short form, which gets weird. Codex round 2 caught the gap.
**Fix:** Declare the two as separate boolean options, then merge in `runTest`: `const flag = opts.observability ?? opts.observe ?? false;`. Mirrors the existing `--no-tui` / `--tui` precedent at `index.ts:88`. Add a unit test that asserts both flags produce identical `EngineOptions`.
**Rule:** For boolean CLI aliases under Commander, declare separately + merge. Always add an alias-equivalence test; otherwise you're trusting that nobody re-runs the merge logic in a different code path.

### 20. Path-traversal guards must check realpath escape, not just lexical containment — and must validate BEFORE reading
**File:** `cli/src/commands/acp.ts` (`boundPath`, `boundResolveFlows`)
**Pattern:** ACP runs untrusted prompts that include file paths and globs. Three traversal vectors:
  1. **Absolute path** (`/etc/passwd`) — reject before resolve.
  2. **Lexical traversal** (`../../etc/passwd`) — reject after `path.resolve` if the relative path leaves the root.
  3. **Symlink escape** — a symlink at `<root>/flows/escape.yaml` pointing to `/tmp/secret.yaml`. Lexical resolution thinks it's contained; realpath resolution shows it isn't. Without `fs.realpathSync(file)` + comparing against `fs.realpathSync(root)`, the YAML gets parsed and could leak via the tool's response.
For glob expansion, validate every match's realpath BEFORE calling `parseFlowFile` — earlier drafts used `resolveFlows` which parses inside the loop, so a symlink escape could have its YAML read before the boundary check fired. Switch to `resolveFlowPaths` (path-only), validate each match's realpath, then parse.
**Rule:** Sandboxed file access for any untrusted-input surface must do all three checks (absolute reject, lexical reject, realpath reject), and globs must validate-then-parse, not parse-then-validate. Compute the root's realpath once at session creation (`cwdReal`) and reuse it.

### 29. Network/console capture parity audit vs expect's MCP server (B5)
**Files:** `cli/src/observability/collectors/network-collector.ts`, `cli/src/observability/collectors/console-collector.ts`, `cli/src/observability/url-redact.ts`
**Pattern:** Plan §B5 included an explicit parity sweep against expect's `network_requests` and `console_logs` MCP tools to make sure skeptic's TS-pivot didn't regress the comprehensive jigyansurout benchmark numbers. Result: skeptic ahead on the network side (richer per-request `duration` ms, `frameUrl` provenance, and `transferSize` derived from `Performance.getEntriesByType('resource')`); skeptic ahead on the console side (default-on PII redaction via `redactConsoleText` — JWT, `Bearer`, `key=value` credential, email local-part, URL-token scrubbing — plus per-message `location` with `url+lineNumber+columnNumber` for source attribution). Expect's surface is leaner — they emit raw URL/method/status only — but skeptic's richer payload doesn't cost more capture-time work because it's piggybacked on already-attached CDP listeners.
**Rule:** When a parity audit pulls more from your collectors than the comparator's, document the deltas in the plan (swirly §B5) and link the lesson back. Future maintainers tempted to "simplify" by dropping `frameUrl` or `transferSize` need to know those fields are differentiators, not accidents. The audit also confirms the redaction defaults: `redactConsoleText` is **on** by default for console capture; opt-out logs a startup warning.

### 30. AGENTS.md ships via `package.json:files`, not via the dist tree
**Files:** `cli/package.json`, `cli/AGENTS.md`, `cli/LICENSES.md`, `cli/tsup.config.ts`
**Pattern:** B6 added `cli/AGENTS.md` and `cli/LICENSES.md` at the package root. tsup writes to `dist/`, so neither file would land in the npm tarball without an explicit `files: ["AGENTS.md", "LICENSES.md", ...]` entry. The license banner in tsup is a **separate** mechanism — it adds `/*! @license skeptic-cli — see LICENSES.md ... */` as the first line of every emitted `.mjs`, but the actual LICENSES.md content distributes via the `files` array. Both mechanisms must be in place for Apache 2.0 §4(d) attribution to be complete: the banner satisfies "wherever such third-party notices normally appear" for object form, the `LICENSES.md` distribution satisfies "within a NOTICE text file distributed as part of the Derivative Works." Verify with `npm pack --dry-run` after every files-array edit.
**Rule:** When you add a top-level docs file to a tsup-built package, edit `package.json:files` in the same change, and verify with `npm pack --dry-run` before merging. Don't trust that "tsup will copy it" — tsup only emits `dist/`. The `tsup.config.ts:banner` is an attribution mechanism for the bundled output, not a substitute for distributing the actual NOTICE file.
