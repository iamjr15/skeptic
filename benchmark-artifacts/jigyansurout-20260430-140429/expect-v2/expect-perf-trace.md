# Performance Trace

## Web Vitals

- **FCP**: 460ms (good)
- **LCP**: 2644ms (needs-improvement)
- **CLS**: 0.006 (good)

## Navigation Timing

- **TTFB**: 149ms
- **DOM Content Loaded**: 210ms
- **Load Complete**: 332ms

### Server Timing
- **cfCacheStatus**: 0ms — DYNAMIC
- **cfEdge**: 2ms
- **cfOrigin**: 14ms
- **cfExtPri**: 0ms

## Long Animation Frames (LoAF)

10 long animation frames detected.

### Frame 1

- **Duration**: 182ms
- **Blocking Duration**: 94ms
- **Render Start**: 2358ms
- **Style & Layout Start**: 2500ms

**Scripts:**

- `(anonymous)` — 141ms
  - Invoker: FrameRequestCallback (user-callback)
  - Source: https://raw.githack.com/strangerintheq/rgba/0.0.8/rgba.js:-1

### Frame 2

- **Duration**: 210ms
- **Blocking Duration**: 83ms
- **Render Start**: 332ms
- **Style & Layout Start**: 335ms

**Scripts:**

- `I` — 7ms
  - Invoker: #document.onDOMContentLoaded (event-listener)
  - Source: https://jigyansurout.com/other-js/jquery.min.js:29704
- `(anonymous)` — 121ms
  - Invoker: DOMWindow.onload (event-listener)
  - Source: https://jigyansurout.com/assets/js/preloader-shader.js:84

### Frame 3

- **Duration**: 88ms
- **Blocking Duration**: 0ms
- **Render Start**: 441ms
- **Style & Layout Start**: 441ms

### Frame 4

- **Duration**: 116ms
- **Blocking Duration**: 0ms
- **Render Start**: 1982ms
- **Style & Layout Start**: 1982ms

### Frame 5

- **Duration**: 104ms
- **Blocking Duration**: 0ms
- **Render Start**: 2624ms
- **Style & Layout Start**: 2624ms

### Frame 6

- **Duration**: 117ms
- **Blocking Duration**: 0ms
- **Render Start**: 2845ms
- **Style & Layout Start**: 2845ms

### Frame 7

- **Duration**: 57ms
- **Blocking Duration**: 0ms
- **Render Start**: 3447ms
- **Style & Layout Start**: 3448ms

### Frame 8

- **Duration**: 182ms
- **Blocking Duration**: 0ms
- **Render Start**: 3630ms
- **Style & Layout Start**: 3630ms

### Frame 9

- **Duration**: 58ms
- **Blocking Duration**: 0ms
- **Render Start**: 4068ms
- **Style & Layout Start**: 4068ms

### Frame 10

- **Duration**: 50ms
- **Blocking Duration**: 0ms
- **Render Start**: 4118ms
- **Style & Layout Start**: 4119ms

## Resources

33 resources loaded — 1.8MB total transfer size.

### Slowest Resources

- 214ms — https://jigyansurout.com/assets/blog.png (css, 1.8MB)
- 131ms — https://jigyansurout.com/cdn-cgi/rum? (xmlhttprequest, 300B)
- 1ms — https://jigyansurout.com/fonts/font-awesome/css/font-awesome.css (css, 0B)
- 1ms — https://jigyansurout.com/fonts/elegant_font/HTML_CSS/style.css (css, 0B)
- 1ms — https://jigyansurout.com/fonts/et-line-font/style.css (css, 0B)
- 0ms — https://jigyansurout.com/other-css/bootstrap.css (link, 0B)
- 0ms — https://jigyansurout.com/other-css/style.css (link, 0B)
- 0ms — https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css (link, 0B)
- 0ms — https://jigyansurout.com/other-css/custom-projects.css (link, 0B)
- 0ms — https://jigyansurout.com/assets/img/about/thumb.png (img, 0B)

### Largest Resources

- 1.8MB — https://jigyansurout.com/assets/blog.png (css, 214ms)
- 300B — https://jigyansurout.com/cdn-cgi/rum? (xmlhttprequest, 131ms)
