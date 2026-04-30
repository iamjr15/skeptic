# AGENTS.md

Instructions for AI coding agents authoring and running tests with
[skeptic-cli](https://github.com/iamjr15/skeptic).

> This document adapts the structure of
> [agent-browser's AGENTS.md](https://github.com/vercel-labs/agent-browser/blob/main/AGENTS.md)
> (Apache License 2.0 — see [LICENSES.md](./LICENSES.md)). The TypeScript-specific
> content, the selector grammar, and the `*.spec.ts` examples are skeptic's own.

---

## Overview

skeptic is a **TypeScript test runner**. You — the agent — author one
`*.spec.ts` file per scenario, declare the test with `test("name", async (fixture) => {...})`,
and skeptic runs it with Playwright. Results land in
`skeptic-output/results.json` (schema v0.3.0) plus per-test sidecars (videos,
traces, screenshots, perf-trace, network/console JSON, accessibility report).

The shape of a test is intentionally close to what Playwright Test, vitest
browser-mode, and Cypress already do — there is no DSL to learn beyond
`async/await`. What skeptic adds on top is a **fixture object** that bundles
seven helpers your test code needs in practice:

```ts
import { test, expect } from "skeptic-cli";

test("homepage smoke", async ({ page, snapshot, screenshot, ai, observability, settle, ctx }) => {
  await page.goto("https://example.com");

  // Standard Playwright assertions.
  await expect(page).toHaveTitle(/Example Domain/);

  // ARIA snapshot — same shape AI agents use to discover the DOM during `inspect`.
  const tree = await snapshot(page);
  await tree.byRole("link", { name: "More information..." }).click();

  // Visual evidence.
  await screenshot("homepage", { fullPage: true });
});
```

Run it with:

```bash
skeptic run tests/homepage.spec.ts --observability --video --trace
```

Open `skeptic-output/results.json` for the structured outcome, and
`skeptic-output/<test>/` for the artifacts.

---

## Discovery (the `inspect` loop)

The job of writing a test starts with **finding the elements you need**.
skeptic exposes a one-shot discovery command:

```bash
skeptic inspect https://example.com
```

This opens a real browser, captures an ARIA + cursor-interactive tree, and
prints the result to stdout. The output looks like:

```yaml
- main:
  - heading "Example Domain" [ref=e2]
  - paragraph: This domain is for use in illustrative examples...
  - link "More information..." [ref=e3] /url: https://www.iana.org/domains/example

  e2 selectorHint: role=heading:Example Domain
  e3 selectorHint: role=link:More information...
  e3 /url: https://www.iana.org/domains/example

2 refs (2 ARIA, 0 cursor-interactive). Stable artifact: copy a selectorHint
into your test — refs are NOT portable across inspect calls. Inside a test,
use @eN only after a snapshot(page) call in the same run.
```

The footer is the one rule you must internalize: **the `selectorHint:` lines
are the stable artifact.** Copy a selectorHint string (`role=link:More information...`)
into your `*.spec.ts`. Do **not** copy `@e3` into the spec file — the ref
number is volatile across runs and across pages.

Other useful flags:

| Flag | Purpose |
|---|---|
| `-i`, `--interactive` | Only show entries that have a ref (`-i` matches agent-browser's flag) |
| `-c`, `--compact` | Interactive + minimal ancestors. Smallest token footprint |
| `--selector "#main"` | Scope the snapshot to a CSS subtree |
| `--json` | Machine-readable output: refs array + per-entry `selectorHint` + `href` |
| `--device iPhone-14` | Discover under a specific device profile |
| `--connect 9222` | Attach to an existing Chrome over CDP (auto-discovers `/json/version`) |
| `--with-playwright-hints` | Also emit `page.getByRole(...)` Playwright snippets (advanced) |
| `--wait 3000` | Wait N ms before snapshotting (post-load animations) |

The intended loop:

1. `skeptic inspect <url>` — see the tree, pick one or more `selectorHint`s.
2. Write `tests/foo.spec.ts` using those hints (`tree.byRole("link", { name: "..." })`).
3. `skeptic run tests/foo.spec.ts` — execute.

If a step fails because the element wasn't found, re-run `inspect` against
the page state at failure time and update the spec. Don't guess CSS selectors —
the inspect output is the source of truth.

### When to use `@eN` (refs)

Inside a test file, after you've called `snapshot(page)`, the returned tree
exposes `byRef("eN")` and the snapshot YAML it captured contains the same
`[ref=eN]` annotations. These refs are **only valid for the lifetime of one
test, after the matching `snapshot(...)` call**. They're useful when you want
to interact with an element you just located via `inspect` in the same run:

```ts
test("interactive snapshot", async ({ page, snapshot }) => {
  await page.goto("https://example.com");
  const tree = await snapshot(page);
  // Inside this test, after this snapshot, refs are stable.
  const link = await tree.byRef("e3");
  await link.click();
});
```

Refs across `snapshot()` calls in the same test are **not** stable — a new
snapshot remints. Treat refs as in-process locator handles, not portable IDs.

---

## Selector cheatsheet

skeptic accepts three layers of selector grammar. You'll mostly use the first.

### 1. selectorHint strings (the agent path)

The `selectorHint:` lines from `inspect` are valid skeptic selectors. The
grammar is forgiving and parses the prefix:

| Form | Example | What it does |
|---|---|---|
| `role=ROLE:NAME` | `role=button:Sign in` | `getByRole("button", { name: "Sign in" })` |
| `testid=ID` | `testid=save-btn` | `getByTestId("save-btn")` |
| `css=SELECTOR` | `css=a[href*="github"]` | Raw CSS escape hatch |
| bare text | `Submit` | Auto-detect chain: testid → role+name → text → label → placeholder → CSS |

Inside a test:

```ts
import { test } from "skeptic-cli";

test("sign in", async ({ page, snapshot }) => {
  await page.goto("https://example.com/login");
  const tree = await snapshot(page);
  await tree.byRole("textbox", { name: "Email" }).fill("alice@example.com");
  await tree.byRole("textbox", { name: "Password" }).fill("hunter2");
  await tree.byRole("button", { name: "Sign in" }).click();
});
```

### 2. The `snapshot()` tree (typed, ref-aware)

`await snapshot(page, opts?)` returns a `SnapshotTree` with strongly-typed
helpers:

| Method | Purpose |
|---|---|
| `tree.byRole(role, { name?, hrefIncludes?, index? })` | Role + accessible-name match. `index` disambiguates when multiple match |
| `tree.byText(text \| RegExp)` | Locator by visible text |
| `tree.byTestId(id)` | Locator by `data-testid` |
| `tree.byRef("eN")` | The N-th ref minted by this snapshot. Returns `Locator` (or `Promise<Locator>` for cursor-interactive entries) |
| `tree.refs` | `Map<string, AriaRefEntry>` — iterate to inspect every minted ref |
| `tree.yaml` | Rendered YAML matching `inspect` output |

`SnapshotOptions`:

| Field | Default | Purpose |
|---|---|---|
| `interactive` | `false` | Match `inspect -i` — only ref-bearing nodes |
| `compact` | `false` | Match `inspect -c` — minimum-context tree |
| `selector` | `"body"` | Scope the snapshot to a CSS subtree |
| `viewportAware` | `true` | Emit "N items hidden above/below" markers |
| `includeCursorInteractive` | `true` | Run the cursor-interactive heuristic for click handlers without ARIA roles |

### 3. Raw Playwright (escape hatch)

`fixture.page` is a real `Page` (wrapped in a Proxy when `--video` is on, but
otherwise transparent). When you need something the snapshot tree can't
express — file uploads, iframe traversal, network mocking, etc. — drop down
to Playwright directly:

```ts
test("upload", async ({ page }) => {
  await page.goto("https://example.com/upload");
  await page.setInputFiles("#file-input", "/tmp/payload.bin");
  await expect(page.locator("#status")).toHaveText("uploaded");
});
```

`expect` is re-exported from `skeptic-cli` so you don't import a second
package. All standard Playwright matchers (`toBeVisible`, `toHaveText`,
`toHaveURL`, `toHaveAttribute`, ...) are available.

### Refs vs selectorHints (the two contracts)

This is the single most important distinction in the agent surface:

- **`selectorHint`** is **portable**. It's a string. Copy it from `inspect`
  output into a `*.spec.ts` file. It survives across runs, across machines,
  across page reloads. Use it in spec files.
- **`@eN`** is **volatile**. It's an in-process handle. Valid only inside
  one test, only after a `snapshot(...)` call, only against the snapshot
  that minted it. Never put `@eN` in a `*.spec.ts` file you intend to run
  later or share. Use it only via `tree.byRef("eN")` in the same async block.

If you ever feel tempted to write `@e3` as a hard-coded string in a spec,
replace it with the `selectorHint` for that ref instead.

---

## Output schema

`results.json` — written by the JSON reporter, schema v0.3.0:

```json
{
  "version": "0.3.0",
  "timestamp": "2026-04-30T05:38:23.000Z",
  "total": 3,
  "passed": 2,
  "failed": 1,
  "duration_ms": 5421,
  "tests": [
    {
      "id": "tests/login.spec.ts#0",
      "name": "sign in",
      "file": "tests/login.spec.ts",
      "status": "passed",
      "duration_ms": 1812,
      "steps": [...],
      "artifacts": {
        "video": "skeptic-output/sign_in/video.webm",
        "trace": "skeptic-output/sign_in/trace.zip",
        "screenshots": ["skeptic-output/sign_in/homepage.png"],
        "perfTrace": "skeptic-output/sign_in/perf-trace.md"
      },
      "metrics": { "performance": {...}, "network": {...}, "console": {...}, "accessibility": {...} },
      "metricsSummary": { "performance": {...} }
    }
  ]
}
```

What changed between schema versions:

- **0.3.0 (TS-pivot)**: `flows` field renamed to `tests`. Per-test `id` is
  `<file>#<ordinal>` — stable across reorderings of unrelated tests in the
  same file.
- **0.2.0**: Added `artifacts` (video/trace/screenshots), `diagnostics[]` per
  step, and `metricsSummary` (precomputed aggregates).

Each step inside `steps[]` carries `command`, `status`, `duration_ms`, and
optional `error`, `warnings[]`, `diagnostics[]`. See "Failure-mode guide"
below for the diagnostic kinds you'll most often see.

Sidecars in `<output>/<test>/`:

- `video.webm` — full session video. Recorded at the configured viewport
  size (no automatic 800x450 clamp; see lessons §22). On under `--video`.
- `trace.zip` — Playwright trace, openable with `npx playwright show-trace`.
  On under `--trace`.
- `<name>.png` — every `screenshot(name, ...)` call writes here. Names are
  sanitized.
- `perf-trace.md` — Markdown summary of LoAF entries, long tasks, and
  Server-Timing headers. Written when the performance collector is on.
- `network.json`, `console.json` — captured-and-redacted streams. Default-on
  PII redaction (URL token-shaped params, `Bearer ...`, JWTs, `password=`,
  email local-parts) — see `redactConsoleText` for the full pipeline.
- `accessibility.json` — axe-core findings (and IBM Equal Access findings,
  deduplicated by rule ID, when the optional `accessibility-checker-engine`
  peer is installed and `--observability` is on or
  `accessibilityDualEngine: true`).
- `report.html` — human-readable HTML report combining everything.

A sidecar Markdown file (`<test>.md`) is written alongside the JSON when
`--reporter html` or `--observability` is set. It links every artifact and
contains the rendered selectorHint table for the test's snapshots.

---

## Failure-mode guide

Diagnostics surface as `step.diagnostics[]` in `results.json` and as a
yellow-tinted line under the failing step in console output. Each carries a
`kind` string, a human-readable `message`, and optional `meta`.

| `kind` | Meaning | What to do |
|---|---|---|
| `blank-screenshot` | The captured PNG is mostly one color (e.g. solid black). Often a WebGL/canvas preloader hadn't finished. | Add `await fixture.settle()` (or `--full-page-screenshot`) before the screenshot; investigate whether DOM-visible matches screen-visible. |
| `settle-timeout` | `fixture.settle()` exceeded its time budget waiting for `networkidle` + double-RAF. | Page never quiesces (long-poll WS, polling fetches). Use a more specific wait (`waitForSelector` on a known stable element). |
| `path-rejected` | A path passed to a fixture method escaped the test's sandbox root (absolute path or symlink-traversal). | Pass paths relative to the test file, or to `ctx.flowDir`. The MCP/ACP servers enforce this strictly to defeat untrusted-prompt attacks. |
| `auto-a11y-skipped` | Auto-accessibility audit was scheduled but the optional `accessibility-checker-engine` peer wasn't installable. | Either accept axe-only (slim binary case), or install the peer: `npm install accessibility-checker-engine`. Standalone binary always degrades. |
| `aria-snapshot` | A `snapshot()` call failed to capture a tree (page closed mid-capture, eval threw, etc.). | Re-snapshot after the navigation/state change is done; check that no abort is in-flight. |
| `annotation-map` | Diagnostic-only. Carries the per-label boundingBox map for an annotated screenshot (`screenshot(name, { annotate: true })`). Not a failure. | Ignore unless you're auditing label placement. |

When a step fails, you also get the canonical Playwright error at
`step.error`. Combine that with the surrounding diagnostics to triage:

- Selector failure (`Could not find element ...`): re-run `inspect`.
- Timeout (`Timeout 30000ms exceeded`): check `--video` for what happened.
- Assertion mismatch (`expected "foo" but got "bar"`): the page rendered;
  the assertion is wrong or the data changed.
- Hard-timeout (Promise.race wins over the body, see invariants in
  `cli/src/api/page-proxy.ts`): the step has `optional: true` semantics or
  the test exceeded `hardTimeout`.

---

## Common patterns

These are the patterns you'll write 90% of the time. Each is copy-pastable.

### Login

```ts
import { test, expect } from "skeptic-cli";

test("login", async ({ page, snapshot }) => {
  await page.goto("https://example.com/login");
  const tree = await snapshot(page);
  await tree.byRole("textbox", { name: "Email" }).fill(process.env.TEST_USER!);
  await tree.byRole("textbox", { name: "Password" }).fill(process.env.TEST_PASS!);
  await tree.byRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
});
```

Pair with `--cookies` to seed cookies from your local browser, or use
`test.use({ cookies: { browser: "chrome" } })` for per-test seeding.

### Multi-page navigation (preserve cursor across pages)

The cursor overlay persists across navigations via `sessionStorage`. Don't
add manual setup:

```ts
test("traverse the site", async ({ page, snapshot, screenshot }) => {
  await page.goto("https://example.com");
  await screenshot("home");

  await snapshot(page).then((t) => t.byRole("link", { name: "About" }).click());
  await page.waitForURL(/\/about/);
  await screenshot("about");

  await snapshot(page).then((t) => t.byRole("link", { name: "Contact" }).click());
  await page.waitForURL(/\/contact/);
  await screenshot("contact");
});
```

In the recorded video (`--video`), the synthetic cursor and action markers
follow you across all three pages.

### Hover-then-click

For UI that reveals content on hover (dropdowns, tooltips):

```ts
test("hover dropdown", async ({ page, snapshot }) => {
  await page.goto("https://example.com");
  const tree = await snapshot(page);
  await tree.byRole("button", { name: "Account" }).hover();
  // Dropdown is now in the DOM — re-snapshot to mint refs for it.
  const expanded = await snapshot(page);
  await expanded.byRole("link", { name: "Settings" }).click();
});
```

Re-snapshot any time the visible-DOM changes meaningfully. Refs from the
pre-hover snapshot don't carry over.

### Scroll-into-view-then-assert

```ts
test("footer link", async ({ page, snapshot }) => {
  await page.goto("https://example.com");
  const tree = await snapshot(page);
  const link = tree.byRole("link", { name: "Privacy" });
  await link.scrollIntoViewIfNeeded();
  await expect(link).toBeVisible();
  await link.click();
});
```

### Observability assertions

Pass `test.use({ collectors: ["performance", "network", "console", "accessibility"] })`
or run with `--observability` (the richest profile):

```ts
test.use({ collectors: ["performance", "network", "accessibility"] });

test("perf budget", async ({ page, observability }) => {
  await page.goto("https://example.com");
  await page.waitForLoadState("networkidle");

  await observability.expectPerformance({ lcp: "<2500ms", cls: "<0.1", inp: "<200ms" });
  await observability.expectNoNetworkErrors({ allow: [/analytics\./] });
  await observability.expectAccessible({ standard: "WCAG21AA", impacts: ["critical", "serious"] });
});
```

Thresholds use a tiny grammar: `<N`, `<=N`, `>N`, `>=N`, with optional `ms`
suffix.

### AI assertions

```ts
test.use({ collectors: [] }); // AI doesn't need the collectors

test("hero looks right", async ({ page, ai }) => {
  await page.goto("https://example.com");
  await ai.assert("the hero section shows a welcome message and a primary CTA button");
  await ai.assertNoDefects(); // generic visual-defect scan
  const cta = await ai.extract("the text of the primary call-to-action button");
  expect(cta.toLowerCase()).toContain("get started");
});
```

AI features need a configured provider (`GEMINI_API_KEY`, `OPENAI_API_KEY`,
or `ANTHROPIC_API_KEY`). They run against PII-redacted screenshots by
default.

---

## The cursor + video

`--video` records a WebM at the configured viewport size, with skeptic's
synthetic cursor overlay drawn on top. Run with:

```bash
skeptic run tests/login.spec.ts --video --trace --observability
```

The cursor overlay shows:

- A circular cursor at the current pointer location.
- A short fading **action marker** at every fixture-routed `click`/`fill`/
  `hover`/`press`/`type`/`dblclick`/`selectOption` call.
- A **persistent narration tooltip** beside the cursor — labels are written
  in **sentence form** (`Clicked the "Sign in" button`, `Filled the email
  field`, `Auditing accessibility (axe + IBM Equal Access)`), not as bare
  method names. The tooltip stays on screen for the full duration of long
  operations (accessibility audit, network-idle wait, AI step) so a viewer
  reading frames out of context can still tell what skeptic was doing.
- The tooltip clamps to the **viewport edges** — it shifts left when the
  cursor sits in the right gutter, and the host element uses
  `pointer-events: none` so the tooltip never blocks page interaction or
  steals click targets.

These markers are **best-effort and only fire for fixture-routed methods**.
A raw `await page.click(...)` (no fixture interception) does not draw a
marker. If you want every action marked, use the snapshot-tree locators
(`tree.byRole(...).click()`) or wrap the call in
`fixture.runAction("label", () => page.click(...))`.

Tip: use `--trace` for click-by-click timing (Playwright trace viewer); use
`--video` for visual review. They're complementary.

---

## Recording resolution

The default WebM resolution is the configured viewport size (1280×720
unless overridden). For HD recordings or to match a downstream
review-tool's expected size, override the resolution without changing how
the page renders:

| Surface | Where | Example |
|---|---|---|
| CLI flag | `skeptic run` and `skeptic inspect` | `--video --video-size 1920x1080` |
| Per-test | `test.use({ videoSize })` at file or test scope | `test.use({ videoSize: { width: 1920, height: 1080 } })` |
| Viewport fallback | `test.use({ viewport })` | applies when `videoSize` is unset |

**Precedence (highest wins):** CLI `--video-size` > `test.use({ videoSize })`
> viewport size. The CLI flag value is forwarded to the worker as a
`{width, height}` pair and lands on `recordVideo.size` in the
`browser.newContext` options.

`--video-size` only changes the **recording resolution**, not the page
rendering. The browser still lays out at viewport dimensions; Playwright
captures and scales the recording at the chosen size. If you need a
specific layout (e.g. wide hero), set both:

```bash
skeptic run tests/hero.spec.ts \
  --video --video-size 1920x1080 \
  # use test.use({ viewport: { width: 1920, height: 1080 } }) for layout
```

Format: `<width>x<height>` (lowercase `x`), integers only, both within
`[1, 7680]`. Malformed values fail fast with a clear error before the
worker spawns.

Verify the result with `ffprobe`:

```bash
ffprobe -v error -select_streams v -show_entries stream=width,height \
  -of csv=p=0 skeptic-output/<test>/page@*.webm
```

---

## Audit reports

Under `--observability` (or YAML `observability.autoAccessibilityAudit:
true`), skeptic runs the dual-engine accessibility collector — axe-core +
IBM Equal Access — and writes two artifacts per test:

- **`perf-trace.md`** — the cross-cutting performance + a11y digest. The
  Accessibility section is **summary-only** here: rules grouped by impact
  bucket (`critical`/`serious`/`moderate`/`minor`), capped at
  `accessibilityMaxRulesPerImpact` (default 100), with a
  `…and N more — see audit.md` footer when truncated. This file stays
  legible on mega-pages.
- **`audit.md`** — the **full** per-test report. No rule-level
  truncation: every axe + Equal Access violation is rendered.

`audit.md` lives at `skeptic-output/<test>/audit.md` (same directory as
`perf-trace.md`, `network.json`, `console.json`, `page@*.webm`). The HTML
report links it as "Open audit.md" in the per-test artifact card.

Format:

- **Per-rule grouping**, ordered `critical → serious → moderate → minor`,
  alphabetical within bucket.
- Each rule block opens with the rule id, an engine badge — **`(axe)`**
  or **`(equal-access)`** — and the violation summary.
- Up to **10 example node selectors per rule** (CSS path or stable
  attribute), truncated with `+N more nodes` when a rule fires on more
  than 10 elements. Every rule is rendered; only the **examples** are
  capped, never the rule list itself.
- The dual-engine merge dedupes by canonical rule id so the same finding
  isn't double-counted, but every engine-unique rule is preserved — no
  `(equal-access)` rule is silently dropped when axe also flagged a
  related (but not identical) issue.

When to read which:

| Need | File |
|---|---|
| Quick pass/fail signal in CI | `perf-trace.md` Accessibility section |
| Every violation for compliance review | `audit.md` |
| Programmatic consumption | `metrics.accessibility` in `results.json` |

The **`accessibilityMaxRulesPerImpact`** config knob (CLI/YAML/`test.use`)
controls only the `perf-trace.md` cap. `audit.md` always renders the
complete rule set; the example-node cap is fixed at 10 per rule (with the
`+N more nodes` footer) and not user-tunable — that limit guards
file size on adversarial pages without dropping rule visibility.

To opt into a higher cap in `perf-trace.md`:

```yaml
# skeptic.config.yaml
observability:
  autoAccessibilityAudit: true
  accessibilityMaxRulesPerImpact: 0   # 0 = show every rule in perf-trace.md too
```

---

## Daemon mode

skeptic ships with a persistent **BrowserServer daemon** that keeps a
warm Chromium between calls. It's auto-spawned on first use of `run` or
`inspect`, listens on a Unix socket at `~/.skeptic/daemon.sock`, and
exits after an idle window (default 300 s).

What's shared and what isn't:

- The daemon owns the **`Browser`** process. Every test connects via
  Playwright's `chromium.connect(wsEndpoint)` and creates its **own
  `BrowserContext`** — cookies, storage, service workers, IndexedDB.
- Cleanup-on-disconnect is Playwright's native WebSocket-disconnect
  behavior. The daemon does not track contexts; when a worker closes its
  WebSocket, Playwright tears down that worker's context. State does not
  bleed across tests.
- The daemon does **not** marshal browser ops over the socket. It's a
  control-plane RPC only (handshake, version probe, idle reset). Page,
  Locator, and routing operations stay on the direct Playwright
  WebSocket.

Lifecycle:

| Event | Behavior |
|---|---|
| First `run`/`inspect` after a clean `~/.skeptic/` | Cold spawn (~3-5 s). PID + version + engine sidecar files written. |
| Subsequent calls within the idle window | Warm path — connect-only, no browser launch. Typically < 200 ms RPC. |
| Idle for `--daemon-idle-timeout` seconds | Daemon self-exits and unlinks its sidecars. |
| `SIGINT` / `SIGTERM` / `SIGHUP` | BrowserServer closed first, then sidecars unlinked, then process exit. |
| Stale lockfile (PID dead) | Detected on next spawn (`kill -0` probe), atomically recreated. |
| Playwright version mismatch on `daemon.ping` | Client refuses to connect, restarts the daemon, retries (capped). |

Flags:

| Flag | Surface | Effect |
|---|---|---|
| `--no-daemon` | `run`, `inspect` | Bypass the daemon — fresh browser launch per call (pre-B10 behavior). Safety valve when daemon misbehaves. |
| `--daemon-idle-timeout <seconds>` | `run`, `inspect`, `daemon start` | Override the default 300 s idle window. `0` disables the timer. |

Subcommands (under `skeptic daemon`):

| Command | Purpose |
|---|---|
| `daemon start [--engine chromium\|firefox\|webkit] [--headed] [--daemon-idle-timeout N]` | Foreground start. Useful for explicit control or for inspecting daemon stdout/stderr. |
| `daemon stop` | Send a clean shutdown over the socket. Removes lockfile + socket. Idempotent. |
| `daemon status` | Print running / not-running, uptime, connected clients, engine. Exit 0 either way (informational). |
| `daemon logs` | Tail the daemon log at `~/.skeptic/daemon.log`. |

Security envelope:

- `~/.skeptic/` is created with **`0700`** (owner-only). The socket and
  PID lockfile inherit the parent's restriction; Unix-socket
  filesystem-permission semantics enforce the boundary.
- Optional shared-secret auth: set
  **`SKEPTIC_DAEMON_AUTH_TOKEN=<token>`** in the daemon's environment.
  When set, every connecting client must present the same token in the
  handshake; mismatch closes the socket. The token never traverses the
  network — daemon and clients are colocated on the same host.
- The daemon's WebSocket endpoint is bound to `127.0.0.1` only. There is
  no path that exposes the BrowserServer to other hosts.

Common workflows:

```bash
# Default — auto-spawned, warmed across runs
skeptic run tests/foo.spec.ts --observability --video

# Disable daemon for a single run (e.g. while debugging the daemon itself)
skeptic run tests/foo.spec.ts --no-daemon

# Foreground with a 30 s idle window for short-lived dev sessions
skeptic daemon start --daemon-idle-timeout 30

# Always-on under tmux for a long review session, 0 = never idle out
skeptic daemon start --daemon-idle-timeout 0

# Status check before a CI gate
skeptic daemon status

# Stop before suspending the laptop
skeptic daemon stop
```

If the daemon ever wedges, the recovery path is `skeptic daemon stop &&
rm -rf ~/.skeptic` — the next `run` will cold-spawn cleanly.

---

## MCP / ACP integration

skeptic ships two protocol surfaces for editor/agent integration:

- **`skeptic mcp`** — a Model Context Protocol server (stdio). The discovery
  layer (`list_tests`, `validate_tests`, `generate_test`) is **import-only**
  and never executes a test. Use `run_test` (a separate tool) when you want
  side effects.
- **`skeptic acp`** — an Agent Client Protocol server (stdio). Editors like
  Zed and Cursor connect over ACP and prompt skeptic in natural language
  ("run flows/login.spec.ts", "validate tests/**/*.spec.ts"). The prompt
  parser is heuristic; arbitrary prompts fall back to a help message.

Both servers redirect their logger to stderr before opening the stdio
channel — stdout is reserved for the protocol's NDJSON. Both enforce
realpath-bounded sandboxing on every file path in the prompt (absolute,
lexical, and symlink-escape rejected before any read; see lessons §20).

Start the MCP server:

```bash
skeptic mcp
```

Wire ACP into your editor:

```json
{
  "agent": {
    "command": "skeptic",
    "args": ["acp"]
  }
}
```

The two protocols coexist — they're different processes, can run in
parallel, share the same parser/engine/AI client.

---

## Code style for spec files

A few conventions to keep specs readable and reviewable:

- **One scenario per file.** Use `test.describe.skip()` and split files
  rather than nest scenarios.
- **Top-level `test.use({...})`** for file-wide config (collectors, base URL,
  viewport). Per-test overrides as the third arg to `test()`.
- **Hooks** (`test.beforeEach`, `test.afterEach`) are file-scoped. They run
  inside the same fixture lifecycle as the tests.
- **No comments unless explaining non-obvious "why".** The test name is the
  description.
- **Arrow functions** and `async/await` only. No `.then()` chains in spec
  files (acceptable in the few inline snippets above, but avoid as a
  pattern).
- **Don't import from internal paths.** Public surface is `skeptic-cli`
  (re-exports `test`, `expect`, plus types). Anything under
  `skeptic-cli/dist/...` is unstable.

---

## Verification before you ship

For any non-trivial test you author, the gold-path verification loop:

```bash
# 1. Type-check
skeptic run tests/foo.spec.ts --list   # discover-only, no browser

# 2. Run with full evidence
skeptic run tests/foo.spec.ts --observability --video --trace

# 3. Review
open skeptic-output/report.html
```

If `--list` rejects the file, fix the TypeScript before running with a
browser — `tsx` resolves the imports at discovery time, and a missing import
will surface as a discovery error, not a flaky run.

If you wrote a test from `inspect` output and it fails on the first run,
the workflow is: re-`inspect` against the page state at failure time
(captured in `--video`), update the `selectorHint` you used, re-run.
Selectors from `inspect` are stable; if a selector failed, the page
changed.

---

## Attribution

Sections of this document (Discovery, Selectors, Output schema, Failure
modes, Common patterns, Cursor + video) adapt the structure of
agent-browser's own AGENTS.md. The skeptic-specific TypeScript content
(spec examples, the fixture object, the snapshot tree's typed methods, the
results.json schema, MCP/ACP semantics) is original. agent-browser is
licensed under the Apache License 2.0; see [LICENSES.md](./LICENSES.md) for
the full attribution and per-file `// Source: agent-browser ...` headers.
