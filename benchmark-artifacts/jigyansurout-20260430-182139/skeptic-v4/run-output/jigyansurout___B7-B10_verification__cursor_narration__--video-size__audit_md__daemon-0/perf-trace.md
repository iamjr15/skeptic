# Performance Trace

## Web Vitals

- **FCP**: 496ms (good)
- **LCP**: 2472ms (good)
- **CLS**: 0.006 (good)
- **INP**: — (—)

## Navigation Timing

- **TTFB**: 219ms
- **DOM Content Loaded**: 490ms
- **Load Complete**: 496ms
- **Server-Timing**:
  - `cfCacheStatus` (0ms) — DYNAMIC
  - `cfEdge` (2ms)
  - `cfOrigin` (23ms)
  - `cfExtPri` (0ms)

## Long Animation Frames (LoAF)

2 long animation frames detected.

### Frame 1

- **Duration**: 272ms
- **Blocking Duration**: 0ms
- **Render Start**: 218ms

**Scripts:**

- `I` — 7ms
  - Invoker: #document.onDOMContentLoaded
  - Source: https://jigyansurout.com/other-js/jquery.min.js

**Scripts (sorted by duration):**

- `I` — 7ms — forced layout 3ms

### Frame 2

- **Duration**: 55ms
- **Blocking Duration**: 0ms
- **Render Start**: 2694ms

## Resources

41 resources loaded — 1.82MB transferred.

### Slowest Resources

- 275ms — https://jigyansurout.com/assets/blog.png (css, 1.79MB)
- 215ms — https://jigyansurout.com/fonts/font-awesome/css/font-awesome.css (css, 0B)
- 214ms — https://jigyansurout.com/fonts/elegant_font/HTML_CSS/style.css (css, 0B)
- 214ms — https://jigyansurout.com/fonts/et-line-font/style.css (css, 0B)
- 198ms — https://jigyansurout.com/fonts/font-awesome/css/font-awesome.css (xmlhttprequest, 9.3KB)
- 197ms — https://jigyansurout.com/fonts/et-line-font/style.css (xmlhttprequest, 9.3KB)
- 196ms — https://jigyansurout.com/fonts/elegant_font/HTML_CSS/style.css (xmlhttprequest, 9.2KB)
- 176ms — https://jigyansurout.com/cdn-cgi/rum? (xmlhttprequest, 300B)
- 91ms — https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@100;200;300;400;500;600&display=swap (xmlhttprequest, 1.1KB)
- 84ms — https://fonts.googleapis.com/css2?family=Montserrat:wght@600&display=swap (xmlhttprequest, 872B)

### Largest Resources

- 1.79MB — https://jigyansurout.com/assets/blog.png (css, 275ms)
- 9.3KB — https://jigyansurout.com/fonts/et-line-font/style.css (xmlhttprequest, 197ms)
- 9.3KB — https://jigyansurout.com/fonts/font-awesome/css/font-awesome.css (xmlhttprequest, 198ms)
- 9.2KB — https://jigyansurout.com/fonts/elegant_font/HTML_CSS/style.css (xmlhttprequest, 196ms)
- 1.1KB — https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@100;200;300;400;500;600&display=swap (xmlhttprequest, 91ms)
- 872B — https://fonts.googleapis.com/css2?family=Montserrat:wght@600&display=swap (xmlhttprequest, 84ms)
- 300B — https://jigyansurout.com/cdn-cgi/rum? (xmlhttprequest, 176ms)
- 0B — https://jigyansurout.com/other-css/bootstrap.css (link, 0ms)
- 0B — https://jigyansurout.com/other-css/style.css (link, 0ms)
- 0B — https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css (link, 0ms)

## Network

163 request(s) captured.

### Issues

- **Network failures (DNS/TCP/aborted)**: 12
  - POST https://jigyansurout.com/cdn-cgi/rum? — net::ERR_ABORTED
  - GET https://jigyansurout.com/fonts/font-awesome/css/font-awesome.css — net::ERR_ABORTED
  - GET https://jigyansurout.com/fonts/elegant_font/HTML_CSS/style.css — net::ERR_ABORTED
  - GET https://jigyansurout.com/fonts/et-line-font/style.css — net::ERR_ABORTED
  - POST https://jigyansurout.com/cdn-cgi/rum? — net::ERR_ABORTED
  - GET https://jigyansurout.com/fonts/font-awesome/css/font-awesome.css — net::ERR_ABORTED
  - GET https://jigyansurout.com/fonts/elegant_font/HTML_CSS/style.css — net::ERR_ABORTED
  - GET https://jigyansurout.com/fonts/et-line-font/style.css — net::ERR_ABORTED
  - POST https://jigyansurout.com/cdn-cgi/rum? — net::ERR_ABORTED
  - GET https://jigyansurout.com/fonts/font-awesome/css/font-awesome.css — net::ERR_ABORTED
- **Duplicate request groups**: 2

## Console

13 message(s) — 9 error(s), 4 warning(s).

### Errors & warnings

- **warning**: [.WebGL-0x12400457800]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels
- **warning**: [.WebGL-0x12400457800]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels
- **warning**: [.WebGL-0x12400457800]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels
- **warning**: [.WebGL-0x12400457800]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels (this message will no longer repeat)
- **error**: Refused to apply style from 'https://jigyansurout.com/fonts/elegant_font/HTML_CSS/style.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled.
- **error**: Refused to apply style from 'https://jigyansurout.com/fonts/et-line-font/style.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled.
- **error**: Refused to apply style from 'https://jigyansurout.com/fonts/font-awesome/css/font-awesome.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled.
- **error**: Refused to apply style from 'https://jigyansurout.com/fonts/elegant_font/HTML_CSS/style.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled.
- **error**: Refused to apply style from 'https://jigyansurout.com/fonts/et-line-font/style.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled.
- **error**: Refused to apply style from 'https://jigyansurout.com/fonts/font-awesome/css/font-awesome.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled.
- **error**: Refused to apply style from 'https://jigyansurout.com/fonts/elegant_font/HTML_CSS/style.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled.
- **error**: Refused to apply style from 'https://jigyansurout.com/fonts/et-line-font/style.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled.
- **error**: Refused to apply style from 'https://jigyansurout.com/fonts/font-awesome/css/font-awesome.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled.

## Accessibility

Standard: WCAG21AA. Engines: axe-core + IBM Equal Access.
1 violation(s), 16 pass(es), 1 incomplete.

### Serious (1)

- **link-name** — Links must have discernible text
  - https://dequeuniversity.com/rules/axe/4.11/link-name?application=playwright
