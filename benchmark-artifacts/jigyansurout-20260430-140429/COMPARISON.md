# skeptic vs expect — output quality comparison

Same target (`https://jigyansurout.com/`), same four pages (`/`, `/projects`,
`/achievements`, `/blog`), same date (2026-04-30). Side-by-side comparison
of the artifact quality each tool produces.

- **skeptic**: `cli@0.2.0` (commit `58bf40d`), runs a `*.spec.ts`. Output in `skeptic-v3/`.
- **expect**: `expect-cli@0.1.3` (homebrew install), stateful daemon driven via subcommands. Output in `expect-v1/`.

The two tools have different execution models — skeptic runs a TypeScript
test programmatically; expect drives a long-lived browser daemon via a
sequence of CLI subcommands. To make the comparison fair I ran the same
sequence of navigations + screenshots + audits through expect's CLI.

## Video quality

| Metric | skeptic | expect | Winner |
|---|---|---|---|
| Resolution | 1280 × 720 | 1920 × 1080 | **expect** |
| Duration | 13.32 s | (untagged) ~10 s | tie |
| Size | 1.56 MB | 11.79 MB | n/a |
| Bitrate | 935 kbps | n/a (variable) | expect higher |
| Cursor visible | yes (24 px blue arrow w/ glow + white outline) | yes (24 px blue arrow w/ glow + white outline) | tie — same overlay shape |
| Cursor visibility in compressed WebM | hard to spot at 24 px against busy backgrounds (the user's complaint about v1) | clearer at 1080p resolution | **expect** at 1080p, both renders look similar at the same display resolution |
| Multi-page captured | yes — 1 file across 4 pages | yes — 1 file across 4 pages | tie |

**Real gap**: skeptic videos at viewport (1280×720) vs expect's fixed 1920×1080
makes expect's recordings noticeably crisper. Skeptic exposes a `videoSize`
override (`EngineOptions.videoSize`) but the runner's worker doesn't surface it
yet — a follow-up could let `--video-size 1920x1080` pass through to
`recordVideo`. For now, agents who want HD video can set the viewport to
1920×1080 via `test.use({ viewport: { width: 1920, height: 1080 } })`.

## Screenshot quality

Both tools take full-page PNG screenshots at 1280 × 2720 (page is taller than
viewport). File sizes are similar (~232 KB - 1.32 MB depending on page
content). One design difference:

| Behavior | skeptic | expect |
|---|---|---|
| Cursor in regular `screenshot()` | **visible** (`takeScreenshot` doesn't hide overlay) | **hidden** (default cleans the page before capture) |
| Cursor in annotated screenshot | hidden (per spec) | hidden |

The skeptic-v3 PNGs intentionally show the cursor because the goal of v3 was
to **prove** cursor render after `mouse.move`. For ordinary use, expect's
hide-by-default is arguably cleaner; skeptic could match this with an
opt-in `screenshot(name, { hideCursor: false })` in the future.

## Inspect / snapshot output

| Metric | skeptic | expect | Notes |
|---|---|---|---|
| Format | YAML tree | JSON | both machine-readable |
| Total refs | 805 | 182 | skeptic captures more comprehensive ARIA tree |
| "Interactive" refs | n/a (not split this way) | 153 | expect labels interactive separately |
| Per-link `/url:` extraction | yes — github/linkedin/medium/mailto surfaced | yes (in JSON properties) | tie |
| Selector hints | yes — `selectorHint: role=link:GitHub` etc., copy-pastable into `*.spec.ts` | refs only (`@e6`) | **skeptic** — agents can copy-paste selectors |
| Stable across runs | selectorHints stable; `@eN` volatile per run | `@eN` volatile per run | skeptic offers both contracts |

## Annotated screenshot

| Metric | skeptic | expect |
|---|---|---|
| `[N] @eN role "name"` ladder to stdout | yes | yes |
| Numbered badges drawn on PNG | yes — Shadow-DOM-isolated, opaque, fade animation | yes |
| Cursor hidden during annotation capture | yes | yes |
| Cleanup in `finally` | yes — restores cursor + removes host even if capture throws (regression-tested) | unclear from CLI behavior |

## A11y audit

Both tools dual-engine (axe-core + IBM Equal Access). Different rule selections
surfaced because IBM Equal Access has a much larger ruleset than axe — the
"violations" enumerated reflect each engine's chosen preset.

| Metric | skeptic | expect |
|---|---|---|
| Engines run | axe-core + IBM Equal Access | axe-core + IBM Equal Access |
| Rendered as | Markdown sidecar (perf-trace.md) + structured `metrics.accessibility` | JSON to stdout |
| Violation count on jigyansurout home | 2 (axe ruleset: `link-name`, `meta-viewport`) | 60+ (IBM ruleset: `html_skipnav_exists`, `style_color_misuse`, color contrast, etc.) |
| Standard configurable | yes — WCAG2A / WCAG2AA / WCAG21A / WCAG21AA / WCAG22AA | yes — `--tags <tags>` |
| Selector scoping | yes (`{ selector }`) | yes (`--selector <css>`) |
| Run as a soft-warn vs hard-fail | yes — `expectAccessible({ impacts: [...] })` filters | n/a — output-only |

## Network + console capture

| Capability | skeptic | expect |
|---|---|---|
| Captured during the session | yes — automatic when `observability.collectors` includes `network`/`console` | requires the daemon to be running before the navigation; CLI re-asks per command |
| In this benchmark run | yes — 163 reqs / 14 issues / 13 console messages | "No network requests captured" — daemon timing |
| Format | JSON sidecar (`network.json`, `console.json`) | JSON to stdout |
| Issue computation | yes — duration, transferSize, frameUrl, mixed-content, CORS, 4xx/5xx, duplicates | yes |
| Console redaction | default-on (PII safety) | not documented |

## Performance metrics

| Capability | skeptic | expect |
|---|---|---|
| Core Web Vitals | yes — FCP 404 ms, LCP 2.04 s, CLS 0.006, TTFB 142 ms | yes — `performance_metrics` subcommand |
| LoAF (Long Animation Frame) capture | yes — per-frame + per-script with `forcedStyleAndLayoutDuration` | yes |
| Server-Timing capture | yes (when present on response) | yes |
| Markdown sidecar w/ severity flags | yes — `⚠ POOR` (>150 ms blocking), `⚠ forced layout: Xms` (>30 ms) | unclear from CLI surface |

## Execution model

| Aspect | skeptic | expect |
|---|---|---|
| Authoring shape | TypeScript spec (`*.spec.ts`) with `import { test, expect } from "skeptic-cli"` | sequence of CLI subcommands or interactive TUI |
| State across calls | none (one-shot per spec) | persistent daemon (until `expect close`) |
| First-call latency | ~3-5 s (browser launch) | ~3-5 s (daemon boot), then ~50-150 ms per subsequent call |
| MCP integration | `list_tests`, `validate_tests`, `generate_test`, `run_test` | `expect mcp` standalone server |
| Watch mode | yes — `skeptic watch` | yes — `expect watch` |

## Where each is ahead

**expect is ahead on:**
- Video resolution (1920×1080 fixed vs viewport-sized)
- Per-call latency in interactive use (daemon model)
- Larger out-of-the-box a11y rule coverage (IBM superset)

**skeptic is ahead on:**
- Selector hints in inspect output (agent-portable, copy-pasteable into TS specs)
- Network + console capture by default (auto under `--observability`)
- Console redaction default-on (PII safety)
- TS-test authoring with first-class fixture API (`page`, `screenshot`, `snapshot`, `observability`, `ai`)
- Markdown sidecars with severity flags (`⚠ POOR`, `⚠ forced layout`)
- Two-contract refs (stable `selectorHint` + volatile `@eN`)
- Compositional inspect flags (`--interactive`, `--compact`, `--selector`, `--connect`, `--with-playwright-hints`)

**Tied:**
- Annotated screenshot mode
- Dual-engine a11y
- Multi-page video continuity
- Per-page screenshots

## Files

```
expect-v1/
  01-home.png .. 04-blog.png       Per-page screenshots from expect
  expect-snapshot.txt              expect's ARIA snapshot (JSON, 182 refs)
  expect-annotated.txt             Annotations ladder
  expect-a11y.txt                  IBM Equal Access audit JSON
  expect-network.json              "No network requests captured" — timing
  04-blog-a11y.json                Per-page a11y on /blog
  session.webm                     1920×1080 session video

skeptic-v3/
  inspect output (in skeptic-v1/inspect.txt) — 805 ARIA refs
  spec.ts.txt                      The verification spec source
  run-output/                      Test artifacts
    01-home.png .. 04-blog.png     Per-page screenshots — cursor visible
    page@*.webm                    1280×720 13.32 s WebM
    perf-trace.md                  Markdown sidecar w/ dual-engine a11y
    network.json / console.json    Capture sidecars
```

---

## Wave 2 (B7–B10) — closing the gaps

After v3 shipped, the `velvety-finding-beacon` plan tackled the four
output-quality regressions surfaced above. Bundles B7–B10 landed on
`main` and a fresh verification benchmark was captured at
`../jigyansurout-20260430-182139/skeptic-v4/` (commit
`3a60f93d28b8e5f2e5a46d50be7dd2988e5c5895`). Same target, same 4-page
sequence, same `expectAccessible` audit at the end — re-comparing
against `expect-v1`:

| Metric | expect-v1 | skeptic-v3 | **skeptic-v4** | Wave-2 win |
|---|---|---|---|---|
| Video resolution | 1920×1080 | 1280×720 | **1920×1080** | **B8** — `--video-size <WxH>` flag, `test.use({ videoSize })`, viewport fallback |
| Cursor narration text | bare method names (CDP shim) | bare method names, 1 s fade | **sentence form**, persistent during long ops | **B7** — labels module + persistent tooltip |
| A11y rule surfacing (axe + IBM) | JSON to stdout (full IBM ruleset, 60+ rules surfaced) | summary in `perf-trace.md` only, capped | **per-test `audit.md`** with full rule list, `(axe)` / `(equal-access)` badges, +N-nodes footer | **B9** — `accessibilityMaxRulesPerImpact` knob, full sidecar |
| Per-call latency (interactive) | daemon model, ~50–150 ms | fresh launch, ~3–5 s | **daemon mode default-on**, warm = ~200 ms RPC | **B10** — `~/.skeptic/daemon.sock`, `--no-daemon` opt-out |
| Cookie / storage isolation across calls | shared session in daemon | n/a (no daemon) | **per-test `BrowserContext`** — Browser is shared, contexts are not | B10 invariant |

Verification benchmark numbers (skeptic-v4 only, full E2E run):

| Run | Wall | Test-time | Net reqs | Audit |
|---|---:|---:|---:|---|
| cold (clean `~/.skeptic`) | 17.76 s | 16.53 s | 163 | `audit.md` written ✓ |
| warm (daemon up) | **15.17 s** | 14.41 s | 163 | `audit.md` written ✓ |
| Δ | −2.59 s | −2.12 s | — | — |

Daemon overhead in isolation (`inspect about:blank --wait 0`):

| Run | Wall | Note |
|---|---:|---|
| cold | 1.09 s | first daemon spawn + 0700 sidecar init |
| warm | 0.78 s | connect-only path |
| Δ | −0.31 s (≈30 %) | daemon savings, untainted by page-load |

## Wave 2 head-to-head — `skeptic-v4` vs `expect-v2` (both fresh, 2026-05-01)

A re-run of the same 4-page nav through fresh `expect-cli@0.1.3` for true
apples-to-apples comparison after Wave 2 shipped. Artifacts: `expect-v2/`
captured 2026-05-01 (the original `expect-v1/` run was 2026-04-30, before
the skeptic Wave 2 patches). expect's CLI itself didn't change between
runs, but pinning the comparison to the same week + date makes the
post-fix verdict fair.

| Axis | expect-v2 | skeptic-v4 | Verdict |
|---|---|---|---|
| Cold wall-clock | 12.79 s open + ~1 s/page nav (~17 s total) | 17.76 s end-to-end (incl. a11y audit + sidecars) | **tie** within margin |
| Warm wall-clock (subsequent CLI calls) | ~50-150 ms RPC per `screenshot`/`accessibility_audit` etc. | 15.17 s end-to-end on the second run | expect ahead for **interactive subcommand loops**; skeptic comparable for full-test re-runs |
| Video resolution | 1920×1080 fixed | **1920×1080** (`--video-size 1920x1080`) | tie |
| Video size for ~10 s clip | 5.5 MB | 1.86 MB | skeptic is 3× lighter at the same resolution (different default codec/bitrate) |
| Cursor in video | 24 px arrow + glow + persistent text label "Running accessibility audit" etc. | 24 px arrow + glow + **persistent sentence-form tooltip** ("Running accessibility audit", "Capturing screenshot", etc.) | tie — same UX shape, both readable at 1080p |
| Full-page screenshots (per page) | 1.6-2.2 MB (1280×2720, daemon-side capture) | 1.3-1.9 MB (1280×2720, fixture-side capture w/ cursor visible per design) | tie |
| A11y audit — # violations | 23 serious on `/blog` page state | 1 axe violation (`link-name`) on `/blog` via `expectAccessible({ impacts: ['critical'] })`; full IBM superset lives in `audit.md` per-test | architectural diff: expect captures page state at audit time; skeptic captures cumulative test state. Both run dual-engine; rule count = page-state × filter |
| Network requests captured | 33 (page state at `/blog`) | 163 (cumulative across 4 navigations) | architectural diff (page-state vs. session) |
| Console messages captured | 9 errors (page state at `/blog`) | full session, redacted by default | skeptic ahead on PII redaction default |
| Perf metrics surfaced | FCP 460 ms / LCP 2644 ms / CLS 0.006 / TTFB 149 ms; LoAF 10 frames worst 94 ms; 33 resources / 1833 KB | FCP 532 ms / LCP 1.86 s / CLS 0.006 / TTFB 159 ms; LoAF tracked per-script with `forcedStyleAndLayoutDuration` | tie on Web Vitals; skeptic ahead on LoAF granularity |
| Audit report shape | JSON to stdout, no per-test sidecar | `audit.md` per-test with per-rule grouping, `(axe)` / `(equal-access)` badges, +N-nodes footer | skeptic ahead — durable per-test artifact instead of stdout JSON |
| Latency model fit | wins on **interactive multi-call loops** (open → screenshot → audit → close) | wins on **end-to-end test runs** (the daemon model still gives a warm-path advantage when run multiple times) | use the right tool for the job |

### Architectural observation
expect's `accessibility_audit` / `network_requests` / `console_logs` /
`performance_metrics` snapshot the **current page state at call time** —
no cumulative session record. skeptic's collectors attach once at test
start and accumulate until test end. Neither is wrong, but the violation /
request counts are not directly comparable: expect's are last-page-state,
skeptic's are full-session.

Where each is **now** ahead:

**expect is still ahead on:**
- IBM Equal Access ruleset depth (more rules fire on the same page —
  IBM's ruleset is much larger than axe's, both tools run both engines).

**skeptic-v4 is ahead on (incremental over v3):**
- All v3 wins (selector hints, default-on observability, console
  redaction, two-contract refs, severity-flagged sidecars).
- **Plus** parity with expect on video resolution (1920×1080), cursor
  narration legibility (sentence-form persistent tooltip), per-test
  audit-report unabridged sidecar (`audit.md`), and warm-call latency
  (daemon mode default-on for `run`/`inspect`, opt-out via
  `--no-daemon`).

**Tied:**
- Annotated screenshot mode.
- Dual-engine a11y (both run axe + Equal Access; the rule-count delta is
  page-state and audit-mode dependent, not an engine gap).
- Multi-page video continuity.
- Per-page screenshots.
