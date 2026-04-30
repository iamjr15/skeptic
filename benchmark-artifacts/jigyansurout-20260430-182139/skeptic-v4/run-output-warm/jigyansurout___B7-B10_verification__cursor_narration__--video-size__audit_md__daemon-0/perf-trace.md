# Performance Trace

## Web Vitals

- **FCP**: 392ms (good)
- **LCP**: 2260ms (good)
- **CLS**: 0.006 (good)
- **INP**: — (—)

## Navigation Timing

- **TTFB**: 170ms
- **DOM Content Loaded**: 382ms
- **Load Complete**: 396ms
- **Server-Timing**:
  - `cfCacheStatus` (0ms) — DYNAMIC
  - `cfEdge` (2ms)
  - `cfOrigin` (13ms)
  - `cfExtPri` (0ms)

## Long Animation Frames (LoAF)

1 long animation frames detected.

### Frame 1

- **Duration**: 217ms
- **Blocking Duration**: 0ms
- **Render Start**: 166ms

**Scripts:**

- `I` — 8ms
  - Invoker: #document.onDOMContentLoaded
  - Source: https://jigyansurout.com/other-js/jquery.min.js

**Scripts (sorted by duration):**

- `I` — 8ms — forced layout 4ms

## Resources

41 resources loaded — 1.79MB transferred.

### Slowest Resources

- 212ms — https://jigyansurout.com/assets/blog.png (css, 1.79MB)
- 180ms — https://jigyansurout.com/fonts/et-line-font/style.css (css, 0B)
- 152ms — https://jigyansurout.com/cdn-cgi/rum? (xmlhttprequest, 300B)
- 91ms — https://fonts.googleapis.com/css2?family=Montserrat:wght@600&display=swap (xmlhttprequest, 872B)
- 89ms — https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@100;200;300;400;500;600&display=swap (xmlhttprequest, 1.1KB)
- 2ms — https://jigyansurout.com/fonts/font-awesome/css/font-awesome.css (css, 0B)
- 2ms — https://jigyansurout.com/fonts/elegant_font/HTML_CSS/style.css (css, 0B)
- 2ms — https://use.typekit.net/ynf8xat.css (xmlhttprequest, 0B)
- 2ms — https://jigyansurout.com/fonts/font-awesome/css/font-awesome.css (xmlhttprequest, 0B)
- 2ms — https://jigyansurout.com/fonts/elegant_font/HTML_CSS/style.css (xmlhttprequest, 0B)

### Largest Resources

- 1.79MB — https://jigyansurout.com/assets/blog.png (css, 212ms)
- 1.1KB — https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@100;200;300;400;500;600&display=swap (xmlhttprequest, 89ms)
- 872B — https://fonts.googleapis.com/css2?family=Montserrat:wght@600&display=swap (xmlhttprequest, 91ms)
- 300B — https://jigyansurout.com/cdn-cgi/rum? (xmlhttprequest, 152ms)
- 0B — https://jigyansurout.com/other-css/bootstrap.css (link, 0ms)
- 0B — https://jigyansurout.com/other-css/style.css (link, 0ms)
- 0B — https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css (link, 0ms)
- 0B — https://jigyansurout.com/other-css/custom-projects.css (link, 0ms)
- 0B — https://jigyansurout.com/assets/img/about/thumb.png (img, 0ms)
- 0B — https://jigyansurout.com/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js (script, 0ms)

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
- **Duplicate request groups**: 1

## Console

9 message(s) — 9 error(s), 0 warning(s).

### Errors & warnings

- **error**: Refused to apply style from 'https://jigyansurout.com/fonts/et-line-font/style.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled.
- **error**: Refused to apply style from 'https://jigyansurout.com/fonts/font-awesome/css/font-awesome.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled.
- **error**: Refused to apply style from 'https://jigyansurout.com/fonts/elegant_font/HTML_CSS/style.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled.
- **error**: Refused to apply style from 'https://jigyansurout.com/fonts/font-awesome/css/font-awesome.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled.
- **error**: Refused to apply style from 'https://jigyansurout.com/fonts/et-line-font/style.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled.
- **error**: Refused to apply style from 'https://jigyansurout.com/fonts/elegant_font/HTML_CSS/style.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled.
- **error**: Refused to apply style from 'https://jigyansurout.com/fonts/font-awesome/css/font-awesome.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled.
- **error**: Refused to apply style from 'https://jigyansurout.com/fonts/elegant_font/HTML_CSS/style.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled.
- **error**: Refused to apply style from 'https://jigyansurout.com/fonts/et-line-font/style.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled.

## Accessibility

Standard: WCAG21AA. Engines: axe-core + IBM Equal Access.
1 violation(s), 16 pass(es), 1 incomplete.

### Serious (1)

- **link-name** — Links must have discernible text
  - https://dequeuniversity.com/rules/axe/4.11/link-name?application=playwright
