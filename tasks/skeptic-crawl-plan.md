# crawly: SOTA Web App Crawler for AI/QA

## Vision

A blazing-fast, lightweight, open-source web app crawler built in Go, designed specifically for understanding web application structure for AI and QA use cases. Single binary, no bundled browser, two-tier rendering (HTTP + CDP), LLM-ready output.

**No tool like this exists today.** Crawl4AI is heavy (Python+Playwright+Chromium). Katana is security-focused (no LLM output). Firecrawl is SaaS-first. Jina Reader is single-page only.

---

## Architecture

```
                        crawly
┌──────────────────────────────────────────────────────┐
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │            BFS Crawl Engine                    │  │
│  │                                                │  │
│  │  • Goroutine pool (bounded concurrency)        │  │
│  │  • Async BFS queue with depth/limit control    │  │
│  │  • Same-domain scope enforcement               │  │
│  │  • SimHash near-duplicate URL deduplication     │  │
│  │  • Rate limiter (token bucket)                  │  │
│  │  • URL normalization & canonicalization          │  │
│  └──────────────────┬─────────────────────────────┘  │
│                     │                                │
│  ┌──────────────────▼─────────────────────────────┐  │
│  │          Smart Renderer (Two-Tier)              │  │
│  │                                                │  │
│  │  TIER 1: HTTP Fetch (net/http)                  │  │
│  │    • Fast path: ~20-50ms per page               │  │
│  │    • Handles 80%+ of pages (SSR/static)         │  │
│  │    • SPA detection heuristics applied           │  │
│  │                                                │  │
│  │  TIER 2: Browser Render (go-rod/CDP)            │  │
│  │    • Slow path: ~1-3s per page                  │  │
│  │    • Only triggered for detected SPAs           │  │
│  │    • Browser pool with page reuse               │  │
│  │    • Uses system Chrome (no bundled binary)      │  │
│  │    • WaitStable heuristic for page readiness     │  │
│  │                                                │  │
│  │  FUTURE: Lightpanda integration                 │  │
│  │    • 11x faster, 9x less memory than Chrome     │  │
│  │    • Slot in as Tier 1.5 when it matures        │  │
│  └──────────────────┬─────────────────────────────┘  │
│                     │                                │
│  ┌──────────────────▼─────────────────────────────┐  │
│  │         Content Extraction Pipeline             │  │
│  │                                                │  │
│  │  Stage 1: Boilerplate Removal (adaptive)         │  │
│  │    • Primary: go-readability (article pages)    │  │
│  │    • Fallback: density-based pruning (app pages)│  │
│  │    • Strips nav, footer, sidebar, ads           │  │
│  │    • Preserves main content structure           │  │
│  │    • Detects page type to choose strategy       │  │
│  │                                                │  │
│  │  Stage 2: Structural Extraction (goquery)       │  │
│  │    • Headings (h1-h6) with hierarchy            │  │
│  │    • Forms: action, method, inputs, labels      │  │
│  │    • Links: internal/external, anchor text      │  │
│  │    • Interactive: buttons, selects, modals      │  │
│  │    • Navigation: menus, breadcrumbs             │  │
│  │    • Auth patterns: login forms, OAuth buttons  │  │
│  │    • Meta: title, description, OG tags          │  │
│  │                                                │  │
│  │  Stage 3: Markdown Conversion                   │  │
│  │    • html-to-markdown v2 (JohannesKaufmann)     │  │
│  │    • Clean, CommonMark-compliant output          │  │
│  │    • Tables, code blocks, images preserved       │  │
│  │    • Relative links converted to absolute        │  │
│  │    • Citation-style link footnotes (LLM-opt)    │  │
│  │    • Dual output: raw_markdown + fit_markdown   │  │
│  └──────────────────┬─────────────────────────────┘  │
│                     │                                │
│  ┌──────────────────▼─────────────────────────────┐  │
│  │              Output Formatter                   │  │
│  │                                                │  │
│  │  • Structured JSON (pages, forms, headings...)  │  │
│  │  • Clean Markdown per page                      │  │
│  │  • Site structure graph (page relationships)    │  │
│  │  • Crawl metadata (timing, pages found, etc.)   │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  Interfaces:                                         │
│    • CLI (single static binary)                      │
│    • Go library (import as package)                  │
│    • HTTP/gRPC server mode (for Python integration)  │
│    • JSON output to stdout (pipe-friendly)           │
└──────────────────────────────────────────────────────┘
```

---

## What We Borrow From Each Tool

### From Katana (Go, MIT, 17K stars)
- **Two-mode architecture**: Standard HTTP engine + Headless CDP engine with shared interface; caller selects by policy or auto-heuristic
- **go-rod browser pooling**: `AcquireBrowser/ReleaseBrowser` pattern with health counters (consecutive failures, total crawls) and auto-restart on failure — not just `rod.NewPagePool`
- **SimHash deduplication**: Tokenize normalized DOM → per-token hash contribution to bit vector → sign-aggregate → Hamming distance comparison with configurable threshold
- **DOM normalization pipeline**: Canonicalize tags/attributes, strip scripts/styles/tracking elements, remove dynamic attributes (timestamps/session IDs), normalize whitespace — creates deterministic snapshot BEFORE SimHash and extraction
- **Page-ready heuristics**: Composite of `DOMContentLoaded` + network-idle polling (request count stabilizes below threshold for N ms) + configurable post-idle delay + overall timeout — not just `WaitStable`
- **Form extraction pattern**: Shallow DOM traversal + attribute normalization + CSRF token detection + input constraint extraction (type, name, placeholder, value, required)
- **Scope control**: domain enforcement, include/exclude URL patterns
- **Cookie-consent blocking**: Request interception to block cookie-consent popups that pollute DOM
- **BFS scheduler coordinates both HTTP AND browser concurrency**: Headless tasks require both a worker goroutine AND a BrowserPool slot — dual gating via semaphores
- **Diagnostics endpoint**: Live crawl debugger HTTP endpoint for real-time monitoring

### From Jina Reader (TypeScript, Apache-2.0, 10K stars)
- **Extraction pipeline**: fetch → Readability → Turndown → clean markdown → optional Reader-LM cleanup
- **The insight**: Readability (boilerplate removal) BEFORE markdown conversion = much cleaner output
- **Page-type routing**: Detect page type (article, docs, app, e-commerce) via URL heuristics + DOM features + JSON-LD; toggle Readability settings per type (stricter pruning for apps, preserve structure for docs)
- **Multi-layer caching**: HTTP-level (response bytes with TTL), Readability intermediate cache (memoize parsed DOM), final markdown cache keyed by URL+options — reduces repeated expensive work
- **Link citation format**: Convert inline links to `[text][1]` citation-style footnotes with references section at bottom — much better for LLM consumption (reduces inline noise)
- **Image handling**: Include as `![alt](url)` with optional captioning via vision-language model

### From spider-rs (Rust, MIT, 2.3K stars)
- **Feature-gating**: Cargo feature flags gate heavy deps (chrome, adblock, caching backends) — keep default binary lean. We replicate with Go build tags
- **Dynamic semaphore sizing**: Concurrency limits auto-scale based on CPU core count and env vars — not hard-coded
- **Streaming transformations**: HTML→Markdown interleaved with network I/O via async streams — reduces peak memory by not buffering entire pages
- **Zero-copy + per-request arenas**: Byte slices with lifetimes, short-lived buffers per page, memory caps with hybrid disk offloading — minimizes GC pressure
- **Isolate + IPC architecture**: Worker processes communicate via channels for true parallelism across CPU cores (relevant for large-scale crawls)

### From Crawl4AI (Python, Apache-2.0, 51K stars)
- **Markdown generation**: Their DefaultMarkdownGenerator (~160 LOC) is a forked html2text with citation-style link references — we replicate with html-to-markdown v2 in Go plus a link-citation post-pass
- **Dual markdown output**: `raw_markdown` (full page) AND `fit_markdown` (pruned for LLM) — we should offer both
- **PruningContentFilter**: Scores DOM nodes by text density, link density, tag importance, then prunes below threshold — complementary to Readability for non-article pages (dashboards, apps)
- **BM25 content filtering**: When a query/context is available, rank content blocks by BM25 relevance — useful for focused extraction
- **Browser pre-warming with staggered creation**: Spawn spare browser instances ahead of traffic, stagger creations to avoid CPU/memory spikes, keep idle pool ready
- **Health-based pool management**: Track consecutive failures per browser instance, auto-kill and replace unhealthy ones

### From Lightpanda (Zig, AGPL-3.0, 12K stars)
- **The key insight**: Skip graphical rendering entirely. HTTP loader + HTML parser + V8 runtime + CDP = 11x faster, 9x less memory
- **Future integration**: When Lightpanda's Web API coverage matures, use it as our default renderer instead of Chrome

### From ReaderLM-v2 (Research Paper, arxiv:2503.01151)
- **The finding**: A 1.5B parameter model trained specifically for HTML→Markdown outperforms GPT-4o by 15-20%
- **Their 3-stage pipeline**: Draft → Refine → Critique for training data synthesis
- **512K token context**: Handles extremely long documents that heuristic extractors struggle with
- **Future integration**: Optional ML-based extraction mode for highest-quality output

### From Academic Research (SIGIR 2023, Springer 2026, NDSS 2026)
- **Heuristic extractors still win**: SIGIR 2023 benchmark found heuristic systems (Readability, Trafilatura) achieve top median/mean performance — ensembles of heuristics outperform individual systems on complex pages
- **DOM-density algorithm (2026)**: Achieved 99.96% precision, 99.8% F1 by combining node depth proximity, direct text-containing children count, and maximal text-without-child nodes — language-independent
- **Trafilatura outperforms Readability**: On many benchmarks; consider using BOTH with fallback (try Readability first, if extraction quality is low, try Trafilatura-style density approach)
- **HTMLDownloader study**: Browser rendering gets 98.4% success on JS-heavy sites vs BeautifulSoup at 34.5% — validates our two-tier approach
- **TRANSPARENT (NDSS)**: SPA frameworks hide semantics in virtual DOMs — framework-aware extraction (detecting React/Angular/Vue runtime patterns) can unlock better structure understanding
- **Vision-based extraction (ÉCLAIR, DocLayout-YOLO)**: For pages where DOM is obfuscated, virtualized, or Canvas-based, screenshot + layout detection recovers structure. Future enhancement path

### From Readability Algorithm Deep Dive
- **Scoring formula**: text_length + (commas * 1) + min(floor(text_length / 100), 3) — per paragraph
- **Score propagation**: Parent gets full score, grandparent gets score/2
- **Unlikely candidates regex**: `banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-hierarchical`
- **Positive signals regex**: `article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story`
- **Link density threshold**: If link text / total text > 0.25 for a node, it's likely navigation — penalize heavily
- **Limitation**: Readability assumes article-style content; for app dashboards, form-heavy pages, or data tables, it may strip useful content. Need fallback for non-article pages

---

## SPA Detection Algorithm

The core innovation: intelligently skip the browser for 80%+ of pages.

```
function needsBrowserRendering(httpResponse):
    html = httpResponse.body

    // 1. Check content length (fastest check)
    bodyText = stripTags(html).trim()
    if len(bodyText) > 500:
        return false  // Has substantial content, no browser needed

    // 2. Check for SPA framework markers
    spaMarkers = [
        // React
        '<div id="root"></div>',
        '<div id="__next"',
        'data-reactroot',
        '__NEXT_DATA__',

        // Vue
        '<div id="app"></div>',
        '__NUXT__',

        // Angular
        '<app-root',
        'ng-version=',

        // Svelte
        '__sveltekit',

        // Generic SPA
        '<div id="root">',
        'bundle.js',
        'main.chunk.js',
    ]
    if any(marker in html for marker in spaMarkers) AND len(bodyText) < 200:
        return true  // SPA framework detected + minimal content

    // 3. Content-to-markup ratio
    markupRatio = len(html) / max(len(bodyText), 1)
    if markupRatio > 50 and len(bodyText) < 100:
        return true  // Lots of HTML structure but almost no text

    // 4. Check for hydration markers in scripts
    scriptContent = extractScriptSrcAndInline(html)
    hydrationMarkers = ['hydrate', 'ReactDOM', 'createRoot',
                        'window.__INITIAL_STATE__', 'data-server-rendered',
                        'vue.runtime', '__remixContext']
    if any(marker in scriptContent for marker in hydrationMarkers) AND len(bodyText) < 200:
        return true

    // 5. Check for noscript tags (indicates JS-dependent content)
    if '<noscript>' in html and 'enable JavaScript' in html:
        return true

    // 6. Heavy JS bundle detection (large script tags, no content)
    scriptTags = countScriptTags(html)
    if scriptTags > 5 and len(bodyText) < 100:
        return true  // Many scripts but almost no content

    return false  // Default: no browser needed
```

### SPA Detection: Avoiding False Negatives

The research identified key gotchas:
- **SSR hydration**: Some SSR apps (Next.js, Nuxt) pre-render content BUT also have hydration markers. If body has content (> 500 chars), trust it even if framework markers exist — don't re-render unnecessarily
- **Bot-tailored shells**: Some SPAs serve different HTML to bots vs browsers. Set realistic `User-Agent` headers on HTTP fetch to reduce discrepancies
- **Partial content**: Some SPAs render navigation/header server-side but lazy-load main content. Check if `<main>` or primary content area is empty, not just overall body text
- **Conservative default**: Better to false-positive (render unnecessarily) than false-negative (miss content). Tune threshold lower (200 chars) rather than higher

---

## Adaptive Extraction Strategy

The research shows no single extractor wins on all page types. Our approach:

```
function extractContent(html, url):
    pageType = detectPageType(html, url)

    switch pageType:
        case "article", "blog", "docs":
            // Readability excels here
            mainContent = readability.Extract(html)
            if mainContent.textLength > 100:
                return mainContent
            // Fallback to density-based if Readability extracts too little
            return densityExtract(html)

        case "app", "dashboard", "settings":
            // Readability would strip useful forms/buttons
            // Use full DOM with density-based noise removal
            return densityExtract(html, keepForms=true, keepInteractive=true)

        case "login", "signup", "auth":
            // Keep everything — forms are the main content
            return fullDOMExtract(html)

        default:
            // Try Readability, fall back to density if poor result
            result = readability.Extract(html)
            if result.textLength < 50:
                return densityExtract(html)
            return result

function detectPageType(html, url):
    // URL-based heuristics
    if url matches /login|signin|auth/:    return "auth"
    if url matches /dashboard|admin|settings/: return "app"
    if url matches /blog|post|article/:    return "article"
    if url matches /docs|documentation|guide/: return "docs"

    // DOM-based heuristics
    if html has <article> or JSON-LD Article schema: return "article"
    if html has >3 forms:                              return "app"
    if html has login/password inputs:                 return "auth"

    return "unknown"
```

**Why this matters**: Readability strips forms and interactive elements — exactly what we need for QA. For app pages, we MUST use a different extraction strategy that preserves the full interactive DOM.

---

## Page-Ready Detection Algorithm (for browser-rendered pages)

Borrowed from Katana's composite approach:

```
function waitForPageReady(page, timeout=30s):
    // Phase 1: Wait for DOMContentLoaded
    await page.WaitForDOMContentLoaded()

    // Phase 2: Network idle polling
    // Monitor in-flight network requests
    // Page is "ready" when requests stabilize below threshold for N ms
    idleThreshold = 2      // max concurrent requests to consider "idle"
    idleWindow = 500ms     // must stay idle for this duration
    pollInterval = 100ms

    lastActiveTime = now()
    while now() - start < timeout:
        activeRequests = page.GetPendingRequestCount()
        if activeRequests <= idleThreshold:
            if now() - lastActiveTime > idleWindow:
                break  // Page is stable
        else:
            lastActiveTime = now()
        sleep(pollInterval)

    // Phase 3: Post-idle stabilization delay
    // Some SPAs trigger late renders after data loads
    sleep(200ms)

    // Phase 4: Optional framework-specific readiness
    // If we detected React/Vue/Angular, check hydration status
    if page.HasReactRoot():
        await page.Evaluate("new Promise(r => requestIdleCallback(r))")
```

---

## DOM Normalization Pipeline (before SimHash/dedup)

From Katana's approach — normalize BEFORE comparing:

```
function normalizeDOM(html):
    // 1. Remove all <script> and <style> tags and contents
    // 2. Remove tracking/analytics attributes (data-gtm-*, data-analytics-*)
    // 3. Remove dynamic IDs (session tokens, CSRF tokens, timestamps)
    // 4. Remove inline event handlers (onclick, onload, etc.)
    // 5. Normalize whitespace (collapse multiple spaces/newlines)
    // 6. Sort attributes alphabetically for determinism
    // 7. Remove empty tags
    // 8. Lowercase all tag names and attribute names
    return normalizedHTML
```

This ensures SimHash produces stable fingerprints even when pages have session-specific or time-varying content.

---

## Technology Stack

| Component | Library | Version | License | Why |
|---|---|---|---|---|
| **HTTP Client** | `net/http` (stdlib) | Go stdlib | BSD | Fastest, zero deps, connection pooling |
| **CDP/Browser** | `go-rod/rod` | v0.116+ | MIT | Best Go CDP client, PagePool, WaitStable |
| **HTML Parser** | `goquery` | v1.9+ | BSD | jQuery-like selectors, battle-tested |
| **Readability** | `go-shiori/go-readability` | v1.6+ | MIT | Mozilla Readability port, main content extraction |
| **HTML→Markdown** | `JohannesKaufmann/html-to-markdown` | v2.5+ | MIT | Best Go converter, plugin system, handles entire sites |
| **SimHash** | `mfonda/simhash` | latest | MIT | Near-duplicate detection |
| **URL Parsing** | `net/url` (stdlib) | Go stdlib | BSD | URL normalization and canonicalization |
| **CLI** | `cobra` | v1.8+ | Apache-2.0 | Standard Go CLI framework |
| **Concurrency** | goroutines + channels | Go stdlib | BSD | Built into the language |
| **JSON Output** | `encoding/json` (stdlib) | Go stdlib | BSD | Structured output |
| **Rate Limiter** | `golang.org/x/time/rate` | latest | BSD | Token bucket rate limiting |
| **Error Group** | `golang.org/x/sync/errgroup` | latest | BSD | Cancel-on-error fan-out concurrency |
| **DNS Cache** | `github.com/viki-org/dnscache` | latest | MIT | Go does NOT cache DNS — critical for crawlers |
| **Bloom Filter** | `github.com/bits-and-blooms/bloom/v3` | latest | BSD | Memory-efficient URL dedup at scale |
| **Selector Compiler** | `github.com/andybalholm/cascadia` | latest | BSD | Compile CSS selectors once, reuse across all pages |
| **Robots.txt** | `github.com/samclarke/robotstxt` | latest | MIT | Parse crawl-delay directives |
| **Retryable HTTP** | `github.com/hashicorp/go-retryablehttp` | latest | MPL-2.0 | Exponential backoff with jitter built-in |
| **Leak Detector** | `go.uber.org/goleak` | latest | MIT | Goroutine leak detection in tests |

**Total dependencies**: ~18 Go modules. **Binary size**: ~15-20MB static binary. **No bundled browser.**

---

## Reference Codebases

All cloned to `crawly/references/` (shallow, 114MB total). See `references/REPOS.md` for full index.

### Go References (direct patterns to adapt)
| Repo | What We Study | Key Files |
|---|---|---|
| **katana** | Two-mode engine, browser pool, SimHash, DOM normalization, form extraction, BFS scheduler | `pkg/engine/headless/`, `pkg/engine/standard/`, `pkg/engine/headless/crawler/normalizer/` |
| **colly** | Queue worker pattern, per-domain slot limiters, HTTP backend tuning | `queue/queue.go`, `http_backend.go`, `collector.go` |
| **html-to-markdown** | HTML→Markdown conversion, plugin architecture, CommonMark compliance | `convert.go`, `converter/`, `plugin/` |
| **go-readability** | Mozilla Readability ported to Go, DOM scoring, boilerplate removal | `readability.go`, `parser.go` |
| **html2md** | Lightweight Go readability + markdown in one package | `extractor.go`, `converter.go` |

### Other Language References (architecture and pipeline patterns)
| Repo | What We Study | Key Files |
|---|---|---|
| **reader** (Jina) | Extraction pipeline, page-type routing, caching, link citations | `src/` |
| **readability** (Mozilla) | THE reference Readability algorithm (~2000 LOC), scoring formulas, regex patterns | `Readability.js` |
| **crawl4ai** | Markdown generation (~160 LOC), BM25/Pruning content filters, browser pool | `crawl4ai/markdown_generation_strategy.py`, `crawl4ai/content_filter_strategy.py` |
| **spider** (Rust) | Concurrency model, feature-gating, memory management, streaming transforms | `spider/src/concurrency.rs`, `spider/src/fetch.rs`, `Cargo.toml` |
| **spider_transformations** | Rust HTML→Markdown streaming pipeline | `src/lib.rs`, `src/transformation/` |

### Go Performance Guide
See `tasks/go-performance-guide.md` for 25 performance patterns with copy-paste Go code covering:
- HTTP Transport tuning (MaxIdleConnsPerHost=100, DNS caching, connection draining)
- sync.Pool for buffer reuse, zero-allocation patterns, escape analysis
- Goroutine pools (semaphore + errgroup), fan-out/fan-in pipelines
- GOGC/GOMEMLIMIT tuning, PGO (Profile-Guided Optimization)
- Concurrent URL dedup (sync.Map vs sharded map vs Bloom filter)
- Build tags for feature-gating, streaming JSON output
- Colly's per-domain slot limiter, compiled CSS selectors (cascadia)
- HTML tokenizer for fast targeted extraction (3-5x faster than full parse)
- Graceful shutdown with state checkpointing, goroutine leak detection

---

## Output Schema

```json
{
  "crawl_metadata": {
    "start_url": "https://app.example.com",
    "total_pages": 15,
    "crawl_duration_ms": 2340,
    "pages_via_http": 12,
    "pages_via_browser": 3,
    "timestamp": "2026-03-13T10:30:00Z"
  },
  "pages": [
    {
      "url": "https://app.example.com/dashboard",
      "title": "Dashboard - MyApp",
      "rendered_via": "http",
      "status_code": 200,
      "fetch_duration_ms": 45,

      "meta": {
        "description": "Your personal dashboard",
        "og_title": "Dashboard",
        "og_image": "https://app.example.com/og.png"
      },

      "headings": [
        {"level": 1, "text": "Dashboard"},
        {"level": 2, "text": "Recent Activity"},
        {"level": 2, "text": "Quick Actions"}
      ],

      "links": {
        "internal": [
          {"href": "/settings", "text": "Settings"},
          {"href": "/profile", "text": "Profile"}
        ],
        "external": [
          {"href": "https://docs.example.com", "text": "Documentation"}
        ]
      },

      "forms": [
        {
          "action": "/api/search",
          "method": "GET",
          "inputs": [
            {"name": "q", "type": "text", "placeholder": "Search...", "required": true},
            {"name": "filter", "type": "select", "options": ["all", "recent", "popular"]}
          ],
          "submit_button": {"text": "Search", "type": "submit"}
        }
      ],

      "interactive_elements": [
        {"tag": "button", "text": "Create New", "type": "button"},
        {"tag": "button", "text": "Export Data", "type": "button"},
        {"tag": "a", "text": "View All", "role": "button"}
      ],

      "navigation": {
        "menu_items": ["Dashboard", "Projects", "Settings", "Help"],
        "breadcrumbs": ["Home", "Dashboard"]
      },

      "auth_patterns": {
        "has_login_form": false,
        "has_logout_link": true,
        "has_oauth_buttons": false
      },

      "page_type": "app",
      "content_extractor_used": "density",
      "simhash": "a1b2c3d4e5f6",

      "raw_markdown": "# Dashboard\n\n...(includes nav/footer)...",
      "fit_markdown": "# Dashboard\n\n## Recent Activity\n\n...(clean, LLM-optimized)...",
      "markdown_with_citations": "# Dashboard\n\n## Recent Activity [1]\n\n...\n\n[1]: /activity"
    }
  ],
  "site_structure": {
    "total_internal_links": 45,
    "total_external_links": 8,
    "total_forms": 5,
    "total_interactive_elements": 23,
    "page_depth_distribution": {"1": 5, "2": 8, "3": 2}
  }
}
```

---

## Implementation Plan

### Phase 1: Core Engine (Week 1)
**Refer to:** `references/katana/pkg/engine/`, `references/colly/queue/queue.go`, `references/colly/http_backend.go`
**Go perf guide:** §1 HTTP Transport tuning, §2 Goroutine pool, §4 Zero-allocation, §7 Context cascading, §20 URL canonicalization
- [ ] Project scaffolding (Go module, CLI with cobra)
- [ ] HTTP fetcher with tuned Transport (MaxIdleConnsPerHost=100, DNS cache, response draining)
- [ ] BFS crawl engine with semaphore-bounded goroutine pool (§2)
- [ ] URL normalization and canonicalization (§20 copy-paste function) + same-domain scope enforcement
- [ ] Depth/limit controls
- [ ] Basic link extraction with goquery + compiled cascadia selectors (§19)
- [ ] JSON/JSONL streaming output (§11)
- [ ] errgroup for cancel-on-error fan-out (§16)
- [ ] Context cascading: crawl > page > request timeouts (§7)

### Phase 2: Smart Rendering (Week 1-2)
**Refer to:** `references/katana/pkg/engine/headless/` (browser pool, page-ready, crawler), `references/katana/pkg/engine/standard/` (HTTP engine)
**Go perf guide:** §9 Build tags, §18 HTML tokenizer for SPA detection, §23 DNS caching
- [ ] SPA detection heuristics using HTML tokenizer (§18) — framework fingerprinting + content-to-markup ratio + hydration markers
- [ ] go-rod integration for browser rendering (study rod's PagePool in `references/katana/pkg/engine/headless/browser/`)
- [ ] Browser pool with health tracking — study `references/katana/pkg/engine/headless/browser/browser.go` for AcquireBrowser/ReleaseBrowser, failure counters, auto-restart
- [ ] Page-ready detection — study `references/katana/pkg/engine/headless/crawler/crawler.go` for composite DOMContentLoaded + network-idle polling + post-idle stabilization
- [ ] Cookie-consent/ad interception — study `references/katana/pkg/engine/hybrid/hijack.go` for request interception patterns
- [ ] System Chrome detection (find installed Chrome/Chromium)
- [ ] Graceful degradation via build tags (§9) — headless support gated behind `//go:build headless`
- [ ] Two-tier pipeline: HTTP first → SPA check → browser fallback
- [ ] Browser pre-warming with staggered creation — study `references/crawl4ai/crawl4ai/browser_pool_manager.py`
- [ ] DNS caching with viki-org/dnscache (§23) — Go does NOT cache DNS!

### Phase 3: Content Extraction (Week 2)
**Refer to:** `references/go-readability/` (Readability port), `references/readability/Readability.js` (original algorithm ~2000 LOC), `references/html2md/` (lightweight Go combo), `references/crawl4ai/crawl4ai/markdown_generation_strategy.py` (~160 LOC), `references/crawl4ai/crawl4ai/content_filter_strategy.py` (density pruning), `references/html-to-markdown/` (Go MD converter), `references/reader/src/` (Jina pipeline), `references/katana/pkg/engine/headless/crawler/formfill.go` (form extraction)
**Go perf guide:** §4 Pre-allocate slices, §18 Tokenizer for meta/title, §19 Compiled selectors
- [ ] Page-type detection (article/app/auth/docs via URL + DOM heuristics)
- [ ] Adaptive extraction strategy — study `references/readability/Readability.js` for scoring formulas; study `references/crawl4ai/crawl4ai/content_filter_strategy.py` for density-based pruning
- [ ] go-readability integration — study `references/go-readability/readability.go` for Go-specific patterns
- [ ] Density-based pruning for non-article pages — adapt from `references/crawl4ai/crawl4ai/content_filter_strategy.py` PruningContentFilter
- [ ] DOM normalization pipeline — study `references/katana/pkg/engine/headless/crawler/normalizer/`
- [ ] Heading extraction with compiled selectors (§19) — `cascadia.MustCompile("h1,h2,h3,h4,h5,h6")`
- [ ] Form extraction — study `references/katana/pkg/engine/headless/crawler/formfill.go` for CSRF detection, input constraints
- [ ] Interactive element detection (buttons, selects, modals, tabs, dropdowns)
- [ ] Navigation extraction (menus, breadcrumbs, sidebar, footer links)
- [ ] Auth pattern detection (login forms, OAuth buttons, signup flows)
- [ ] Meta tag extraction using HTML tokenizer (§18) — 3-5x faster than full goquery parse for targeted fields
- [ ] html-to-markdown v2 integration — study `references/html-to-markdown/converter/` for plugin architecture
- [ ] Citation-style link footnotes — study `references/reader/src/` and `references/crawl4ai/crawl4ai/markdown_generation_strategy.py` for citation format
- [ ] Dual output: raw_markdown + fit_markdown — study `references/crawl4ai/` fit_markdown concept

### Phase 4: Performance & Quality (Week 3)
**Refer to:** `references/katana/pkg/engine/headless/crawler/normalizer/simhash/` (SimHash), `references/spider/spider/src/concurrency.rs` (dynamic concurrency), `references/spider/spider/src/memory.rs` (memory management), `references/colly/http_backend.go` (per-domain limits), `references/katana/pkg/engine/headless/debugger.go` (diagnostics)
**Go perf guide:** §3 sync.Pool, §5 URL dedup (sync.Map/sharded/Bloom), §6 BFS pipeline, §8 GOGC/GOMEMLIMIT, §10 PGO, §13 Error resilience, §14 Benchmarking, §17 Per-domain slot limiter, §21 Bloom filter, §23 DNS cache, §24 Leak detection
- [ ] DOM normalization → SimHash dedup — study `references/katana/.../normalizer/simhash/simhash.go` for Go implementation
- [ ] Rate limiting with per-domain slot limiters (§17 Colly pattern) — study `references/colly/http_backend.go`
- [ ] Streaming results (JSONL §11, pages emitted as crawled via channel pipeline §6)
- [ ] sync.Pool for buffer reuse (§3) — body buffers, string builders, goquery docs
- [ ] Dynamic concurrency sizing based on CPU cores — study `references/spider/spider/src/concurrency.rs` for adaptive sizing
- [ ] GOGC=200 + GOMEMLIMIT tuning (§8) for throughput
- [ ] Error resilience — per-page error isolation, retry with exponential backoff (§13), circuit breaker per host
- [ ] Memory profiling with pprof (§14) — identify hot paths, reduce allocs/op
- [ ] Diagnostics HTTP endpoint — study `references/katana/pkg/engine/headless/debugger.go`
- [ ] Goroutine leak detection with goleak in tests (§24)
- [ ] Benchmark suite (§14) — compare against Crawl4AI, katana, Jina Reader using benchstat
- [ ] PGO build (§10) — collect production profile, rebuild with default.pgo
- [ ] Bloom filter for URL dedup at scale (§21)

### Phase 5: Integration & Polish (Week 3-4)
**Go perf guide:** §9 Build tags, §12 Graceful shutdown, §15 Project structure, §22 State checkpointing
- [ ] HTTP server mode (for Python/skeptic integration)
- [ ] Python wrapper package (crawly-py, subprocess-based)
- [ ] skeptic ICrawlerPort adapter implementation
- [ ] Docker image (minimal Alpine + system Chromium)
- [ ] Build tags for feature-gating (§9) — `go build` vs `go build -tags headless`
- [ ] Graceful shutdown with state checkpointing for resume (§12, §22)
- [ ] Binary size reduction: `-ldflags="-s -w" -trimpath` (§9)
- [ ] CLI documentation and examples
- [ ] GitHub Actions CI/CD
- [ ] Cross-platform binary releases (Linux, macOS, Windows)
- [ ] README, LICENSE (MIT), CONTRIBUTING
- [ ] Project structure following §15 layout

### Phase 6: Future Enhancements
- [ ] Lightpanda integration as Tier 1.5 renderer (11x faster, 9x less memory than Chrome)
- [ ] ReaderLM-v2 optional ML extraction mode (1.5B params, beats GPT-4o by 15-20% on HTML→MD)
- [ ] Vision-based extraction fallback (DocLayout-YOLO / ÉCLAIR for Canvas/Shadow DOM pages)
- [ ] Sitemap.xml discovery for additional URL seeding
- [ ] robots.txt respect (opt-in flag, since we typically crawl our own apps)
- [ ] Screenshot capture mode (useful for visual regression and vision-model extraction)
- [ ] Diff mode (detect content changes between crawls using SimHash delta)
- [ ] WebSocket/SSE support for real-time streaming results to clients
- [ ] BM25 content filtering (when user provides a query/context for focused extraction)
- [ ] Framework-aware readiness hooks (detect React/Vue/Angular, wait for hydration completion)
- [ ] Go build tags for feature-gating (browser support, vision models, ML extraction)
- [ ] Ensemble extraction mode (run Readability + density + DOM-structure, pick best result)

---

## CLI Usage Design

```bash
# Basic: crawl a site, output JSON
crawly https://app.example.com

# With options
crawly https://app.example.com \
  --max-pages 20 \
  --max-depth 3 \
  --concurrency 5 \
  --output json \
  --timeout 30s

# Markdown-only output
crawly https://app.example.com --output markdown

# Force browser rendering for all pages
crawly https://app.example.com --render always

# HTTP-only mode (no browser, fastest)
crawly https://app.example.com --render never

# Server mode (for integration with Python/other services)
crawly serve --port 8089

# Then from Python:
# POST http://localhost:8089/crawl {"url": "https://...", "max_pages": 20}
```

---

## Performance Targets

| Metric | Target | How |
|---|---|---|
| **20 static pages** | < 3 seconds | HTTP fetch only, goroutine pool |
| **20 SPA pages** | < 15 seconds | Browser pool (5 concurrent), page reuse |
| **20 mixed pages** (80% static, 20% SPA) | < 5 seconds | Two-tier: 16 pages HTTP + 4 pages browser |
| **Memory (HTTP mode)** | < 50MB | No browser, just Go runtime |
| **Memory (browser mode)** | < 300MB | Single Chrome instance, page pool |
| **Binary size** | < 20MB | Static Go binary, no embedded assets |
| **Docker image** | < 150MB | Alpine + Chromium (for browser mode) |
| **Cold start** | < 100ms | Go binary, instant startup |

---

## Python Integration (for skeptic)

```python
# crawly-py: thin wrapper around the Go binary

class CrawlyAdapter(ICrawlerPort):
    """Adapter that calls crawly binary via subprocess."""

    def __init__(self, binary_path: str = "crawly"):
        self._binary = binary_path

    async def crawl_site(self, url: str, max_pages: int = 20, max_depth: int = 3) -> CrawlResult:
        proc = await asyncio.create_subprocess_exec(
            self._binary, url,
            "--max-pages", str(max_pages),
            "--max-depth", str(max_depth),
            "--output", "json",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        data = json.loads(stdout)

        pages = []
        for p in data["pages"]:
            pages.append(PageInfo(
                url=p["url"],
                title=p["title"],
                links=[l["href"] for l in p["links"]["internal"]],
                forms=p["forms"],
                headings=[h["text"] for h in p["headings"]],
                interactive_elements=p["interactive_elements"],
            ))

        return CrawlResult(
            pages=pages,
            total_pages=data["crawl_metadata"]["total_pages"],
            crawl_duration_ms=data["crawl_metadata"]["crawl_duration_ms"],
        )
```

---

## Key Design Decisions

### 1. Go over Rust
- Katana (17K stars) proves Go is the right choice for crawlers
- go-rod is the best CDP client in any language
- Single binary deployment, great concurrency
- Faster dev velocity than Rust
- Can always optimize hot paths later

### 2. Two-tier rendering over always-browser
- 80%+ of web apps serve meaningful HTML without JS
- HTTP fetch is 20-50x faster than browser rendering
- Dramatically reduces resource usage
- Browser only when actually needed

### 3. Readability BEFORE markdown (Jina Reader pattern)
- Strip boilerplate first, then convert to markdown
- Result: clean markdown without nav/footer noise
- Reduces token count by 60-80% vs raw page markdown

### 4. Subprocess over FFI for Python integration
- Simpler than CGO/PyO3 bindings
- Go binary handles all complexity
- Python wrapper is ~50 lines
- Easy to version and deploy independently

### 5. System Chrome over bundled Chromium
- No 400MB binary to ship
- Users install Chrome once on their system
- Docker image uses system chromium package
- HTTP-only mode works with zero browser dependency

### 6. Adaptive extraction over one-size-fits-all
- Readability is great for articles but STRIPS forms and interactive elements
- App dashboards, settings pages, login screens need density-based extraction that preserves interactive DOM
- Page-type detection (URL heuristics + DOM signals) routes to the right extractor
- This is critical: Crawl4AI/Jina Reader always use Readability → they lose forms on app pages

### 7. Dual markdown output (raw + fit)
- `raw_markdown`: Full page conversion, includes nav/footer/sidebar (complete context)
- `fit_markdown`: Readability/density-pruned, LLM-optimized (minimal tokens, maximum signal)
- `markdown_with_citations`: Links as footnotes `[text][1]` with references section (Jina Reader pattern)
- Let the consumer choose which format suits their use case

### 8. QA-focused extraction (our differentiator)
- No other crawler extracts: forms, interactive elements, auth patterns, navigation structure
- This is exactly what an LLM needs to generate test cases
- Makes crawly uniquely valuable for QA/testing use cases

---

## Open Source Positioning

**Name**: `crawly`
**Tagline**: "The fastest web app crawler for AI and QA"
**License**: MIT

**README pitch**:
> Blazing-fast web app crawler that produces LLM-ready output. Two-tier rendering (HTTP + CDP) means 80% of pages crawl in under 50ms. Extracts forms, navigation, interactive elements, and auth patterns — everything an AI needs to understand your app. Single binary, no bundled browser.

**Target users**:
1. QA teams building AI-powered test generation
2. Developers building RAG pipelines from web apps
3. Security researchers needing fast, structured crawl data
4. Anyone who needs clean markdown from web pages
