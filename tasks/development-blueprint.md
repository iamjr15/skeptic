# crawly: Development Blueprint

> **Single source of truth for implementation.**
> A developer should be able to pick this up and start building without reading anything else.
> Last updated: 2026-03-13

---

## Table of Contents

1. [Complete Folder Structure](#1-complete-folder-structure)
2. [File-by-File Implementation Guide](#2-file-by-file-implementation-guide)
3. [Build Order](#3-build-order)
4. [Interface Contracts](#4-interface-contracts)
5. [Testing Strategy](#5-testing-strategy)
6. [Makefile Targets](#6-makefile-targets)
7. [Docker Strategy](#7-docker-strategy)
8. [CI/CD Pipeline](#8-cicd-pipeline)
9. [How to Use References While Coding](#9-how-to-use-references-while-coding)

---

## 1. Complete Folder Structure

Every file that needs to be created, with exact path and one-line description.

```
crawly/
├── cmd/
│   └── crawly/
│       ├── main.go                          # CLI entry point: cobra root command, signal handling, pprof
│       ├── crawl.go                         # "crawl" subcommand: parse flags, build config, run engine
│       ├── serve.go                         # "serve" subcommand: HTTP server mode for Python integration
│       └── version.go                       # "version" subcommand: prints build info (version, commit, date)
│
├── pkg/
│   ├── types/
│   │   ├── config.go                        # CrawlConfig options struct with all user-configurable fields
│   │   ├── result.go                        # PageResult, CrawlResult, CrawlMetadata, SiteStructure structs
│   │   ├── page.go                          # FormInfo, HeadingInfo, LinkInfo, InteractiveElement, NavInfo, AuthPatterns, MetaInfo structs
│   │   └── enums.go                         # RenderMode, OutputFormat, PageType, ExtractorType enums
│   │
│   ├── crawler/
│   │   ├── engine.go                        # BFS crawl engine: goroutine pool, semaphore, main crawl loop
│   │   ├── engine_test.go                   # Unit tests for crawl engine with mock fetcher/extractor
│   │   ├── queue.go                         # BFS queue: channel-based with depth tracking and backpressure
│   │   ├── queue_test.go                    # Queue push/pop/close tests
│   │   ├── dedup.go                         # URL deduplication: sync.Map for small crawls, Bloom filter for large
│   │   ├── dedup_test.go                    # Dedup correctness and concurrency tests
│   │   ├── scope.go                         # Same-domain enforcement, include/exclude URL pattern matching
│   │   ├── scope_test.go                    # Scope validation tests
│   │   ├── frontier.go                      # Crawl frontier state: checkpoint save/load for resume
│   │   └── robots.go                       # Phase 6: robots.txt fetching/caching/lookup via samclarke/robotstxt
│   │
│   ├── fetcher/
│   │   ├── fetcher.go                       # Fetcher interface definition + FetchResult type
│   │   ├── http.go                          # HTTP fetcher: tuned Transport, DNS cache, response draining, retry
│   │   ├── http_test.go                     # HTTP fetcher tests with httptest server
│   │   ├── browser.go                       # Browser fetcher (build tag: headless): go-rod CDP, page pool, page-ready
│   │   ├── browser_stub.go                  # Browser fetcher stub (build tag: !headless): returns ErrNoBrowser
│   │   ├── browser_test.go                  # Browser fetcher integration tests (build tag: headless)
│   │   ├── browser_pool.go                  # Browser pool: acquire/release, health tracking, auto-restart
│   │   └── chrome.go                        # System Chrome detection: find installed Chrome/Chromium binary
│   │
│   ├── detector/
│   │   ├── spa.go                           # SPA detection: framework markers, content-to-markup ratio, hydration signals
│   │   ├── spa_test.go                      # SPA detection tests with fixture HTML files
│   │   ├── pagetype.go                      # Page-type detection: article/app/auth/docs via URL heuristics + DOM signals
│   │   └── pagetype_test.go                 # Page-type detection tests
│   │
│   ├── extractor/
│   │   ├── extractor.go                     # Extractor interface definition + adaptive routing logic
│   │   ├── readability.go                   # Readability extractor: wraps go-shiori/go-readability
│   │   ├── readability_test.go              # Readability extraction tests with fixture HTML
│   │   ├── density.go                       # Density-based extractor: text density scoring, link density, node pruning
│   │   ├── density_test.go                  # Density extractor tests
│   │   ├── full.go                          # Full/passthrough extractor: no pruning, keeps entire DOM for auth/form-heavy pages
│   │   ├── structural.go                    # Structural extractor: headings, forms, links, buttons, nav, auth patterns
│   │   ├── structural_test.go               # Structural extraction tests
│   │   ├── meta.go                          # Meta extractor: title, description, OG tags, JSON-LD via HTML tokenizer
│   │   └── meta_test.go                     # Meta extraction tests
│   │
│   ├── markdown/
│   │   ├── converter.go                     # Markdown converter: wraps html-to-markdown v2 with crawly plugins
│   │   ├── converter_test.go                # Markdown conversion tests with golden files
│   │   ├── citations.go                     # Citation-style link footnotes: [text][1] with references section
│   │   └── citations_test.go                # Citation conversion tests
│   │
│   ├── security/
│   │   ├── urlpolicy.go                     # URL/IP validation, SafeDialContext, CheckRedirectPolicy, ReadBounded, WrapBrowserRequestInterceptor — SSRF protection at every boundary
│   │   └── urlpolicy_test.go                # URL policy tests: blocked IPs, allowed URLs, DNS rebinding scenarios
│   │
│   ├── normalize/
│   │   ├── dom.go                           # DOM normalization: strip scripts/styles, remove tracking attrs, collapse whitespace
│   │   ├── dom_test.go                      # DOM normalization tests
│   │   ├── url.go                           # URL canonicalization: lowercase, sort params, strip fragment, trim trailing slash
│   │   ├── url_test.go                      # URL normalization tests
│   │   ├── simhash.go                       # SimHash fingerprinting: tokenize HTML, compute fingerprint, Hamming distance
│   │   └── simhash_test.go                  # SimHash tests with near-duplicate HTML pairs
│   │
│   ├── output/
│   │   ├── json.go                          # JSON output: buffer full result, write as single JSON object
│   │   ├── jsonl.go                         # JSONL streaming output: one JSON object per line as pages complete
│   │   ├── markdown_output.go               # Markdown-only output: write clean markdown per page to stdout/files
│   │   ├── writer.go                        # OutputWriter interface + factory function for format selection
│   │   └── writer_test.go                   # Output writer tests
│   │
│   └── server/
│       ├── handler.go                       # HTTP handler: POST /crawl endpoint, request validation, JSON response
│       ├── handler_test.go                  # HTTP handler tests
│       └── server.go                        # HTTP server: ListenAndServe with graceful shutdown
│
├── internal/
│   ├── pool/
│   │   ├── buffer.go                        # sync.Pool instances: body buffers (8KB), string builders, with size caps
│   │   └── buffer_test.go                   # Pool correctness tests: get/put/reset cycle
│   │
│   ├── ratelimit/
│   │   ├── limiter.go                       # Rate limiter: global token bucket + per-domain slot limiter (Colly pattern)
│   │   └── limiter_test.go                  # Rate limiter tests
│   │
│   └── selector/
│       ├── compiled.go                      # Pre-compiled CSS selectors: headings, forms, links, buttons, nav, meta
│       └── compiled_test.go                 # Selector compilation sanity tests
│
├── testdata/
│   ├── fixtures/
│   │   ├── static_page.html                 # Static HTML page with article content, forms, nav
│   │   ├── spa_react.html                   # React SPA shell (empty root div, bundle.js)
│   │   ├── spa_next.html                    # Next.js SSR page with __NEXT_DATA__ hydration
│   │   ├── spa_vue.html                     # Vue app shell (empty app div, __NUXT__)
│   │   ├── login_page.html                  # Login form with username/password/OAuth buttons
│   │   ├── dashboard_page.html              # App dashboard with forms, buttons, data tables
│   │   ├── docs_page.html                   # Documentation page with headings, code blocks, sidebar nav
│   │   ├── blog_article.html                # Blog article with rich content, images, author byline
│   │   ├── near_duplicate_a.html            # Near-duplicate page A (for SimHash testing)
│   │   ├── near_duplicate_b.html            # Near-duplicate page B (slight variation of A)
│   │   └── complex_forms.html               # Page with multiple forms: search, filters, CSRF tokens
│   └── golden/
│       ├── static_page.md                   # Expected markdown output for static_page.html
│       ├── blog_article.md                  # Expected markdown output for blog_article.html
│       └── citations_output.md              # Expected citation-style markdown
│
├── go.mod                                   # Go module: github.com/anthropic/crawly
├── go.sum                                   # Go dependency checksums
├── Makefile                                 # Build, test, bench, lint, release, docker, pgo targets
├── Dockerfile                               # Multi-stage Docker build for minimal image
├── .github/
│   └── workflows/
│       ├── ci.yml                           # CI: test, lint, build on push/PR
│       └── release.yml                      # Release: goreleaser on tag push
├── .golangci.yml                            # Golangci-lint configuration
├── .goreleaser.yml                          # GoReleaser configuration for cross-platform binaries
├── LICENSE                                  # MIT license
└── README.md                                # Project README
```

**Total files: 77** (42 Go source, 15 Go test, 11 fixture/golden, 9 config/build)

---

## 2. File-by-File Implementation Guide

### Legend
- **Ref:** = reference files to study (paths relative to `references/`)
- **Perf:** = Go performance guide sections to apply (section numbers)
- **Imports:** = other crawly files this file depends on
- **LOC:** = estimated lines of code

---

### 2.1 Types Package (`pkg/types/`)

#### `pkg/types/enums.go`
**What it does:** Defines type-safe string enumerations for render mode (auto/always/never), output format (json/jsonl/markdown), page type (article/app/auth/docs/unknown), and extractor type (readability/density/full). These are used throughout the codebase for configuration and result reporting.

- **Ref:** `katana/pkg/types/options.go` (how katana defines strategy/field enums), `crawl4ai/crawl4ai/models.py` (page type enum)
- **Perf:** None (trivial types)
- **Exports:** `RenderMode`, `OutputFormat`, `PageType`, `ExtractorType` types with `const` blocks
- **Imports:** None
- **LOC:** ~60

#### `pkg/types/config.go`
**What it does:** Defines the `CrawlConfig` struct containing all user-configurable options: start URL, max pages, max depth, concurrency, timeouts, render mode, output format, rate limit, include/exclude patterns, user agent, custom headers, and all boolean feature flags. Also provides `DefaultConfig()` constructor and `Validate()` method.

- **Ref:** `katana/pkg/types/options.go` (Options struct, 200 lines of config fields), `colly/colly.go` (Collector config pattern), `reader/src/dto/crawler-options.ts` (Jina Reader options)
- **Perf:** None
- **Exports:** `CrawlConfig` struct, `DefaultConfig() CrawlConfig`, `(c *CrawlConfig) Validate() error`
- **Imports:** `pkg/types/enums.go`
- **LOC:** ~150

#### `pkg/types/page.go`
**What it does:** Defines all the structural sub-types extracted per page: `HeadingInfo` (level + text), `LinkInfo` (href + text + is_internal), `FormInfo` (action, method, inputs, submit button), `InputInfo` (name, type, placeholder, required, value, options), `InteractiveElement` (tag, text, type, role), `NavInfo` (menu items, breadcrumbs), `AuthPatterns` (has_login_form, has_logout_link, has_oauth_buttons), `MetaInfo` (title, description, og_title, og_image, og_description, canonical, json_ld).

- **Ref:** `katana/pkg/navigation/response.go` (Form struct), `katana/pkg/utils/formfill.go` (FormInput, FormSelect, FormTextArea), `crawl4ai/crawl4ai/models.py` (CrawlResult model fields)
- **Perf:** None
- **Exports:** All structs listed above with JSON tags
- **Imports:** None
- **LOC:** ~180

#### `pkg/types/result.go`
**What it does:** Defines the output data structures: `PageResult` (URL, title, rendered_via, status_code, fetch_duration, meta, headings, links, forms, interactive_elements, navigation, auth_patterns, page_type, extractor_used, simhash, raw_markdown, fit_markdown, markdown_with_citations, error), `CrawlResult` (crawl_metadata + pages[] + site_structure), `CrawlMetadata` (start_url, total_pages, duration, pages_via_http, pages_via_browser, timestamp), `SiteStructure` (total_internal/external_links, total_forms, total_interactive, depth_distribution).

- **Ref:** `katana/pkg/output/result.go` (Result struct), Output schema in `crawly-plan.md` lines 411-496, `crawl4ai/crawl4ai/models.py` (CrawlResult)
- **Perf:** SS4 (pre-allocate slice fields with estimated capacity)
- **Exports:** `PageResult`, `CrawlResult`, `CrawlMetadata`, `SiteStructure`
- **Imports:** `pkg/types/page.go`, `pkg/types/enums.go`
- **LOC:** ~120

---

### 2.2 Internal Packages (`internal/`)

#### `internal/pool/buffer.go`
**What it does:** Declares package-level `sync.Pool` instances for reusable buffers: `BodyBufferPool` (8KB initial `*bytes.Buffer`), `StringBuilderPool` (`*strings.Builder`), `ByteSlicePool` (4KB `[]byte`). Each pool has `Get()` / `Put()` helpers that handle Reset before Put and cap maximum sizes to prevent memory bloat (reject buffers > 64KB back to GC).

- **Ref:** `katana/pkg/engine/headless/crawler/normalizer/simhash/simhash.go` lines 28-32 (bufferPool pattern), `spider_transformations/src/lib.rs` (buffer reuse concept)
- **Perf:** SS3 (sync.Pool, 93% throughput improvement), SS3 rules (always Reset before Put, always copy out, cap sizes)
- **Exports:** `GetBodyBuffer() *bytes.Buffer`, `PutBodyBuffer(*bytes.Buffer)`, `GetStringBuilder() *strings.Builder`, `PutStringBuilder(*strings.Builder)`, `GetByteSlice() []byte`, `PutByteSlice([]byte)`
- **Imports:** None (stdlib only)
- **LOC:** ~80

#### `internal/pool/buffer_test.go`
- **LOC:** ~40

#### `internal/ratelimit/limiter.go`
**What it does:** Implements two-level rate limiting. (1) `GlobalLimiter` wraps `golang.org/x/time/rate.Limiter` for overall requests-per-second. (2) `DomainLimiter` implements the Colly per-domain slot pattern: `map[string]*DomainSlot` where each slot has a buffered channel sized to max parallelism and a politeness delay applied before releasing. Provides `Acquire(domain)` and `Release(domain)` methods. Thread-safe via sync.RWMutex for the map.

- **Ref:** `colly/http_backend.go` lines 36-65 (LimitRule struct with waitChan, Delay, Parallelism), `colly/colly.go` (Limit method)
- **Perf:** SS17 (Colly's per-domain limiter pattern, copy-paste)
- **Exports:** `GlobalLimiter` struct, `DomainLimiter` struct, `NewDomainLimiter(parallelism int, delay time.Duration) *DomainLimiter`
- **Imports:** None (stdlib + `golang.org/x/time/rate`)
- **LOC:** ~100

#### `internal/ratelimit/limiter_test.go`
- **LOC:** ~60

#### `internal/selector/compiled.go`
**What it does:** Declares package-level compiled CSS selectors using `cascadia.MustCompile()`, initialized once at package init. Selectors: `HeadingSel` ("h1,h2,h3,h4,h5,h6"), `FormSel` ("form"), `InputSel` ("input,textarea,select"), `LinkSel` ("a[href]"), `ButtonSel` ("button,input[type=submit],input[type=button],a[role=button]"), `NavSel` ("nav"), `MetaSel` ("meta"), `ImgSel` ("img"), `ScriptSel` ("script"), `StyleSel` ("style"), `MainContentSel` ("main,article,[role=main]"), `BreadcrumbSel` ("[aria-label=breadcrumb],ol.breadcrumb,.breadcrumbs"), `MenuSel` ("nav ul,nav ol,[role=navigation] ul,[role=menu]").

- **Ref:** `katana/pkg/engine/parser/parser.go` (uses goquery selectors extensively), `html-to-markdown/converter/converter.go` (tag-based handling)
- **Perf:** SS19 (compiled CSS selectors: compile once, reuse via FindMatcher, avoids re-parsing selector string each page)
- **Exports:** All selector variables listed above
- **Imports:** `github.com/andybalholm/cascadia`
- **LOC:** ~50

#### `internal/selector/compiled_test.go`
- **LOC:** ~30

---

### 2.3 Normalize Package (`pkg/normalize/`)

#### `pkg/normalize/url.go`
**What it does:** Implements `NormalizeURL(raw string) (string, error)` for URL canonicalization. Steps: parse URL, lowercase scheme and host, `path.Clean()` the path, strip fragment, sort query parameters alphabetically, remove trailing slash (except root "/"), remove common tracking parameters (utm_*, fbclid, gclid). Also implements `ResolveURL(base, href string) string` for converting relative URLs to absolute. Also `IsSameDomain(url1, url2 string) bool`.

- **Ref:** `katana/pkg/engine/headless/crawler/normalizer/normalizer.go` (normalizeDocument function), `katana/pkg/utils/utils.go` (URL utilities)
- **Perf:** SS20 (copy-paste normalizeURL function), SS4 (strings.Builder for query param assembly)
- **Exports:** `NormalizeURL(raw string) (string, error)`, `ResolveURL(baseURL, href string) string`, `IsSameDomain(a, b string) bool`
- **Imports:** None (stdlib only)
- **LOC:** ~120

#### `pkg/normalize/url_test.go`
- **LOC:** ~100

#### `pkg/normalize/dom.go`
**What it does:** Implements `NormalizeDOM(htmlStr string) (string, error)` that produces a deterministic DOM snapshot for SimHash comparison. Pipeline: (1) parse with goquery, (2) remove all `<script>`, `<style>`, `<noscript>` elements, (3) remove tracking/analytics attributes (data-gtm-*, data-analytics-*, data-tracking-*), (4) remove dynamic attributes (onclick, onload, style, data-session-*, data-timestamp-*), (5) remove empty elements, (6) lowercase all tag names, (7) sort attributes alphabetically, (8) collapse whitespace. Returns normalized HTML string.

- **Ref:** `katana/pkg/engine/headless/crawler/normalizer/normalizer.go` (Apply method, multi-pass normalization), `katana/pkg/engine/headless/crawler/normalizer/dom_utils.go` (DOM manipulation), `katana/pkg/engine/headless/crawler/normalizer/text_utils.go` (text normalization)
- **Perf:** SS3 (pool goquery parsing buffers), SS4 (pre-allocate)
- **Exports:** `NormalizeDOM(htmlStr string) (string, error)`
- **Imports:** `internal/pool`, `internal/selector`
- **LOC:** ~150

#### `pkg/normalize/dom_test.go`
- **LOC:** ~80

#### `pkg/normalize/simhash.go`
**What it does:** Wraps the `mfonda/simhash` library to produce 64-bit fingerprints from normalized HTML. Implements `Fingerprint(html string) uint64` using streaming HTML tokenizer (not full parse). Implements `Distance(a, b uint64) uint8` returning Hamming distance. Implements `SimHashOracle` struct (trie-based seen/unseen tracker from katana) with `See(fingerprint)` and `Seen(fingerprint, threshold) bool` methods for near-duplicate detection.

- **Ref:** `katana/pkg/engine/headless/crawler/normalizer/simhash/simhash.go` (entire file -- Fingerprint, Oracle, Distance, extractFeatures with buffer pooling)
- **Perf:** SS3 (sync.Pool for feature buffers), SS18 (HTML tokenizer for feature extraction, not full parse)
- **Exports:** `Fingerprint(html string) uint64`, `Distance(a, b uint64) uint8`, `SimHashOracle` struct with `See()` and `Seen()` methods
- **Imports:** `internal/pool`, `github.com/mfonda/simhash`
- **LOC:** ~150

#### `pkg/normalize/simhash_test.go`
- **LOC:** ~80

---

### 2.4 Security Package (`pkg/security/`)

#### `pkg/security/urlpolicy.go`
**What it does:** Implements `URLPolicy` struct for URL and IP validation to prevent SSRF attacks. Blocks: loopback addresses (127.0.0.0/8), private networks (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), link-local addresses (169.254.0.0/16), cloud metadata endpoints (169.254.169.254), and non-HTTP/HTTPS schemes. Methods: `CheckURL(rawURL string) error` (validates scheme, host, resolved IP), `ReadBounded(r io.Reader, maxKB int) (body []byte, truncated bool, err error)` (reads up to maxKB*1024 bytes, returns truncated=true if limit was hit; does NOT drain remaining body — caller should close), `NewURLPolicy(cfg *types.CrawlConfig) *URLPolicy`. Provides `SafeDialContext(ctx context.Context, network, addr string) (net.Conn, error)` — a custom DialContext that resolves the hostname, validates the resolved IP against the blocked ranges (loopback, private, link-local, metadata), then dials. This catches DNS rebinding at connection time, not just at URL validation time. Provides `CheckRedirectPolicy(req *http.Request, via []*http.Request) error` — validates each redirect hop URL against the policy. Rejects redirects to blocked IPs/schemes. Provides `WrapBrowserRequestInterceptor()` — a rod request interception callback that blocks subrequests to forbidden IPs/schemes during browser rendering.

- **Ref:** OWASP SSRF Prevention Cheat Sheet, Go `net` package for IP parsing and CIDR checks
- **Perf:** None (security-critical, correctness over speed)
- **Exports:** `URLPolicy` struct, `NewURLPolicy(cfg *types.CrawlConfig) *URLPolicy`, `CheckURL(rawURL string) error`, `ReadBounded(r io.Reader, maxKB int) (body []byte, truncated bool, err error)`, `SafeDialContext(ctx context.Context, network, addr string) (net.Conn, error)`, `CheckRedirectPolicy(req *http.Request, via []*http.Request) error`, `WrapBrowserRequestInterceptor()`
- **Imports:** `pkg/types`
- **LOC:** ~200

#### `pkg/security/urlpolicy_test.go`
- **LOC:** ~100

---

### 2.5 Fetcher Package (`pkg/fetcher/`)

#### `pkg/fetcher/fetcher.go`
**What it does:** Defines the `Fetcher` interface with a single method: `Fetch(ctx context.Context, url string) (*FetchResult, error)`. Defines `FetchResult` struct containing: `StatusCode int`, `Body []byte`, `Headers http.Header`, `FinalURL string` (after redirects), `Duration time.Duration`, `RenderedVia string` ("http" or "browser"). This interface is implemented by both HTTPFetcher and BrowserFetcher.

- **Ref:** `katana/pkg/engine/engine.go` (Engine interface), `katana/pkg/engine/common/base.go` (DoRequestFunc type)
- **Perf:** None
- **Exports:** `Fetcher` interface, `FetchResult` struct
- **Imports:** `pkg/types`
- **LOC:** ~50

#### `pkg/fetcher/http.go`
**What it does:** Implements `HTTPFetcher` struct satisfying the `Fetcher` interface. Constructor `NewHTTPFetcher(cfg *CrawlConfig)` builds an `*http.Client` with fully tuned `*http.Transport`: MaxIdleConns=100, MaxIdleConnsPerHost=100, DNS caching via viki-org/dnscache, ForceAttemptHTTP2=true, TLS tuning, response header timeout. Uses `urlpolicy.SafeDialContext` as the Transport's DialContext and `urlpolicy.CheckRedirectPolicy` as the client's CheckRedirect — SSRF protection at every network boundary. The `Fetch()` method: validates URL via `security.URLPolicy.CheckURL()` before connecting, creates request with context, sets User-Agent and custom headers, uses `urlpolicy.ReadBounded()` instead of io.ReadAll for MaxBodyKB enforcement — if truncated, logs warning and continues with partial body, closes body immediately to free connection (accepts connection reuse loss for oversized responses), records timing. Also implements retry with exponential backoff (3 attempts, 500ms base, jitter).

- **Ref:** `colly/http_backend.go` (HTTP backend with transport tuning, cookie jar), `katana/pkg/engine/common/http.go` (BuildHttpClient), `katana/pkg/engine/standard/crawl.go` (HTTP fetch flow)
- **Perf:** SS1 (HTTP Transport tuning -- biggest single win), SS3 (sync.Pool for body buffers), SS7 (context propagation -- per-request timeout), SS13 (retry with exponential backoff), SS23 (DNS caching -- Go does NOT cache DNS)
- **Exports:** `HTTPFetcher` struct, `NewHTTPFetcher(cfg *types.CrawlConfig) *HTTPFetcher`
- **Imports:** `pkg/types`, `pkg/security`, `internal/pool`, `github.com/viki-org/dnscache`
- **LOC:** ~200

#### `pkg/fetcher/http_test.go`
- **LOC:** ~120

#### `pkg/fetcher/browser.go` (build tag: `//go:build headless`)
**What it does:** Implements `BrowserFetcher` struct satisfying the `Fetcher` interface. Uses go-rod for CDP browser control. Constructor `NewBrowserFetcher(cfg *CrawlConfig)` finds system Chrome, creates a `BrowserPool`, and initializes rod.Browser. Installs `urlpolicy.WrapBrowserRequestInterceptor()` via rod's HijackRequests to block browser subrequests to forbidden IPs/schemes (covers all subresource loads, XHR, fetch). The `Fetch()` method: validates URL via `security.URLPolicy.CheckURL()` before navigating, acquires page from pool, navigates to URL, runs page-ready heuristics (composite: WaitLoad + network idle polling + post-idle stabilization + optional framework-specific readiness), extracts rendered HTML via `page.HTML()`, checks `len(html)` against `MaxBrowserHTMLKB` (default 10MB, configurable) — if exceeded, truncates and logs warning. Releases page back to pool. Implements stealth evasion (user agent, webdriver flag). Handles dialog boxes (auto-dismiss alerts/confirms). **SSRF limitation:** Browser mode's initial navigation uses Chrome's own resolver, so DNS rebinding between CheckURL and Navigate is not fully preventable via CDP. The request interception callback catches subrequests but not the initial navigation's DNS resolution. For untrusted targets, use HTTP-only mode (`--render never`) or deploy behind a network-level firewall. This is the standard approach used by Katana and similar tools — sufficient for the primary use case of crawling your own apps.

- **Ref:** `katana/pkg/engine/headless/browser/browser.go` (Launcher, BrowserPage, WaitPageLoadHeurisitics, GetPageFromPool, PutBrowserToPool, headlessFlags, dialog handling), `katana/pkg/engine/headless/crawler/crawler.go` (crawl orchestration with browser), `katana/pkg/engine/headless/browser/stealth/assets.go` (stealth JS)
- **Perf:** SS9 (build tag gating), SS7 (context timeout per-page)
- **Exports:** `BrowserFetcher` struct, `NewBrowserFetcher(cfg *types.CrawlConfig) (*BrowserFetcher, error)`
- **Imports:** `pkg/types`, `pkg/security`, `pkg/fetcher/browser_pool.go`, `github.com/go-rod/rod`
- **LOC:** ~250

#### `pkg/fetcher/browser_stub.go` (build tag: `//go:build !headless`)
**What it does:** Provides a stub `BrowserFetcher` that returns `ErrNoBrowser` when headless build tag is not set. This allows the binary to compile without go-rod dependency when browser support is not needed.

- **Ref:** Performance guide SS9 (build tags for feature gating)
- **Perf:** SS9
- **Exports:** `BrowserFetcher` struct (stub), `NewBrowserFetcher(cfg *types.CrawlConfig) (*BrowserFetcher, error)`, `ErrNoBrowser` — signature matches the headless version exactly; cfg is accepted but ignored for API compatibility
- **Imports:** `pkg/types`
- **LOC:** ~30

#### `pkg/fetcher/browser_pool.go` (build tag: `//go:build headless`)
**What it does:** Implements `BrowserPool` struct for managing a pool of browser pages. Uses rod's `rod.Pool` or a custom implementation with: acquire/release semantics, health tracking per page (consecutive failure count), automatic page disposal and recreation when unhealthy, configurable pool size (default: 5), staggered browser creation to avoid CPU spikes, connection health check before returning page.

- **Ref:** `katana/pkg/engine/headless/browser/browser.go` lines 36-41 (Launcher with rod.Pool), lines 362-371 (GetPageFromPool), lines 541-570 (PutBrowserToPool with health check), `crawl4ai/crawl4ai/browser_pool_manager.py` (pre-warming, staggered creation, health-based management)
- **Perf:** None (focus on correctness)
- **Exports:** `BrowserPool` struct, `NewBrowserPool(size int, chromePath string) (*BrowserPool, error)`, `Acquire(ctx context.Context) (*rod.Page, error)`, `Release(page *rod.Page, healthy bool)` — when healthy=false, page is discarded instead of returned to pool, `Close()`
- **Imports:** `github.com/go-rod/rod`
- **LOC:** ~180

#### `pkg/fetcher/browser_test.go` (build tag: `//go:build headless`)
- **LOC:** ~80

#### `pkg/fetcher/chrome.go`
**What it does:** Implements `FindChrome() (string, error)` that searches for an installed Chrome or Chromium binary on the system. Checks platform-specific paths: macOS (`/Applications/Google Chrome.app/...`, Chromium), Linux (`/usr/bin/google-chrome`, `/usr/bin/chromium-browser`, `/snap/bin/chromium`), Windows (`%PROGRAMFILES%/Google/Chrome/...`). Also checks `$CHROME_PATH` env var first. Returns the first found binary path or error.

- **Ref:** `katana/pkg/engine/headless/browser/browser.go` (uses rod's launcher which handles Chrome detection internally, but we want explicit control)
- **Perf:** None
- **Exports:** `FindChrome() (string, error)`
- **Imports:** None (stdlib only)
- **LOC:** ~80

---

### 2.6 Detector Package (`pkg/detector/`)

#### `pkg/detector/spa.go`
**What it does:** Implements `NeedsBrowserRendering(body []byte, contentType string) bool` using HTML tokenizer for fast scanning (not full goquery parse). Algorithm: (1) quick check -- if stripped text > 500 chars, return false; (2) scan for SPA framework markers (React root div, __NEXT_DATA__, Vue app div, __NUXT__, Angular app-root, ng-version, __sveltekit); (3) compute content-to-markup ratio; (4) check hydration markers in script content; (5) check for `<noscript>` with "enable JavaScript"; (6) count script tags vs text content. Returns true only when content is thin AND SPA signals are present.

- **Ref:** SPA Detection Algorithm in `crawly-plan.md` lines 164-232 (pseudocode), `katana/pkg/engine/hybrid/crawl.go` (hybrid crawl decision), `reader/src/services/puppeteer.ts` (browser rendering decision logic)
- **Perf:** SS18 (HTML tokenizer for SPA detection -- 3-5x faster than full goquery parse for scanning markers)
- **Exports:** `NeedsBrowserRendering(body []byte, contentType string) bool`
- **Imports:** `golang.org/x/net/html` (tokenizer)
- **LOC:** ~150

#### `pkg/detector/spa_test.go`
- **LOC:** ~120

#### `pkg/detector/pagetype.go`
**What it does:** Implements `DetectPageType(url string, body []byte) PageType` that classifies pages into: article, blog, docs, app, dashboard, auth, unknown. Algorithm: (1) URL pattern matching (login/signin/auth -> auth, dashboard/admin/settings -> app, blog/post/article -> article, docs/documentation -> docs); (2) DOM signals via tokenizer (presence of `<article>`, JSON-LD Article schema, >3 forms -> app, login/password inputs -> auth); (3) Content heuristics (high heading density -> docs, single main article -> article). Returns `PageType` enum.

- **Ref:** Adaptive Extraction Strategy in `crawly-plan.md` lines 240-281 (detectPageType pseudocode), `reader/src/dto/crawler-options.ts` (page type routing concept), `katana/pkg/types/options.go` (FilterPageType, KnowledgeBase classification)
- **Perf:** SS18 (tokenizer for DOM signals), SS4 (avoid fmt.Sprintf in hot path)
- **Exports:** `DetectPageType(url string, body []byte) types.PageType`
- **Imports:** `pkg/types`
- **LOC:** ~130

#### `pkg/detector/pagetype_test.go`
- **LOC:** ~80

---

### 2.7 Extractor Package (`pkg/extractor/`)

#### `pkg/extractor/extractor.go`
**What it does:** Defines the `Extractor` interface: `Extract(doc *goquery.Document, pageURL string) (*ExtractionResult, error)` — individual extractors operate on a parsed `*goquery.Document`. Defines `ExtractionResult` struct containing the cleaned HTML content string and the extraction strategy name used. Implements the top-level adaptive routing function `ExtractContent(body []byte, pageURL string, pageType PageType) (*ExtractionResult, error)` — this takes raw `body []byte`, internally parses it to `*goquery.Document`, then routes to the appropriate `Extractor` implementation based on page type. For article/blog/docs: try readability first, fall back to density if result is too short. For app/dashboard/auth: use density with keepForms=true. For auth: use full extractor (no pruning). For unknown: try readability, fall back to density.

- **Ref:** Adaptive Extraction Strategy in `crawly-plan.md` lines 240-281, `reader/src/api/crawler.ts` (extraction pipeline orchestration), `html2md/extractor.go` (combined extraction approach)
- **Perf:** SS4 (pre-allocate)
- **Exports:** `Extractor` interface, `ExtractionResult` struct, `ExtractContent(body []byte, pageURL string, pageType types.PageType) (*ExtractionResult, error)` function
- **Imports:** `pkg/types`, `pkg/detector`, `github.com/PuerkitoBio/goquery`
- **LOC:** ~120

#### `pkg/extractor/readability.go`
**What it does:** Implements `ReadabilityExtractor` struct satisfying the `Extractor` interface. Wraps `go-shiori/go-readability` package. The `Extract()` method: parses the goquery document back to `*html.Node`, calls `readability.FromDocument()`, returns the article content HTML. Handles edge cases: empty extraction (returns error so caller can fall back), very short extraction (< 50 chars -> fall back). Configures the readability parser for best results (MaxElemsToParse, CharThreshold).

- **Ref:** `go-readability/readability.go` (FromReader, FromDocument API), `go-readability/parser.go` (Parser struct, Article struct with Title/Content/TextContent/Length), `readability/Readability.js` (reference algorithm for understanding scoring -- lines 1-2000, especially the scoring formula, unlikely candidates regex, link density threshold)
- **Perf:** SS4 (pre-allocate)
- **Exports:** `ReadabilityExtractor` struct, `NewReadabilityExtractor() *ReadabilityExtractor`
- **Imports:** `pkg/types`, `github.com/go-shiori/go-readability`
- **LOC:** ~80

#### `pkg/extractor/readability_test.go`
- **LOC:** ~60

#### `pkg/extractor/density.go`
**What it does:** Implements `DensityExtractor` struct satisfying the `Extractor` interface. Adapts Crawl4AI's PruningContentFilter to Go. Algorithm: (1) walk DOM tree, (2) for each node compute text_density = text_length / total_length and link_density = link_text / total_text, (3) score nodes by: text_density * tag_importance_weight - link_density_penalty, (4) prune nodes below threshold, (5) optionally keep forms and interactive elements (for app pages). Parameters: density_threshold (default: 0.5), min_text_length (default: 25), keep_forms (bool), keep_interactive (bool).

- **Ref:** `crawl4ai/crawl4ai/content_filter_strategy.py` (PruningContentFilter class -- scores DOM nodes by text density, link density, tag importance, then prunes below threshold), `readability/Readability.js` lines around scoring (link density > 0.25 penalty), Plan lines 151-156 (Readability scoring formula for comparison)
- **Perf:** SS4 (pre-allocate node score slices), SS19 (compiled selectors for tag-based scoring)
- **Exports:** `DensityExtractor` struct, `NewDensityExtractor(opts DensityOptions) *DensityExtractor`, `DensityOptions` struct
- **Imports:** `pkg/types`, `internal/selector`
- **LOC:** ~200

#### `pkg/extractor/density_test.go`
- **LOC:** ~80

#### `pkg/extractor/full.go`
**What it does:** Implements `FullExtractor` struct satisfying the `Extractor` interface. A passthrough extractor that performs no content pruning — keeps the entire DOM intact. Used for auth pages and form-heavy pages where aggressive content extraction would remove essential interactive elements. The `Extract()` method returns the full document HTML as-is (after basic script/style removal via normalize.NormalizeDOM).

- **Ref:** None (simple passthrough)
- **Perf:** None
- **Exports:** `FullExtractor` struct, `NewFullExtractor() *FullExtractor`
- **Imports:** `pkg/types`
- **LOC:** ~30

#### `pkg/extractor/structural.go`
**What it does:** Extracts all structural elements from a page using goquery with compiled cascadia selectors. Implements: `ExtractHeadings(doc *goquery.Document) []HeadingInfo`, `ExtractForms(doc *goquery.Document, baseURL string) []FormInfo`, `ExtractLinks(doc *goquery.Document, baseURL, currentDomain string) (internal []LinkInfo, external []LinkInfo)`, `ExtractInteractiveElements(doc *goquery.Document) []InteractiveElement`, `ExtractNavigation(doc *goquery.Document) NavInfo`, `ExtractAuthPatterns(doc *goquery.Document) AuthPatterns`. Each function uses compiled selectors from `internal/selector` and pre-allocated slices.

- **Ref:** `katana/pkg/utils/formfill.go` (FormInput struct, FormFillData, form traversal pattern), `katana/pkg/utils/formfields.go` (form field extraction), `katana/pkg/engine/parser/parser.go` (link extraction from HTML), `katana/pkg/navigation/response.go` (Form struct with method/action/enctype/parameters)
- **Perf:** SS19 (compiled CSS selectors via FindMatcher), SS4 (pre-allocate slices with estimated capacity from Length()), SS4 (zero-allocation in-place filtering)
- **Exports:** All `Extract*` functions listed above
- **Imports:** `pkg/types`, `pkg/normalize` (for URL resolution), `internal/selector`
- **LOC:** ~350

#### `pkg/extractor/structural_test.go`
- **LOC:** ~200

#### `pkg/extractor/meta.go`
**What it does:** Extracts meta information using HTML tokenizer (NOT full goquery parse) for speed. Implements `ExtractMeta(body []byte, pageURL string) MetaInfo`. Scans for: `<title>` text, `<meta name="description">`, `<meta property="og:*">` (title, image, description, url), `<meta name="twitter:*">`, `<link rel="canonical">`, `<script type="application/ld+json">` (JSON-LD parsing). Uses streaming tokenizer that stops after `</head>` for efficiency (meta tags are always in `<head>`).

- **Ref:** `katana/pkg/engine/parser/parser.go` (meta extraction), `katana/pkg/output/fields.go` (field extraction from response), `reader/src/services/snapshot-formatter.ts` (metadata extraction), `go-readability/parser.go` lines 22-48 (metadata regex patterns from readability)
- **Perf:** SS18 (HTML tokenizer 3-5x faster than full goquery parse for targeted extraction -- stop after head close tag)
- **Exports:** `ExtractMeta(body []byte, pageURL string) types.MetaInfo`
- **Imports:** `pkg/types`, `golang.org/x/net/html` (tokenizer)
- **LOC:** ~180

#### `pkg/extractor/meta_test.go`
- **LOC:** ~80

---

### 2.8 Markdown Package (`pkg/markdown/`)

#### `pkg/markdown/converter.go`
**What it does:** Wraps JohannesKaufmann/html-to-markdown v2 for HTML-to-Markdown conversion. Implements `NewMarkdownConverter(baseURL string) *MarkdownConverter` that configures the converter with CommonMark plugin, table plugin, strikethrough plugin, and custom settings (heading style ATX, link style inlined, code block style fenced). Implements `Convert(html string) (string, error)` for raw conversion and `ConvertFit(html string) (string, error)` for LLM-optimized output (fit_markdown: tighter whitespace, link citations). Also converts relative links to absolute using the base URL.

- **Ref:** `html-to-markdown/convert.go` (top-level Convert API), `html-to-markdown/converter/converter.go` (Converter struct, NewConverter, WithEscapeMode), `html-to-markdown/converter/plugin.go` (plugin registration), `html-to-markdown/plugin/commonmark/commonmark.go` (CommonMark plugin), `html-to-markdown/plugin/table/table.go` (table plugin), `html-to-markdown/plugin/base/base.go` (base plugin), `html-to-markdown/WRITING_PLUGINS.md` (how to write custom plugins)
- **Perf:** SS3 (pool string builders for output assembly)
- **Exports:** `MarkdownConverter` struct, `NewMarkdownConverter(baseURL string) *MarkdownConverter`, `Convert(html string) (string, error)`, `ConvertFit(html string) (string, error)`
- **Imports:** `internal/pool`, `github.com/JohannesKaufmann/html-to-markdown/v2`
- **LOC:** ~120

#### `pkg/markdown/converter_test.go`
- **LOC:** ~80

#### `pkg/markdown/citations.go`
**What it does:** Implements citation-style link footnotes transformation. Takes markdown with inline links `[text](url)` and converts them to `[text][1]` with a collected references section at the bottom: `[1]: url`. Implements `ConvertToCitations(markdown string) string`. Uses regex to find all inline links, assigns sequential numbers, deduplicates URLs (same URL gets same reference number), appends reference list at end. This is the Jina Reader pattern for LLM-friendly output (reduces inline noise).

- **Ref:** `reader/src/utils/markdown.ts` (citation-style link conversion), `crawl4ai/crawl4ai/markdown_generation_strategy.py` (DefaultMarkdownGenerator with citation references), Plan lines 114 and 546 (citation format description)
- **Perf:** SS4 (strings.Builder for output, pre-allocate reference list)
- **Exports:** `ConvertToCitations(markdown string) string`
- **Imports:** `internal/pool`
- **LOC:** ~100

#### `pkg/markdown/citations_test.go`
- **LOC:** ~60

---

### 2.9 Crawler Package (`pkg/crawler/`)

#### `pkg/crawler/queue.go`
**What it does:** Implements `CrawlQueue` struct: a channel-based BFS queue with depth tracking and frontier-aware state management. Uses a buffered channel (`chan CrawlTask`) for backpressure. `CrawlTask` contains URL, Depth, and ParentURL. Tracks task states: queued, inflight, and done. Methods: `Push(ctx context.Context, task CrawlTask) error` (blocks until space available or ctx canceled), `Next(ctx context.Context) (CrawlTask, error)` (returns next task, blocks until available or ctx canceled, moves task to inflight state), `Done(task CrawlTask)` (marks task complete, moves from inflight to done), `Snapshot() []CrawlTask` (atomic snapshot of pending+inflight tasks for checkpointing), `Close()`, `Len() int`, `Inflight() int`. The queue respects context cancellation throughout.

- **Ref:** `katana/pkg/utils/queue/queue.go` (Queue interface with Push/Pop), `katana/pkg/utils/queue/strategy.go` (BFS strategy), `colly/queue/queue.go` (channel-based queue with workers)
- **Perf:** SS6 (BFS queue with channel pipeline, buffered for backpressure)
- **Exports:** `CrawlQueue` struct, `CrawlTask` struct, `NewCrawlQueue(capacity int) *CrawlQueue`
- **Imports:** None (stdlib only)
- **LOC:** ~120

#### `pkg/crawler/queue_test.go`
- **LOC:** ~60

#### `pkg/crawler/dedup.go`
**What it does:** Implements `URLDedup` struct with dual strategy: `sync.Map` for small crawls (< 10K URLs, default) and optional Bloom filter for large crawls. Bloom filter is used ONLY as a fast prefilter before the exact sync.Map check -- never as the sole dedup mechanism. This prevents false-positive page drops while still benefiting from Bloom's memory efficiency for large crawls (Bloom says "no" = definitely new, Bloom says "yes" = check sync.Map to confirm). Methods: `MarkVisited(url string) bool` (returns true if already visited, uses LoadOrStore), `IsVisited(url string) bool`, `Count() int`, `Snapshot() []string` (returns a copy of all visited URLs from the sync.Map by iterating via Range and collecting keys; thread-safe). The Bloom filter mode is enabled via constructor option `WithBloomFilter(expectedURLs int, fpRate float64)`. Always normalizes URLs before checking.

- **Ref:** Performance guide SS5 (sync.Map for read-heavy dedup), SS21 (Bloom filter for scale), `katana/pkg/engine/common/base.go` lines 108 (UniqueFilter.UniqueURL)
- **Perf:** SS5 (sync.Map), SS21 (Bloom filter at scale)
- **Exports:** `URLDedup` struct, `NewURLDedup() *URLDedup`, `NewURLDedupWithBloom(n int, fp float64) *URLDedup`, `Snapshot() []string`
- **Imports:** `pkg/normalize`, `github.com/bits-and-blooms/bloom/v3`
- **LOC:** ~90

#### `pkg/crawler/dedup_test.go`
- **LOC:** ~60

#### `pkg/crawler/scope.go`
**What it does:** Implements `ScopeChecker` struct for URL scope validation. Methods: `IsInScope(url string, rootDomain string) bool` (checks same-domain by default), `WithIncludePatterns(patterns []string)` (regex patterns for additional allowed URLs), `WithExcludePatterns(patterns []string)` (regex patterns for denied URLs), `IsAllowedExtension(url string) bool` (filters out non-HTML extensions like .pdf, .png, .css, .js). Compiles regex patterns once at construction.

- **Ref:** `katana/pkg/utils/scope/scope.go` (scope validation with regex), `katana/pkg/utils/extensions/extensions.go` (extension filtering), `katana/pkg/engine/common/base.go` lines 166-177 (ValidateScope)
- **Perf:** None (simple logic)
- **Exports:** `ScopeChecker` struct, `NewScopeChecker(rootDomain string, include, exclude []string) (*ScopeChecker, error)`
- **Imports:** `pkg/normalize`
- **LOC:** ~100

#### `pkg/crawler/scope_test.go`
- **LOC:** ~80

#### `pkg/crawler/frontier.go`
**What it does:** Implements `Frontier` as a data-only struct holding `PendingTasks []CrawlTask`, `VisitedURLs []string`, and `CrawlProgress` metadata. The Frontier does NOT perform snapshotting itself — it is populated by `CrawlEngine.Shutdown()` which coordinates the queue+dedup snapshot, then returned to the caller. Methods: `Save(path string) error` (serializes the data-only Frontier fields to JSON file), `RemainingURLs() []CrawlTask`. Static function `LoadFrontier(path string) (*Frontier, error)` restores from checkpoint.

**Ownership model:** `engine.Shutdown(ctx)` does the coordinated snapshot (pauses workers, calls queue.Snapshot() + dedup.Snapshot(), builds Frontier). `frontier.Save(path)` only serializes. This is the single source of truth.

- **Ref:** Performance guide SS22 (graceful shutdown with state checkpointing), `katana/pkg/types/options.go` line 26 (Resume field)
- **Perf:** SS22
- **Exports:** `Frontier` struct (data-only: PendingTasks, VisitedURLs, CrawlProgress), `(f *Frontier) Save(path string) error`, `LoadFrontier(path string) (*Frontier, error)`
- **Imports:** None (stdlib only — just JSON marshal/unmarshal)
- **LOC:** ~80

#### `pkg/crawler/engine.go`
**What it does:** The core crawl engine. `CrawlEngine` struct orchestrates BFS crawl: maintains the queue, URL dedup, scope checker, fetcher (HTTP + optional browser), extractors, markdown converter. The engine is output-agnostic — it does NOT own an OutputWriter; instead it streams results via channel and lets the caller (CLI/server) wire the output writer. Constructor `NewCrawlEngine(cfg *types.CrawlConfig) (*CrawlEngine, error)` wires all dependencies. `Crawl(ctx context.Context) (<-chan types.PageResult, error)` returns a streaming channel of PageResult for real-time consumption. `Wait() (types.CrawlMetadata, types.SiteStructure, error)` blocks until the crawl completes (channel closed), computes SiteStructure from accumulated results, and returns final metadata + structure + any terminal error from errgroup. Crawl implements: (1) seed queue with start URL, (2) spawn worker goroutines bounded by semaphore, (3) each worker: pop task via queue.Next(), acquire rate limit, fetch page (HTTP first, SPA check, browser fallback), extract meta, detect page type, run adaptive content extraction, extract structural elements, convert to markdown (raw + fit + citations), build PageResult, send to results channel, extract links, normalize and enqueue new links, call queue.Done(). (4) Channel closes when crawl is complete. Uses errgroup for cancel-on-error on fatal errors while continuing on per-page errors.

- **Ref:** `katana/pkg/engine/common/base.go` (Do method -- the main crawl loop with concurrent workers, queue pop, request validation, output), `katana/pkg/engine/standard/crawl.go` (standard HTTP crawl), `katana/pkg/engine/headless/crawler/crawler.go` (headless crawl with browser), `colly/queue/queue.go` (queue + worker pattern), Performance guide SS2 (semaphore goroutine pool), SS6 (BFS pipeline), SS16 (errgroup + semaphore)
- **Perf:** SS2 (semaphore-bounded goroutine pool), SS6 (BFS channel pipeline), SS7 (context cascading: crawl > page > request), SS8 (GOGC=200 + GOMEMLIMIT), SS12 (graceful shutdown), SS13 (per-page error isolation), SS16 (errgroup for cancel-on-error)
- **Exports:** `CrawlEngine` struct, `NewCrawlEngine(cfg *types.CrawlConfig) (*CrawlEngine, error)`, `Crawl(ctx context.Context) (<-chan types.PageResult, error)`, `Wait() (types.CrawlMetadata, types.SiteStructure, error)`, `Shutdown(ctx context.Context) (*Frontier, error)` — cancels crawl context, waits for inflight workers to finish (with ctx timeout), takes coordinated queue+dedup snapshot, returns Frontier for persistence
- **Imports:** `pkg/types`, `pkg/fetcher`, `pkg/security`, `pkg/detector`, `pkg/extractor`, `pkg/markdown`, `pkg/normalize`, `pkg/crawler/queue`, `pkg/crawler/dedup`, `pkg/crawler/scope`, `internal/ratelimit`, `internal/pool`
- **LOC:** ~400

#### `pkg/crawler/engine_test.go`
- **LOC:** ~200

---

### 2.10 Output Package (`pkg/output/`)

#### `pkg/output/writer.go`
**What it does:** Defines `OutputWriter` interface with methods: `WriteResult(result types.PageResult) error`, `Finalize(meta types.CrawlMetadata, structure types.SiteStructure) error`, `Close() error`. Also provides factory function `NewOutputWriter(format OutputFormat, w io.Writer) OutputWriter` that returns the appropriate writer based on format. Writers are designed to consume from `<-chan types.PageResult` — the caller (CLI/server) reads from the engine's channel and calls `WriteResult()` for each page.

- **Ref:** `katana/pkg/output/output.go` (OutputWriter interface with Write/WriteErr)
- **Perf:** None
- **Exports:** `OutputWriter` interface, `NewOutputWriter()` factory
- **Imports:** `pkg/types`
- **LOC:** ~40

#### `pkg/output/json.go`
**What it does:** Implements `JSONWriter` satisfying `OutputWriter`. Buffers all PageResults in memory, then on `Finalize()` constructs the full CrawlResult JSON and writes it to the output writer as a single JSON document. Uses `json.NewEncoder` with `SetIndent` for pretty printing.

- **Ref:** `katana/pkg/output/format_json.go` (JSON output formatting)
- **Perf:** SS4 (pre-allocate pages slice)
- **Exports:** `JSONWriter` struct
- **Imports:** `pkg/types`
- **LOC:** ~60

#### `pkg/output/jsonl.go`
**What it does:** Implements `JSONLWriter` satisfying `OutputWriter`. Streams each PageResult as a single JSON line immediately when `WriteResult()` is called. On `Finalize()`, writes metadata as the final line. Uses `json.NewEncoder` (no indent, one object per line).

- **Ref:** Performance guide SS11 (JSON streaming output -- don't buffer entire crawl)
- **Perf:** SS11 (streaming JSONL)
- **Exports:** `JSONLWriter` struct
- **Imports:** `pkg/types`
- **LOC:** ~50

#### `pkg/output/markdown_output.go`
**What it does:** Implements `MarkdownWriter` satisfying `OutputWriter`. Writes fit_markdown for each page as it completes, separated by page URL headers. Format: `# Page: {url}\n\n{fit_markdown}\n\n---\n\n`.

- **Ref:** None (simple format)
- **Perf:** None
- **Exports:** `MarkdownWriter` struct
- **Imports:** `pkg/types`
- **LOC:** ~40

#### `pkg/output/writer_test.go`
- **LOC:** ~80

---

### 2.11 Server Package (`pkg/server/`)

#### `pkg/server/server.go`
**What it does:** Implements `Server` struct with `Start(addr string) error` and `Shutdown(ctx context.Context) error`. Binds to localhost only by default (127.0.0.1). Add `--server-host` flag to override for non-local use. NOT intended for public-facing deployment without additional auth. Uses `http.Server` with timeouts (read: 10s, write: 5min for long crawls, idle: 120s). Registers handler routes. Graceful shutdown drains connections.

- **Ref:** `reader/src/api/crawler.ts` (HTTP API for crawl requests)
- **Perf:** SS12 (graceful shutdown)
- **Exports:** `Server` struct, `NewServer(host string, port int) *Server`
- **Imports:** `pkg/server/handler.go`
- **LOC:** ~60

#### `pkg/server/handler.go`
**What it does:** Implements HTTP handler for `POST /crawl` endpoint. Accepts JSON body with crawl config fields (url, max_pages, max_depth, etc.), validates input, creates CrawlEngine, calls `engine.Crawl()` to get the streaming channel, consumes all PageResults, then calls `engine.Wait()` to get both CrawlMetadata and SiteStructure, assembles the full CrawlResult response, and returns it as JSON. Also implements `GET /health` for health checks.

- **Ref:** `reader/src/api/crawler.ts` (crawler API endpoint), `katana/pkg/engine/headless/debugger.go` (diagnostics endpoint)
- **Perf:** None
- **Exports:** `CrawlHandler`, `HealthHandler`
- **Imports:** `pkg/types`, `pkg/crawler`
- **LOC:** ~100

#### `pkg/server/handler_test.go`
- **LOC:** ~80

---

### 2.12 CLI (`cmd/crawly/`)

#### `cmd/crawly/main.go`
**What it does:** CLI entry point. Sets up cobra root command, registers subcommands (crawl, serve, version). Configures signal handling (SIGINT, SIGTERM) with context cancellation. Optionally starts pprof server on port 6060 when `--pprof` flag is set. Sets GOGC and GOMEMLIMIT from flags or environment variables.

- **Ref:** `katana/cmd/katana/main.go` (CLI entry point pattern), `colly/cmd/colly/colly.go` (simple CLI)
- **Perf:** SS8 (GOGC/GOMEMLIMIT tuning), SS10 (pprof endpoint for PGO), SS12 (graceful shutdown with signal handling)
- **Exports:** `main()`
- **Imports:** `cmd/crawly/crawl.go`, `cmd/crawly/serve.go`, `cmd/crawly/version.go`
- **LOC:** ~80

#### `cmd/crawly/crawl.go`
**What it does:** Defines the "crawl" cobra command. Maps CLI flags to `CrawlConfig` struct: `--max-pages`, `--max-depth`, `--concurrency`, `--timeout`, `--render` (auto/always/never), `--output` (json/jsonl/markdown), `--rate-limit`, `--include`, `--exclude`, `--user-agent`, `--headers`, `--delay`, `--resume`, `--pprof`. Creates CrawlEngine, calls `engine.Crawl()` to get `<-chan types.PageResult`, creates OutputWriter, reads from channel and calls `writer.WriteResult()` for each page, then calls `engine.Wait()` to get CrawlMetadata, SiteStructure, and any fatal error, and calls `writer.Finalize()` with the returned metadata and structure. On SIGINT: calls `engine.Shutdown(ctx)` which cancels workers, waits for inflight to finish (5s timeout), takes coordinated queue+dedup snapshot, returns `*Frontier`; CLI then calls `frontier.Save(checkpointPath)` to persist. This is the concrete SIGINT→shutdown→checkpoint sequence.

- **Ref:** `katana/internal/runner/options.go` (flag definitions and parsing), `katana/internal/runner/runner.go` (runner that wires everything together)
- **Perf:** SS12 (graceful shutdown), SS22 (checkpoint on interrupt)
- **Exports:** `NewCrawlCmd() *cobra.Command`
- **Imports:** `pkg/types`, `pkg/crawler`, `pkg/output`
- **LOC:** ~150

#### `cmd/crawly/serve.go`
**What it does:** Defines the "serve" cobra command. Starts HTTP server on `--port` (default: 8089). Provides the API endpoint for Python/external integration.

- **Ref:** `reader/src/stand-alone/crawl.ts` (standalone server mode)
- **Perf:** None
- **Exports:** `NewServeCmd() *cobra.Command`
- **Imports:** `pkg/server`
- **LOC:** ~40

#### `cmd/crawly/version.go`
**What it does:** Defines the "version" cobra command. Prints version, git commit, build date, Go version. Uses `-ldflags` injected variables.

- **Ref:** None (standard pattern)
- **Perf:** None
- **Exports:** `NewVersionCmd() *cobra.Command`
- **Imports:** None
- **LOC:** ~30

---

## 3. Build Order

Files must be implemented in this sequence to ensure no file depends on something not yet written. Each sub-phase is independently testable.

### Phase 1: Foundation

**Sub-phase 1A: Types (no dependencies)**
1. `pkg/types/enums.go`
2. `pkg/types/page.go`
3. `pkg/types/config.go`
4. `pkg/types/result.go`

**Sub-phase 1B: Internal utilities (depends on: nothing)**
5. `internal/pool/buffer.go` + `buffer_test.go`
6. `internal/selector/compiled.go` + `compiled_test.go`
7. `internal/ratelimit/limiter.go` + `limiter_test.go`

**Sub-phase 1C: Normalization (depends on: internal/)**
8. `pkg/normalize/url.go` + `url_test.go`
9. `pkg/normalize/dom.go` + `dom_test.go`
10. `pkg/normalize/simhash.go` + `simhash_test.go`

**Sub-phase 1D: Security (depends on: types)**
11. `pkg/security/urlpolicy.go` + `urlpolicy_test.go`

**Checkpoint: `go test ./pkg/types/... ./internal/... ./pkg/normalize/... ./pkg/security/...` passes**

### Phase 2: Fetching

**Sub-phase 2A: Fetcher interface + HTTP (depends on: types, internal/pool, security)**
12. `pkg/fetcher/fetcher.go`
13. `pkg/fetcher/chrome.go`
14. `pkg/fetcher/http.go` + `http_test.go`

**Sub-phase 2B: Browser fetcher (depends on: fetcher.go, chrome.go, security)**
15. `pkg/fetcher/browser_stub.go`
16. `pkg/fetcher/browser_pool.go`
17. `pkg/fetcher/browser.go` + `browser_test.go`

**Checkpoint: `go test ./pkg/fetcher/...` passes (without headless tag), `go test -tags headless ./pkg/fetcher/...` passes (with Chrome installed)**

### Phase 2.5: Test Fixtures

**Create testdata directory and fixture files before extraction phase (extractors need fixtures for testing)**
18. All `testdata/fixtures/*.html` files
19. All `testdata/golden/*.md` files

**Checkpoint: `testdata/` directory exists with fixture files**

### Phase 3: Detection + Extraction

**Sub-phase 3A: Detectors (depends on: types)**
20. `pkg/detector/spa.go` + `spa_test.go`
21. `pkg/detector/pagetype.go` + `pagetype_test.go`

**Sub-phase 3B: Extractors (depends on: types, internal/selector, normalize)**
22. `pkg/extractor/extractor.go`
23. `pkg/extractor/readability.go` + `readability_test.go`
24. `pkg/extractor/density.go` + `density_test.go`
25. `pkg/extractor/full.go`
26. `pkg/extractor/structural.go` + `structural_test.go`
27. `pkg/extractor/meta.go` + `meta_test.go`

**Sub-phase 3C: Markdown (depends on: internal/pool)**
28. `pkg/markdown/converter.go` + `converter_test.go`
29. `pkg/markdown/citations.go` + `citations_test.go`

**Checkpoint: `go test ./pkg/detector/... ./pkg/extractor/... ./pkg/markdown/...` passes**

### Phase 4: Crawl Engine

**Sub-phase 4A: Crawl support types (depends on: normalize, types)**
30. `pkg/crawler/queue.go` + `queue_test.go`
31. `pkg/crawler/dedup.go` + `dedup_test.go`
32. `pkg/crawler/scope.go` + `scope_test.go`
33. `pkg/crawler/frontier.go`

**Sub-phase 4B: Engine (depends on: ALL packages above)**
34. `pkg/crawler/engine.go` + `engine_test.go`

**Checkpoint: `go test ./pkg/crawler/...` passes with mock HTTP server**

### Phase 5: Output + Server + CLI

**Sub-phase 5A: Output (depends on: types)**
35. `pkg/output/writer.go`
36. `pkg/output/json.go`
37. `pkg/output/jsonl.go`
38. `pkg/output/markdown_output.go`
39. `pkg/output/writer_test.go`

**Sub-phase 5B: Server (depends on: types, crawler, output)**
40. `pkg/server/handler.go` + `handler_test.go`
41. `pkg/server/server.go`

**Sub-phase 5C: CLI (depends on: ALL)**
42. `cmd/crawly/version.go`
43. `cmd/crawly/crawl.go`
44. `cmd/crawly/serve.go`
45. `cmd/crawly/main.go`

**Checkpoint: `go build ./cmd/crawly` produces working binary, `crawly --help` works**

### Phase 6: Integration + Future Features

46. Integration tests (crawl a local httptest server end-to-end)
47. `pkg/crawler/robots.go` — robots.txt support via `samclarke/robotstxt` (Phase 6 feature, not v1 core)
48. Authenticated/session-based crawling (shared cookie jar between HTTP and browser fetchers)

### Phase 7: Build/Deploy Infrastructure

49. `Makefile`
50. `Dockerfile`
51. `.github/workflows/ci.yml`
52. `.github/workflows/release.yml`
53. `.golangci.yml`
54. `.goreleaser.yml`

---

## 4. Interface Contracts

All Go interfaces, key structs, and type definitions. Copy these directly into the appropriate files.

### 4.1 Enums (`pkg/types/enums.go`)

```go
package types

// RenderMode controls when browser rendering is used.
type RenderMode string

const (
    RenderAuto   RenderMode = "auto"   // SPA detection decides (default)
    RenderAlways RenderMode = "always" // Always use browser
    RenderNever  RenderMode = "never"  // HTTP-only, fastest
)

// OutputFormat controls the output format.
type OutputFormat string

const (
    OutputJSON     OutputFormat = "json"     // Buffered JSON object
    OutputJSONL    OutputFormat = "jsonl"    // Streaming JSON lines
    OutputMarkdown OutputFormat = "markdown" // Clean markdown per page
)

// PageType classifies a web page for extraction strategy routing.
type PageType string

const (
    PageArticle  PageType = "article"
    PageBlog     PageType = "blog"
    PageDocs     PageType = "docs"
    PageApp      PageType = "app"
    PageDashboard PageType = "dashboard"
    PageAuth     PageType = "auth"
    PageUnknown  PageType = "unknown"
)

// ExtractorType identifies which extraction strategy was used.
type ExtractorType string

const (
    ExtractorReadability ExtractorType = "readability"
    ExtractorDensity     ExtractorType = "density"
    ExtractorFull        ExtractorType = "full"
)
```

### 4.2 Configuration (`pkg/types/config.go`)

```go
package types

import "time"

// CrawlConfig contains all user-configurable crawl options.
type CrawlConfig struct {
    // Target
    StartURL string `json:"start_url"`

    // Limits
    MaxPages   int `json:"max_pages"`   // Default: 20
    MaxDepth   int `json:"max_depth"`   // Default: 3
    MaxBodyKB         int `json:"max_body_kb"`          // Max HTTP response body size in KB. Default: 5120 (5MB)
    MaxBrowserHTMLKB  int `json:"max_browser_html_kb"`  // Max browser-rendered HTML size in KB. Default: 10240 (10MB). Checked post-render (known limitation: full DOM materializes in memory before check).

    // Concurrency
    Concurrency int `json:"concurrency"` // Goroutine pool size. Default: 10

    // Timeouts
    CrawlTimeout   time.Duration `json:"crawl_timeout"`   // Overall crawl timeout. Default: 5m
    PageTimeout    time.Duration `json:"page_timeout"`    // Per-page timeout. Default: 30s
    RequestTimeout time.Duration `json:"request_timeout"` // Per-HTTP-request timeout. Default: 15s

    // Rendering
    RenderMode     RenderMode `json:"render_mode"`     // auto, always, never. Default: auto
    ChromePath     string     `json:"chrome_path"`     // Path to Chrome binary (auto-detected if empty)
    BrowserPoolSize int       `json:"browser_pool_size"` // Number of browser pages in pool. Default: 5

    // Output
    OutputFormat OutputFormat `json:"output_format"` // json, jsonl, markdown. Default: json

    // Rate limiting
    RateLimit        int           `json:"rate_limit"`         // Max requests per second (0 = unlimited). Default: 0
    DomainDelay      time.Duration `json:"domain_delay"`       // Delay between requests to same domain. Default: 0
    DomainParallelism int          `json:"domain_parallelism"` // Max concurrent requests per domain. Default: 5

    // Scope
    IncludePatterns []string `json:"include_patterns"` // Regex patterns for allowed URLs
    ExcludePatterns []string `json:"exclude_patterns"` // Regex patterns for denied URLs

    // HTTP
    UserAgent     string            `json:"user_agent"`     // Custom User-Agent. Default: "Crawly/1.0"
    CustomHeaders map[string]string `json:"custom_headers"` // Additional HTTP headers
    Retries       int               `json:"retries"`        // Number of retries on failure. Default: 2

    // Features
    FollowRedirects    bool `json:"follow_redirects"`    // Follow HTTP redirects. Default: true
    RespectRobotsTxt   bool `json:"respect_robots_txt"`  // Respect robots.txt. Default: false. // RespectRobotsTxt: Phase 6 feature — implementation in pkg/crawler/robots.go
    EnableSimHash      bool `json:"enable_simhash"`      // Near-duplicate detection. Default: true
    SimHashThreshold   int  `json:"simhash_threshold"`   // Hamming distance threshold. Default: 3

    // Resume
    CheckpointPath string `json:"checkpoint_path"` // Path for crawl state checkpoint file

    // Debug
    EnablePprof bool `json:"enable_pprof"` // Enable pprof HTTP endpoint on :6060
    Verbose     bool `json:"verbose"`      // Verbose logging
}

// DefaultConfig returns a CrawlConfig with sensible defaults.
func DefaultConfig() CrawlConfig {
    return CrawlConfig{
        MaxPages:          20,
        MaxDepth:          3,
        MaxBodyKB:         5120,
        MaxBrowserHTMLKB:  10240,
        Concurrency:       10,
        CrawlTimeout:      5 * time.Minute,
        PageTimeout:       30 * time.Second,
        RequestTimeout:    15 * time.Second,
        RenderMode:        RenderAuto,
        BrowserPoolSize:   5,
        OutputFormat:      OutputJSON,
        DomainParallelism: 5,
        UserAgent:         "Crawly/1.0",
        Retries:           2,
        FollowRedirects:   true,
        EnableSimHash:     true,
        SimHashThreshold:  3,
    }
}

// Validate checks that the config is valid.
func (c *CrawlConfig) Validate() error {
    // Validate StartURL is non-empty and parseable
    // Validate MaxPages > 0, MaxDepth >= 0
    // Validate Concurrency > 0
    // Validate timeouts are positive
    // Validate RenderMode and OutputFormat are valid enum values
    return nil
}
```

### 4.3 Page Structs (`pkg/types/page.go`)

```go
package types

// HeadingInfo represents an extracted heading element.
type HeadingInfo struct {
    Level int    `json:"level"` // 1-6
    Text  string `json:"text"`
}

// LinkInfo represents an extracted link.
type LinkInfo struct {
    Href       string `json:"href"`
    Text       string `json:"text"`
    IsInternal bool   `json:"is_internal,omitempty"`
}

// InputInfo represents a form input element.
type InputInfo struct {
    Name        string   `json:"name"`
    Type        string   `json:"type"`                  // text, email, password, hidden, select, textarea, etc.
    Placeholder string   `json:"placeholder,omitempty"`
    Required    bool     `json:"required,omitempty"`
    Value       string   `json:"value,omitempty"`        // Default value if present
    Options     []string `json:"options,omitempty"`       // For select elements
}

// FormInfo represents an extracted HTML form.
type FormInfo struct {
    Action       string      `json:"action"`
    Method       string      `json:"method"`
    Inputs       []InputInfo `json:"inputs"`
    SubmitButton *ButtonInfo `json:"submit_button,omitempty"`
    HasCSRF      bool        `json:"has_csrf,omitempty"` // CSRF token detected
}

// ButtonInfo represents a button element.
type ButtonInfo struct {
    Text string `json:"text"`
    Type string `json:"type"` // submit, button, reset
}

// InteractiveElement represents a clickable/interactive UI element.
type InteractiveElement struct {
    Tag  string `json:"tag"`            // button, a, input, select
    Text string `json:"text"`
    Type string `json:"type,omitempty"` // button type or input type
    Role string `json:"role,omitempty"` // ARIA role
}

// NavInfo represents navigation structure.
type NavInfo struct {
    MenuItems   []string `json:"menu_items,omitempty"`
    Breadcrumbs []string `json:"breadcrumbs,omitempty"`
}

// AuthPatterns represents detected authentication patterns.
type AuthPatterns struct {
    HasLoginForm    bool `json:"has_login_form"`
    HasLogoutLink   bool `json:"has_logout_link"`
    HasOAuthButtons bool `json:"has_oauth_buttons"`
}

// MetaInfo represents page metadata.
type MetaInfo struct {
    Title         string                 `json:"title,omitempty"`
    Description   string                 `json:"description,omitempty"`
    OGTitle       string                 `json:"og_title,omitempty"`
    OGImage       string                 `json:"og_image,omitempty"`
    OGDescription string                 `json:"og_description,omitempty"`
    Canonical     string                 `json:"canonical,omitempty"`
    Language      string                 `json:"language,omitempty"`
    JSONLD        map[string]interface{} `json:"json_ld,omitempty"`
}
```

### 4.4 Result Structs (`pkg/types/result.go`)

```go
package types

import "time"

// PageResult contains all extracted data for a single crawled page.
type PageResult struct {
    URL           string `json:"url"`
    Title         string `json:"title"`
    RenderedVia   string `json:"rendered_via"`         // "http" or "browser"
    StatusCode    int    `json:"status_code"`
    FetchDurationMs int64 `json:"fetch_duration_ms"`
    Error         string `json:"error,omitempty"`

    Meta          MetaInfo       `json:"meta"`
    Headings      []HeadingInfo  `json:"headings"`
    Links         PageLinks      `json:"links"`
    Forms         []FormInfo     `json:"forms"`

    InteractiveElements []InteractiveElement `json:"interactive_elements"`
    Navigation          NavInfo              `json:"navigation"`
    AuthPatterns        AuthPatterns         `json:"auth_patterns"`

    PageType      PageType      `json:"page_type"`
    ExtractorUsed ExtractorType `json:"content_extractor_used"`
    SimHash       string        `json:"simhash,omitempty"`

    RawMarkdown           string `json:"raw_markdown"`
    FitMarkdown           string `json:"fit_markdown"`
    MarkdownWithCitations string `json:"markdown_with_citations"`
}

// PageLinks separates internal and external links.
type PageLinks struct {
    Internal []LinkInfo `json:"internal"`
    External []LinkInfo `json:"external"`
}

// CrawlResult is the complete output of a crawl operation.
type CrawlResult struct {
    CrawlMetadata CrawlMetadata `json:"crawl_metadata"`
    Pages         []PageResult  `json:"pages"`
    SiteStructure SiteStructure `json:"site_structure"`
}

// CrawlMetadata contains crawl-level statistics.
type CrawlMetadata struct {
    StartURL        string    `json:"start_url"`
    TotalPages      int       `json:"total_pages"`
    CrawlDurationMs int64     `json:"crawl_duration_ms"`
    PagesViaHTTP    int       `json:"pages_via_http"`
    PagesViaBrowser int       `json:"pages_via_browser"`
    Timestamp       time.Time `json:"timestamp"`
}

// SiteStructure contains aggregate site-level statistics.
type SiteStructure struct {
    TotalInternalLinks     int            `json:"total_internal_links"`
    TotalExternalLinks     int            `json:"total_external_links"`
    TotalForms             int            `json:"total_forms"`
    TotalInteractiveElems  int            `json:"total_interactive_elements"`
    PageDepthDistribution  map[int]int    `json:"page_depth_distribution"`
}
```

### 4.5 Fetcher Interface (`pkg/fetcher/fetcher.go`)

```go
package fetcher

import (
    "context"
    "net/http"
    "time"
)

// FetchResult contains the raw output of a page fetch.
type FetchResult struct {
    StatusCode  int           `json:"status_code"`
    Body        []byte        `json:"-"`
    Headers     http.Header   `json:"-"`
    FinalURL    string        `json:"final_url"`    // After redirects
    Duration    time.Duration `json:"duration"`
    RenderedVia string        `json:"rendered_via"`  // "http" or "browser"
    ContentType string        `json:"content_type"`
}

// Fetcher fetches a web page and returns its raw content.
// Implementations include HTTPFetcher (fast path) and BrowserFetcher (CDP path).
type Fetcher interface {
    // Fetch retrieves the page at the given URL.
    // The context controls timeout and cancellation.
    Fetch(ctx context.Context, url string) (*FetchResult, error)

    // Close releases any resources held by the fetcher.
    Close() error
}
```

### 4.6 Extractor Interface (`pkg/extractor/extractor.go`)

```go
package extractor

import (
    "github.com/PuerkitoBio/goquery"
    "github.com/anthropic/crawly/pkg/types"
)

// ExtractionResult holds the cleaned content from an extraction.
type ExtractionResult struct {
    CleanHTML    string            // Cleaned HTML (boilerplate removed)
    TextContent  string            // Plain text content
    TextLength   int               // Length of text content
    ExtractorUsed types.ExtractorType // Which extractor produced this result
}

// Extractor removes boilerplate and extracts main content from HTML.
// Implementations include ReadabilityExtractor and DensityExtractor.
type Extractor interface {
    // Extract takes a parsed document and returns the main content.
    Extract(doc *goquery.Document, pageURL string) (*ExtractionResult, error)
}

// ExtractContent is the top-level adaptive routing function. It takes raw HTML
// body bytes, parses to *goquery.Document internally, then selects the best
// extractor based on page type and runs extraction with fallback.
func ExtractContent(
    body []byte,
    pageURL string,
    pageType types.PageType,
) (*ExtractionResult, error) {
    // 1. Parse body to *goquery.Document
    // 2. Route based on page type:
    //    article/blog/docs -> readability first, density fallback
    //    app/dashboard     -> density with keepForms=true
    //    auth              -> full extractor (no pruning, keeps entire DOM)
    //    unknown           -> readability first, density fallback
    return nil, nil // Implementation placeholder
}
```

### 4.7 Output Writer Interface (`pkg/output/writer.go`)

```go
package output

import (
    "io"
    "github.com/anthropic/crawly/pkg/types"
)

// OutputWriter writes crawl results in a specific format.
type OutputWriter interface {
    // WriteResult writes a single page result.
    // For streaming formats (JSONL), this writes immediately.
    // For buffered formats (JSON), this accumulates results.
    WriteResult(result types.PageResult) error

    // Finalize writes any final output (metadata, closing brackets).
    // Must be called after all WriteResult calls.
    Finalize(meta types.CrawlMetadata, structure types.SiteStructure) error

    // Close releases resources.
    Close() error
}

// NewOutputWriter creates an OutputWriter for the given format.
func NewOutputWriter(format types.OutputFormat, w io.Writer) OutputWriter {
    switch format {
    case types.OutputJSONL:
        return NewJSONLWriter(w)
    case types.OutputMarkdown:
        return NewMarkdownWriter(w)
    default:
        return NewJSONWriter(w)
    }
}
```

---

## 5. Testing Strategy

### 5.1 Unit Tests

Every `*.go` file has a corresponding `*_test.go`. Focus areas:

| Package | What to test | Test approach |
|---|---|---|
| `types/` | Config validation, default values | Table-driven tests |
| `normalize/url` | URL canonicalization edge cases | Table-driven: trailing slashes, fragments, query sort, encoding |
| `normalize/dom` | DOM normalization determinism | Compare input/output HTML strings |
| `normalize/simhash` | Fingerprint stability, near-duplicate detection | Hash same content -> same hash, similar -> low distance, different -> high distance |
| `fetcher/http` | HTTP fetch with tuned transport | `httptest.NewServer` returning fixture HTML |
| `detector/spa` | SPA detection accuracy | Fixture HTML files for React/Vue/Angular/static pages |
| `detector/pagetype` | Page type classification | URL patterns + fixture HTML |
| `extractor/readability` | Article extraction quality | Fixture articles, compare extracted text to expected |
| `extractor/density` | App page extraction, form preservation | Fixture dashboard/app HTML |
| `extractor/structural` | Form/heading/link/button extraction | Fixture HTML with known elements, verify counts and values |
| `extractor/meta` | Meta tag extraction | Fixture HTML with various meta tags, OG, JSON-LD |
| `markdown/converter` | HTML-to-markdown quality | Golden file tests: input HTML -> expected markdown |
| `markdown/citations` | Citation link conversion | Input markdown with links -> expected citation format |
| `crawler/queue` | Queue push/pop/backpressure/close | Concurrent push/pop, verify ordering |
| `crawler/dedup` | Dedup correctness + thread safety | Concurrent MarkVisited from multiple goroutines |
| `crawler/scope` | Scope validation | In-scope/out-scope URLs, include/exclude patterns |
| `crawler/engine` | Full crawl pipeline | Mock HTTP server with multi-page site |
| `output/*` | Output format correctness | Compare output bytes to expected |

### 5.2 Integration Tests

Located in `pkg/crawler/engine_test.go` with build tag `//go:build integration`:

1. **Local multi-page crawl**: `httptest.Server` serving 10+ linked HTML pages, verify all pages discovered via BFS, correct depth tracking, scope enforcement.
2. **SPA detection integration**: Serve static HTML and SPA HTML, verify correct renderer selection.
3. **End-to-end JSON output**: Crawl test server, verify output JSON matches expected schema.
4. **Resume from checkpoint**: Crawl 5 pages, interrupt, resume, verify all 10 pages eventually crawled.

### 5.3 Benchmark Tests

Located alongside unit tests with `Benchmark` prefix:

```go
// pkg/normalize/url_test.go
func BenchmarkNormalizeURL(b *testing.B) { ... }

// pkg/normalize/simhash_test.go
func BenchmarkFingerprint(b *testing.B) { ... }

// pkg/extractor/structural_test.go
func BenchmarkExtractStructural(b *testing.B) { ... }

// pkg/extractor/meta_test.go
func BenchmarkExtractMeta_Tokenizer(b *testing.B) { ... }
func BenchmarkExtractMeta_Goquery(b *testing.B)   { ... } // Compare approaches

// pkg/markdown/converter_test.go
func BenchmarkConvert(b *testing.B) { ... }

// pkg/crawler/dedup_test.go
func BenchmarkDedup_SyncMap(b *testing.B) { ... }
func BenchmarkDedup_Bloom(b *testing.B)   { ... }
```

Key metrics to track: `allocs/op`, `B/op`, `ns/op`. Use `benchstat` for before/after comparison.

### 5.4 Test Fixtures

Create from scratch (do NOT copy copyrighted HTML). Each fixture is a minimal but realistic HTML page:

- `testdata/fixtures/static_page.html` -- ~100 lines: article with headings, paragraphs, images, nav, footer, sidebar, 2 forms
- `testdata/fixtures/spa_react.html` -- ~30 lines: empty `<div id="root">`, React bundle script, minimal body text
- `testdata/fixtures/spa_next.html` -- ~50 lines: SSR content with `__NEXT_DATA__` script, hydration markers
- `testdata/fixtures/spa_vue.html` -- ~30 lines: empty `<div id="app">`, Vue bundle, `__NUXT__`
- `testdata/fixtures/login_page.html` -- ~60 lines: login form with email/password, "Sign in with Google" button, CSRF token
- `testdata/fixtures/dashboard_page.html` -- ~120 lines: nav, data table, search form, action buttons, stats cards
- `testdata/fixtures/docs_page.html` -- ~80 lines: sidebar nav, breadcrumbs, h1-h4 headings, code blocks
- `testdata/fixtures/blog_article.html` -- ~100 lines: article tag, author byline, content, related links
- `testdata/fixtures/near_duplicate_a.html` -- ~40 lines: page with session-varying content
- `testdata/fixtures/near_duplicate_b.html` -- ~40 lines: same structure as A, different session tokens
- `testdata/fixtures/complex_forms.html` -- ~80 lines: search form, filter form, file upload, select dropdowns

### 5.5 Goroutine Leak Detection

Every package's `TestMain` uses goleak:

```go
func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}
```

---

## 6. Makefile Targets

```makefile
# crawly Makefile

BINARY := crawly
MODULE := github.com/anthropic/crawly
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
DATE := $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")
LDFLAGS := -ldflags="-s -w -X main.version=$(VERSION) -X main.commit=$(COMMIT) -X main.date=$(DATE)"
GOFLAGS := -trimpath

.PHONY: all build build-headless test bench lint release docker pgo-collect pgo-build clean

## build: Build HTTP-only binary (no browser dependency)
build:
	go build $(GOFLAGS) $(LDFLAGS) -o bin/$(BINARY) ./cmd/crawly

## build-headless: Build with browser support (requires go-rod)
build-headless:
	go build $(GOFLAGS) $(LDFLAGS) -tags headless -o bin/$(BINARY) ./cmd/crawly

## test: Run all unit tests with race detector
test:
	go test -race -count=1 -timeout 120s ./...

## test-headless: Run all tests including browser integration tests
test-headless:
	go test -race -count=1 -tags headless -timeout 300s ./...

## test-integration: Run integration tests only
test-integration:
	go test -race -count=1 -tags integration -timeout 300s ./pkg/crawler/...

## bench: Run all benchmarks
bench:
	go test -bench=. -benchmem -count=5 -timeout 300s ./... | tee bench.txt

## bench-compare: Compare benchmarks (requires benchstat)
bench-compare:
	@echo "Run 'make bench' on old code, save to old.txt"
	@echo "Run 'make bench' on new code, save to new.txt"
	@echo "Then: benchstat old.txt new.txt"

## lint: Run golangci-lint
lint:
	golangci-lint run ./...

## fmt: Format code
fmt:
	gofmt -s -w .
	goimports -w .

## vet: Run go vet
vet:
	go vet ./...

## escape: Show escape analysis (heap allocation decisions)
escape:
	go build -gcflags="-m" ./... 2>&1 | grep "escapes to heap"

## release: Build release binaries for all platforms
release:
	goreleaser release --snapshot --clean

## docker: Build Docker image
docker:
	docker build -t crawly:$(VERSION) .

## docker-run: Run Docker container
docker-run:
	docker run --rm -it crawly:$(VERSION) $(ARGS)

## pgo-collect: Collect CPU profile for PGO (run a representative crawl)
pgo-collect:
	@echo "Start the binary with --pprof, then:"
	@echo "  curl http://localhost:6060/debug/pprof/profile?seconds=60 > cmd/crawly/default.pgo"
	@echo "Then run 'make pgo-build'"

## pgo-build: Build with PGO profile
pgo-build:
	@test -f cmd/crawly/default.pgo || (echo "No PGO profile found. Run 'make pgo-collect' first." && exit 1)
	go build $(GOFLAGS) $(LDFLAGS) -tags headless -o bin/$(BINARY) ./cmd/crawly

## deps: Download and verify dependencies
deps:
	go mod download
	go mod verify

## tidy: Tidy go.mod
tidy:
	go mod tidy

## clean: Remove build artifacts
clean:
	rm -rf bin/ dist/ bench.txt cpu.prof mem.prof trace.out

## cover: Generate test coverage report
cover:
	go test -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html
	@echo "Open coverage.html in browser"

## help: Show this help
help:
	@grep -E '^## ' Makefile | sed 's/## //' | column -t -s ':'
```

---

## 7. Docker Strategy

Multi-stage Dockerfile for minimal image:

```dockerfile
# Stage 1: Build
FROM golang:1.22-alpine AS builder

RUN apk add --no-cache git ca-certificates tzdata

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Build with headless support and all optimizations
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath \
    -ldflags="-s -w -X main.version=$(cat VERSION 2>/dev/null || echo dev)" \
    -tags headless \
    -o /bin/crawly \
    ./cmd/crawly

# Stage 2: Runtime
FROM alpine:3.19

# Install Chromium for browser rendering support
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    tzdata \
    && rm -rf /var/cache/apk/*

# Set Chrome path for crawly auto-detection
ENV CHROME_PATH=/usr/bin/chromium-browser
# Recommended GC tuning for container
ENV GOGC=200
ENV GOMEMLIMIT=850MiB

COPY --from=builder /bin/crawly /usr/local/bin/crawly

# Non-root user for security
RUN adduser -D -u 1000 crawler
USER crawler

ENTRYPOINT ["crawly"]
CMD ["--help"]
```

**Image size estimate:** ~150MB (Alpine ~5MB + Chromium ~130MB + Go binary ~20MB)

**HTTP-only variant** (no Chromium, ~25MB) — built WITHOUT `-tags headless` so go-rod is not compiled in:

```dockerfile
# Stage 1: Build (HTTP-only — no headless tag)
FROM golang:1.22-alpine AS builder
RUN apk add --no-cache git ca-certificates tzdata
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath \
    -ldflags="-s -w -X main.version=$(cat VERSION 2>/dev/null || echo dev)" \
    -o /bin/crawly \
    ./cmd/crawly

# Stage 2: Runtime
FROM alpine:3.19
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /bin/crawly /usr/local/bin/crawly
RUN adduser -D -u 1000 crawler
USER crawler
ENTRYPOINT ["crawly"]
```

---

## 8. CI/CD Pipeline

### `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        go-version: ['1.22', '1.23']
    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: ${{ matrix.go-version }}
          cache: true

      - name: Download dependencies
        run: go mod download

      - name: Vet
        run: go vet ./...

      - name: Test (HTTP-only)
        run: go test -race -count=1 -timeout 120s -coverprofile=coverage.out ./...

      - name: Test (with headless)
        run: |
          sudo apt-get update && sudo apt-get install -y chromium-browser
          go test -race -count=1 -tags headless -timeout 300s ./...

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          file: coverage.out

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.23'
          cache: true

      - name: golangci-lint
        uses: golangci/golangci-lint-action@v4
        with:
          version: latest

  build:
    runs-on: ubuntu-latest
    needs: [test, lint]
    strategy:
      matrix:
        goos: [linux, darwin, windows]
        goarch: [amd64, arm64]
        exclude:
          - goos: windows
            goarch: arm64
    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.23'
          cache: true

      - name: Build
        env:
          GOOS: ${{ matrix.goos }}
          GOARCH: ${{ matrix.goarch }}
          CGO_ENABLED: '0'
        run: |
          go build -trimpath -ldflags="-s -w" -tags headless \
            -o bin/crawly-${{ matrix.goos }}-${{ matrix.goarch }} \
            ./cmd/crawly

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: crawly-${{ matrix.goos }}-${{ matrix.goarch }}
          path: bin/

  bench:
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.23'
          cache: true

      - name: Benchmarks
        run: go test -bench=. -benchmem -count=5 -timeout 300s ./... | tee bench.txt

      - name: Upload benchmark results
        uses: actions/upload-artifact@v4
        with:
          name: benchmarks
          path: bench.txt
```

### `.github/workflows/release.yml`

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write
  packages: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.23'
          cache: true

      - name: Run GoReleaser
        uses: goreleaser/goreleaser-action@v5
        with:
          distribution: goreleaser
          version: latest
          args: release --clean
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  docker:
    runs-on: ubuntu-latest
    needs: release
    steps:
      - uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push Docker image
        uses: docker/build-push-action@v5
        with:
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:${{ github.ref_name }}
            ghcr.io/${{ github.repository }}:latest
```

---

## 9. How to Use References While Coding

### Phase 1: Foundation -- Before You Start

Read these files completely to internalize the patterns:

**URL normalization:**
```
references/katana/pkg/engine/headless/crawler/normalizer/normalizer.go  (Apply method, normalizeDocument)
references/katana/pkg/engine/headless/crawler/normalizer/text_utils.go  (text normalization regexes)
```

**SimHash:**
```
references/katana/pkg/engine/headless/crawler/normalizer/simhash/simhash.go  (entire file, ~200 LOC)
```

**Performance patterns to apply immediately:**
- Read `tasks/go-performance-guide.md` sections 1, 3, 4, 5, 20 before writing ANY code

### Phase 2: Fetching -- Before You Start

**HTTP fetcher patterns:**
```
references/colly/http_backend.go              (LimitRule, Transport config, cookie jar)
references/katana/pkg/engine/common/http.go   (BuildHttpClient function)
references/katana/pkg/engine/standard/crawl.go (HTTP-only crawl flow)
```

**Browser fetcher patterns:**
```
references/katana/pkg/engine/headless/browser/browser.go  (entire file: Launcher, BrowserPage, WaitPageLoadHeurisitics, pool get/put, headlessFlags, dialog handling, stealth)
references/katana/pkg/engine/headless/crawler/crawler.go  (headless crawl orchestration)
references/katana/pkg/engine/hybrid/hijack.go             (request interception for cookie consent)
```

**To find specific patterns in katana headless code:**
```bash
# Find page-ready heuristics
grep -rn "WaitPageLoad\|WaitIdle\|WaitStable\|WaitDOMStable" references/katana/

# Find browser pool patterns
grep -rn "GetPageFromPool\|PutBrowserToPool\|browserPool" references/katana/

# Find stealth/evasion patterns
grep -rn "stealth\|EvalOnNewDocument" references/katana/
```

### Phase 3: Extraction -- Before You Start

**Readability algorithm (THE reference):**
```
references/readability/Readability.js  (entire ~2000 LOC file -- understand scoring formula, unlikely candidates, link density)
references/go-readability/readability.go  (Go API: FromReader, FromDocument, Check)
references/go-readability/parser.go       (Parser struct, Article struct, scoring implementation)
```

**Density-based extraction:**
```
references/crawl4ai/crawl4ai/content_filter_strategy.py  (PruningContentFilter class)
```

**Markdown generation + citations:**
```
references/html-to-markdown/converter/converter.go  (Converter struct, NewConverter, plugin registration)
references/html-to-markdown/plugin/commonmark/       (all files: heading, link, list, code, image renderers)
references/html-to-markdown/plugin/table/             (table rendering)
references/crawl4ai/crawl4ai/markdown_generation_strategy.py  (DefaultMarkdownGenerator, citation references)
references/reader/src/utils/markdown.ts               (markdown utilities, link citations)
```

**Form extraction:**
```
references/katana/pkg/utils/formfill.go       (FormInput, FormSelect, FormTextArea structs)
references/katana/pkg/utils/formfields.go     (field extraction logic)
references/katana/pkg/engine/headless/crawler/formfill.go  (form filling in headless)
```

**To find extraction patterns:**
```bash
# Find readability scoring in Go
grep -rn "ContentScore\|textLength\|linkDensity" references/go-readability/

# Find form extraction
grep -rn "FormInput\|FormSelect\|form.*action" references/katana/pkg/utils/

# Find markdown citation pattern
grep -rn "citation\|footnote\|\[.*\]\[.*\]" references/crawl4ai/ references/reader/

# Find page type detection
grep -rn "pageType\|page_type\|detectType\|classify" references/reader/ references/crawl4ai/
```

### Phase 4: Engine Assembly -- Before You Start

**Crawl engine patterns:**
```
references/katana/pkg/engine/common/base.go   (Do method: the main crawl loop, queue pop, concurrent workers, output)
references/katana/pkg/engine/engine.go         (Engine interface: Crawl + Close)
references/colly/queue/queue.go                (queue + worker goroutine pattern)
references/colly/colly.go                      (Collector: central orchestration of callbacks)
```

**BFS queue:**
```
references/katana/pkg/utils/queue/queue.go     (Queue interface)
references/katana/pkg/utils/queue/strategy.go  (BFS/DFS strategy selection)
```

**Scope control:**
```
references/katana/pkg/utils/scope/scope.go     (scope validation with regex)
references/katana/pkg/engine/common/base.go    (ValidateScope, Enqueue with depth/uniqueness/scope checks)
```

**To find engine wiring patterns:**
```bash
# Find how katana wires everything together
grep -rn "NewCrawlSession\|CrawlerOptions\|ScopeManager" references/katana/

# Find Colly's limit/delay pattern
grep -rn "LimitRule\|waitChan\|Parallelism" references/colly/

# Find spider-rs concurrency patterns
grep -rn "semaphore\|concurrency\|spawn" references/spider/
```

### Phase 5: Polish -- Before You Start

**Output formatting:**
```
references/katana/pkg/output/format_json.go    (JSON output)
references/katana/pkg/output/result.go         (Result struct)
```

**Server mode:**
```
references/reader/src/api/crawler.ts           (HTTP API endpoint for crawling)
references/reader/src/stand-alone/crawl.ts     (standalone mode)
```

**Diagnostics:**
```
references/katana/pkg/engine/headless/debugger.go  (live crawl debugger endpoint)
```

**To find specific patterns:**
```bash
# Find JSON output formatting
grep -rn "json.NewEncoder\|json.Marshal\|json.Encode" references/katana/pkg/output/

# Find streaming output
grep -rn "JSONL\|jsonl\|ndjson\|newline.*delimited" references/

# Find HTTP server patterns
grep -rn "ListenAndServe\|http.Server\|handler" references/reader/src/api/
```

### Quick Reference: Pattern Lookup Table

| Need | Where to look |
|---|---|
| HTTP transport tuning | `tasks/go-performance-guide.md` SS1 |
| Goroutine pool | `tasks/go-performance-guide.md` SS2 |
| sync.Pool buffers | `tasks/go-performance-guide.md` SS3, `references/katana/.../simhash/simhash.go` lines 28-32 |
| Pre-allocate slices | `tasks/go-performance-guide.md` SS4 |
| URL dedup (sync.Map) | `tasks/go-performance-guide.md` SS5 |
| BFS channel pipeline | `tasks/go-performance-guide.md` SS6 |
| Context cascading | `tasks/go-performance-guide.md` SS7 |
| GOGC/GOMEMLIMIT | `tasks/go-performance-guide.md` SS8 |
| Build tags | `tasks/go-performance-guide.md` SS9 |
| PGO | `tasks/go-performance-guide.md` SS10 |
| JSONL streaming | `tasks/go-performance-guide.md` SS11 |
| Graceful shutdown | `tasks/go-performance-guide.md` SS12 |
| Error resilience | `tasks/go-performance-guide.md` SS13 |
| Benchmarking | `tasks/go-performance-guide.md` SS14 |
| Project structure | `tasks/go-performance-guide.md` SS15 |
| errgroup + semaphore | `tasks/go-performance-guide.md` SS16 |
| Per-domain limiter | `tasks/go-performance-guide.md` SS17, `references/colly/http_backend.go` |
| HTML tokenizer | `tasks/go-performance-guide.md` SS18 |
| Compiled selectors | `tasks/go-performance-guide.md` SS19 |
| URL canonicalization | `tasks/go-performance-guide.md` SS20 |
| Bloom filter | `tasks/go-performance-guide.md` SS21 |
| State checkpointing | `tasks/go-performance-guide.md` SS22 |
| DNS caching | `tasks/go-performance-guide.md` SS23 |
| Goroutine leak detection | `tasks/go-performance-guide.md` SS24 |
| Browser pool pattern | `references/katana/pkg/engine/headless/browser/browser.go` |
| Page-ready heuristics | `references/katana/pkg/engine/headless/browser/browser.go` lines 191-268 |
| SimHash + Oracle | `references/katana/.../simhash/simhash.go` (entire file) |
| DOM normalization | `references/katana/.../normalizer/normalizer.go` |
| Form extraction structs | `references/katana/pkg/utils/formfill.go` |
| Scope validation | `references/katana/pkg/utils/scope/scope.go` |
| Queue + worker pattern | `references/colly/queue/queue.go` |
| Readability algorithm | `references/readability/Readability.js` |
| go-readability API | `references/go-readability/readability.go` + `parser.go` |
| Density pruning | `references/crawl4ai/crawl4ai/content_filter_strategy.py` |
| Markdown generation | `references/html-to-markdown/converter/converter.go` |
| Citation links | `references/crawl4ai/crawl4ai/markdown_generation_strategy.py` |
| Extraction pipeline | `references/reader/src/api/crawler.ts` |
| Feature-gating pattern | `references/spider/Cargo.toml` (translate to Go build tags) |

---

## End of Blueprint

This document covers every file, interface, struct, build target, and reference needed. Follow the build order strictly. Test each sub-phase before moving to the next. Refer to the interface contracts (Section 4) as the source of truth for cross-package compatibility.
