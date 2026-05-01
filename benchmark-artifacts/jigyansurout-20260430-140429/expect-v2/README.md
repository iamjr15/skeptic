# expect-v2 — fresh side-by-side run after Wave 2 (B7-B10) shipped

Same target (`https://jigyansurout.com/`), same four-page navigation
sequence (`/`, `/projects`, `/achievements`, `/blog`), captured 2026-05-01
via `expect-cli@0.1.3` (homebrew install). Used to update
`../COMPARISON.md` with a true post-Wave-2 head-to-head against
`../../jigyansurout-20260430-182139/skeptic-v4/`.

## Run timing
- `expect-cli open --wait-until networkidle https://jigyansurout.com/` — **12.79 s** cold (first daemon spawn + browser launch + first navigation).
- Subsequent 3 `playwright "await page.goto(...)" + screenshot` round-trips: ~1 s each.
- `accessibility_audit`, `performance_metrics`, `network_requests`, `console_logs` — sub-second each (issued against the daemon).

## Captured artifacts
| File | Bytes | Notes |
|---|---:|---|
| `01-home.png` | 1.92 MB | full-page screenshot, 1280×2720 |
| `02-projects.png` | 2.19 MB | 1280×2720 |
| `03-achievements.png` | 1.94 MB | 1280×2720 |
| `04-blog.png` | 1.61 MB | 1280×2720 |
| `session.webm` | 5.5 MB | 1920×1080 (Playwright BrowserServer-default) |
| `expect-a11y.json` | 15.6 KB | 23 serious violations on `/blog` (audit ran on the last navigated page state) |
| `expect-perf.json` | 0.4 KB | text-form summary; the actual trace lives in `expect-perf-trace.md` |
| `expect-perf-trace.md` | 3.1 KB | FCP 460 ms, LCP 2644 ms, CLS 0.006, TTFB 149 ms; 10 LoAF (worst 94 ms); 33 resources / 1833 KB |
| `expect-network.json` | 22.4 KB | requests captured on `/blog` page state only (33 entries); 1 duplicate (`/cdn-cgi/rum?` ×3) |
| `expect-console.json` | 2.7 KB | 9 errors / 0 warnings on `/blog`; mostly font-MIME mismatches |

## Architectural observation
expect's CLI is stateless across subcommands except for the daemon's persistent
browser. Each `accessibility_audit` / `network_requests` / `console_logs` /
`performance_metrics` invocation captures the **current** page state at
call time — there's no cumulative session record. So:

- expect's a11y count (23) is for `/blog` only.
- expect's network (33 reqs) is for `/blog` only.
- skeptic's a11y is from `expectAccessible()` inside a TS test that visits
  all 4 pages — the dual-engine snapshots on whichever page state the
  fixture call hit.
- skeptic's network (163 reqs) is the cumulative session total across
  all 4 navigations because the network collector is attached at test
  start and never detached until test end.

Both are valid models. skeptic's matches the "complete session" mental
model agents typically have when authoring an e2e test; expect's matches
"inspect what's on screen now."

## Reproducing
```sh
expect-cli close
expect-cli open --wait-until networkidle https://jigyansurout.com/
expect-cli screenshot --full-page                                    # 01-home
expect-cli playwright "await page.goto('https://jigyansurout.com/projects', { waitUntil: 'networkidle' }); await page.waitForTimeout(800);"
expect-cli screenshot --full-page                                    # 02-projects
expect-cli playwright "await page.goto('https://jigyansurout.com/achievements', { waitUntil: 'networkidle' }); await page.waitForTimeout(800);"
expect-cli screenshot --full-page                                    # 03-achievements
expect-cli playwright "await page.goto('https://jigyansurout.com/blog', { waitUntil: 'networkidle' }); await page.waitForTimeout(800);"
expect-cli screenshot --full-page                                    # 04-blog
expect-cli accessibility_audit > expect-a11y.json
expect-cli performance_metrics > expect-perf.json
expect-cli network_requests > expect-network.json
expect-cli console_logs > expect-console.json
expect-cli close                                                     # flushes session.webm
```
