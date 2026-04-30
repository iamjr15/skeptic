# Performance Trace

## Web Vitals

- **FCP**: 1800ms (good)
- **LCP**: 1800ms (good)
- **CLS**: 0.166 (needs-improvement)
- **INP**: — (—)

## Navigation Timing

- **TTFB**: 767ms
- **DOM Content Loaded**: 1989ms
- **Load Complete**: 3233ms
- **Server-Timing**:
  - `cfCacheStatus` (0ms) — DYNAMIC
  - `cfEdge` (9ms)
  - `cfOrigin` (38ms)

## Long Animation Frames (LoAF)

8 long animation frames detected.

### Frame 1 ⚠ POOR

- **Duration**: 968ms
- **Blocking Duration**: 178ms
- **Render Start**: 775ms

**Scripts:**

- `(anonymous)` — 10ms
  - Invoker: https://jigyansurout.com/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js
  - Source: https://jigyansurout.com/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js

**Scripts (sorted by duration):**

- `(anonymous)` — 10ms

### Frame 2

- **Duration**: 61ms
- **Blocking Duration**: 8ms
- **Render Start**: 1764ms

**Scripts:**

- `(anonymous)` — 56ms
  - Invoker: https://jigyansurout.com/assets/js/vendor/jquery.js
  - Source: https://jigyansurout.com/assets/js/vendor/jquery.js

**Scripts (sorted by duration):**

- `(anonymous)` — 56ms

### Frame 3

- **Duration**: 120ms
- **Blocking Duration**: 60ms
- **Render Start**: 1845ms

**Scripts:**

- `(anonymous)` — 49ms
  - Invoker: https://jigyansurout.com/assets/js/main.js
  - Source: https://jigyansurout.com/assets/js/main.js

**Scripts (sorted by duration):**

- `(anonymous)` — 49ms — forced layout 1ms

### Frame 4

- **Duration**: 75ms
- **Blocking Duration**: 18ms
- **Render Start**: 2301ms

**Scripts:**

- `(anonymous)` — 12ms
  - Invoker: Response.json.then
  - Source: https://githubgraph.jigyansurout.com/assets/js/gh.js

**Scripts (sorted by duration):**

- `(anonymous)` — 12ms

### Frame 5

- **Duration**: 169ms
- **Blocking Duration**: 112ms
- **Render Start**: 3084ms

**Scripts:**

- `(anonymous)` — 133ms
  - Invoker: DOMWindow.onload
  - Source: https://jigyansurout.com/assets/js/preloader-shader.js
- `(anonymous)` — 16ms
  - Invoker: FrameRequestCallback
  - Source: https://raw.githack.com/strangerintheq/rgba/0.0.8/rgba.js

**Scripts (sorted by duration):**

- `(anonymous)` — 133ms
- `(anonymous)` — 16ms

### Frame 6

- **Duration**: 117ms
- **Blocking Duration**: 0ms
- **Render Start**: 4441ms

### Frame 7

- **Duration**: 62ms
- **Blocking Duration**: 0ms
- **Render Start**: 4592ms

### Frame 8

- **Duration**: 203ms
- **Blocking Duration**: 0ms
- **Render Start**: 4668ms

## Resources

46 resources loaded — 6.22MB transferred.

### Slowest Resources

- 1309ms — https://jigyansurout.com/assets/index-img.png (img, 1.90MB)
- 1224ms — https://jigyansurout.com/assets/proj-index.png (css, 2.03MB)
- 1209ms — https://jigyansurout.com/assets/ach-index.png (img, 1.72MB)
- 1121ms — https://jigyansurout.com/assets/img/service/bg.png (img, 11.3KB)
- 932ms — https://jigyansurout.com/assets/img/software/bg.png (img, 26.6KB)
- 876ms — https://jigyansurout.com/assets/img/project/aoc.png (img, 18.4KB)
- 876ms — https://jigyansurout.com/assets/img/project/npm.png (img, 3.8KB)
- 778ms — https://jigyansurout.com/assets/img/project/stockly.png (img, 7.0KB)
- 777ms — https://jigyansurout.com/assets/img/project/settleai.png (img, 38.0KB)
- 749ms — https://jigyansurout.com/assets/img/project/cheatcode.png (img, 33.6KB)

### Largest Resources

- 2.03MB — https://jigyansurout.com/assets/proj-index.png (css, 1224ms)
- 1.90MB — https://jigyansurout.com/assets/index-img.png (img, 1309ms)
- 1.72MB — https://jigyansurout.com/assets/ach-index.png (img, 1209ms)
- 81.5KB — https://jigyansurout.com/assets/css/font-awesome-pro.css (link, 479ms)
- 54.7KB — https://jigyansurout.com/assets/img/about/thumb.png (img, 642ms)
- 38.0KB — https://jigyansurout.com/assets/img/project/settleai.png (img, 777ms)
- 37.7KB — https://jigyansurout.com/assets/js/swiper-bundle.js (script, 712ms)
- 33.9KB — https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css (link, 211ms)
- 33.8KB — https://jigyansurout.com/assets/img/author/noice.png (img, 577ms)
- 33.6KB — https://jigyansurout.com/assets/img/project/cheatcode.png (img, 749ms)

## Network

50 request(s) captured.

## Console

4 message(s) — 0 error(s), 4 warning(s).

### Errors & warnings

- **warning**: [.WebGL-0x12c001ca800]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels
- **warning**: [.WebGL-0x12c001ca800]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels
- **warning**: [.WebGL-0x12c001ca800]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels
- **warning**: [.WebGL-0x12c001ca800]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels (this message will no longer repeat)

## Accessibility

Standard: WCAG21AA. Engines: axe-core + IBM Equal Access.
2 violation(s), 21 pass(es), 1 incomplete.

### Serious (1)

- **link-name** — Links must have discernible text
  - https://dequeuniversity.com/rules/axe/4.11/link-name?application=playwright

### Moderate (1)

- **meta-viewport** — Zooming and scaling must not be disabled
  - https://dequeuniversity.com/rules/axe/4.11/meta-viewport?application=playwright
