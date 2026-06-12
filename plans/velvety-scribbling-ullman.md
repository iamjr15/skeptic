# Skeptic — Big Changes Plan: Driver Abstraction, CLI Interaction Verbs, Mobile

## Context

Skeptic just completed an agent-native restructure: the MCP server, ACP server, and built-in AI/model subsystem were deleted, and all remaining verified bugs + perf + OSS hygiene were fixed (tree is green — 89 test files, 707 passing, `tsc` clean, real agent loop verified). Two big capabilities remain, plus the foundation they share:

1. **The deletion of MCP left one real gap.** An agent can `inspect` a page and `run` specs, but it can no longer drive an *interactive* browser loop (open → snapshot → click/fill → re-snapshot) from the shell. agent-browser and react-doctor prove skill + CLI is sufficient for this; skeptic needs the equivalent **CLI interaction verbs** backed by a **daemon-held session** (so `@eN` refs persist between separate CLI invocations).
2. **Skeptic is positioned as one tool for web AND mobile.** Mobile (Android via `adb`, iOS simulator via `simctl`+`idb` — driver-less, never Maestro/Appium) must drive the same `snapshot → ref → act → evidence` loop.

Both rest on the same seam: a platform-agnostic **`Driver`/`DriverSession`** abstraction. The loop's currency — `CaptureResult { yaml, entries: AriaRefEntry[], ... }` (`src/executor/aria-snapshot-capture.ts`, `src/executor/aria-ref-types.ts`) — is already platform-agnostic; only the *functions that produce and consume* it are Playwright-coupled.

**Decisions (owner, 2026-06-12):** Produce this plan now; do not start implementing yet. Build order when execution begins: shared foundation → web CLI verbs → mobile. **Mobile is fully designed here but its build is deferred** until the web verbs ship and prove the seam. **Interactive sessions get a dedicated headed daemon slot** (separate from the headless test daemon).

---

## Foundation: `Driver` / `DriverSession` abstraction (additive, zero test churn)

**Approach: a NEW parallel surface, not a refactor of `ExecutionContext`.** Keep `ExecutionContext` web-typed exactly as-is (its positional constructor is called at `worker.ts`, `playwright-engine.ts`, `inspect.ts` — splitting it into a generic base/subclass would ripple through every `attach(page, ctx)` and the 707 tests for zero present benefit). Instead, add `src/driver/` interfaces that the web impl satisfies by **wrapping** Playwright. `PlaywrightDriverSession` internally *owns* an `ExecutionContext` and delegates to the existing helpers verbatim — so `captureAriaSnapshot`, `resolveAriaRef`, `resolveElement`, `takeScreenshot`, and the four collectors are reused unchanged.

New files:
- `src/driver/types.ts` — `Driver`, `DriverSession`, `DriverElement`, `DriverOpenOptions`, `Box`; re-exports `CaptureResult`/`CaptureOptions`/`AriaRefEntry` as the shared currency.
- `src/driver/playwright/{playwright-driver,playwright-session,playwright-element}.ts` — the web impl.
- `src/driver/index.ts` — barrel. `__tests__/unit/driver/playwright-session.test.ts` — additive.

Interface shape (minimal):
- `DriverSession`: `open/url/title`, `snapshot(opts): Promise<CaptureResult>` (also stores `entries` as the session RefMap, mirroring `ctx.ariaRefs`), `resolveRef(ref)/resolveSelector(sel): Promise<DriverElement>`, `screenshot`, `scroll/wait`, a collector seam (`attachCollectors/collectEvidence/detachCollectors`), `close`, and an optional web-only `raw()` escape hatch.
- `DriverElement` (opaque action target — the key design point): `click/fill/type/press/hover/check/uncheck/selectOption/scrollIntoView/waitFor`, plus nullable best-effort `boundingBox()/textContent()`. The **web** element wraps a lazy Playwright `Locator` (auto-waits, re-resolves); a **mobile** element wraps `{ ref, AriaRefEntry, lastKnownBounds }` and re-resolves coordinates at action time. Keeping it opaque + all-async is what lets those two lifetimes diverge.

**Collectors stay `attach(page, ctx)` for web** (all four are deeply `page.on(...)`/`addInitScript`/`AxeBuilder` bound — a unified `attach(session)` would just dig the `Page` back out). Mobile gets a sibling `DeviceCollector` set; the only cross-platform contract is the output snapshot shapes in `src/observability/types.ts`.

**Migration sequence (green at every step, each additive):** (1) baseline green → (2) add `types.ts` (referenced by nothing) → (3) add the three `playwright/*` impls + unit tests → (4) optional proof: re-point `inspect.ts` internals to obtain its page via the driver (guarded by the existing inspect-smoke tests; skip if risky) → (5) the real payoff is Change A below.

**Hardest parts:** the action-target lifetime gap (web Locator vs mobile coordinate snapshot) — solved by the opaque `DriverElement`; `captureAriaSnapshot` is irreducibly Playwright-coupled (only the *data type* is shareable, mobile needs its own producer); collector lifecycle under a long-lived session (performance `addInitScript` must be context-level and precede load; `collectEvidence()` must be re-callable).

---

## Change A — CLI interaction verbs + daemon-held interactive sessions (web)

Replaces the deleted MCP loop. Refs must survive between `skeptic snapshot` and `skeptic click @e1` (two separate processes), so the **session lives in the daemon** — the only process alive across invocations.

### Daemon model
The daemon already owns a single `BrowserServer` and hands out its `wsEndpoint()` to test workers (control-plane only — it never holds a page today, `lifecycle.ts`). To hold interactive sessions, the daemon **connects to its own `wsEndpoint()` over loopback** (`pw[engine].connect(...)`) lazily on first `open`, yielding one in-process `Browser` whose contexts are the interactive sessions. **One Chrome total**; test workers connect from their processes, the daemon from its own.

**Dedicated headed slot (per owner decision):** interactive sessions run in a **second daemon** on a distinct socket (`~/.skeptic/session.sock`), defaulting to **headed**, separate from the headless test daemon at `~/.skeptic/daemon.sock`. This removes the headed/headless and engine-mismatch tension entirely — the test daemon and the interactive daemon never clobber each other, parallel test isolation is untouched, and `--headed`/`--headless` on the interactive verbs selects/keys that slot. Each slot keeps its own version/engine sidecars and idle timer.

New files:
- `src/daemon/session-registry.ts` — `SessionRegistry`: `Map<string, DriverSession>` keyed by `--session` (default `"default"`); lazy internal `Browser`; per-session `BrowserContext` (isolated cookies/storage) + primary `Page` (+ tabs) + an owned `ExecutionContext` (reused — already carries `ariaRefs`/`ariaSnapshotYaml`) + a per-session async **mutex** (serializes racing CLI calls) + a per-session idle timer that reaps just the context.
- `src/daemon/session-rpc.ts` — `dispatchSession(req, registry)` for the `session.*` methods.
- `src/daemon/session-client.ts` — `ensureSessionDaemon()` (auto-spawn the headed slot) + `sendSessionRpc()` (generous timeout, single-`\n` read loop; does NOT call `browser.getEndpoint`).
- `src/commands/browser-verbs.ts` — one runner per verb.
- `src/commands/snapshot-render.ts` — renderer extracted from `inspect.ts` so `inspect` and the `snapshot` verb produce byte-identical output.

Modified: `src/daemon/rpc.ts` (route `session.*`; add `sessions` to status), `src/daemon/lifecycle.ts` (build registry, lazy internal Browser, idle re-arm while `clients>0 || sessions.size>0`, `closeAll()` on shutdown), `src/daemon/socket.ts` (parameterize the inbound 8KB cap — default preserved so `socket.test.ts` stays green; the session socket passes ~1MB), `src/index.ts` (register verbs), `src/commands/inspect.ts` (use the shared renderer — pure refactor).

### `session.*` RPC surface (over the existing newline-JSON socket)
`session.open / navigate / snapshot / act{verb,ref|selector,args} / query{text|html|value|attr|title|url|count|box|visible|enabled|checked} / screenshot / observe{collector} / wait / find / tabs{list|new|switch|close} / close / list`. Each handler takes the session mutex and reuses skeptic code daemon-side: `captureAriaSnapshot` + `snapshot()`, `resolveAriaRef`, `resolveElement`, `captureAnnotatedScreenshot`, the collectors.

**Framing:** the 8KB cap is **inbound-request only** (`socket.ts` `conn.on("data")`); response + client-read paths are already uncapped (read to the single terminating `\n`, and `JSON.stringify` emits no raw newlines), so large snapshot responses already flow. Fix = raise the inbound cap on the session socket + **never inline binary artifacts** (screenshots/video/trace written to `~/.skeptic/sessions/<name>/`, return the absolute path). Snapshot YAML stays inline (already capped at 256KB). Length-prefixed framing is the documented fallback if >1MB inputs become common (safe — client/daemon are `cliVersion`-locked).

### CLI verbs (flat top-level, grouped under a "Browser session" help heading)
`skeptic open <url>`, `snapshot -i/-c/-s/--json`, `click @e1`, `fill @e2 "text"`, `type`, `press`, `hover`, `check/uncheck`, `select`, `screenshot --full/--annotate`, `get/is …`, `console`, `errors`, `wait`, `close [--all]`, `list`, shared `--session <name>` + `--json` + `--headed/--headless`. Flat matches the agent-browser muscle memory agents already carry and minimizes tokens per call. **Defer to v2:** drag/upload/scroll-as-verb, `find`, `tab *`, `batch --bail`, live network/perf/a11y reads (the existing one-shot `observe` covers those initially).

`inspect` and `observe` stay as the one-shot commands (`inspect` = stateless discovery + `selectorHint`s to copy into specs; `observe` = one-shot evidence bundle). The new `snapshot` verb operates on the already-open daemon session and persists refs.

### Ref persistence & lifecycle
RefMap = the session's `ExecutionContext.ariaRefs`, now in the daemon. `session.snapshot` clears+refills it (existing `snapshot()` behavior) and returns YAML + the `selectorHint`/`/url` table. `session.act @e1` resolves via the existing `resolveAriaRef`. Fast path: Playwright's native `aria-ref=eN` selector is valid on the live page until the next `ariaSnapshot`, fall back to `getByRole(role,{name}).nth(nth)` / `selectorHint`. **Keep `selectorHint` as the cross-invocation-durable artifact** (more durable than a backendNodeId — survives re-snapshots/minor churn). Invalidate refs on `framenavigated`/navigation (set a `refsStale` flag → actionable "re-run `skeptic snapshot`" error); refs are NOT invalidated by CLI process exit (that's the whole point).

### SKILL.md / docs
Rewrite the "MCP Workflow" section (and the duplicated copy in `src/commands/add.ts`, plus `README.md`/`AGENTS.md`) as "Persistent Browser Session": `open → snapshot -i → click @e3 → fill @e5 "…" → snapshot -i → console → screenshot --full → close`. Teach: refs persist because the session lives in the daemon; re-snapshot after navigation; `--session` for parallel isolation; `inspect` is still the one-shot for copying selectorHints into specs; binary outputs come back as file paths.

### Hardest parts (with the headed-slot decision applied)
1. ~~Headed/headless under a single daemon~~ — **resolved by the dedicated headed slot.**
2. Relocating snapshot/ref/collector execution from the client process into the daemon process without regressing the worker `getEndpoint` model, leaking Chrome on session reap, or bloating daemon cold-start.
3. Ref-lifecycle correctness across invocations under concurrency — the per-session mutex + nav-invalidation + the `aria-ref=eN` fast-path validity window.

### Sequencing (each additive; the worker `getEndpoint` path is never touched)
Parameterize the socket cap → add `session-registry.ts` + lazy internal Browser behind the headed slot → add `session-rpc.ts` + route from `rpc.ts` → add `session-client.ts` + verb commands + `index.ts` registration → extract the inspect renderer → rewrite SKILL.md/add.ts/docs → add tests (registry lifecycle, per-verb dispatch, large-payload framing, "ref persists across two RPCs" integration, headed-slot isolation from the test daemon).

---

## Change B — Mobile drivers (fully designed; **build deferred** until web verbs ship)

New `DriverSession` implementations behind the same seam and the same CLI verbs. Driver-less per owner constraint: `adb`/`simctl`+`idb` directly, never Maestro/Appium; a pushed transient shell-uid binary is an optional flagged fast-lane only.

### Android — `AndroidAdbDriverSession` (`src/driver/mobile/adb-session.ts`)
- **snapshot()**: `adb -s <serial> exec-out uiautomator dump /dev/tty` → parse XML → walk depth-first minting `e1,e2,…` → `AriaRefEntry[]`. role from `class`+flags (`*.Button`/clickable→button, `*.EditText`→textbox, `CheckBox`→checkbox, `Switch`→switch, `SeekBar`→slider, `scrollable`→list, `WebView`→opaque leaf); name from `content-desc||text||hint||resource-id` (never masked `password` text); `nth`/`matchCountAtSnapshot` via the existing `parseEntries` algorithm; `selectorHint` grammar `res=` › `desc=` › `text=` › `class=`(+`[n]`); `kind` reuses `"aria"` vs `"cursor-interactive"` (NAF/unlabeled clickables → cursor-interactive). `bounds` parsed into a private `Map<ref, NativeNode>` side-registry (NOT on `AriaRefEntry`); center = tap coordinate. `offViewportRefs` from bounds vs `wm size`. `yaml` via a new `renderMobileTree` (agent-browser shape).
- **resolveRef + actions**: mirror `resolveAriaRef`'s structured-error discipline; **re-verify before tapping** (re-dump or <750ms cache, re-match `selectorHint` scoped to the foreground package, recompute live center) + the re-count retarget guard. tap=`input tap`, long-press/swipe/scroll=`input swipe`, key=`input keyevent`, type=`input text` (ASCII), screenshot=`exec-out screencap -p`. App lifecycle: `install -r -g`, `pm clear`, `am start -W` (feeds perf), deep links via `am start -W -a VIEW -d`.
- **Unicode wall**: `input text` is ASCII-only → detect codepoint >0x7F → structured `[adbInput:unicode_unsupported]` error with remediation (fast-lane or IME paste).

### Android evidence (`DeviceCollector` set, `buildMobileCollectors()`)
logcat→`ConsoleSnapshot` (PID-filtered, FATAL/ANR→error, reuse redaction) · screenrecord→video artifact (hard 3-min cap → chunk+concat) · screencap→screenshot · **`MobilePerformanceSnapshot` (NEW type, do not shoehorn into the Web-Vitals-shaped `PerformanceSnapshot`)**: `am start -W` launch timings + `gfxinfo` jank/frame percentiles + `meminfo` PSS, with a shared `{platform}` discriminant for reporters · uiautomator heuristics→`AccessibilitySnapshot` (NAF/unlabeled-clickable, <48dp targets via `wm density`, image-button-without-desc; honest gap: no contrast without color) · **network is genuinely degraded** — default `netstats` per-uid totals (`degraded:true`, empty `requests[]`); opt-in `--proxy` (mitmproxy + `adb reverse` + user CA) loudly flagged as fragile (TLS pinning / Android-7+ user-CA distrust).

### iOS simulator — `SimctlIdbDriverSession` (`src/driver/mobile/simctl-session.ts`, macOS-only)
Gate `process.platform !== "darwin"` → structured `unsupported-platform`. Lifecycle/evidence via `simctl` (`boot/install/launch/terminate/openurl/privacy/io screenshot/io recordVideo/log stream`). Tap+tree via host-side `idb` (nothing installed in the sim): `idb ui describe-all` JSON → same `AriaRefEntry[]` (`AXType`→role, `AXLabel`→name, `AXFrame`→bounds); actions `idb ui tap/text/swipe/key`; selectorHint `id=<accessibilityIdentifier>` › `label=` › `type=`. Blind spots (`isAccessibilityElement=false`, custom-drawn, merged containers) → screenshot+coordinate fallback (`coord=x,y`, marked non-stable). Perf is thin (launch + footprint; jank null). **Real iOS devices descoped** (`idb ui` is sim-only; real devices need WebDriverAgent/XCTest = the forbidden installed-driver model).

### CLI/skill surface
**Naming:** `--device` is already the web viewport-profile flag — do NOT overload it. Add `--platform <web|android|ios-sim>` (default `web`, selects the session factory), `--target <serial|udid>`, `--app <package|bundle>`; accept `--device android|ios-sim` as a back-compat alias when the value isn't a known profile id. New `skeptic devices` verb (`adb devices -l` / `simctl list` + `idb list-targets`, the latter doubling as an idb health probe); wire both + adb-on-PATH into `skeptic doctor`. Daemon handshake `engine` field widens to a `driver/platform` discriminator; mobile sessions are addressed by session id (no wsEndpoint). SKILL.md "Mobile" section: RN `testID`→`res=` (≥0.64), Compose needs `testTagsAsResourceId`, Flutter needs semantics (else one opaque node → screenshot+coords), unicode limitation, WebView opacity (switch to web driver for in-WebView), re-snapshot after navigation (dumps are 1–3s, prefer `res=`/`id=`).

### What stays web-only (gated by the `--platform`/driver discriminant, not scattered try/catch)
annotation-overlay DOM injection (mobile → host-side image compositing of numbered badges onto the screenshot, reusing `AnnotationMapEntry`), web-vitals, axe/equal-access, cookie extraction, CDP/`connectOverCDP`/wsEndpoint, cursor-overlay video narration (mobile → enable device "show taps"), `page.evaluate` settle (mobile → `am start -W`/foreground polling + bounds math).

### Milestones (person-weeks) and risks
**M0 dump-latency × loop-economics spike (FIRST, ~1pw, go/no-go on dump-per-step and whether M4 is mandatory)** → M1 AdbDriver core (~2–3pw) → M2 Android evidence (~2pw) → M3 CLI/skill wiring (~1–2pw) → M4 optional pushed-binary fast-lane (~2pw, conditional on M0, explicit `--fast-lane` disclosure) → M5 iOS sim (~2–3pw). **Riskiest unknowns:** dump latency × economics; WebView/Flutter/Compose coverage cliffs; ref stability without an engine binding (selectorHints collapse to class+index under list recycling); unicode input; idb health/version drift.

---

## Adjacent (optional, small): deterministic `scaffold`

`skeptic generate` was deleted with the AI subsystem. A deterministic replacement `skeptic scaffold <url>` can recover the salvageable, non-AI `import-graph.ts`/`route-resolver.ts` from git history (commit before the AI deletion) and emit a spec skeleton from an `inspect` snapshot (discovered title + interactive refs as `selectorHint`-based starter steps) — no LLM, the host agent fills in assertions. Low priority; fold in whenever convenient.

---

## Verification

- **Foundation:** `npm run check` + `npm test` stay green at each additive step (707 baseline). New `driver/playwright-session` unit tests with mocked `Page`/`Locator`.
- **Web verbs (end-to-end, the real proof):** in a linked temp project (symlink `skeptic-cli` into `node_modules`, as used to verify the fixes), run `skeptic open <url>` → `snapshot -i` (assert refs + selectorHints) → `click @eN` → `snapshot -i` again (assert DOM changed) → `screenshot --full` (assert PNG path) → `console` → `close`; confirm refs from the first `snapshot` resolve in the later `click` (proves daemon persistence). Assert the headed interactive daemon is a distinct process/socket from the headless test daemon and that a concurrent `skeptic run` is unaffected. Add an integration test asserting "ref persists across two separate CLI invocations."
- **Latency targets (parity with agent-browser 0.27.2):** warm `open/snapshot/click/screenshot` ≤220–250ms; enforce via the existing `benchmark/` harness with budgets.
- **Skill compliance:** real `claude -p` / `codex exec` runs scored against SKILL.md (the agent-browser evals pattern) — with MCP gone, the skill is the only front door, so this is the standing quality gate.
- **Mobile (when built):** M0 spike output (dump p50/p95 across emulator + physical, on native/RN/Flutter/WebView) is the gating artifact; then the same `open → snapshot → click @e` loop green on a native + an RN app via the identical verbs, `--platform android`.

## Validated assumptions (2026-06-12, via /research)
- **Playwright aria-ref — CONFIRMED.** Official docs: `ariaSnapshot({ mode: "ai" })` is documented/stable and "differs from the default by including element references"; Playwright's agent-CLI docs state refs are "stable within a single snapshot but invalidated when the page changes — always re-snapshot after navigation." The daemon ref-persistence design matches. (Opportunity: `boxes: true` emits `[box=x,y,width,height]` — a single-call replacement for the P6/P7 per-element `boundingBox` loop.)
- **Meta idb — CONFIRMED-WITH-CAVEAT.** `idb ui tap`/`describe-all` exist and the repo gets recent commits (last push Apr 2026), but the last formal release is v1.1.8 (2022) and setup is occasionally fragile. Already captured as the "idb health/version drift" risk; iOS is a deferred milestone.

## Status / sequencing
Build order when execution begins: **Foundation → Change A (web verbs, headed slot) → [Change B mobile, deferred].** Everything stays on the `agent-native-overhaul` branch. No `npm publish`/`git push` without explicit approval.
