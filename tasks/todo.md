# SOTA Readiness — Active Plan

Full audit report and detailed checklist: `plans/sota-readiness-plan.md`.
**Architecture decision (2026-06-11): agent-native, model-free core.** Skill + CLI (+ daemon). No MCP, no ACP, no built-in model clients — the host coding agent is the intelligence. Web and mobile are co-equal platforms.

## Phase 0 — Emergency (live exposure; repo + npm already public)
- [ ] One-line patch release: bump retiring Anthropic default model (dies 2026-06-15) — full AI removal lands next minor
- [ ] License attribution for bundled axe-core (MPL-2.0) + ~20 deps; root LICENSE; root README
- [ ] Untrack internal files (plans/, tasks/, internal docs/, .claude/ state, .expect/, cli/.skeptic/.gen-*)
- [ ] Fix .gitignore coverage/ pattern hiding ast-extraction.test.ts from CI
- [ ] SECURITY.md; fix ws vuln; dependabot

## STATUS (verified green: 89 test files, 707 passing, 1 skipped; tsc clean; real e2e run confirmed)

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
- [ ] Adjacent: deterministic `skeptic scaffold` (recover import-graph/route-resolver from git)
- [ ] P2 worker-reuse single-compile (deferred — complex)
- [ ] git hygiene: untrack internal plans/tasks/.claude at commit time

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
