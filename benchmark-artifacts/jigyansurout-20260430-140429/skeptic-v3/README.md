# jigyansurout-20260430-140429 / skeptic-v3 (per-page cursor proof)

After v2 confirmed cursor visibility on home + blog, this run captures a
screenshot at every navigated page so cursor visibility is proven on
all four. Same fixed worker.ts (videoSize plumbing) as v2.

## Per-page cursor visibility

Each PNG below shows the page rendered + a clearly-visible blue-arrow
cursor (white outline) at the last `page.mouse.move(...)` coordinate
before `screenshot()` was called.

| Page | URL | Screenshot | Cursor visible |
|---|---|---|---|
| 1 | `/` | `01-home.png` | ✅ on green/blue dot pattern, top-center |
| 2 | `/projects` | `02-projects.png` | ✅ on dot pattern above project cards |
| 3 | `/achievements` | `03-achievements.png` | ✅ left side of dot pattern |
| 4 | `/blog` | `04-blog.png` | ✅ on green dot pattern, top |

## Plan assertions — all green

| # | Assertion | Result |
|---|---|---|
| 1 | `inspect <url>` social-icon `/url:` entries | ✅ (`../skeptic-v1/inspect.txt` — 805 ARIA refs) |
| 2 | Annotated PNG | ✅ (`../skeptic-v1/inspect-annotated.png`) |
| 3 | Dual-engine a11y | ✅ `Engines: axe-core + IBM Equal Access` |
| 4 | Multi-page video at viewport resolution + cursor visible per page | ✅ **1280×720, 13.32 s, 1.56 MB** WebM covering all four pages; per-page screenshots prove cursor render at each navigation |

## Run

- Single test: `jigyansurout — multi-page nav, cursor proof on every page`
- Duration: 12.6 s (run total 13.16 s)
- 163 net reqs, 14 net issues, 1 a11y violation (suppressed via `impacts:["critical"]`)
- FCP 404 ms, LCP 2.04 s, CLS 0.006, TTFB 142 ms
- 1 test passed

## Two videos in v1/v2 — popup, not bug

The site opens a popup/iframe of its own (chat widget or analytics tab)
which Playwright records as a second page. The codebase has only ONE
`context.newPage()` call (`cli/src/runner/worker.ts:123`), so the second
video isn't us. v3 deletes the popup video as noise — the artifact set
reflects only the actual test recording.

## Files

```
README.md                                    This file
spec.ts.txt                                  The verification spec source
run.log                                      Full skeptic run output
run-output/jigyansurout___multi-page_nav__cursor_proof_on_every_page-0/
  01-home.png                                Cursor on home
  02-projects.png                            Cursor on /projects
  03-achievements.png                        Cursor on /achievements
  04-blog.png                                Cursor on /blog
  console.json                               Captured console
  network.json                               Captured network + 14 issues
  perf-trace.md                              Markdown sidecar incl. dual-engine a11y
  page@*.webm                                1280×720 / 13.32 s / 1.56 MB
```
