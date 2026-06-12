# SOTA Readiness — Active Plan

Full audit report and detailed checklist: `plans/sota-readiness-plan.md`.
**Architecture decision (2026-06-11): agent-native, model-free core.** Skill + CLI (+ daemon). No MCP, no ACP, no built-in model clients — the host coding agent is the intelligence. Web and mobile are co-equal platforms.

## Phase 0 — Emergency (live exposure; repo + npm already public)
- [ ] One-line patch release: bump retiring Anthropic default model (dies 2026-06-15) — full AI removal lands next minor
- [ ] License attribution for bundled axe-core (MPL-2.0) + ~20 deps; root LICENSE; root README
- [ ] Untrack internal files (plans/, tasks/, internal docs/, .claude/ state, .expect/, cli/.skeptic/.gen-*)
- [ ] Fix .gitignore coverage/ pattern hiding ast-extraction.test.ts from CI
- [ ] SECURITY.md; fix ws vuln; dependabot

## STATUS (verified green: 104 test files, 791 passing, 1 skipped; tsc clean; build clean)

### Mobile parity collectors — DONE & LIVE-VERIFIED on a real emulator (2026-06-12)
Emulator-5554 (Android 16) running the real `app.fieldwork.android` app. The previously
environment-blocked live verb-loop now works end-to-end (open→snapshot→click→re-snapshot,
~2s dumps), and all four device-evidence collectors are verified against live data.
- **New `src/driver/mobile/device-evidence.ts`** + `MobilePerformanceSnapshot`/`MobileAccessibilitySnapshot`/`MobileNetworkSnapshot` types (distinct from web shapes, `platform:"android"` discriminant). Wired into `adb-session.collectEvidence` (gathered in parallel).
  - **perf** (gfxinfo frames/jank/percentiles/missed-vsync + meminfo PSS/RSS + `am start -W` launch) — live: `totalFrames:537, jankyPercent:2.79, p50/p90/p95/p99=16/18/18/31, PSS 112MB`.
  - **a11y** — structural uiautomator heuristics (unlabeled-clickable, sub-48dp touch target, NAF); honest "no contrast" note. Live: 3 clickables checked, 0 issues (clean screen); unit-tested to CATCH all three rules on a fixture.
  - **network** — `degraded:true` per-uid byte totals from netstats. Live: `rx 1.7MB, tx 3.1MB`.
  - **video** — `recordVideo` via `screenrecord` (bounded ≤20s, +per-call adb timeout) → `record` verb. Live: real 3s mp4, `degraded:false`.
- **New CLI verbs:** `perf` / `a11y` / `network` / `record` (+ `session.record`/`observe` RPC). `is enabled`/`screenshot`/`scroll` all live-verified on the device; `is checked`/`get value` correctly return structured `[adbQuery:*_unsupported]`.
- **Blank-capture guard (answers "prevent recurrence"):** the AVD was launched `-no-window` with a GPU mode that doesn't composite into screencap → blank screenshots/recordings (even the system launcher captured blank). Root-caused, restarted the emulator with `-gpu swiftshader_indirect` (cold boot) → capture now real (launcher 10KB→1.3MB). skeptic now **detects** a near-uniform frame (`detectBlankCapture`, reusing `detectBlankFrame`'s variance signal — the web byte-floor rule misses full-screen blanks) and attaches a `blank-screenshot` diagnostic with the exact GPU-mode remediation. SKILL.md mobile section documents it. +13 unit tests (parsers vs real fixtures, a11y heuristics, netstats scoping, blank detection).

### Small-P3-cleanups bucket — DONE & verified (2026-06-12)
Hybrid (3 parallel leaf agents + lead-owned entangled CLI core) → build+tsc+full-suite green (778 pass).
- **Done:** `shardId` now populated so reporters/TUI label `[shard N]` · `scroll` verb (element scroll-into-view via `@ref`, viewport pan via `--dx/--dy`) · broadened query surface — new `is visible|enabled|checked` + `get value` (driver seam gained `isVisible/isEnabled/isChecked/inputValue`; web full, Android best-effort for visible/enabled + structured-unsupported for checked/value) · `-t/--grep <substring>` run flag (wired the orphaned `nameFilter`, switched it from exact→substring to match vitest/playwright; +6 unit tests) · HAR card in report.html (leaf agent) · doctor session-daemon visibility + removed dead `getSessionLogPath` (leaf agent) · inspect/snapshot-render `formatNumber` dedup (shared; footer dedup left documented — has byte-significant divergences + no byte-test).
- **Two audit findings were WRONG (caught by verifying-by-running, not trusting the audit):**
  - `--features` already works — `bin/skeptic.ts:16` prints the build-time feature map as a fast-path and exits. The audit critic missed the bin entry. Reverted the redundant index.ts handler I'd added (it would've produced a divergent second output).
  - **Regression fixed:** the prior batch removed `fast-xml-parser` as "unused", but `src/driver/mobile/uiautomator-parse.ts` imports it at runtime. Root cause: the aliased bash `grep` function uses `-I` (skip binary files) and that .ts file reads as binary (non-ASCII unicode-wall chars), so every `grep` over it returns a false negative. Restored to devDeps + `tsup` noExternal (now inlined into dist, verified), corrected the CHANGELOG. Saved a memory ([[bash-grep-false-negatives]]) — use the Grep tool / `/usr/bin/grep`, never the bash `grep`, for any "is this unused?" decision.
- **Mobile honesty:** Android `is checked`/`get value` reject with structured `[adbQuery:*_unsupported]` errors (NativeNode doesn't retain those attrs) rather than lying.

### Audit-driven pending-work batch — DONE & verified (2026-06-12)
Code-verified audit (10 agents) → 8-agent file-partitioned fix → build+tsc+full-suite green (767 pass).
- **P1 invariant residue:** `add.ts` `findBundledSkillDir` now resolves `../agent-skills` from the flat dist (so `add skill` finds the real SKILL.md), and `EMBEDDED_SKILL_MD` fallback rewritten with ZERO MCP/AI/`generate` surface (was reintroducing `browser_open`/MCP/`generate --diff` and clobbering good installs). Purged `--ai/--provider`/`ai`-fixture from AGENTS.md + README.md, and the orphaned `ai.assert/assertNoDefects/extract` labels from `api/labels.ts` (+ their 2 tests + page-proxy comment). Repo-wide `ai.*` residue now ZERO.
- **P2 correctness:** sharded runs no longer spuriously exit 1 on empty/over-provisioned shards (precise post-filter `discoveredCount` threaded through `RunnerOutcome`; a `--tag` matching nothing still exits 1) · enum flags `--blank-frame-detection`/`wait --state`/`--platform` now validate (typo no longer silently degrades `fail`→warn or `ios`→chromium) · adb `clearField` dead busy-loop removed + reliable bounded clear · `har-capture`/`self-healing` integration tests now hard-assert (the soft-return masked a real 30s event-loop-starvation bug, now fixed; har-capture 31s→0.9s) · dialog+crash evidence capture in console-collector · benchmark repointed off the deleted MCP client onto real session verbs + warm-latency budget + daemon-isolation assert.
- **P3 OSS hygiene:** `cli/LICENSE` ships in tarball · npm provenance/OIDC + concurrency guard + LTS Node 24 in release.yml · `.github/dependabot.yml` · dropped unused `fast-xml-parser` (matched CHANGELOG) · accessibility-checker-engine attribution (corrected to Apache-2.0, the real license) · CHANGELOG cut into 0.2.0/0.2.1 dated sections.
- **Mobile do-ables:** `skeptic devices` verb (adb + macOS simctl preview) · adb/simctl/idb probes in `doctor` · Android `screenshot` rejects `--annotate` with a structured error instead of silently dropping it.
- **Remaining (verified-pending, not in this batch):** P3 small cleanups (shardId label unpopulated, dead `--features` flag, HAR not linked in report.html, `scroll` verb + broader `get/is`, orphaned `nameFilter`, inspect renderer dedup, session-daemon doctor visibility); mobile parity collectors (screenrecord video, gfxinfo perf, a11y heuristics, netstats) + Android path in `skeptic run`. Blocked: iOS sim driver, live Android device proof + M0 dump-latency spike, M4 fast-lane, skill-evals harness.

## (earlier) STATUS — agent-native restructure + bug/perf/hygiene baseline

Done & verified this session (all with regression tests + a real linked `skeptic run`):
- **Agent-native restructure**: MCP/ACP/AI deleted, 88 npm pkgs removed, bundle 2.33→1.74MB, then splitting → **dist 4.3M→2.0M**, startup 90→70ms.
- **Runner** (9): worker-crash no longer exits 0 / synthesizes errors; artifact-dir collision fixed (file-slug); failure screenshots on run path (verified failure.png); --env/--cookies/device/baseURL wired; timeout/hardTimeout de-conflated; AbortSignal; parallel-by-default.
- **Commands** (10): all dead flags wired/removed (--visual-settle, --no-tui, browsers --dry-run, blank-frame); exit codes; numeric validation; tui keeps ResultsScreen; **always writes results.json** (verified); inspect −60%; prewarm overlap.
- **Snapshot** (6): byRef now async; viewport/registry agree; hrefIncludes; flat compact render; batched protocol calls.
- **Observability** (5 + 3 earlier): expectAccessible fails on engine error; impacts filter; report.html relative links; junit skipped; redaction gaps; + pageerror capture, network duration, (earlier).
- **Security** (4): file:// allowlist; parent-domain cookies; daemon idle-timer sees clients; daemon won't kill active clients; + Chrome M127 cookie fix (earlier).
- **Integration fixes by me**: blank-frame detector wired into screenshot.ts; skipped count in RunSummary + json reporter; P8 bundle splitting.
- **Hygiene**: LICENSE, root README, SECURITY.md, CHANGELOG, CONTRIBUTING, CLAUDE.md rewrite, Dockerfile, attribution, CI cache/concurrency, npm audit fix.

Remaining LARGE builds — **fully planned, execution deferred by owner ("plan only for now")**:
- Roadmap: `plans/velvety-scribbling-ullman.md` (approved 2026-06-12). Build order:
  1. [x] **Foundation: `Driver`/`DriverSession` abstraction — DONE & verified.** src/driver/ (types + PlaywrightDriver/Session/Element + barrel); additive (zero existing-file changes); 10 new tests (8 unit + 2 real-browser smoke proving open→snapshot→resolveRef→click + ref invalidation). Suite 717 passing, tsc clean. Assumptions validated via /research (Playwright aria-ref CONFIRMED, idb CONFIRMED-WITH-CAVEAT).
  2. [x] **Change A: CLI interaction verbs + daemon-held sessions — DONE & verified.** SessionRegistry + session-rpc dispatch + headed session daemon + client + 18 verb commands (open/snapshot/click/fill/type/press/hover/check/uncheck/select/get/screenshot/console/wait/list/close) + shared snapshot-render. Real e2e: @eN refs persist across separate CLI processes (open→snapshot→click), stale-ref detection works. SKILL.md/README/AGENTS rewritten (MCP/AI removed). Suite 736 passing, startup 90ms. 2 real bugs found+fixed in verification (registry create-race, headed-handshake UX).
  3. [~] Change B: Mobile drivers — **Android adb driver BUILT & unit-verified.** src/driver/mobile/ (adb wrapper, uiautomator XML→CaptureResult parser, AndroidAdbDriverSession+element, AdbDriver factory, selectorHint resolver). 11 unit tests incl. a real emulator-captured Settings fixture; parser produces clean clickable rows with res= hints + tap coords; dump retry-loop handles the "null root" transient. `--platform android` wired through daemon/registry/verbs (folds into engine identity). SKILL.md mobile section added (RN/Compose/Flutter caveats, unicode wall). Suite 747 passing, startup 100ms. **Verification:** parser validated against a REAL uiautomator dump captured from the emulator (13 clean clickable rows, res= hints, tap coords); 11 unit tests cover parse/role/hint/nth/off-viewport/tap-coords/resolve/unicode-reject/dump-retry. The dump retry-loop confirmed against the real "null root node" transient (capture succeeded on attempt 5). Full live verb-loop on this box was blocked by the degraded headless-swiftshader emulator's unbounded dump latency under disk pressure — an environment artifact, not a code issue (a healthy device/CI emulator runs ~1-3s/dump per the research). iOS sim (simctl+idb) deferred — idb not installed here.
- [x] **Deterministic `skeptic scaffold <url>` — DONE & verified** (opens page via the Driver, snapshots interactive refs, emits a tests/<slug>.spec.ts skeleton; no LLM; real-browser integration test). Replaces the removed `generate`.
- [x] git hygiene: untracked personal `.claude` runtime state at commit time.
- [x] **Pushed to main** (f577364) + scaffold/hardening follow-up.
- [x] Mobile dump-hardening: bounded dump budget (~30s) → fails fast with an actionable diagnostic instead of hanging on an unresponsive device.

### Environment-blocked here (need a different machine/setup — NOT built blind)
- [ ] iOS simulator driver (`--platform ios-sim`, simctl + idb): **no simctl/idb/simulator on this box** — fully designed in plans/velvety-scribbling-ullman.md; build it where it can be run+verified (full Xcode + `brew install idb-companion`).
- [ ] Skill-evals harness (real `claude -p`/`codex exec` scored on skill compliance): CLIs exist but it needs installing the new skill into a sandbox + recursive agent runs that modify `~/.claude` — do in a dedicated setup.

### Remaining (verifiable, but risky/large — pick deliberately)
- [✗] P2 worker-reuse single-compile — **MEASURED, then IMPLEMENTED far enough to prove the premise void, then reverted. Final verdict: do NOT do it.**
  - Empirical: a 10-spec run (parallel 4, --no-daemon) is ~1.7s TOTAL. The double-import overhead can't be ~3s (275ms×10) because **discovery is already fully parallelized** (`Promise.all` over all specs) — its wall-clock is ~one worker's tsx-init (~300-500ms), not the sum. So eliminating the discovery phase saves only ~0.3-0.5s wall-clock for typical suites, regardless of spec count (it's parallel).
  - **Implementation finding (2026-06-12, the decisive one):** single-import via per-file self-discovery CANNOT replace the two-phase path — `shard.ts` partitions at the **test** level (`i % shardCount` over the flat global list) and `--list` needs the full manifest, so both REQUIRE the upfront global collect. Self-discover can therefore only run *alongside* the existing path as a divergent second code path, with two behavior changes the other path wouldn't share: (a) `test.only` goes global→per-file (and would mean different things with vs without `--shard`), (b) the live TUI loses its upfront `totalTests` (built from the pre-discovered partition at `execute.ts:499`). That's strictly MORE complexity to save ~0.3s — the opposite of the "cleaner codebase" reason it was greenlit for.
  - The current discover→execute model is the **standard collect-then-run pattern** (Vitest/Jest/Playwright). Using separate processes for the two phases is a feature: clean isolation, a discovery crash can't corrupt execution state. The "double import" is a minor, standard inefficiency, not a cleanliness defect.
  - The only genuinely-clean single-import variant is a Vitest-style **persistent worker pool** (hold workers across collect→execute so the import is reused while keeping global `.only` + upfront count + test-level sharding). That's a moderate-risk rewrite of the runner's worker lifecycle for the same sub-second win — not worth it now; revisit only if startup latency becomes a real, measured signal. Lower-risk lever if so: tsx→esbuild loader (no behavior change).
  - WIP reverted to the green committed state; suite re-verified 101 files / 759 passing / 1 skipped, tsc clean.
- [ ] Phase-4 differentiators: self-healing-as-agent-loop, email/OTP + dynamic data, HAR export. New features.
- [x] P10 flat compact render — already implemented (compactTree drops structural noise).

## Phase 1 — Agent-native restructure + fix the agent loop
- [x] Delete src/mcp/, commands/mcp.ts, commands/acp.ts, acp-prompt-parser **(DONE — build green, 599 tests pass, bundle 2.33MB→1.74MB; salvage of session/path-containment deferred to verb bundle)**
- [x] Delete src/ai/ + ai fixture + --analyze + AI coverage; strip deps/flags/schema **(DONE — 88 npm packages removed; import-graph/route-resolver recoverable from git for scaffold)**
- [x] Fix .gitignore coverage/ pattern (was hiding ast-extraction.test.ts; also blocked git rm) **(DONE)**
- [ ] Replace generate with deterministic `skeptic scaffold` (recover import-graph/route-resolver from git)
- [ ] Build CLI interaction verbs on daemon-held session (open/snapshot/click/fill/type/press/wait/screenshot/console/network/a11y/perf/close, all --json)
- [ ] Rewrite SKILL.md (CLI verbs + inspect→author→run loop + cold-start branch; drop MCP/ai sections); fix `add skill` stale-copy bug; CLI-served versioned skill; rewrite CLAUDE.md
- [ ] Always write results.json on run (skill promise)
- [ ] API: byRef union type; viewport-filtered ref mismatch; baseURL no-op; timeout conflation; hrefIncludes; describe/step/visual matchers
- [ ] Runner: worker-crash exit 0; dead --env/--cookies/device; artifact collisions; failure screenshots; dead flags; tui 120ms unmount; exit codes; AbortSignal plumbing
- [ ] Daemon: idle timer must see WS clients + CLI sessions; per-config daemon slots
- [x] Security: Chrome cookie 32-byte prefix (crypto.ts — verified vs M127 scheme, +4 regression tests) **DONE**; [ ] file:// allowlist bypass; [ ] parent-domain cookies
- [x] Observability: pageerror capture (console-collector, +2 tests) **DONE**; network duration bug (verified vs Playwright types, fixed) **DONE**; [ ] expectAccessible false-pass; [ ] impacts no-op; [ ] report.html links

### Verified-green checkpoints this session
- Agent-native restructure complete: MCP/ACP/AI deleted, build green, bundle 2.33MB→1.74MB, 88 npm pkgs removed
- 3 high-sev bug fixes landed with regression tests; full suite 604 passing / 1 skipped; `npm run check` clean
- All findings re-verified against current code before fixing (network-duration + cookie-prefix confirmed against Playwright types / Chromium M127 scheme, not taken on trust)

## Phase 2 — Performance (measured)
- [ ] P1 inspect −60%; P2 single-compile + esbuild; P3 parallel default; P4 prewarm overlap; P5 adaptive settle; P6/P7 batch snapshot calls; P8 bundle splitting; CI perf budgets

## Phase 3 — OSS hygiene (changelog, immutable tags, CI cache, Dockerfile, lint, completions, config introspection)

## Phase 4 — Differentiators vs Passmark (agent-loop self-healing via failure-point snapshots, email/OTP + dynamic data without Redis, visual baselines, saved flows/learnings, skill evals harness, $0 cost story)

## Workstream B (parallel) — Mobile via adb-direct (isMobile/hasTouch quick fix → dump-latency spike → M0 Driver extraction → M1 AdbDriver → M2 evidence → M3 mobile CLI verbs + skill; iOS sim via simctl+idb; real iOS descoped)
