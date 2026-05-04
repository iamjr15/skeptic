# crawly: Fix Plan

All gaps identified by the triple audit (architecture plan, performance guide, development blueprint).
Ordered by severity. Each fix includes exact file, line, code change, AND cross-references to all three planning documents and reference repos.

## Planning Documents

| Doc | Path | Abbreviation |
|---|---|---|
| Architecture Plan | `/Users/iamjr15/Desktop/skeptic/tasks/crawly-plan.md` | **PLAN** |
| Go Performance Guide | `/Users/iamjr15/Desktop/skeptic/tasks/go-performance-guide.md` | **PERF** |
| Development Blueprint | `/Users/iamjr15/Desktop/skeptic/tasks/development-blueprint.md` | **BLUEPRINT** |

## Reference Repos (at `crawly/references/`)

| Repo | Path | What |
|---|---|---|
| katana | `references/katana/` | Go crawler — engine, browser pool, SimHash, DOM normalization |
| colly | `references/colly/` | Go crawler — queue workers, HTTP backend, per-domain limiters |
| html-to-markdown | `references/html-to-markdown/` | Go HTML→MD converter |
| go-readability | `references/go-readability/` | Go Readability port |
| html2md | `references/html2md/` | Lightweight Go readability+markdown |
| reader | `references/reader/` | Jina Reader — extraction pipeline |
| readability | `references/readability/` | Mozilla Readability — original algorithm |
| crawl4ai | `references/crawl4ai/` | Python — markdown generation, content filtering |
| spider | `references/spider/` | Rust — concurrency, feature-gating |
| spider_transformations | `references/spider_transformations/` | Rust HTML→MD transforms |

---

## 🔴 CRITICAL (2 fixes — blocks all CLI usage)

### C1: Wire real HTTPFetcher into CLI

**File to change:** `cmd/crawly/crawl.go` lines 78-81, 174-181
**Problem:** CLI must create real fetchers with proper RenderMode-aware initialization and cleanup

**Plan references:**
- **PLAN** lines 598-624: CLI Usage Design — expects `crawly crawl https://app.example.com` to actually fetch pages
- **PLAN** lines 696-700: "Two-tier rendering over always-browser" design decision — engine should use HTTP first
- **BLUEPRINT** Section 2.12 (`cmd/crawly/crawl.go`): "Creates CrawlEngine, calls engine.Crawl() to get channel" — no mention of stub
- **BLUEPRINT** Section 3, Phase 5C, Step 39: `crawl.go` — "Maps CLI flags to CrawlConfig, creates CrawlEngine"
- **PERF** §1: HTTP Transport tuning — all the tuning in `http.go` is useless if the CLI never creates an HTTPFetcher

**Reference repos to study:**
- `references/katana/cmd/katana/main.go` — how Katana wires its crawler engine in the CLI
- `references/colly/collector.go` — how Colly creates its HTTP backend in the Collector constructor

**Fix:** Create real fetchers with RenderMode-aware initialization and proper cleanup.

```go
// Create real fetchers.
httpF := fetcher.NewHTTPFetcher(&cfg)
defer httpF.Close()

var browserF fetcher.Fetcher
if cfg.RenderMode != types.RenderNever {
    bf, bErr := fetcher.NewBrowserFetcher(&cfg)
    if bErr != nil {
        if errors.Is(bErr, fetcher.ErrNoBrowser) {
            if cfg.Verbose {
                fmt.Fprintf(os.Stderr, "browser unavailable: %v\n", bErr)
            }
            if cfg.RenderMode == types.RenderAlways {
                return fmt.Errorf("--render always requires browser: %w", bErr)
            }
        } else {
            if cfg.RenderMode == types.RenderAlways {
                return fmt.Errorf("browser init failed: %w", bErr)
            }
            fmt.Fprintf(os.Stderr, "WARN: browser init failed, falling back to HTTP-only: %v\n", bErr)
        }
    } else {
        browserF = bf
    }
}
if browserF != nil {
    defer browserF.Close()
}
```
**Important:** This checks `RenderMode` before attempting browser init (skips entirely for `RenderNever`). For `ErrNoBrowser`, it fails hard on `RenderAlways` and degrades silently on `RenderAuto`. For real browser errors, it fails hard on `RenderAlways` and warns+degrades on `RenderAuto`. Both CLI and server factory use this pattern.

Server path: handler.go creates fetchers per-request via FetcherFactory (line 83). Cleanup must be in the handler after the crawl completes, NOT in serve.go. The factory returns both fetchers; handler defers `httpF.Close()` and nil-guarded `if browserF != nil { defer browserF.Close() }` after the factory call. The factory itself handles `--render always` validation, returning an error if browser is required but unavailable.

Also in serve.go, the factory at lines 37-66:
```go
factory := func(cfg *types.CrawlConfig) (fetcher.Fetcher, fetcher.Fetcher, error) {
    httpF := fetcher.NewHTTPFetcher(cfg)

    var browserF fetcher.Fetcher
    if cfg.RenderMode != types.RenderNever {
        bf, bErr := fetcher.NewBrowserFetcher(cfg)
        if bErr != nil {
            if errors.Is(bErr, fetcher.ErrNoBrowser) {
                // RenderAlways requires browser — fail hard.
                if cfg.RenderMode == types.RenderAlways {
                    httpF.Close()
                    return nil, nil, fmt.Errorf("render mode 'always' requires browser: %w", bErr)
                }
                // RenderAuto: degrade to HTTP-only silently.
            } else {
                // Real error (Chrome crash, pool failure).
                if cfg.RenderMode == types.RenderAlways {
                    httpF.Close()
                    return nil, nil, fmt.Errorf("browser init failed: %w", bErr)
                }
                fmt.Fprintf(os.Stderr, "WARN: browser init failed, falling back to HTTP-only: %v\n", bErr)
            }
        } else {
            browserF = bf
        }
    }
    // RenderNever: skip browser init entirely.

    return httpF, browserF, nil
}
```

The crawl.go code above includes `defer httpF.Close()` immediately after creation and `if browserF != nil { defer browserF.Close() }` after the init block. The engine's Wait() doesn't close fetchers — only Shutdown() does (line 428). Without explicit close, browser pools and HTTP clients leak on successful requests.

**Test:** `go build ./cmd/crawly && ./crawly crawl https://example.com --max-pages 1 --render never --output json`

---

### C2: Fix browser stub to return nil (fail fast)

**File to change:** `pkg/fetcher/browser_stub.go` line 21-23
**Problem:** Stub returns `(*BrowserFetcher{}, nil)` — non-nil interface value. Engine checks `e.browserFetcher != nil` to decide if browser is available, so stub makes it always true, leading to unnecessary browser fetch attempts that always fail.

**Plan references:**
- **PLAN** lines 516-528: "Graceful degradation via build tags — headless support gated behind `//go:build headless`"
- **PLAN** line 712: "System Chrome over bundled Chromium — HTTP-only mode works with zero browser dependency"
- **BLUEPRINT** Section 2.5 (`pkg/fetcher/browser_stub.go`): "Provides a stub BrowserFetcher that returns ErrNoBrowser"
- **PERF** §9: Build tags for feature gating — stub must be transparent to callers

**Reference repos:**
- `references/katana/pkg/engine/headless/browser/browser.go` — Katana's browser launcher returns error when Chrome not found (fail fast pattern)

**Fix:**
```go
// CHANGE FROM:
func NewBrowserFetcher(_ *types.CrawlConfig) (*BrowserFetcher, error) {
    return &BrowserFetcher{}, nil
}

// TO:
func NewBrowserFetcher(_ *types.CrawlConfig, _ ...BrowserFetcherOption) (*BrowserFetcher, error) {
    return nil, ErrNoBrowser
}
```

The `BrowserFetcherOption` type AND the `browserFetcherConfig` struct must both be defined in a file that compiles under BOTH build tags (not in `browser.go` which is headless-only). Define them in `fetcher.go` (the interface file, which has no build tag). The config struct can be minimal — it just holds policy options:
```go
// In pkg/fetcher/fetcher.go (no build tag):
type browserFetcherConfig struct {
    PolicyOptions []security.PolicyOption
}
type BrowserFetcherOption func(*browserFetcherConfig)
func WithPolicyOptions(opts ...security.PolicyOption) BrowserFetcherOption {
    return func(c *browserFetcherConfig) { c.PolicyOptions = opts }
}
```
Both `browser.go` and `browser_stub.go` constructors accept `...BrowserFetcherOption`. This is critical: if `browserFetcherConfig` is defined only in a tagged file, the other build variant won't compile.

The CLI from C1 naturally handles it: `browserF` becomes nil, engine runs HTTP-only.

Also add validation in crawl.go: if `cfg.RenderMode == types.RenderAlways && browserF == nil`, return error `'browser rendering required but no browser available — build with -tags headless and install Chrome'`. This makes `--render always` fail fast instead of silently falling back to HTTP.

---

## 🟡 HIGH (5 fixes)

### H1: ~~Wire tag lowercase into SimHash fingerprinting~~ RESOLVED — NOT A BUG

**Status:** RESOLVED — NOT A BUG

**Explanation:** SimHash's Fingerprint() uses html.Tokenizer which already returns `t.DataAtom.String()` (lowercase atoms). Tag case is normalized by the tokenizer itself. Lowercasing the entire input would also lowercase TEXT CONTENT and attribute values, increasing false positives. The DOM normalization plan step 8 (lowercase tags) is already handled implicitly by the tokenizer. No code change needed.

---

### H2: ~~Add framework-specific hydration readiness hooks (Phase 4 of page-ready)~~ DEFERRED TO PHASE 6

**Status:** DEFERRED TO PHASE 6. Requires adding EnableFrameworkReadiness field to CrawlConfig + DefaultConfig() + CLI flag wiring + server request mapping. Given that the current 3-phase approach (WaitLoad + WaitIdle + stabilization) already covers 90%+ of pages, this is not worth the complexity for v1. Defer to Phase 6 alongside other framework-aware enhancements.

---

### H3: Add goleak for goroutine leak detection

**Files to change:** `go.mod` + new files in `pkg/crawler/`, `pkg/fetcher/`, `pkg/server/`
**Problem:** No goroutine leak detection. Goroutine leaks could accumulate under sustained crawling.

**Plan references:**
- **PERF** §24: "Goroutine Leak Detection in Tests — `goleak.VerifyTestMain(m)`"
- **PERF** §25: Technology stack — lists `go.uber.org/goleak` as required dependency
- **BLUEPRINT** Section 5.1: Testing Strategy — "Goroutine leak detection: goleak.VerifyTestMain in engine and fetcher tests"

**Fix 1:** `go get go.uber.org/goleak`

**Fix 2:** Create `pkg/crawler/leak_test.go`:
```go
package crawler

import (
    "testing"
    "go.uber.org/goleak"
)

func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}
```

**Fix 3:** Same pattern in `pkg/fetcher/leak_test.go` and `pkg/server/leak_test.go`

> **Note:** `browser.go:93` starts a long-lived `go page.EachEvent(...)` goroutine for dialog handling. goleak will flag this. Add `goleak.IgnoreTopFunction("github.com/go-rod/rod.(*Page).EachEvent...")` or refactor to stop the event listener on page release.

---

### H4: Add headless test job to CI

**File to change:** `.github/workflows/ci.yml`
**Problem:** CI only tests HTTP-only build. Browser integration never tested in CI.

**Plan references:**
- **BLUEPRINT** Section 8, lines 1518-1521: "Test (headless) step — installs chromium-browser, runs with headless tag"
- **PERF** §9: Build tags — must test both build tag variants

**Fix:** Add new job after `test`:
```yaml
  test-headless:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.23'
          cache: true
      - name: Install Chromium
        run: sudo apt-get update && sudo apt-get install -y chromium-browser
      - name: Download dependencies
        run: go mod download
      - name: Test (with browser)
        env:
          CHROME_PATH: /usr/bin/chromium-browser
        run: go test -tags headless -race -count=1 -timeout 180s ./pkg/fetcher/... ./pkg/crawler/... ./cmd/crawly/...
```

> **Note:** Before headless tests can pass, `browser_test.go` needs a loopback bypass similar to HTTPFetcher's `WithUnsafeLocalFetch`. Add `AllowLoopback` policy option to `BrowserFetcher` constructor for testing.
>
> **Concrete change:** `browser_test.go` must create BrowserFetcher with AllowLoopback: `bf, _ := NewBrowserFetcher(&cfg, WithPolicyOptions(security.AllowLoopback()))`.
>
> **Note:** Expand test scope to also cover `./pkg/crawler/...` and `./cmd/crawly/...` (not just fetcher).

---

### H5: Add GHCR Docker push to release workflow

**File to change:** `.github/workflows/release.yml`
**Problem:** Release workflow does goreleaser but doesn't push Docker image to GHCR. Missing `packages: write` permission.

**Plan references:**
- **BLUEPRINT** Section 8, lines 1638-1657: "Docker job — build and push to GHCR"
- **BLUEPRINT** Section 8, line 1612: "permissions: packages: write"
- **BLUEPRINT** Section 7: Docker Strategy — "Push to ghcr.io"

**Fix:** Add to `release.yml`:
```yaml
permissions:
  contents: write
  packages: write    # ADD

jobs:
  goreleaser:
    # ... existing unchanged ...

  docker:
    runs-on: ubuntu-latest
    needs: goreleaser
    steps:
      - uses: actions/checkout@v4
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Extract version
        id: version
        run: echo "VERSION=${GITHUB_REF#refs/tags/v}" >> $GITHUB_OUTPUT
      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:${{ steps.version.outputs.VERSION }}
            ghcr.io/${{ github.repository }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

---

## 🔵 MEDIUM (4 active fixes, 2 deferred — nice to have for v1)

### M1: Add browser request interception for SSRF on subrequests

**File to change:** `pkg/fetcher/browser.go` — add before `page.Navigate()` (before line 98)
**Problem:** Browser subrequests (JS-triggered fetch, XHR, CSS, images) bypass SSRF policy.

**Plan references:**
- **PLAN** line 105: "Cookie-consent blocking: Request interception to block cookie-consent popups that pollute DOM"
- **PLAN** line 332 (browser.go description): "Installs urlpolicy.WrapBrowserRequestInterceptor() via rod's HijackRequests"
- **BLUEPRINT** Section 2.5 (`browser.go`): "installs request interception callback"
- **BLUEPRINT** Section 2.4 (`urlpolicy.go`): "WrapBrowserRequestInterceptor() — a rod request interception callback"

**Reference repos:**
- `references/katana/pkg/engine/hybrid/hijack.go` — Katana's request interception for cookie consent blocking and request filtering
- `references/katana/pkg/engine/headless/crawler/crawler.go` — how Katana wires interception into the crawl flow

**Concrete API changes required:**
- Add to `pkg/security/urlpolicy.go`: `CheckURLResolved(rawURL string) error` — same as CheckURL but also resolves hostname to IP and validates the resolved IP against blocked ranges. This is the DNS-aware version.
- **Browser constructor signature (decided):** Use `BrowserFetcherOption` functional options pattern (matches HTTPFetcher's pattern). Constructor: `NewBrowserFetcher(cfg *types.CrawlConfig, opts ...BrowserFetcherOption)`. Option: `WithPolicyOptions(opts ...security.PolicyOption) BrowserFetcherOption`. This replaces the previous `...security.PolicyOption` direct parameter. Change `security.NewURLPolicy()` at line 43 to `security.NewURLPolicy(policyOpts...)` where `policyOpts` is extracted from the functional options. Update all call sites: browser.go constructor, browser_test.go, crawl.go.

**Fix:** Add in `browser.go` before `page.Navigate(url)`:
```go
// Install request interception for SSRF protection on subrequests.
// Set up once per page acquire; tear down on page release (avoid goroutine leak).
router := page.HijackRequests()
router.MustAdd("*", func(ctx *rod.Hijack) {
    reqURL := ctx.Request.URL().String()

    // Allowlist legitimate browser-internal schemes
    scheme := ctx.Request.URL().Scheme
    if scheme == "data" || scheme == "blob" || scheme == "javascript" {
        ctx.ContinueRequest(&proto.FetchContinueRequest{})
        return
    }

    // Resolve DNS and check the resolved IP (not just the hostname)
    if err := f.policy.CheckURLResolved(reqURL); err != nil {
        ctx.Response.Fail(proto.NetworkErrorReasonBlockedByClient)
        return
    }
    ctx.ContinueRequest(&proto.FetchContinueRequest{})
})
go router.Run()
// IMPORTANT: call router.Stop() when the page is released to avoid goroutine leak.
defer router.Stop()
```

> **Note:** This reduces SSRF risk via defense-in-depth (preflight URL check + subrequest interception), not a complete solution. Browser DNS rebinding remains a TOCTOU risk — `CheckURLResolved` validates before `Navigate` but Chrome re-resolves at connect time. Full closure would require Chrome proxy flags or network-level controls, which are out of scope for v1.
>
> Hijack router must be set up once per page acquire and torn down on release, not per-fetch. `CheckURLResolved` must resolve DNS and verify the resolved IP against SSRF blocklists (not just `CheckURL` on the raw hostname, which is vulnerable to DNS rebinding).
>
> **ALSO:** Replace `f.policy.CheckURL(url)` at browser.go:50 with `f.policy.CheckURLResolved(url)` for the initial navigation. This ensures DNS-aware SSRF protection on the main document request, not just subrequests.

**Security regression tests (required for M1):**

**Unified resolver seam for testability:** Add a `Resolver` interface to `pkg/security/urlpolicy.go` with `LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error)` method. The `Resolver` interface and `WithResolver` option are stored as a field on `URLPolicy`. BOTH `SafeDialContext` (used by HTTP fetcher) AND `CheckURLResolved` (used by browser fetcher) use `p.resolver.LookupIPAddr()` instead of `net.DefaultResolver.LookupIPAddr`. This ensures a single DNS resolution path across the entire policy, and tests can inject a mock for either code path.
```go
type URLPolicy struct {
    maxRedirects   int
    allowLoopback  bool
    allowPrivate   bool
    resolver       Resolver  // defaults to net.DefaultResolver wrapper
}
```
Default: `defaultResolver` wrapping `net.DefaultResolver`. Test: `WithResolver(mockResolver{...})`. Constructor: `NewURLPolicy(opts ...PolicyOption)` with `WithResolver(r Resolver)` option. In tests, inject a mock resolver that returns `127.0.0.1` for test hostnames.

Add tests to `pkg/security/urlpolicy_test.go`:
- `TestCheckURLResolved_HostnameResolvesToBlockedIP` — inject mock resolver returning 127.0.0.1 for `evil.example.com`, verify `CheckURLResolved` blocks it
- `TestCheckURLResolved_AllowLoopback` — with `AllowLoopback()`, inject mock resolver returning 127.0.0.1, verify it's allowed
- `TestCheckURLResolved_SafeHostname` — inject mock resolver returning a public IP, verify it's allowed

**Scheme allowlist scope:** The `data:`/`blob:`/`javascript:` allowlist belongs ONLY in the browser hijack callback (`browser.go`), NOT in the generic `CheckURL`/`CheckURLResolved` functions. `CheckURL` should continue to restrict to `http`/`https` for top-level crawl URLs. The hijack callback should have its own scheme check before calling `CheckURLResolved`:
```go
scheme := ctx.Request.URL().Scheme
if scheme == "data" || scheme == "blob" || scheme == "javascript" {
    ctx.ContinueRequest(&proto.FetchContinueRequest{})
    return
}
```

Also add to `pkg/fetcher/browser_test.go`: test that subrequest interception blocks a request to a blocked IP.

---

### M2: Cookie-consent popup blocking

**File to change:** `pkg/fetcher/browser.go` — extend M1's hijack callback
**Problem:** Consent popups pollute DOM extraction with irrelevant overlay content.

**Plan references:**
- **PLAN** line 105: "Cookie-consent blocking: Request interception to block cookie-consent popups that pollute DOM"
- **PLAN** line 107 (from Katana): Borrowed pattern

**Reference repos:**
- `references/katana/pkg/engine/hybrid/hijack.go` — Katana blocks certain request types via interception

**Fix:** Add consent domain blocklist to the hijack callback from M1:
```go
var consentDomains = []string{
    "consent.cookiebot.com",
    "cdn.cookielaw.org",
    "consentcdn.cookiebot.com",
    "consent.trustarc.com",
    "cdn.privacy-mgmt.com",
}

// Inside hijack callback, before ContinueRequest:
host := ctx.Request.URL().Hostname()
for _, blocked := range consentDomains {
    if host == blocked || strings.HasSuffix(host, "."+blocked) {
        ctx.Response.Fail(proto.NetworkErrorReasonBlockedByClient)
        return
    }
}
```

---

### M3: Diagnostics HTTP endpoint

**DEFERRED to Phase 6.** Current server runs crawls synchronously — a debug endpoint during a sync request has nothing to report. Defer M3 to Phase 6 when the server supports async crawl jobs. For now, the `/health` endpoint is sufficient.

**Plan references:**
- **PLAN** line 107: "Diagnostics endpoint: Live crawl debugger HTTP endpoint for real-time monitoring" (from Katana)
- **BLUEPRINT** Section 2.11 (`pkg/server/handler.go`): handler description mentions health checks

**Reference repos:**
- `references/katana/pkg/engine/headless/debugger.go` — Katana's live crawl debugger endpoint

---

### M4: Benchmark tracking in CI

**File to change:** `.github/workflows/ci.yml`
**Problem:** No automatic benchmark comparison on PRs.

**Plan references:**
- **PERF** §14: "Benchmarking and profiling — benchstat for before/after comparison"
- **BLUEPRINT** Section 8, lines 1579-1598: "Benchmark collection on PRs"
- **BLUEPRINT** Section 6 (Makefile): `bench` and `bench-compare` targets exist but not used in CI

**Fix:** Add benchmark job to ci.yml:
```yaml
  bench:
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.23'
          cache: true
      - name: Run benchmarks
        run: go test -bench=. -benchmem -count=5 -run='^$' -timeout 120s ./... > bench.txt
      - name: Upload benchmark results
        uses: actions/upload-artifact@v4
        with:
          name: benchmarks
          path: bench.txt
```

> **Note:** `-run='^$'` ensures no unit tests run during benchmark collection. For proper comparison, also check out the base branch and collect baseline benchmarks. Use `benchstat` for comparison. This is a future enhancement.

---

### M5: Missing test fixtures (SimHash near-duplicates + blog)

**Files to create:** `testdata/fixtures/near-duplicate-a.html`, `near-duplicate-b.html`, `blog-article.html`
**Problem:** SimHash dedup can't be tested with near-duplicate pages. Blog page type not represented.

**Plan references:**
- **PLAN** lines 100-101: "SimHash deduplication: Tokenize normalized DOM → per-token hash → Hamming distance"
- **BLUEPRINT** Section 1, lines 135-137: Fixture file list includes near-duplicate and blog fixtures
- **BLUEPRINT** Section 5.1: "SimHash: Hash same content → same hash, similar → low distance, different → high distance"

**Reference repos:**
- `references/katana/pkg/engine/headless/crawler/normalizer/simhash/simhash_test.go` — Katana's SimHash test patterns
- `references/readability/test/test-pages/` — Mozilla Readability's test HTML pages (good source of realistic article HTML)

**Fix:** Create 3 fixture files and add test:
1. `near-duplicate-a.html` — Article with nav, content, footer
2. `near-duplicate-b.html` — Same article, minor edits (different date, one paragraph changed)
3. `blog-article.html` — Blog post with byline, date, tags, comments

Add to `pkg/normalize/simhash_test.go` (stdlib `testing` only — no testify, it's not in go.mod):
```go
func TestSimHash_NearDuplicates(t *testing.T) {
    a, err := os.ReadFile("../../testdata/fixtures/near-duplicate-a.html")
    if err != nil {
        t.Fatalf("read fixture a: %v", err)
    }
    b, err := os.ReadFile("../../testdata/fixtures/near-duplicate-b.html")
    if err != nil {
        t.Fatalf("read fixture b: %v", err)
    }
    fpA := Fingerprint(string(a))
    fpB := Fingerprint(string(b))
    dist := Distance(fpA, fpB)
    if dist > 5 {
        t.Errorf("near-duplicates should have low Hamming distance, got %d", dist)
    }
}
```

Also add test case in `pkg/detector/pagetype_test.go` that reads `blog-article.html` and asserts `DetectPageType() == PageArticle`. DetectPageType maps /blog/ URLs to PageArticle (not PageBlog) — this is correct behavior since blog posts ARE articles. Test should assert PageArticle. The PageBlog enum exists for future fine-grained classification but is not currently used.

> **Note:** Adjust Hamming distance threshold based on actual SimHash behavior — the repo's current tests may use a different threshold. Run once to calibrate.

---

### M6: Add robotstxt to go.mod (Phase 6 prep)

**DEFERRED** — unused dependency will be removed by `go mod tidy`. Wait until `pkg/crawler/robots.go` is implemented in Phase 6.

**Plan references:**
- **PLAN** line 585: "robots.txt respect (opt-in flag, since we typically crawl our own apps)" — Phase 6
- **PLAN** Technology Stack table: `github.com/samclarke/robotstxt` listed
- **PERF** §25: Technology stack — lists robotstxt as required
- **BLUEPRINT** Section 2.9: `pkg/crawler/robots.go` listed as Phase 6 file

---

## Implementation Order

```
Step 1:  C1 + C2   Wire fetchers + fix stub (crawl.go + handler.go) — 15 min — unblocks ALL CLI usage
Step 2:  H3        Goroutine leak detection (goleak)                — 10 min — improves test quality
Step 3:  M1 + M2   Browser SSRF interception + consent + security   — 45 min — improves security + extraction
                    regression tests (urlpolicy_test + browser_test)
Step 4:  H4 + H5   CI headless test + GHCR push                    — 20 min — improves CI/CD
Step 5:  M4        Benchmark CI job                                 — 10 min — improves perf tracking
Step 6:  M5        Test fixtures (SimHash + blog as PageArticle)    — 20 min — improves test coverage
Step 7:  Full test suite + build verification                       — 5 min
```

**13 fixes total: 9 active now, H1 resolved (not a bug), H2 deferred to Phase 6 (framework readiness), M3 deferred to Phase 6 (async crawl), M6 deferred to Phase 6 (robots.go)**
**Total: ~2 hours 15 min for all active fixes**

---

## Cross-Reference Matrix: Which Fix Addresses Which Plan Gap

| Fix | PLAN Lines | PERF Sections | BLUEPRINT Sections | Reference Repos |
|---|---|---|---|---|
| C1 | 598-624, 696-700 | §1 | 2.12, 3 Phase 5C | `katana/cmd/`, `colly/collector.go` |
| C2 | 516-528, 712 | §9 | 2.5 | `katana/.../browser.go` |
| H1 | 329-340 (step 8), 101 | — | 2.7 | `katana/.../normalizer/normalizer.go` |
| H2 | 318-321, 102, 590 | — | 2.5 | `katana/.../crawler/crawler.go`, `katana/.../browser.go` |
| H3 | — | §24, §25 | 5.1 | — |
| H4 | — | §9 | 8 (lines 1518-1521) | — |
| H5 | — | — | 8 (lines 1638-1657) | — |
| M1 | 105, 332 | — | 2.4, 2.5 | `katana/.../hybrid/hijack.go` |
| M2 | 105 | — | — | `katana/.../hybrid/hijack.go` |
| M3 | 107 | — | 2.11 | `katana/.../debugger.go` |
| M4 | — | §14 | 6, 8 (lines 1579-1598) | — |
| M5 | 100-101 | — | 1 (lines 135-137), 5.1 | `katana/.../simhash_test.go`, `readability/test/` |
| M6 | 585 | §25 | 2.9 | `katana/.../robotstxt.go` |

---

## Verification Checklist (after all fixes)

```bash
# 1. Build works (both modes)
go build -o crawly ./cmd/crawly
go build -tags headless -o crawly-headless ./cmd/crawly

# 2. CLI actually crawls (THE critical test)
./crawly crawl https://example.com --max-pages 1 --render never --output json

# 3. All tests pass
go test -count=1 ./...

# 4. Headless tests pass (if Chrome available)
go test -tags headless -count=1 ./pkg/fetcher/...

# 5. No goroutine leaks
go test -count=1 ./pkg/crawler/... ./pkg/fetcher/... ./pkg/server/...

# 6. Vet clean
go vet ./...

# 7. Binary size < 20MB
ls -lh crawly

# 8. SimHash near-duplicate test
go test -count=1 -run TestSimHash_NearDuplicates ./pkg/normalize/...
```
