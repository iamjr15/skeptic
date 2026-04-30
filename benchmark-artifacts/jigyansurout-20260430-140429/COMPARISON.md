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
