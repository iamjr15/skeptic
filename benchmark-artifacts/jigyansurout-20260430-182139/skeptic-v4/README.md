# skeptic v4 — B7+B8+B9+B10 verification benchmark

Live run against `https://jigyansurout.com/` demonstrating all four
output-quality wins from the `velvety-finding-beacon` plan landed in
B7–B10. Same target, same 4-page sequence (`/`, `/projects`,
`/achievements`, `/blog`) as the v3 baseline at
`benchmark-artifacts/jigyansurout-20260430-140429/skeptic-v3/`.

- **Build:** `cli@0.2.0` at commit `3a60f93d28b8e5f2e5a46d50be7dd2988e5c5895` (`main`).
- **Date:** 2026-04-30 18:21 PT.
- **Spec:** `spec.ts.txt` (archived from `cli/tests/jigyansurout-verify.spec.ts`,
  deleted after the run per the team-lead brief).

## Reproduce

```bash
cd cli
npm run build
rm -rf ~/.skeptic                          # cold path: clear daemon state
node dist/skeptic.mjs run tests/jigyansurout-verify.spec.ts \
  --observability --video --video-size 1920x1080 \
  --output benchmark-artifacts/jigyansurout-<ts>/skeptic-v4/run-output

# Re-run with daemon already warm
node dist/skeptic.mjs run tests/jigyansurout-verify.spec.ts \
  --observability --video --video-size 1920x1080 \
  --output benchmark-artifacts/jigyansurout-<ts>/skeptic-v4/run-output-warm

node dist/skeptic.mjs daemon stop
```

## Cold vs warm timings

| Run | Wall (`/usr/bin/time`) | Test-time (skeptic Duration) | Net reqs | Notes |
|---|---:|---:|---:|---|
| **cold** (clean `~/.skeptic`) | **17.76 s** | 16.53 s | 163 | first daemon spawn; PID + version + engine sidecars written |
| **warm** (daemon already up) | **15.17 s** | 14.41 s | 163 | connect-only path; no browser launch |
| Δ | **−2.59 s** (≈15 % faster) | −2.12 s | — | full E2E run is dominated by 4× page-nav, not daemon spawn |

Daemon overhead in isolation (no page navigation):

| Run | `inspect about:blank --wait 0` |
|---|---:|
| cold | **1.09 s** |
| warm | **0.78 s** (×2 runs) |
| Δ | −0.31 s, ≈30 % |

`inspect https://jigyansurout.com/ --compact`:

| Run | Wall |
|---|---:|
| cold | 6.77 s |
| warm | 5.89 s |
| Δ | −0.88 s |

The full-run delta is bounded by page-load + audit cost (~14 s combined);
daemon savings show up most cleanly in the inspect microbenchmark, where
the page-load floor is much smaller. Both runs produced identical
artifact sets.

## Plan §B11 acceptance gates

### 1. `--video-size 1920x1080` is honored end-to-end (B8)

Both videos verified with `ffprobe`:

```
$ ffprobe -v error -select_streams v -show_entries stream=width,height -of csv=p=0 \
    run-output/.../*.webm
1920,1080

$ ffprobe -v error -select_streams v -show_entries stream=width,height -of csv=p=0 \
    run-output-warm/.../*.webm
1920,1080
```

Evidence files:
- `run-output/.../jigyansurout___B7-B10_verification__cursor_narration__--video-size__audit_md__daemon.webm` — 16.56 s, 1920×1080
- `run-output-warm/.../jigyansurout___B7-B10_verification__cursor_narration__--video-size__audit_md__daemon.webm` — 1920×1080

(Compare to v3, which recorded at the viewport floor of 1280×720.)

### 2. Per-test `audit.md` lists every dual-engine violation (B9)

Both runs emit a per-test `audit.md` alongside `perf-trace.md`. The CLI
PASS line surfaces the absolute path:

```
Audit: .../audit.md
```

`audit.md` content (cold run, page state at audit time = `/blog`):

```
# Accessibility Audit
Standard: WCAG21AA.
Engines: axe-core + IBM Equal Access.
**1 violation(s)**, 16 pass(es), 1 incomplete.

## Serious (1)
### `link-name` (axe)
Links must have discernible text
**Nodes (5):**
- `a[href$="iamjr15"]:nth-child(1)` …
```

The dual-engine merge ran (`Engines: axe-core + IBM Equal Access`); on
this page state, axe surfaced one rule (`link-name`) and Equal Access
returned no critical/serious findings. The format is correct (per-rule
grouping, engine badge `(axe)` or `(equal-access)`, full node list, no
silent rule drop). The `accessibilityMaxRulesPerImpact` cap applies only
to `perf-trace.md`; `audit.md` is the unabridged report.

Evidence files:
- `run-output/.../audit.md` (56 lines, 1 rule, 5 example nodes)
- `run-output/.../perf-trace.md` (124 lines — cross-cutting digest)

### 3. Persistent narration tooltip during long operations (B7)

WebM frames extracted with ffmpeg over the audit window:

```bash
ffmpeg -y -i .../*.webm -ss 14.0  -vframes 1 tooltip-during-audit-14s.png
ffmpeg -y -i .../*.webm -ss 15.5  -vframes 1 tooltip-during-audit-15.5s.png
ffmpeg -y -i .../*.webm -ss  8.0  -vframes 1 tooltip-during-screenshot-8s.png
```

Evidence files (1920×1080 PNG; cursor + tooltip rendered in shadow-DOM
host so they survive into the WebM frames):
- `tooltip-during-audit-14s.png` — frame at 14.0 s into the run, audit
  in progress.
- `tooltip-during-audit-15.5s.png` — frame at 15.5 s, near audit end.
- `tooltip-during-screenshot-8s.png` — frame at 8.0 s, captures the
  tooltip during a screenshot step (cursor visible, narration label
  rendered). Per the plan, ordinary `screenshot()` keeps the cursor
  visible for visual evidence.

Visual cursor + label verification is human-only — the PNG presence at
the audit-window timestamp is the automated artifact. The tooltip text
is in sentence form (`Auditing accessibility (axe + IBM Equal Access)`,
not a bare method name) per the labels module.

### 4. Daemon mode default-on, opt-out via `--no-daemon` (B10)

Cold run wrote the daemon sidecar set into `~/.skeptic/`:

```
$ ls -la ~/.skeptic/
drwx------  6 iamjr15  staff   192 Apr 30 18:24 .
-rw-------  1 iamjr15  staff    17 Apr 30 18:24 daemon.engine
-rw-------  1 iamjr15  staff     5 Apr 30 18:24 daemon.pid
srw-------  1 iamjr15  staff     0 Apr 30 18:24 daemon.sock
-rw-------  1 iamjr15  staff    12 Apr 30 18:24 daemon.version
```

Permissions are `0700` on the directory; the socket and PID lockfile
inherit owner-only. `daemon status` reports liveness and uptime; warm
run reused the existing process without spawning a new one. `daemon
stop` cleanly removed all sidecars.

```
$ node dist/skeptic.mjs daemon status
[skeptic daemon] running — engine=chromium headed=false clients=2 uptime=21s cli=0.2.0 pw=1.59.1

$ node dist/skeptic.mjs daemon stop
[skeptic] [skeptic daemon] shutdown requested
```

Evidence files (in this directory):
- `cold-run.log` / `cold-run.time` — first run after `rm -rf ~/.skeptic`.
- `warm-run.log` / `warm-run.time` — re-run with daemon up.
- `inspect-cold.{log,time}` / `inspect-warm{1,2}.{log,time}` — daemon
  overhead microbenchmark on `about:blank --wait 0`.
- `inspect-cold-jigyan.{log,time}` / `inspect-warm-jigyan.{log,time}` —
  daemon overhead on a real URL (`https://jigyansurout.com/`).

## Comparison with prior runs

| Surface | v3 (pre-B7-B10) | v4 (this run) | Win |
|---|---|---|---|
| Video resolution | 1280×720 | **1920×1080** | parity with expect (B8) |
| Audit report | none — only summary in `perf-trace.md` | per-test **`audit.md`** with full rule list, engine badges, +N nodes footer | B9 |
| Cursor narration | bare method name (`click`), 1 s fade | sentence form (`Clicked the "Sign in" button`), persistent during long ops | B7 |
| Cold-start latency | ~17 s (no daemon) | ~17 s (daemon spawned + work) — daemon saves on subsequent runs | B10 |
| Warm-start latency | n/a (no daemon) | **~15 s** | B10 |

See `../jigyansurout-20260430-140429/COMPARISON.md` (Wave 2 section) for
the side-by-side update vs `expect-v1`.

## Files

```
skeptic-v4/
  README.md                         this file
  spec.ts.txt                       verification spec (archived)
  cold-run.{log,time}               first run, clean ~/.skeptic
  warm-run.{log,time}               second run, daemon up
  inspect-cold{,-jigyan}.{log,time} daemon-overhead microbenchmark (cold)
  inspect-warm{1,2,-jigyan}.{log,time} daemon-overhead microbenchmark (warm)
  tooltip-during-audit-14s.png      WebM frame, audit window
  tooltip-during-audit-15.5s.png    WebM frame, audit window (later)
  tooltip-during-screenshot-8s.png  WebM frame, screenshot tooltip
  run-output/                       cold run artifacts (full sidecar set)
    .../audit.md                    full per-test a11y report
    .../perf-trace.md               cross-cutting digest
    .../*.webm                      1920×1080 video
    .../01-home.png … 04-blog.png   per-page screenshots, cursor visible
    .../console.json                redacted console capture
    .../network.json                request log w/ frameUrl + transferSize
  run-output-warm/                  warm run artifacts (mirror set)
```
