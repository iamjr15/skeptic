---
name: skeptic
description: Use Skeptic for CLI-first browser QA and TypeScript E2E tests. Use when asked to inspect pages, drive a browser interactively, write or run skeptic-cli specs, validate UI changes, or capture observability evidence. Not for unit-only logic with no browser behavior.
---

<!-- skeptic-agent-skill: managed by skeptic-cli -->

# Skeptic

Use Skeptic when you need browser evidence: interactive page-driving, page inspection, TypeScript E2E specs, one-off QA captures, or observability evidence. Do not claim a UI/browser change works until you have run a relevant Skeptic command and checked the evidence.

Skeptic is **agent-native**: it has no model of its own, makes no LLM calls, and needs no API keys. You (the coding agent) are the intelligence; Skeptic is the deterministic hands and eyes. Everything is driven from the shell — there is no MCP server.

## Choose The Surface

- **Drive a browser interactively** (click through a flow, check a fix): use the persistent session verbs — `skeptic open <url>`, `skeptic snapshot -i`, `skeptic click @e3`, etc. Refs persist between commands.
- **One-off discovery** (get stable selectors to write a spec): `skeptic inspect <url> --interactive --compact --with-playwright-hints`.
- **One-off QA / bug hunt** (full evidence bundle for one page): `skeptic observe <url> --full-page --video --trace`.
- **Persistent regression coverage**: inspect, write a `tests/*.spec.ts`, then `skeptic run`.
- **Changed-code verification**: run existing specs with `skeptic run`.

If the `skeptic` binary is not on PATH, try `npx skeptic-cli` or `npx --yes skeptic-cli@latest`.

Specs import the project dependency `skeptic-cli`. A normal `skeptic init` writes that dependency to `package.json`. If specs fail with `Cannot find package 'skeptic-cli'`: in an initialized project run `npm install`; in a project that never ran `skeptic init`, run `skeptic init` first, then `npm install`.

## Persistent Browser Session

A daemon holds the browser, so `@eN` refs from one `skeptic snapshot` stay valid for the next `skeptic click @eN` — across separate commands. The loop:

```bash
skeptic open https://app.example.com    # opens a session (default name "default")
skeptic snapshot -i                      # mints @e1.. refs + stable selectorHints
skeptic click @e3                        # act on a ref from the last snapshot
skeptic fill @e5 "user@test.com"
skeptic snapshot -i                      # RE-SNAPSHOT after the DOM changed
skeptic console --errors                 # check for uncaught errors
skeptic screenshot --full                # returns a file path
skeptic close                            # end the session
```

Verbs: `open`, `snapshot` (`-i` interactive, `-c` compact), `click`, `fill`, `type`, `press`, `hover`, `check`, `uncheck`, `select`, `get <text|box|url|title> [@ref]`, `screenshot` (`--full`, `--annotate`), `console` (`--errors`), `wait` (`--ms` or `--selector`), `list`, `close` (`--all`). Add `--json` to any verb for machine-readable output.

Rules:

- **Re-snapshot after any navigation, route change, modal open/close, or DOM mutation.** Refs are minted per snapshot and invalidated by navigation; acting on a stale ref returns a clear `[ariaRef:stale]` error — re-run `skeptic snapshot`.
- Prefer `@eN` refs from the latest snapshot; for selectors, use the `selectorHint` grammar (`role=button:Save`, `text=...`, `css=...`, `testid=...`).
- Use `--session <name>` for parallel isolated sessions.
- The session browser defaults to headed for local debugging; pass `--headless` on the first `open` for headless environments (CI/containers).
- Binary outputs (screenshots) come back as file paths, not inline data.

## Mobile (Android)

The same verbs drive an Android app on an emulator or attached device via `adb`
(no installed driver, no Appium). Pass `--platform android`; `open` takes a
package name or deep link instead of a URL:

```bash
skeptic open com.example.app --platform android   # launches the app (am start -W)
skeptic snapshot -i                                # uiautomator tree → @eN refs
skeptic click @e5                                  # taps the node's center
skeptic fill @e3 "user@test.com"                   # ASCII input
skeptic is enabled @e5                             # element state (visible|enabled)
skeptic screenshot                                 # device screencap → file path
skeptic record --duration 5                        # screenrecord → .mp4
skeptic perf                                        # gfxinfo jank + meminfo PSS + launch ms
skeptic a11y                                        # uiautomator a11y heuristics
skeptic network                                     # per-uid byte totals (degraded)
skeptic console --errors                           # logcat (app-filtered)
skeptic close
```

Device evidence (parallels the web collectors; read via the verbs above):

- **perf** — `dumpsys gfxinfo` (total/janky frames, frame-time percentiles, missed
  vsync) + `meminfo` (PSS/RSS) + `am start -W` launch timings. A distinct shape from
  web vitals (`platform: "android"`).
- **a11y** — STRUCTURAL uiautomator heuristics only (unlabeled clickables, sub-48dp
  touch targets, NAF nodes). No color-contrast check — the dump has no pixels.
- **network** — `degraded: true` by default: Android exposes only per-uid byte totals,
  never per-request URLs/status. Per-request capture needs an opt-in proxy.
- `is checked` / `get value` aren't available on Android (the node doesn't retain them)
  — they return a structured `[adbQuery:*_unsupported]` error; re-`snapshot` to read state.

Mobile-specific guidance:

- **Emulator GPU mode matters for visual evidence.** A headless emulator launched
  with `-no-window` and the wrong `-gpu` mode returns BLANK screencaps/recordings.
  skeptic detects this (a near-uniform frame) and attaches a `blank-screenshot`
  diagnostic. Fix: relaunch with software rendering —
  `emulator -avd <name> -gpu swiftshader_indirect` (drop `-no-window` if it persists).
  uiautomator dumps and `dumpsys` evidence are unaffected (no GPU needed).
- Refs come from a `uiautomator` accessibility dump (~1–3s each on a healthy
  device). Re-snapshot after every screen change; prefer `res=` (resource-id)
  and `desc=` (content-description) selectorHints over `text=`/`class=`.
- **React Native:** `testID` surfaces as `resource-id` on RN ≥ 0.64 → use `res=`.
  **Compose:** needs `Modifier.semantics { testTagsAsResourceId = true }`, else
  nodes are generic `View`s (rely on `desc=`/`text=`). **Flutter:** needs the
  semantics tree enabled, else the app is one opaque node — fall back to a
  screenshot and tap by coordinates.
- `adb` text input is ASCII-only; non-ASCII `fill`/`type` returns a structured
  `[adbInput:unicode_unsupported]` error — set the value via a deep link or test
  seam instead.
- WebView contents are invisible to uiautomator; for in-WebView assertions, drive
  the web surface separately.
- iOS simulator support (`--platform ios-sim`, via `simctl` + `idb`) is planned;
  real iOS devices are out of scope.

## Writing Specs

Skeptic specs import from `skeptic-cli`.

```ts
import { test, expect } from "skeptic-cli";

test("homepage smoke", async ({ page, snapshot, screenshot, observability }) => {
  await page.goto("https://example.com");
  await expect(page).toHaveTitle(/Example Domain/);

  const tree = await snapshot(page, { interactive: true, compact: true });
  await (await tree.byRef("e1")).click();

  await screenshot("homepage", { fullPage: true });
  await observability.expectNoConsoleErrors();
});
```

Rules:

- Put browser side effects inside `test(...)`, hooks, or helper functions called from tests.
- Prefer role, label, text, and test-id locators over CSS.
- `await snapshot(page)` before interacting through refs; `tree.byRef("eN")` is async — always `await` it.
- Re-snapshot after navigation, route changes, modal open/close, or major DOM mutation.
- Do not paste CLI `@eN` refs into specs. Use `selectorHint` from `inspect`, or `tree.byRef("eN")` only for refs from the same in-test `snapshot(page)` call.
- Add `screenshot("name")` for states that would help debug a failure.

### Android specs

The same `test`/`expect`, runner, and `results.json` drive Android — run with
`skeptic run <spec> --platform android` (`--target <serial>` to pick a device).
Specs get a **`device`** fixture instead of `page` (uiautomator refs, not
Playwright locators):

```ts
import { test, expect } from "skeptic-cli";

test("sessions screen loads", async ({ device }) => {
  await device.open("app.fieldwork.android");      // package or scheme:// deep link
  let snap = await device.snapshot();              // refs + selectorHints
  if (snap.has("text=OK")) {                       // dismiss a dialog if present
    await device.click("text=OK");
    snap = await device.snapshot();                // re-snapshot after the change
  }
  expect(snap.has("Search sessions")).toBe(true);  // match selectorHint / name / role:name
  await device.screenshot("sessions");
});
```

- Targets accept an `@eN` ref from the **last** `device.snapshot()` or a
  selectorHint (`res=`/`desc=`/`text=`). Re-`snapshot()` after every screen change.
- `device.is("visible"|"enabled"|"checked", target)` and `device.get("text"|"value", target)`
  read state; `device.scroll("@e5")` (into view) or `device.scroll({ dy: 600 })` (pan).
- The run auto-attaches mobile evidence to `results.json`: `console` (logcat),
  `mobilePerformance` (gfxinfo/meminfo/launch), `mobileAccessibility`, `mobileNetwork`.
- Using `page` in an android spec (or `device` in a web spec) throws a clear error.

## Observability Checks

Use `--observability` for real QA evidence. In specs, assert the signals that match the risk:

```ts
await observability.expectNoConsoleErrors();
await observability.expectNoNetworkErrors({ allow: [/analytics/] });
await observability.expectPerformance({ lcp: "<2500ms", cls: "<0.1" });
await observability.expectAccessible({ standard: "WCAG21AA" });
```

`skeptic run` always writes `results.json` to the output dir (default `./skeptic-output`). Use it plus screenshots, videos, traces, `network.json`, `console.json`, `accessibility.json`, and `perf-trace.md` as the evidence source. Reference artifact paths from `results.json` instead of guessing filenames. If an observability artifact reports a failure, fix the product or the test and re-run the same flow immediately.

## Verification Standard

Before reporting completion for browser-facing work:

- Run the smallest Skeptic command (session verbs or a spec) that actually exercises the changed behavior.
- Test at least one adjacent or negative path when forms, routing, validation, auth, persistence, or shared components changed.
- Read the full command output. Passing navigation alone is not enough.
- If there are console errors, network failures, serious accessibility issues, poor Web Vitals, or visible regressions, fix and re-run.
- State the exact command run and the main artifact path in the final report.
