# velvety-finding-beacon — close the post-shipping gaps surfaced by the expect comparison

**Status:** drafted (this revision supersedes the prior contents — the prior plan covered the pre-TS-pivot bundles which are all shipped on `main`; this one is a fresh planning cycle).
**Owner:** Claude (planning) → user (approval) → teammates (implementation).
**Scope:** `cli/` plus a single targeted `tasks/lessons.md` append in B11 (matches prior-bundle precedent — entries #29/#30 already live there). No edits to `plans/`, `.github/`, or other repo-root scaffolding.

---

## Context — why this change

The TS-pivot bundles (B0.5/B1/B1.5/B2/B3/B4/B5/B5.5/B6) all merged to `main`. The B6 verification benchmark against `https://jigyansurout.com/` produced:

- `benchmark-artifacts/jigyansurout-20260430-140429/skeptic-v1` (initial — 800×450 video bug + cursor never rendered)
- `benchmark-artifacts/jigyansurout-20260430-140429/skeptic-v2` (videoSize fix + mouse interactions, cursor visible on home + blog)
- `benchmark-artifacts/jigyansurout-20260430-140429/skeptic-v3` (per-page screenshots, cursor visible on all four pages)
- `benchmark-artifacts/jigyansurout-20260430-140429/expect-v1` (same flow run via expect-cli for side-by-side)
- `benchmark-artifacts/jigyansurout-20260430-140429/COMPARISON.md` (the full diff)

The user reviewed the side-by-side and surfaced **five concrete gaps** where expect is ahead and skeptic should catch up:

1. **Cursor narration** — expect's video shows a persistent tooltip near the cursor announcing what the tool is doing in friendly sentence form ("Running accessibility audit", "Taking annotated screenshot"). skeptic has `setCommandLabel` but it (a) shows terse internal API names and (b) auto-fades after 1.5 s — invisible during multi-second operations.
2. **Video resolution** — expect records at fixed 1920×1080. skeptic records at viewport (1280×720 default). The cursor and page content look noticeably crisper in expect's WebM at the same display zoom.
3. **A11y rule coverage surfaced** — both tools dual-engine (axe + IBM Equal Access), but expect surfaces the full IBM superset (~60+ rules on jigyansurout) while skeptic shows only 2 (markdown render is capped at top-10 per impact bucket; full violations live in the snapshot but never render).
4. **Output txt quality** — expect's per-call output (`accessibility_audit > json`, `network_requests > json`) lands as clean structured files alongside a Markdown summary; skeptic's `perf-trace.md` truncates lossy and there's no per-test "human-readable audit summary" emitted.
5. **Daemon latency** — expect keeps a persistent browser subprocess across subcommands (~50-150 ms per call). skeptic's worker-per-file model launches a fresh browser every time (~3-5 s).

The user has chosen **Full daemon** for gap 5 — the architectural pivot is real but worth it. The original TS-pivot plan excluded daemon mode under the rationale that refs were session-local; this plan addresses that constraint head-on (each test still gets its own `BrowserContext`, state stays isolated; the daemon shares only the underlying browser subprocess).

---

## Source verification

Before finalizing, I read both reference codebases to ground the plan in real implementations rather than speculation:

- **`/Users/iamjr15/Desktop/aurum-refs/agent-browser/`** (Apache 2.0, Vercel Inc.) — daemon design verified against `cli/src/native/daemon.rs` (entry, socket listener, line-delimited JSON framing, idle-timer-with-reset, SIGTERM+Notify graceful close, per-session sidecar files). Code-port patterns are cited inline with `// Source: agent-browser/<path>:<lines> © Vercel Inc., Apache 2.0` headers. Skeptic's plan goes BEYOND agent-browser's posture in three places: `0700` parent-dir permissions, realpath-checked stale-socket cleanup, optional `SKEPTIC_DAEMON_AUTH_TOKEN` shared-secret. Skeptic also chose `BrowserServer.wsEndpoint()` handoff (vs agent-browser's full RPC marshaling) because Playwright supports it natively and isolates state at the Context layer cleanly.
- **`/Users/iamjr15/Desktop/aurum-refs/expect/`** (FSL-1.1-MIT) — only the **observable end-user behaviors** were used to inform skeptic's plan: tooltip is persistent until cleared (no auto-fade), labels are sentence-form present-participle phrasing ("Running accessibility audit", "Reading console logs"). Skeptic's `labels.ts` lookup table is an independent design choice that's safer than embedding raw user-supplied strings in label text (a centralized static table eliminates the PII vector). The "keep tooltip visible near viewport edges by flipping/clamping" UX is also an independent design choice — common pattern across UI libraries, not a code port.

## Decisions

| Axis | Decision | Why |
|---|---|---|
| Daemon transport | Unix socket at `~/.skeptic/daemon.sock` + **line-delimited JSON** framing (one JSON object per `\n`-terminated line; matches agent-browser's precedent at `cli/src/native/daemon.rs:357-430`) for the **minimal control plane only** (`ping`, `status`, `shutdown`, `getEndpoint`); browser ops use `pw[engine].connect(wsEndpoint)` directly | Codex round 1 #1 + round 2 #3; agent-browser source-walk verified — line-delimited JSON is simpler than length-prefixed and the daemon does NOT marshal `newContext`/`newPage` over the socket. Engine parameterized for Chromium / Firefox / WebKit |
| Daemon compatibility handshake | `getEndpoint` request includes `{ engine, headed, playwrightVersion, cliVersion }`; daemon returns `wsEndpoint` only on exact match — otherwise responds `RestartRequired` and the client waits for the daemon to re-spawn with the requested config | Codex round 1 #2 — headless Chromium daemon cannot serve a headed Firefox request, and Playwright client/server versions must match |
| Daemon lifecycle | Auto-spawn ONLY on `run` (without `--list`) and `inspect`; `skeptic daemon start\|stop\|status\|logs` for explicit control; `--no-daemon` bypasses for any command | Codex round 1 #3 — `init`, `audit`, `comment`, `cookies`, `browsers install`, `run --list`, help-style commands never spawn a browser |
| State isolation | Daemon hands out `wsEndpoint`; workers connect via `pw[engine].connect(wsEndpoint)` and create their own `BrowserContext` through Playwright's normal API; **on WebSocket disconnect, Playwright's server-side automatically closes contexts that client created** (the BrowserServer public API does NOT expose context-creation events — Codex round 2 #1) | Codex round 1 #5 + round 2 #1 — `worker.terminate()` triggers WebSocket disconnect; Playwright handles the cleanup natively |
| Daemon teardown | Idle timeout (default 5 min) + `SIGTERM`-graceful close + atomic stale-lockfile recovery + `0700` parent-dir permissions + optional `SKEPTIC_DAEMON_AUTH_TOKEN` env (constant-time validated). **No runtime same-UID check** — Node's `net` API doesn't expose `SO_PEERCRED`/`LOCAL_PEERCRED` (Codex round 2 #2). The `0700` directory is the boundary | Codex round 1 #4 + round 2 #2 — security comes from filesystem perms (only the user's own UID can `connect()` to a socket inside their `0700`-mode dir) plus the optional shared-secret auth token; runtime UID validation needs a native helper which we explicitly opt out of |
| Engine parameterization | `pw[engine].launchServer()` for spawn; `pw[engine].connect()` for client; handshake fields the engine and rejects mismatch | Codex round 2 #3 — non-Chromium daemons supported the same way; or scope daemon-mode to Chromium and force `--no-daemon` for Firefox/WebKit (decision: support all three engines) |
| Video size override | New `--video-size <WxH>` CLI flag + new `test.use({ videoSize })` per-test override | precedence: CLI > test.use > viewport |
| Cursor labels | Sentence-form static templates per fixture method, persistent until cleared, `clearCommandLabel()` paired with `runAction` finally | independent reimplementation — no expect code copied, no source identifiers or implementation structure reused; only the observable end-user behaviors (persistent tooltip, sentence-form labels) inform the design |
| A11y rule cap | Bump default to 100 per impact bucket + `observability.accessibilityMaxRulesPerImpact` config + per-test Markdown summary file with the full count | the existing `perf-trace-md.ts:236` cap is the bottleneck |
| Audit summary file | New `audit.md` written per-test alongside `perf-trace.md` — human-readable violations grouped by rule, with selectors and help URLs, no truncation | net-new, observable behavior parity with expect |

---

## Bundles

```
B7  Cursor narration (persistent sentence labels)         ~280 LoC
B8  Video size override (CLI flag + test.use)             ~150 LoC
B9  A11y rule coverage + audit.md per-test                ~280 LoC
B10 Daemon mode (Unix socket + persistent browser)       ~1180 LoC
B11 LICENSES.md attribution + AGENTS.md updates + verify  ~180 LoC
```

Order: B7, B8, B9, B10 in any sequence (with caveat below) → B11. B7/B8/B9/B10 are **all independent** because the daemon RPC is control-plane only — it does not forward labels/video/a11y config (those are passed through normal Playwright APIs once a client is connected). B11 (docs + verification benchmark) goes last and depends on everything (Codex round 2 #8 — earlier draft incorrectly tied B10 to B7-B9 via RPC). The caveat is integration tests: B11's benchmark needs all four feature bundles merged to demonstrate the full output quality at once.

---

### Bundle 7 — Cursor narration (persistent sentence labels)

**Goal:** the user watching the WebM sees a persistent tooltip announcing what the test is doing right now, in friendly sentence form. Cleared when the action finishes.

**Files modified:**
- `cli/src/executor/cursor-overlay.ts` (~+50 LoC — bumped from +30 for viewport-flip clamping)
  - Extend `setCommandLabel(label, opts?: { persistent?: boolean })` at line 304 — when `persistent: true`, do not start the auto-fade timer.
  - Add `clearCommandLabel()` (new function) — clears the tooltip immediately and any pending fade timer.
  - Expose both via `window.__skepticCursor.{setCommandLabel,clearCommandLabel}`.
  - Bump max-chars from 40 → 80 to fit sentence-form labels comfortably.
  - **Viewport-edge clamping for the persistent tooltip** (independent design — common UI pattern, not code-derived from any reference): when the tooltip would clip the right edge of viewport, render to the left of the cursor instead; when it would clip the bottom, render above. The existing horizontal clamp at `cursor-overlay.ts:198-200` covers the simple case but not the flip; this extends it. Keeps the persistent tooltip visible even when the cursor is near a screen edge.
- `cli/src/api/page-proxy.ts` (~+45 LoC — bumped from +15 per Codex round 1 #7)
  - **Change `fireSetCommandLabel(page, label, opts?)` and `fireClearCommandLabel(page)` to return `Promise<void>` (currently void — Codex round 2 #6) so callers can `await`/`.catch()` reliably.**
  - Update `fireSetCommandLabel` (lines 200-216) to forward the optional `persistent` flag to `page.evaluate`.
  - Add `fireClearCommandLabel(page)` paired helper.
  - **Wrap each intercepted Page/Locator action method (`click`, `dblclick`, `hover`, `fill`, `type`, `press`, `select`, `check`, `uncheck`) in `try/finally`**:
    - `try`: `await fireSetCommandLabel(page, friendlyLabel("proxy.click"), { persistent: true })` then `Reflect.apply(...)` the original.
    - `finally`: `await fireClearCommandLabel(page).catch(() => {})` so the tooltip clears whether the action succeeded or threw. Otherwise a click that errors silently leaves the persistent label stuck on screen.
- `cli/src/api/fixture.ts` (~+25 LoC) — `runAction(label, fn)` lines 83-115:
  - Replace direct `fireSetCommandLabel(page, label)` with a friendly-label resolver.
  - In `finally`: `fireClearCommandLabel(page)` after the action completes (success or fail).
- `cli/src/api/labels.ts` (NEW, ~80 LoC) — single source of truth for sentence-form labels:
  ```ts
  export const friendlyLabel = (action: string): string => LABELS[action] ?? action;
  const LABELS: Record<string, string> = {
    "screenshot": "Capturing screenshot",
    "screenshot.annotated": "Taking annotated screenshot",
    "snapshot": "Reading ARIA snapshot",
    "settle": "Waiting for visual settle",
    "observability.expectAccessible": "Running accessibility audit",
    "observability.expectPerformance": "Checking performance thresholds",
    "observability.expectNoNetworkErrors": "Analyzing network requests",
    "observability.expectNoConsoleErrors": "Reading console messages",
    "observability.snapshot": "Snapshotting observability metrics",
    "ai.assert": "Running AI assertion",
    "ai.assertNoDefects": "Running AI defect scan",
    "ai.extract": "Extracting via AI",
    "test": "Running test",
  };
  ```
  - Page-Proxy methods (click/hover/fill/etc. via `cli/src/api/page-proxy.ts`) get a synthetic action-name like `proxy.click` → "Clicking"; the label resolver maps these too.
- `cli/src/executor/playwright-engine.ts` (~+10 LoC, lines 71-105):
  - Update `fireSetCommandLabelOnPage(page, command)` callers to pass `{ persistent: true }` for long-running operations and use `friendlyLabel(command)`.
  - Wire `clearCommandLabel` after each step.

**Tests:**
- `cli/__tests__/unit/api/labels.test.ts` (NEW) — assert friendly mapping for every fixture method, fall-through to raw action name for unknown actions.
- Extend `cli/__tests__/unit/executor/cursor-overlay.test.ts` — assert `clearCommandLabel` exists, `setCommandLabel(label, { persistent: true })` does not schedule a fade, calling setCommandLabel a second time replaces the first.
- Extend `cli/__tests__/integration/cursor/proxy-coverage.test.ts` — assert each canonical fixture method emits its friendly label and clears on completion.

**Acceptance:**
- `npm run check` clean.
- `npm test` green.
- `npm run build` clean.
- Manual: re-run the v3 benchmark spec; extract video frame at the moment `expectAccessible` fires; confirm the tooltip reads "Running accessibility audit" and persists for the full audit duration (not the 1.5 s fade).

---

### Bundle 8 — Video size override

**Goal:** ship `--video-size <WxH>` CLI flag and `test.use({ videoSize })` per-test override so users can record at 1920×1080 (or any resolution) without bumping the viewport.

**Files modified:**
- `cli/src/index.ts` line ~74 — Commander block: insert
  ```ts
  .option("--video-size <WxH>", "video recording resolution (e.g., 1920x1080); overrides viewport size for video only")
  ```
- `cli/src/commands/run.ts` (~+30 LoC):
  - Add a `parseVideoSize(s)` helper. Validates `^\d+x\d+$` AND the parsed width/height are both **positive integers within sane bounds** (e.g., `1 ≤ w,h ≤ 3840` to catch 0×0 and obviously-wrong values). Codex round 1 #6.
  - Pass parsed size into the worker config (`WorkerStartConfig.videoSize`).
- `cli/src/runner/ipc.ts` lines 19-55 — `WorkerStartConfig`:
  - Add `videoSize?: { width: number; height: number }`.
- `cli/src/runner/worker.ts` line 100-105 — context options builder:
  ```ts
  // Precedence MUST match the declared decision (CLI > test.use > viewport):
  // config.videoSize is the CLI flag; merged.videoSize is from test.use({ videoSize }).
  const videoSize = config.videoSize ?? merged.videoSize ?? viewport;
  ...(config.video ? { recordVideo: { dir: flowDir, size: videoSize } } : {}),
  ```
  (Codex round 1 #6 — earlier draft had the operands reversed.)
- `cli/src/api/test.ts` — extend the `TestUse` type (`use?: { viewport?, collectors?, ... }`) to include `videoSize?: { width: number; height: number }`. Per-test override.

**Tests:**
- `cli/__tests__/unit/runner/video-size.test.ts` (NEW, ~60 LoC) — mock `browser.newContext` and assert the `recordVideo.size` field follows the precedence chain (CLI > test.use > viewport).
- Extend `cli/__tests__/integration/runner/runner-acceptance.test.ts` — fixture spec that calls `test.use({ videoSize: { width: 1920, height: 1080 } })` and asserts the resulting WebM is 1920×1080.

**Acceptance:**
- All gates green.
- Manual: `node dist/skeptic.mjs run tests/jigyansurout-verify.spec.ts --observability --video --video-size 1920x1080` produces a 1920×1080 WebM.

---

### Bundle 9 — A11y rule coverage + per-test audit.md

**Goal:** stop truncating IBM-only violations; emit a separate, complete-but-readable per-test Markdown summary file (`audit.md`) that surfaces every rule.

**Files modified:**
- `cli/src/reporter/perf-trace-md.ts` line ~236:
  - **Add a `cap` parameter to `formatPerfTraceMarkdown(metrics, options?)` (currently has no config input — Codex round 1 #8).** The function reads `options.accessibilityMaxRulesPerImpact ?? 100`.
  - Replace hardcoded `slice(0, 10)` with `slice(0, cap)`.
  - Print a "...and N more — see audit.md" line at the end of each impact bucket if truncation happens.
- `cli/src/config/schema.ts` — `observability` block: add
  ```ts
  accessibilityMaxRulesPerImpact: z.number().int().min(0).default(100),
  ```
- `cli/src/observability/types.ts` — extend `ObservabilityRuntimeConfig`:
  ```ts
  accessibilityMaxRulesPerImpact?: number;
  ```
- `cli/src/executor/types.ts` line ~54 — extend `TestArtifacts` (Codex round 1 #9 + round 2 #7 — corrected file path; `TestArtifacts` lives in executor/types.ts, not observability/types.ts):
  ```ts
  accessibilityAudit?: string; // path to per-test audit.md
  ```
- `cli/src/runner/ipc.ts` `WorkerStartConfig` — thread `accessibilityMaxRulesPerImpact` from the run command into the worker (Codex round 1 #8).
- `cli/src/executor/sidecars.ts` (~+90 LoC, signature change — Codex round 1 #8):
  - **Update `writeSidecars(args)` to accept `args.observabilityConfig` (incl. the cap) and `args.artifacts` (so it can mutate the artifact map with `accessibilityAudit`).**
  - New `writeAuditSidecar({ flowDir, metrics, snapshot, artifacts })` writes `audit.md` alongside `perf-trace.md` and sets `artifacts.accessibilityAudit = <path>` so reporters (JSON/HTML/console) can link it.
  - Format: per-rule grouping (axe vs equal-access marked), full violation count, no truncation at the rule level, link to dequeuniversity / IBM rule docs, condensed selector list per node (max 10 example nodes per rule, "+N more nodes" footer when truncated, but every rule rendered).
  - Call from `cli/src/executor/playwright-engine.ts` near where `writeSidecars` is invoked. Both the engine and runner-worker code paths must pass through the new config (Codex round 1 #8 — both call sites are exercised by tests).
- `cli/src/reporter/{json,html,console}-reporter.ts` — surface the new `artifacts.accessibilityAudit` field if present (one-line conditional render per reporter).

**Tests:**
- `cli/__tests__/unit/observability/accessibility-cap.test.ts` (NEW, ~70 LoC) — mock collector output with 30 violations across two impact buckets; assert `perf-trace.md` shows 100 (no truncation banner) when default; assert `audit.md` shows all 30.
- Extend `cli/__tests__/unit/reporter/perf-trace-md.test.ts` — assert truncation banner appears when violations > cap.

**Acceptance:**
- All gates green.
- Manual: re-run benchmark against jigyansurout — `audit.md` exists per test, lists every IBM + axe violation, no `(equal-access)` rule silently dropped.

---

### Bundle 10 — Daemon mode (Unix socket + persistent browser)

**Goal:** persistent browser subprocess; subsequent CLI calls connect via Unix socket and reuse the browser. Each test still owns its own `BrowserContext` for state isolation.

**Architectural constraint preserved:** `@eN` refs remain session-local (lifetime = one BrowserContext = one test), per the original TS-pivot plan §4.2. The daemon shares the browser, NOT the contexts.

**Files NEW (under `cli/src/daemon/`):**
- `cli/src/daemon/socket.ts` (~150 LoC) — Unix socket listener at `~/.skeptic/daemon.sock` with the security envelope (Codex round 1 #4 + round 2 #2):
  - Parent dir `~/.skeptic/` created with `0700`; the socket file inherits the parent's permissions. **The 0700 directory is the boundary — only the user's own UID can `connect()` to a socket inside it.** No runtime same-UID check (Node's `net` doesn't expose `SO_PEERCRED`/`LOCAL_PEERCRED`).
  - Stale-socket handling: try-bind; on `EADDRINUSE` connect-and-ping the existing socket; on no-response, **realpath-check the socket file** (refuse if it's a symlink to anywhere outside `~/.skeptic/`), then `unlink` and re-bind. This defeats symlink races.
  - Optional shared-secret auth via `SKEPTIC_DAEMON_AUTH_TOKEN` env (token in client `daemon.ping` request, validated server-side in constant time via `crypto.timingSafeEqual`). When unset, the `0700` directory is the only boundary.
  - **Line-delimited JSON framing** (matches the Decisions table; agent-browser uses the same): one JSON object per `\n`-terminated line; read via Node's `readline` interface or a chunk-aware accumulator. Reject lines longer than a safety cap (8 KB; control-plane RPC payloads are small, so this is generous). Malformed JSON → respond with `{"error": "parse-failed"}` on the same connection and continue (don't kill the connection on a single bad frame).
- `cli/src/daemon/lifecycle.ts` (~180 LoC) — engine-parameterized BrowserServer manager (Codex round 2 #3; patterns ported from `agent-browser/cli/src/native/daemon.rs:115-255` with `// Source: agent-browser/cli/src/native/daemon.rs:115-255 © Vercel Inc., Apache 2.0` header):
  - Spawn `BrowserServer` via `pw[engine].launchServer({ headless: !headed })` on first connection. `engine` ∈ `{chromium, firefox, webkit}`. Capture engine + headed + Playwright version into the daemon's process state.
  - **Idle-timer with reset on activity** (agent-browser pattern): a single timer pinned at the top of the event loop; every accepted command resets it via a signal channel. When the timer fires with no resets, gracefully close. Default 300 s, override `--daemon-idle-timeout`.
  - **SIGTERM + Notify graceful close** (agent-browser pattern at `daemon.rs:439-482`): trap SIGINT/SIGTERM/SIGHUP; `await browserServer.close()` then exit. Avoids `process.exit()` short-circuiting which can orphan browser processes.
  - **Per-session sidecar files** for observability: `~/.skeptic/daemon.pid` (PID lockfile), `~/.skeptic/daemon.version` (CLI + Playwright version, for client compatibility check), `~/.skeptic/daemon.engine` (engine + headed). Atomic create-or-fail on PID lockfile; on existing lockfile, validate PID with `kill(pid, 0)` before assuming stale; if alive, refuse to start a duplicate. On exit: cleanup all sidecars.
  - **Cleanup model (Codex round 2 #1):** the daemon does NOT track contexts. Playwright's BrowserServer auto-closes contexts that a client created when that client's WebSocket disconnects. The daemon's job is just to keep the BrowserServer alive across multiple connect/disconnect cycles. The integration test asserts this: connect from worker, force `worker.terminate()`, wait, assert no leaked browser processes / no leaked context state in subsequent tests.
- `cli/src/daemon/rpc.ts` (~120 LoC) — **MINIMAL control-plane only** (Codex round 1 #1):
  - `daemon.ping({ engine, headed, playwrightVersion, cliVersion, authToken? }) → { ok: true } | { ok: false, reason: "engine-mismatch"|"version-mismatch"|"auth-failed"|... }` (Codex round 1 #2 + round 2 #2).
  - `daemon.status() → { uptimeMs, clients, browserVersion, engine, headed }`. (No context count — daemon doesn't track them — Codex round 2 #1.)
  - `daemon.shutdown(reason)` — graceful close.
  - `browser.getEndpoint() → { wsEndpoint: string }` — returns the `BrowserServer.wsEndpoint()`. The client connects via Playwright's `pw[engine].connect(wsEndpoint)` directly.
  - **Browser context/page operations are NOT marshaled over RPC** — workers connect to `wsEndpoint` directly and own their `BrowserContext` via Playwright's normal API. Codex round 1 #1.
- `cli/src/daemon/client.ts` (~200 LoC):
  - `connectDaemon({ engine, headed }) → { browser: Browser, disconnect: () => Promise<void> }`.
  - On no daemon running: spawn one (`spawn` with `detached: true` + `unref()`), wait for socket-ready, then `daemon.ping`.
  - On `daemon.ping` returning `engine-mismatch` / `version-mismatch`: tell the user, ask the daemon to shutdown, restart with the requested config (Codex round 1 #2). Cap retries at 1 to avoid loops.
  - Returns a connected `Browser` from `pw[engine].connect(wsEndpoint)` (Codex round 2 #3). Worker passes this directly to its existing `browser.newContext(...)` call site (worker.ts:102 stays unchanged). On `disconnect()`: `await browser.close()` (which severs the WebSocket; Playwright's server-side cleans up contexts automatically — Codex round 2 #1).

**Files modified:**
- `cli/src/runner/worker.ts` lines ~50-80 (the `loadPlaywright().launch()` path):
  - Replace `await launcher.launch({ ... })` with the daemon-or-direct-launch branch:
    ```ts
    const browser = config.noDaemon
      ? await launcher.launch({ headless: !config.headed })
      : (await connectDaemon({ engine, headed: config.headed })).browser;
    ```
  - Worker owns its own `BrowserContext` via `browser.newContext(...)` — the existing newContext call at line 102 stays unchanged.
  - On worker exit: close the context, then call `disconnect()` from `connectDaemon` (which calls `browser.close()` to sever the WebSocket).
  - **Hard-timeout / `worker.terminate()` safety (Codex round 2 #1):** the cleanup-on-disconnect is Playwright's native behavior — when the WebSocket between worker and daemon's BrowserServer drops (whether via clean `disconnect()` or because the worker was force-terminated), Playwright's server-side closes any contexts that client created. The integration test asserts a second test on the same daemon sees clean state after terminating the first.
- `cli/src/commands/inspect.ts` (~+25 LoC) — **two distinct connect paths (Codex round 2 #4 — `--connect` is CDP, daemon is Playwright wsEndpoint; do not conflate):**
  1. **Daemon path** (default when daemon is running and no `--connect` arg): `connectDaemon()` → Playwright `Browser` → existing inspect flow.
  2. **Explicit `--connect <ws-url>`** (CDP only, unchanged): uses `chromium.connectOverCDP(wsUrl)` against an external Chrome started with `--remote-debugging-port=...`. Same code path as today.
  3. **`--no-daemon`** flag (Codex round 2 #5 — also added to `inspect`): bypass daemon, fall back to one-shot launch as before.
- `cli/src/commands/run.ts` (~+15 LoC):
  - New `--no-daemon` flag — bypass the daemon and launch a fresh browser per spec (the pre-B10 behavior).
- `cli/src/index.ts` (~+30 LoC):
  - **`--no-daemon` is a global Commander option** (Codex round 2 #5 — applies to both `run` and `inspect`; `commandUsesBrowser(argv)` reads `argv['--no-daemon']` to decide whether to short-circuit auto-spawn).
  - New `daemon` Commander group: `skeptic daemon start | stop | status | logs`.
  - **Auto-spawn discipline (Codex round 1 #3):** ONLY `run` (without `--list`) and `inspect` auto-launch the daemon. `init`, `audit`, `comment`, `cookies`, `browsers install`, `run --list`, `mcp`, `acp`, `add`, `generate`, help-style commands NEVER spawn a browser. The auto-spawn predicate is a single-source-of-truth function `commandUsesBrowser(argv): boolean`.

**Files NEW (tests):**
- `cli/__tests__/integration/daemon/lifecycle.test.ts` — auto-spawn, idle-timeout, SIGTERM cleanup.
- `cli/__tests__/integration/daemon/state-isolation.test.ts` — assert two consecutive `runOne` calls have NO shared cookies/storage (each gets a fresh BrowserContext).
- `cli/__tests__/integration/daemon/concurrent-workers.test.ts` — N parallel workers connect to the same daemon, assert each gets its own context, no cross-worker context leakage.
- `cli/__tests__/integration/daemon/handshake.test.ts` — Codex round 1 #2: client requests engine=firefox while daemon is chromium → `engine-mismatch`; client requests playwrightVersion mismatch → `version-mismatch`; on mismatch, daemon restarts with the new config (if idle) or rejects.
- `cli/__tests__/integration/daemon/worker-kill-cleanup.test.ts` — Codex round 1 #5 + round 2 #1: spawn worker, force `worker.terminate()` mid-test, run a SECOND test on the same daemon, assert the second test sees a clean state (no cookies/storage from the first; no leaked browser process). Validates that Playwright's WebSocket-disconnect cleanup actually fires for hard-killed clients.
- `cli/__tests__/unit/daemon/auto-spawn-discipline.test.ts` — Codex round 1 #3: assert `commandUsesBrowser('init')` / `'audit'` / `'comment'` / `'run --list'` are all false; only `'run'` and `'inspect'` are true.
- `cli/__tests__/unit/daemon/socket.test.ts` — JSON-RPC framing happy path + malformed input rejection + `0700` directory permissions assertion + realpath-checked stale-socket cleanup (refuse symlink to outside `~/.skeptic/`) + optional `SKEPTIC_DAEMON_AUTH_TOKEN` constant-time validation (correct token accepted, wrong token rejected, unset token allowed when no env set).
- `cli/__tests__/unit/daemon/client.test.ts` — auto-spawn behavior (mock socket connect).

**Critical invariants:**
1. **Each test owns its `BrowserContext`** — daemon shares only the underlying browser binary (Chromium / Firefox / WebKit per the engine handshake). Cookies/sessionStorage/localStorage isolated per test.
2. **Refs (`@eN`) stay session-local** — they live on a Locator, which lives on a Page, which lives on a Context. A new Context = new ref space. No cross-test ref reuse.
3. **`--no-daemon` always works** — for CI, Playwright version pinning, and debugging.
4. **Idle timeout default 300 s** — overridable via `--daemon-idle-timeout <seconds>`.
5. **Lockfile prevents duplicate daemons** — atomic create-or-fail at `~/.skeptic/daemon.pid` with PID validation on stale-lock cleanup.
6. **Apache 2.0 attribution** — `// Source: agent-browser/cli/src/daemon/<file>:<lines> © Vercel Inc., Apache 2.0` headers on `socket.ts`, `lifecycle.ts`, `client.ts` (the patterns are observable in agent-browser's source which is Apache-licensed; we cite even though our impl is original).
7. **Compatibility handshake (Codex round 1 #2)** — every connect carries `{engine, headed, playwrightVersion, cliVersion}`. Mismatch on any field → daemon either restarts under the new config (if no other clients are using it) or rejects with `RestartRequired` and the client retries once after asking the daemon to shutdown. Headless ≠ headed; Chromium ≠ Firefox; Playwright 1.50 ≠ 1.51.
8. **Auto-spawn is narrow (Codex round 1 #3)** — `commandUsesBrowser(argv)` returns true for `run` (without `--list`) and `inspect`. Every other command runs without a daemon.
9. **Socket security envelope (Codex round 1 #4 + round 2 #2)** — `~/.skeptic/` is created with `0700` permissions (only the user's UID can `connect()` to a socket inside it). Stale sockets cleaned via realpath-checked `unlink` (refuse symlink to outside `~/.skeptic/`). Optional `SKEPTIC_DAEMON_AUTH_TOKEN` for explicit shared-secret auth, validated server-side via `crypto.timingSafeEqual`. **No runtime same-UID check** — Node's `net` API doesn't expose `SO_PEERCRED`/`LOCAL_PEERCRED`.
10. **Cleanup-on-disconnect via Playwright's native behavior (Codex round 2 #1)** — daemon does NOT track contexts (BrowserServer's public API doesn't expose context-creation events). Cleanup happens because Playwright's server-side closes contexts that a client created when that client's WebSocket disconnects. The integration test asserts no leaked context state across two consecutive runs even after a `worker.terminate()`.
11. **Engine parameterization (Codex round 2 #3)** — `pw[engine].launchServer()` and `pw[engine].connect()` for all three engines (Chromium, Firefox, WebKit). Engine is captured in the daemon process state and validated on each `daemon.ping`.

**Acceptance:**
- All gates green.
- Manual benchmarks (Codex round 4 #1 — measure daemon overhead, NOT total command time, because `inspect` has `DEFAULT_WAIT_MS=1500` + `networkidle` baked in):
  - **Daemon overhead** measured via a microbenchmark: `connectDaemon({ engine: "chromium", headed: false })` returns a connected `Browser` in ≤ 200 ms when daemon is warm, ≤ 5 s when cold (daemon spawn + BrowserServer launch). Test asserts the warm path's `connectDaemon` measurement is ≥ 5× faster than the cold path's.
  - **Effective `inspect` warm-up benefit** measured against a static-fixture URL with `--wait 0`: `time skeptic inspect file:///<fixture>/index.html --wait 0` warm ≤ 2 s, cold ≤ 6 s. (The 1500-ms default `--wait` and `networkidle` are command-level overhead, not daemon overhead.)
- State-isolation test passes (two consecutive `run` invocations don't share cookies).
- `--no-daemon` flag bypasses the daemon and reproduces the pre-B10 behavior.

---

### Bundle 11 — LICENSES.md + AGENTS.md updates + verification re-run

**Goal:** document the new flags + daemon model, update attribution.

**Files modified:**
- `cli/AGENTS.md`:
  - New section "Daemon mode" — lifecycle, `--no-daemon`, idle timeout.
  - New section "Recording resolution" — `--video-size` flag.
  - New section "Audit reports" — `audit.md` location, format.
  - "Cursor + video" section: mention persistent narration tooltips.
- `cli/LICENSES.md`:
  - Add NOTICE entries for the four new daemon-related files (Apache 2.0 attribution).
- `cli/README.md`:
  - Mention daemon, `--video-size`, and `audit.md` in the README quickstart.
- `tasks/lessons.md`:
  - Append entry: "Daemon mode is opt-out via `--no-daemon`; default-on after first call. State isolation is at the Context layer, not the Browser layer."

**Verification benchmark — `benchmark-artifacts/jigyansurout-<new-ts>/skeptic-v4`:**
- Re-run the v3 spec with the new build:
  - `node dist/skeptic.mjs run tests/jigyansurout-verify.spec.ts --observability --video --video-size 1920x1080 --output ...`
  - Confirm: video is 1920×1080; `audit.md` written with full violation list; cursor tooltip persistent during `expectAccessible` (verify via frame extraction at audit start + audit end).
- Re-run with daemon:
  - First call: cold path. Time it.
  - Second call: warm path. Time it. Confirm ≥ 5× faster than cold.
  - `skeptic daemon stop` cleans up.
- Updated `COMPARISON.md` showing skeptic now matches expect on video resolution + a11y rule surfacing + cursor narration + daemon latency.

---

## Critical files referenced

| Concern | File | Lines |
|---|---|---|
| Cursor overlay tooltip + fade | `cli/src/executor/cursor-overlay.ts` | 304-315 (`setCommandLabel`), 78-86 (CSS), 42 (TOOLTIP_FADE_MS) |
| Cursor side-channel | `cli/src/api/page-proxy.ts` | 200-216 (`fireSetCommandLabel`) |
| Cursor side-channel (engine) | `cli/src/executor/playwright-engine.ts` | 71-84 |
| Action wrapper | `cli/src/api/fixture.ts` | 83-115 (`runAction`) |
| Fixture method labels | `cli/src/api/{fixture.ts,observability.ts,ai.ts}` | various |
| Worker context options | `cli/src/runner/worker.ts` | 100-105 |
| Worker config IPC | `cli/src/runner/ipc.ts` | 19-55 (`WorkerStartConfig`) |
| CLI flags | `cli/src/index.ts` | 74 (`--video` block) |
| Run command | `cli/src/commands/run.ts` | option parsing |
| Test API use config | `cli/src/api/test.ts` | `TestUse` type |
| Dual-engine merge | `cli/src/observability/collectors/accessibility-collector.ts` | 152-163 |
| Markdown rule render | `cli/src/reporter/perf-trace-md.ts` | 216-242 (esp. line 236 cap) |
| Sidecar writer | `cli/src/executor/sidecars.ts` | `writeSidecars` entry |
| Inspect entry | `cli/src/commands/inspect.ts` | 64-145 (current launch flow), 77-82 (`--connect`) |

## Existing utilities to reuse

- `cli/src/utils/playwright-loader.ts` — already abstracts Playwright loading; daemon RPC layer goes through this.
- `cli/src/api/page-proxy.ts:Reflect.apply` pattern — already proven for proxy-wrapping Page/Locator; same shape applies for a daemon-connected browser.
- `cli/src/observability/collectors/accessibility-collector.ts` — already merges axe + IBM with dedup-by-ruleId; only the markdown rendering and per-test `audit.md` are new.
- `cli/src/runner/ipc.ts` — already JSON-message-serialized; same shape for daemon RPC.
- `cli/__tests__/integration/runner/runner-acceptance.test.ts` — pattern for end-to-end runner tests; daemon tests follow the same scaffold.

## Order of operations

```
B7   cursor narration              (independent)
B8   video size override           (independent)
B9   a11y rule cap + audit.md      (independent)
B10  daemon mode                   (independent — RPC is control-plane only;
                                    no field-marshaling dependency on B7-B9)

B11  docs + verification benchmark (depends on B7-B10 merged for the
                                    end-to-end benchmark to demonstrate
                                    all four output-quality wins at once)
```

B7/B8/B9/B10 can all run in parallel by separate teammates. B11 goes last because the verification benchmark needs all four merged. Each bundle is independently revertable. Production binary stays usable after each (B10's `--no-daemon` flag is the safety valve — pre-B10 behavior is preserved).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Daemon state leakage between tests | Each test gets its own `BrowserContext`; daemon shares only the Browser. Integration test asserts no cookie/storage cross-contamination. |
| Daemon hung after SIGKILL | Stale-lockfile detection on next spawn (read PID, `kill -0` check, atomic recreate). |
| Playwright version drift across daemon ↔ client | Pin Playwright in `package.json`; daemon reports its `playwright.version()` on `daemon.ping`; client refuses to connect if mismatch. |
| Persistent tooltip obscures content | Tooltip clamps to viewport (existing logic at `cursor-overlay.ts:198-200` stays); adds a `pointer-events:none` host so it never blocks page interaction. |
| Video-size mismatch with viewport (CSS layout breaks) | Document that `--video-size` only affects the recording resolution, not the page rendering. The browser still renders at viewport dimensions; the video is captured/scaled at the chosen size. |
| `audit.md` blows up on mega-pages with 1000+ violations | Hard cap of 10 example nodes per rule (every rule rendered, but examples truncated); footer shows "+N more nodes" when truncated. |
| New `labels.ts` becomes a hardcoded translation table | Living documentation with one-line entries; PII rule (no interpolation, no args) is enforced at the resolver boundary, not at each call site. |

## Out of scope

- AI-generated test plans (separate tool category; `skeptic generate` already covers AI flow generation).
- Watch-screen TUI redesign.
- Per-test screenshot dimensions independent of viewport (use `screenshot({ clip })` if needed).
- Removing existing functionality. All current step types, reporters, flags stay.

## Verification

After all bundles ship:

1. `cd cli && npm run check && npm test && npm run build` — all green.
2. `node dist/skeptic.mjs daemon status` — exits 0 with "running" or "not running" (informational).
3. **Daemon overhead microbenchmark** (Codex round 4 #1): warm `connectDaemon()` ≤ 200 ms; cold ≤ 5 s. **Effective `inspect` against a static-fixture URL** with `--wait 0`: warm ≤ 2 s, cold ≤ 6 s. (Real-URL inspect is bound by `DEFAULT_WAIT_MS=1500` + `networkidle`, NOT by daemon spawn cost.)
4. `node dist/skeptic.mjs run tests/jigyansurout-verify.spec.ts --observability --video --video-size 1920x1080 --output benchmark-artifacts/jigyansurout-<ts>/skeptic-v4/run-output` produces:
   - 1920×1080 WebM.
   - Cursor tooltip persistent during `expectAccessible` (verify via ffmpeg frame at audit-start + audit-end).
   - `audit.md` listing every IBM + axe violation, no `(equal-access)` rule dropped.
5. State isolation test (two consecutive runs, second sees no cookies/localStorage from first) passes.
6. `skeptic daemon stop` cleans up the socket and PID lockfile.

## Cost estimate

| Bundle | Modified | New | Tests | Total |
|---|---:|---:|---:|---:|
| B7 cursor narration | ~110 | ~80 | ~140 | ~330 (Codex #7 added try/finally proxy wrapping) |
| B8 video size | ~80 | 0 | ~70 | ~150 |
| B9 a11y + audit.md | ~110 | ~90 | ~140 | ~340 (Codex #8/#9 added config threading + reporters) |
| B10 daemon | ~180 | ~750 | ~340 | ~1270 (Codex #1-5 added handshake + security + cleanup tests) |
| B11 docs + verification | ~150 | ~30 (benchmark) | 0 | ~180 |
| **Total** | **~630** | **~950** | **~690** | **~2270 LoC** |

Roughly 6-9 engineering days at typical pace if run sequentially; 4-5 days with B7/B8/B9 parallelized via teammates.
