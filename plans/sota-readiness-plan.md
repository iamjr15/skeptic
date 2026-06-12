# Skeptic — SOTA Readiness Audit & Plan (2026-06-11)

Multi-agent audit: 8 subsystem reviews + adversarial verification of every critical/high finding (41 verified, only 2 refuted), build/test/CI health, Passmark competitor research, aurum-refs comparison, adb-direct mobile architecture research, and a completeness critic. 54 agents total.

## Verdict

The architecture is genuinely good — lazy per-command imports (~90ms startup), build-time feature flags with DCE, typed IPC, a thoughtful snapshot→ref→selectorHint model, security-conscious ACP path containment, 791 passing tests, 3-OS CI matrix. **But the system does not currently deliver the flawless agent-triggered QA loop it promises.** The flag surface and docs rotted ahead of the implementation: ~a dozen advertised flags/features are dead or mis-wired, the spec-runner path silently drops features the engine path honors, and the agent skill's own Fast Loop doesn't produce the `results.json` it tells agents to read.

**Critical reframing: the repo is ALREADY public and `skeptic-cli@0.2.1` is ALREADY on npm** (published 2026-05-07). Everything below is live exposure, not pre-launch checklist.

## Positioning

Skeptic is ONE QA tool for **web and mobile apps equally** — same skill, same CLI, same `snapshot → ref → act → evidence` loop and `results.json` contract on both platforms. Web is simply the platform that shipped first. Mobile (adb-direct Android, simctl+idb iOS simulator) is a co-equal parallel workstream, not a later phase — and all README/SKILL.md/positioning copy must say "web and mobile" from the start.

## Architecture decision (2026-06-11) — agent-native, model-free core

The host coding agent provides ALL intelligence; skeptic provides deterministic capabilities + evidence. The pattern is **skill + CLI (+ daemon for session persistence)** — exactly how agent-browser and react-doctor work. Consequences:

- **Delete the MCP server and ACP server** (`src/mcp/`, `commands/mcp.ts`, `commands/acp.ts`, `acp-prompt-parser.ts`). The integration surface is the skill driving CLI commands over Bash. This deletes the MCP browser-leak bugs, the disconnect-cleanup bug, and the ACP cancel-abandonment bug outright.
- **Delete the AI subsystem from the core** (`src/ai/` clients, the `ai.*` fixture, `--analyze`, AI coverage mapping). The agent authors specs from `skeptic inspect` output, judges screenshots itself, and reads `results.json` itself. (Audit fact: `fixture.ai.*` never worked under `skeptic run` — no one depends on it.) This deletes the generate dynamic-import RCE class, the unwired `excludePaths` gap, and the stale-model-ID class, and shrinks the bundle.
- **Replace `skeptic generate` with deterministic `skeptic scaffold`** — template + inspect-informed selectors, no LLM. SKILL.md teaches inspect → author → run as the only generation path; the agent is the generator.
- **Add CLI interaction verbs** as the core agent surface (agent-browser parity): `skeptic open/snapshot/click/fill/type/press/wait/screenshot/console/network/a11y/perf/close` against a daemon-held session, all with `--json`. Everything MCP offered, available to any agent with a shell.
- **Trade-off accepted:** CI runs are deterministic-only — no runtime AI assertions, ever. Visual checks in CI = screenshot baselines + a11y + console + network. Judgment happens at agent-time or in agent-reviewed evidence. This is the positioning vs Passmark: zero API keys, zero Redis, zero LLM cost — bring your coding agent.
- Migration: keep deleted code on a branch for one release; announce in CHANGELOG since `skeptic-cli@0.2.1` is already public.

---

## Phase 0 — Emergency (this week; live exposure)

- [ ] **Anthropic default model `claude-sonnet-4-20250514` retires 2026-06-15 — 4 days.** The published `skeptic-cli@0.2.1` breaks for anthropic users on that date. Ship a one-line patch release bumping `DEFAULT_MODEL_BY_PROVIDER` (`cli/src/ai/client-factory.ts:13`, duplicated `anthropic-client.ts:11`) now; the AI subsystem's full removal (architecture decision) lands in the next minor and retires this problem class permanently.
- [ ] **License compliance:** MPL-2.0 axe-core + ~20 MIT/Apache deps are bundled minified into the published artifact with zero attribution (LICENSES.md attributes none of them; bundle banner promises it). Generate real attribution; MPL requires source-availability notice.
- [ ] **Scrub the public repo:** untrack `plans/`, `tasks/`, internal `docs/` (pitch, competitive analyses), `.claude/` session state + lockfile with session id, `.expect/`, `cli/.skeptic/.gen-*`, dangling symlink, empty leftover release dirs. History rewrite probably unnecessary (no secrets found in 23 commits) but decide explicitly.
- [ ] **Add root `LICENSE` file (MIT)** — GitHub/npm don't classify the project as MIT today. Add root `README.md` (landing page is currently empty).
- [ ] **`.gitignore` `coverage/` pattern silently excludes a real test file** (`ast-extraction.test.ts`) from git and CI. Fix the pattern, commit the file.
- [ ] **SECURITY.md** — a tool that decrypts browser cookies and executes arbitrary code needs a disclosure policy.
- [ ] Fix the `ws <=8.20.0` moderate vuln (via ink@7.0.2); add dependabot/renovate.

## Phase 1 — Fix the agent loop end-to-end (the core promise)

Every item verified-real with file:line evidence.

### Skill front door
- [ ] **Rewrite SKILL.md around the agent-native surface:** drop the "MCP Workflow" section and `fixture.ai` references; teach the CLI verbs for ad-hoc interaction, the inspect → author → run loop for specs, and the cold-start branch. One skill, web + mobile.
- [ ] SKILL.md Fast Loop never produces `results.json`/`report.html` it instructs agents to read — json/html reporters aren't active under default config (`SKILL.md:32`, `json-reporter.ts:71`). Always write `results.json` on `run`.
- [ ] No bootstrap path for un-initialized projects; the skill's only remediation (`npm install`) can't fix a repo where `skeptic init` never ran (`SKILL.md:22`). Add the cold-start branch (init → install → browsers install) with exact failure signatures.
- [ ] `skeptic add skill` installs a stale embedded skill copy — bundle path resolution bug (`add.ts:444`, candidates miss `<pkg>/agent-skills` from `dist/skeptic.mjs`).
- [ ] CLAUDE.md describes a YAML-flow architecture that no longer exists (nested-executor, raceWithHardTimeout invariants are gone — replaced by worker ceiling + runAction abort gate). Rewrite to match reality.
- [ ] Adopt agent-browser's pattern: CLI-served versioned skill (`skeptic skills get <name>` thin-stub) so installed skills never go stale; add version metadata to installed copies; `doctor` should check project dep presence + skill freshness.

### Spec-authoring API (what agents write)
- [ ] Remove `fixture.ai.*` from the fixture, types, and SKILL.md (per architecture decision — it never worked under `skeptic run` anyway, `worker.ts:171`).
- [ ] `byRef` returns `Locator | Promise<Locator>` — the exact SKILL.md usage `tree.byRef("eN").click()` fails typecheck and crashes for cursor-interactive refs (`snapshot.ts:43`). Make it uniformly async (or resolve eagerly).
- [ ] Default `snapshot()` silently drops off-viewport refs from the registry while still rendering them in YAML — agent reads `[ref=e9]`, `byRef("e9")` errors "not found" (`snapshot.ts:93`). Render and registry must agree.
- [ ] `test.use({ url })` doesn't set Playwright baseURL — relative `page.goto("/")` throws despite JSDoc (`test.ts:5`, `worker.ts:110`).
- [ ] `test.use({ timeout })` silently becomes the hard kill ceiling — soft/hard conflated (`worker.ts:104`).
- [ ] `byRole({ hrefIncludes })` can never match a normal link — `filter({has})` queries descendants; use `.and(locator)` (`snapshot.ts:147`).
- [ ] Add the Playwright table stakes agents expect: `test.describe/beforeAll/afterAll/test.step`, visual matchers (`toHaveScreenshot` — pixelmatch+pngjs already deps), `storageState`/locale/timezone/permissions in `test.use`, retain-on-failure artifact policies.

### Runner correctness
- [ ] **Worker crash silently drops remaining tests and can exit 0** (`execute.ts:249` — `worker.on("error")` doesn't set workerTerminated). Synthesize error results; never exit 0 on lost tests.
- [ ] **`--env`, `--cookies`, device UA/DPR are dead in the spec-runner path** — built, threaded over IPC, never read in `runOneTest` (`worker.ts:110`).
- [ ] **Artifact dir collision across spec files** — `<output>/login-0` from two files overwrite each other under `--parallel` (`worker.ts:98`). Key by file+test.
- [ ] **No failure screenshot in the spec-runner path** despite `screenshotOnFailure` config default true (engine path honors it; `worker.ts:262` catch block doesn't).
- [ ] Dead flags: `--connect` (registered, never read), `--visual-settle/--no-visual-settle` (settle hard-wired to `--observability`), `observe --no-tui` (Commander stores `tui`, code reads phantom `noTui`), `browsers install --dry-run` (still downloads!), blank-frame detection (fully wired in config, `detectBlankFrame` never called). Wire or delete every one.
- [ ] `skeptic tui` unmounts the TUI 120ms after run end — ResultsScreen with per-failure expansion is unreachable dead code (`run.ts:456`).
- [ ] Exit-code discipline: exit non-zero on zero discovered tests and `--list` discovery errors; validate numeric flags (bare `parseInt` NaN); document exit codes.
- [ ] Add `skipped`/`flaky` statuses; graceful Ctrl-C with partial results.json; per-attempt artifacts.

### Agent surface (CLI verbs + daemon) — replaces MCP/ACP per architecture decision
- [ ] **Delete `src/mcp/`, `commands/mcp.ts`, `commands/acp.ts`, `acp-prompt-parser.ts`** — removes the MCP browser-process leak (`browser-session.ts:338`), the disconnect-cleanup leak (`mcp.ts:589`), and ACP cancel abandonment (`acp.ts:504`) by deletion. Salvage the good parts: the browser-session lifecycle code becomes the daemon-held CLI session; ACP's path-containment logic moves to the CLI session layer.
- [ ] **Build the CLI interaction verbs** on a daemon-held session: `open/snapshot/click @ref/fill @ref/type/press/wait/screenshot/console/network/a11y/perf/close`, all with `--json`, with multi-tab support and wait/dialog primitives. Element-level verbs take refs/selectorHints — no arbitrary-JS escape hatch as the primary path.
  - **Hard prerequisite (verified against both codebases):** the current daemon protocol cannot support per-invocation verbs — it only hands out a BrowserServer wsEndpoint and *clients* own contexts, which die on disconnect (`client.ts:85-91`, `rpc.ts` has just ping/status/shutdown/getEndpoint). Session state (browser, pages, RefMap, collectors) must move daemon-side: convert `BrowserMcpSession` into the daemon-held session and marshal verbs over the socket — agent-browser's exact model (per-session socket + NDJSON line per command, no settle sleep, respawn-once on unreachable; their 0.27.2 cut warm dispatch to ~1ms).
  - **Copy from agent-browser 0.27.2:** command grammar (`@eN` refs, `snapshot -i/-c`, `find role/text/label` fallback ladder, `wait --url/--load/--fn/--text --timeout`, `get text/attr/value`), stable tab ids (`t1` + `--label`), `batch --bail`, per-session socket files with version sidecars, click-interception detection + scroll-into-view.
  - **Keep skeptic's advantages in every verb:** semantic re-resolution (getByRole + nth + retarget warnings — more durable than their backendNodeId fast path), `selectorHint` in all `--json` output (portable across calls; agent-browser refs aren't), and the evidence stack.
  - **Measured parity targets (warm, daemon up, page open):** open ≤250ms, snapshot ≤250ms, click ≤220ms, screenshot ≤250ms; snapshot payload ≤1.5× agent-browser bytes. Benchmarked today: agent-browser 163–202ms/verb; skeptic's persistent-session engine path already did open+click+screenshot+perf+a11y in **673ms total vs agent-browser's 2040ms** — the engine is competitive, the per-call surface is what loses (re-navigation + 1500ms settle + 105ms Node spawn → 2.4–3.7s/call today).
- [ ] **Daemon idle timer is blind to active WebSocket clients — kills browsers mid-run** (`lifecycle.ts:219`). Count WS connections and held CLI sessions as activity.
- [ ] **Single global daemon slot + restart-on-mismatch kills other clients' runs** (`client.ts:95`). Key socket by engine/headed/version, or refuse shutdown with active clients.
- [ ] Plumb AbortSignal through `runSpecs`/execute.ts so Ctrl-C and session teardown actually stop workers and browsers (still needed without ACP).

### Security
- [ ] ~~`skeptic generate` dynamic-import RCE~~ and ~~unwired `ai.excludePaths`~~ — **moot: deleted with the AI subsystem** (architecture decision). Verify no other path dynamic-imports unreviewed content; `scaffold` must be template-only.
- [ ] **Chrome cookie corruption:** 32-byte SHA256(host_key) prefix (Chrome M127+) never stripped after AES decryption (`crypto.ts:45`) — injected sessions silently broken on modern Chrome.
- [ ] `file://` and all non-http URLs bypass `allowedDomains` (`policy.ts:122`). Enforce the allowlist on navigation events in the daemon-held CLI session and the spec-runner/observe/inspect paths; block `file://` by default.
- [ ] Extract parent-domain cookies (`.example.com` for `app.example.com`) — common login-session failure.

### Observability correctness (the evidence is the product)
- [ ] **`pageerror`/`weberror` never captured** — uncaught page exceptions invisible; highest-signal QA event (`console-collector.ts:58`).
- [ ] **Network duration always undefined** — epoch-vs-relative mixup; `responseEnd` IS the duration (`network-collector.ts:73`).
- [ ] **`expectAccessible()` false-passes when the audit engine errors** (CSP-blocked axe etc.) — read `enginesErrored` (`api/observability.ts:166`).
- [ ] Accessibility `impacts` filter is a no-op on every surface (`accessibility-collector.ts:124`).
- [ ] `report.html` artifact links 404 under default relative outputDir (`html-reporter.ts:280`) — make paths relative to the report file.
- [ ] Redaction misses JSON-body credentials and OAuth fragment tokens; JUnit miscounts skipped.
- [ ] Add: HAR export / request-response headers+bodies (opt-in), per-navigation web-vitals (currently last-page-only), dialog/crash capture.

## Phase 2 — Performance (first-class requirement)

Measured (darwin-arm64, medians): `--help` 90ms, `--version` 80ms, `doctor --quick` 180ms, `observe example.com` 0.81s — startup engineering is genuinely good (lazy imports verified, Playwright/sqlite dynamic, collectors zero per-event IO). Ranked fixes:

- [ ] **P1 — `inspect` pays ~1.9s fixed latency** (hardcoded `DEFAULT_WAIT_MS=1500` at `inspect.ts:61` + mandatory networkidle at `:138`): 2.39s → 0.99s measured with `--wait 0`. Default wait to 0 + capped settle. −60% on the discovery primitive agents call most.
- [ ] **P2 — Every spec compiles twice via tsx (~275ms per tsx init; esbuild transform is 17-36ms).** Discovery worker imports the file, then execution worker re-imports (`discover.ts:98`, `worker.ts:39,418`). Fix: reuse the discovery worker for execution, then swap tsx for an esbuild `module.register` hook. Per-spec overhead ~640ms → <100ms; a 20-spec suite drops ~6-11s.
- [ ] **P3 — Default `--parallel` is 1** (`execute.ts:408`); measured 2.4x at `--parallel 4`. Default to `min(files, ceil(availableParallelism()/2))` — agents won't pass flags they don't know.
- [ ] **P4 — `run` serializes discovery then daemon prewarm** (`run.ts:353` → `:399`, independent). `Promise.all` saves ~300ms warm, seconds on cold daemon spawn.
- [ ] **P5 — Visual settle guarantees a fixed 500ms per screenshot** (`visual-settle.ts:34-76`: networkidle timeout == sleep, race can never finish early). Make adaptive.
- [ ] **P6/P7 — Snapshot hot path does per-element protocol round-trips** (serial selector generation up to 100 candidates, `aria-snapshot-capture.ts:278`; one `boundingBox` call per ARIA entry uncapped, `:139` — 613 calls on Wikipedia). Batch both into single `page.evaluate`s.
- [ ] **P10 — Snapshot output is 4.9× more expensive in tokens than agent-browser** (HN: 64.9KB/~16.2k tokens with 587 pure-structural noise lines even in `--compact`, vs their 13.3KB flat name-first list). Add a truly flat compact render (interactive-only, name-first, structural nesting dropped) while keeping selectorHint/url metadata; target ≤1.5× their bytes. Token cost IS latency and money for agent callers.
- [ ] **P8 — `splitting: false` duplicates 2.33MB twice in the bundle** (~40% of unpacked size); workers re-parse 728KB per spawn. Enable splitting; verify worker URL resolution. Also ship sourcemaps.
- [ ] ~~P9 — `--analyze` sequential AI calls~~ — moot: `--analyze` is deleted with the AI subsystem.
- [ ] **CI perf budgets** (gate on medians, exit 1 on violation — ~50 lines on top of `benchmark/sota-browser-benchmark.mjs`): `--help` ≤150ms, `observe` ≤2.0s, `inspect -i -c` ≤1.2s post-P1, smoke run ≤1.5s, unpacked dist ≤3.5MB post-P8, build ≤5s.

## Phase 3 — OSS hygiene & release engineering

- [ ] CHANGELOG + immutable release tags (current "restamp" workflow deliberately mutates tags); npm provenance attestation.
- [ ] CONTRIBUTING.md; lint tooling (none exists); coverage tooling.
- [ ] CI: fix Linux-only Playwright cache path (mac/win re-download every run); concurrency group; release on LTS Node (not 25.5); smoke-test packed tarball in release.
- [ ] Fix Dockerfile (4 independent breakages: postinstall script not copied → npm ci fails; tsup.config.ts not copied; wrong entrypoint; version mismatches).
- [ ] Enforce Node >= 22 at runtime with a clear error; fix "too many arguments" error for unknown subcommands.
- [ ] `skeptic config` introspection (resolved config with provenance); `--json` on run/observe; JSON schema for skeptic.config with `$schema`; shell completions; `doctor --fix`; `skeptic upgrade`; `skeptic remove skill`.

## Phase 4 — SOTA differentiators (beat Passmark)

Passmark (passmark.dev, Bug0, FSL-licensed, ~900 stars): Playwright **library** — AI executes plain-English steps once, caches resolved actions in Redis, replays at native speed, self-heals on cache miss. No CLI, no agent skill, no test generation, no diff-awareness, requires Redis + two API keys. Skeptic's structural win, sharpened by the agent-native decision: **deterministic specs by construction, zero API keys, zero infra — bring your coding agent.** Their wins, absorbed the agent-native way:

- [ ] **Self-healing as an agent loop, not a hidden cache:** on selector failure, skeptic deterministically captures a fresh snapshot + selectorHint candidates at the failure point into `results.json`; the skill instructs the agent to patch the spec from that evidence — a reviewable diff, no Redis, no keys.
- [ ] **Email/OTP testing + dynamic data placeholders + cross-test state — without Redis.** Deterministic features; biggest remaining feature gap.
- [ ] Visual/baseline assertions in CI replace runtime AI assertions: `toHaveScreenshot` + `--update-snapshots`/baseline management (pixelmatch+pngjs already deps).
- [ ] From expect: saved flows + learnings files the skill reads/writes (plain markdown the agent maintains — no model calls in skeptic); watch mode with deterministic skip filters.
- [ ] From agent-browser: **skill evals harness** (real `claude -p`/`codex exec` runs scored on skill compliance) — with MCP gone, the skill IS the product's front door; this is how "it works flawlessly from any agent" gets proven and kept true across Claude Code, Codex, Cursor, OpenCode.
- [ ] CLI: `--grep`, `--last-failed` re-runs.
- [ ] Market the cost math: Passmark claims "$10–30/mo vs $400–800/mo" for AI-per-run tools; skeptic's number is **$0**.
- [ ] **Absorb agent-browser 0.2x features** (shipped Mar–Jun 2026, post-dating the original refs read): React introspection verbs (`react tree/inspect/renders/suspense`) + Web Vitals verb + SPA `pushstate` handling, screencast `record start/stop`, stable tab ids, `--profile` Chrome-login reuse, cross-origin iframe refs (`Target.setAutoAttach`), HAR 1.2 export (merges with the observability HAR item), click-interception detection. Their evals harness confirms the Phase 4 skill-evals priority.

## Workstream B — Mobile (parallel with Phases 1-4; adb-direct, explicitly NOT Maestro-style drivers)

Mobile is a co-equal platform, not an add-on: it starts at M0 alongside Phase 1 (the Driver extraction also cleans up the web path). Owner constraint: drive emulators/devices directly via platform tooling; nothing installed on the device. Research verdict: viable on Android today; iOS simulator needs the host-side `idb` helper; real iOS devices impossible driver-less (descope).

- [ ] **M0 (1.5pw):** extract `Driver`/`DriverSession` interfaces; collectors take session not Page; web becomes first implementation. (Port concepts only from Maestro: Driver contract, Filters selector DSL, screen-settle waiting.)
- [ ] **M1 (2.5pw):** `AdbDriver` — device discovery, lifecycle (`pm clear`, `am start -W`, deep links), `uiautomator dump`→refs parser (retry + staleness guards), `input tap/swipe/text` (ASCII; structured error for unicode).
- [ ] **M2 (2pw):** Android evidence — logcat→console, screenrecord→video (3-min segments), screencap, gfxinfo/meminfo→perf, a11y heuristics (NAF, unlabeled clickables, <48dp targets); degraded network collector (netstats + opt-in `--proxy`).
- [ ] **M3 (1.5pw):** mobile CLI verbs (same verb set as web against a device session), `inspect/observe --device`, SKILL.md mobile guidance (RN testID→resource-id ≥0.64; Compose `testTagsAsResourceId`; Flutter semantics).
- [ ] **M4 (optional, flag-gated, 2.5pw):** scrcpy-pattern pushed `app_process` "fast lane" (<100ms snapshots, unicode, gestures) — transient shell-uid process, nothing installed; needs owner blessing as distinct from Maestro's installed-driver model.
- [ ] **M5 (3pw):** iOS simulator via `simctl` (lifecycle/evidence) + host-side `idb` (tap/tree). Real iOS devices: descoped.
- [ ] **First task: 1-day spike** measuring uiautomator dump latency on a real app — decides whether M4 is optional.
- [ ] Quick win independent of all above: fix Playwright mobile emulation (`isMobile`/`hasTouch` not set, so exposed `tap()` is broken) and claim mobile-web testing today.

## Verification standard for this plan

Each phase lands only with: type-check + full vitest green, a real end-to-end agent-loop run (skill → inspect → generate/author → run → read results.json) on a sample app, and — once the evals harness exists (Phase 4) — passing skill-compliance evals. Perf budgets enforced in CI from Phase 2 on.
