# Go Performance Guide for crawly

Best practices, patterns, and optimizations for building the fastest possible crawler in Go.
Based on research from production Go crawlers (Colly, Katana), Go performance literature, and benchmarks.

---

## 1. HTTP Client Tuning (Critical for Crawler Speed)

The default `net/http` Transport is tuned for convenience, NOT performance. These changes alone can give 5-10x throughput improvement.

```go
import (
    "crypto/tls"
    "net"
    "net/http"
    "time"
)

func NewCrawlerHTTPClient() *http.Client {
    transport := &http.Transport{
        // Connection pooling — DEFAULT IS ONLY 2 PER HOST!
        MaxIdleConns:        100,             // Total idle connections across all hosts
        MaxIdleConnsPerHost: 100,             // Per-host idle connections (default: 2!)
        IdleConnTimeout:     90 * time.Second,

        // DO NOT use MaxConnsPerHost — has a known panic bug under high load
        // Instead, control concurrency via semaphores in your crawler logic

        // Connection tuning
        DialContext: (&net.Dialer{
            Timeout:   10 * time.Second,  // TCP connection timeout
            KeepAlive: 30 * time.Second,  // TCP keep-alive interval
        }).DialContext,

        // TLS tuning
        TLSHandshakeTimeout: 10 * time.Second,
        TLSClientConfig: &tls.Config{
            InsecureSkipVerify: false, // Set true only for testing
        },

        // HTTP/2 — enabled by default with TLS
        ForceAttemptHTTP2: true,

        // Response header timeout
        ResponseHeaderTimeout: 15 * time.Second,

        // Compression
        DisableCompression: false,
    }

    return &http.Client{
        Transport: transport,
        Timeout:   30 * time.Second, // Overall request timeout
        // Don't follow redirects automatically — we want to track them
        CheckRedirect: func(req *http.Request, via []*http.Request) error {
            if len(via) >= 10 {
                return http.ErrUseLastResponse
            }
            return nil
        },
    }
}
```

### Critical: Always Drain Response Bodies

Undrained response bodies prevent connection reuse and cause connection leaks:

```go
func fetchPage(client *http.Client, url string) ([]byte, error) {
    resp, err := client.Get(url)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    // ALWAYS read the full body, even if you don't need it
    // This allows the connection to be reused
    body, err := io.ReadAll(resp.Body)
    if err != nil {
        // Still drain the body on error to reuse connection
        io.Copy(io.Discard, resp.Body)
        return nil, err
    }
    return body, nil
}
```

---

## 2. Goroutine Pool with Semaphore Pattern

The semaphore pattern (buffered channel) is the most efficient for bounded concurrency. Simpler and faster than worker pool libraries.

```go
import (
    "context"
    "sync"
)

type CrawlEngine struct {
    client      *http.Client
    concurrency int
    sem         chan struct{} // semaphore
}

func NewCrawlEngine(concurrency int) *CrawlEngine {
    return &CrawlEngine{
        client:      NewCrawlerHTTPClient(),
        concurrency: concurrency,
        sem:         make(chan struct{}, concurrency),
    }
}

func (e *CrawlEngine) Crawl(ctx context.Context, urls []string) []PageResult {
    results := make(chan PageResult, len(urls))
    var wg sync.WaitGroup

    for _, url := range urls {
        wg.Add(1)
        go func(u string) {
            defer wg.Done()

            // Acquire semaphore slot (blocks if at capacity)
            select {
            case e.sem <- struct{}{}:
                defer func() { <-e.sem }() // Release on return
            case <-ctx.Done():
                return
            }

            result := e.fetchAndExtract(ctx, u)
            results <- result
        }(url)
    }

    // Close results channel when all goroutines complete
    go func() {
        wg.Wait()
        close(results)
    }()

    // Collect results
    var pages []PageResult
    for r := range results {
        pages = append(pages, r)
    }
    return pages
}
```

### Dynamic Concurrency Based on CPU Cores (spider-rs pattern)

```go
import "runtime"

func optimalConcurrency() int {
    cores := runtime.NumCPU()
    // For I/O-bound crawler: 10-20x cores is good
    // For CPU-bound extraction: 1-2x cores
    return cores * 10 // Adjust based on profiling
}
```

---

## 3. sync.Pool for Buffer Reuse (93% Throughput Improvement)

Every page fetch allocates buffers. Reuse them to slash GC pressure.

```go
import (
    "bytes"
    "sync"
)

// Pool for page body buffers (8KB initial, grows as needed)
var bodyBufferPool = sync.Pool{
    New: func() interface{} {
        return bytes.NewBuffer(make([]byte, 0, 8192))
    },
}

// Pool for HTML parse results (reuse goquery documents is NOT safe,
// but we can pool intermediate string builders)
var stringBuilderPool = sync.Pool{
    New: func() interface{} {
        return &strings.Builder{}
    },
}

func fetchWithPooledBuffer(client *http.Client, url string) ([]byte, error) {
    resp, err := client.Get(url)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    buf := bodyBufferPool.Get().(*bytes.Buffer)
    buf.Reset()
    defer bodyBufferPool.Put(buf)

    _, err = buf.ReadFrom(resp.Body)
    if err != nil {
        return nil, err
    }

    // Copy out of pooled buffer before returning it to pool
    result := make([]byte, buf.Len())
    copy(result, buf.Bytes())
    return result, nil
}
```

### sync.Pool Rules
1. **Always Reset before Put** — stale data causes bugs
2. **Always copy data out** before returning buffer to pool — pool may reuse it immediately
3. **Don't store pointers to pooled objects** — GC can reclaim pool contents between GC cycles
4. **Cap pool object sizes** to prevent memory bloat from oversized buffers:

```go
var cappedPool = sync.Pool{
    New: func() interface{} {
        return make([]byte, 0, 8192)
    },
}

func putCapped(buf []byte) {
    if cap(buf) > 64*1024 { // Don't pool buffers > 64KB
        return // Let GC handle oversized buffers
    }
    cappedPool.Put(buf[:0]) // Reset length, keep capacity
}
```

---

## 4. Zero-Allocation Patterns

### Escape Analysis — Understand What Allocates

```bash
# Show escape analysis decisions
go build -gcflags="-m" ./...

# Show more detail
go build -gcflags="-m -m" ./...
```

**What causes heap allocations:**
- Returning pointers from functions (value "escapes" to heap)
- Storing values in `interface{}` (boxing)
- Closures capturing variables
- Slices/maps that grow beyond stack size
- `fmt.Sprintf` (always allocates)

### Pre-allocate Slices

```go
// BAD: repeated allocations as slice grows
var links []string
for _, a := range doc.Find("a") {
    links = append(links, a.AttrOr("href", ""))
}

// GOOD: pre-allocate with estimated capacity
linkNodes := doc.Find("a")
links := make([]string, 0, linkNodes.Length())
linkNodes.Each(func(_ int, s *goquery.Selection) {
    if href, exists := s.Attr("href"); exists {
        links = append(links, href)
    }
})
```

### Filter In-Place (Zero Allocation Filtering)

```go
// Filter internal links without allocating new slice
func filterInternalLinks(links []string, domain string) []string {
    filtered := links[:0] // Reuse underlying array
    for _, link := range links {
        if isInternalLink(link, domain) {
            filtered = append(filtered, link)
        }
    }
    return filtered
}
```

### strings.Builder for Concatenation

```go
// BAD: O(n²) string concatenation
result := ""
for _, heading := range headings {
    result += heading.Text + "\n"
}

// GOOD: single allocation
var sb strings.Builder
sb.Grow(len(headings) * 50) // Pre-allocate estimated size
for _, heading := range headings {
    sb.WriteString(heading.Text)
    sb.WriteByte('\n')
}
result := sb.String()
```

### Avoid fmt.Sprintf in Hot Paths

```go
// BAD: allocates every call
key := fmt.Sprintf("%s:%d", host, port)

// GOOD: use strconv + string concatenation or builder
key := host + ":" + strconv.Itoa(port)
```

---

## 5. Concurrent URL Deduplication

For a crawler visiting ~20-100 pages, `sync.Map` or a simple mutex map both work. For larger crawls, sharding helps.

### Recommendation: sync.Map for Read-Heavy Crawler Dedup

Benchmarks show `sync.Map` wins when:
- Reads >> Writes (URLs are checked far more often than added)
- Keys are written once and read many times (exactly our pattern)

```go
type URLDedup struct {
    visited sync.Map
}

func (d *URLDedup) IsVisited(url string) bool {
    _, loaded := d.visited.Load(url)
    return loaded
}

func (d *URLDedup) MarkVisited(url string) bool {
    // LoadOrStore returns true if already existed
    _, loaded := d.visited.LoadOrStore(url, struct{}{})
    return loaded // true = was already visited
}
```

### For Scale (10K+ URLs): Sharded Map

```go
const shardCount = 32

type ShardedURLSet struct {
    shards [shardCount]struct {
        mu   sync.RWMutex
        urls map[string]struct{}
    }
}

func (s *ShardedURLSet) getShard(url string) *struct {
    mu   sync.RWMutex
    urls map[string]struct{}
} {
    h := fnv.New32a()
    h.Write([]byte(url))
    return &s.shards[h.Sum32()%shardCount]
}

func (s *ShardedURLSet) Add(url string) bool {
    shard := s.getShard(url)
    shard.mu.Lock()
    defer shard.mu.Unlock()
    if _, exists := shard.urls[url]; exists {
        return false // Already existed
    }
    shard.urls[url] = struct{}{}
    return true // Newly added
}
```

---

## 6. BFS Queue with Channel Pipeline

Fan-out/fan-in pattern for the crawl pipeline:

```go
func (e *CrawlEngine) BFSCrawl(ctx context.Context, startURL string, maxPages, maxDepth int) <-chan PageResult {
    results := make(chan PageResult, maxPages)

    go func() {
        defer close(results)

        queue := make(chan CrawlTask, maxPages*10) // Buffered for backpressure
        dedup := &URLDedup{}
        var activeWg sync.WaitGroup
        var pagesFound int32

        // Seed the queue
        queue <- CrawlTask{URL: startURL, Depth: 0}
        dedup.MarkVisited(startURL)

        // Worker goroutines
        for i := 0; i < e.concurrency; i++ {
            activeWg.Add(1)
            go func() {
                defer activeWg.Done()
                for {
                    select {
                    case <-ctx.Done():
                        return
                    case task, ok := <-queue:
                        if !ok {
                            return
                        }
                        if atomic.LoadInt32(&pagesFound) >= int32(maxPages) {
                            continue
                        }

                        page := e.processPage(ctx, task)
                        atomic.AddInt32(&pagesFound, 1)
                        results <- page

                        // Enqueue discovered links
                        if task.Depth < maxDepth {
                            for _, link := range page.InternalLinks {
                                if dedup.MarkVisited(link) {
                                    continue // Already visited
                                }
                                select {
                                case queue <- CrawlTask{URL: link, Depth: task.Depth + 1}:
                                default:
                                    // Queue full, skip this link (backpressure)
                                }
                            }
                        }
                    }
                }
            }()
        }

        activeWg.Wait()
    }()

    return results
}
```

---

## 7. Context Propagation and Cascading Timeouts

Three levels of timeout for a crawler:

```go
func (e *CrawlEngine) CrawlWithTimeouts(startURL string) (CrawlResult, error) {
    // Level 1: Overall crawl timeout (e.g., 5 minutes for entire site)
    crawlCtx, crawlCancel := context.WithTimeout(context.Background(), 5*time.Minute)
    defer crawlCancel()

    results := e.BFSCrawl(crawlCtx, startURL, 20, 3)

    var pages []PageResult
    for page := range results {
        pages = append(pages, page)
    }
    return CrawlResult{Pages: pages}, crawlCtx.Err()
}

func (e *CrawlEngine) processPage(crawlCtx context.Context, task CrawlTask) PageResult {
    // Level 2: Per-page timeout (e.g., 30 seconds per page)
    pageCtx, pageCancel := context.WithTimeout(crawlCtx, 30*time.Second)
    defer pageCancel()

    // Level 3: Per-request timeout (built into http.Client)
    // Already set in NewCrawlerHTTPClient() — 30s overall request timeout

    req, _ := http.NewRequestWithContext(pageCtx, "GET", task.URL, nil)
    resp, err := e.client.Do(req)
    // ...
}
```

### Context Leak Prevention

```go
// ALWAYS defer cancel, even if context expires naturally
ctx, cancel := context.WithTimeout(parent, 30*time.Second)
defer cancel() // Prevents context leak even if we return early
```

---

## 8. GOGC and GOMEMLIMIT Tuning

### GOGC (GC Frequency)

Default GOGC=100 means GC triggers when heap doubles. For high-throughput crawlers:

```go
import "runtime/debug"

func init() {
    // GOGC=200 means GC triggers at 3x live heap
    // Less frequent GC = more throughput, more memory
    debug.SetGCPercent(200)
}
```

Or via environment variable:
```bash
GOGC=200 ./crawly https://example.com
```

### GOMEMLIMIT (Soft Memory Ceiling, Go 1.19+)

Prevents OOM by triggering GC more aggressively near the limit:

```go
func init() {
    // Set to 80-85% of available memory
    // In a 512MB container: 430MB
    debug.SetMemoryLimit(430 * 1024 * 1024)
}
```

Or via environment variable:
```bash
GOMEMLIMIT=430MiB ./crawly https://example.com
```

### Recommended Production Config

```bash
# For a container with 1GB RAM:
GOGC=200 GOMEMLIMIT=850MiB ./crawly ...
```

**Rule of thumb:**
- `GOMEMLIMIT` = 80-85% of container memory limit
- `GOGC` = 200-300 for throughput-optimized crawlers (trade memory for speed)

---

## 9. Build Tags for Feature Gating

Like spider-rs Cargo features, use Go build tags to keep the default binary lean:

```go
// file: renderer_headless.go
//go:build headless

package renderer

import "github.com/go-rod/rod"

type HeadlessRenderer struct {
    pool *rod.PagePool
}

func NewHeadlessRenderer() *HeadlessRenderer {
    // Full browser-based rendering
}
```

```go
// file: renderer_http.go
//go:build !headless

package renderer

type HeadlessRenderer struct{}

func NewHeadlessRenderer() *HeadlessRenderer {
    // Stub — returns nil or logs warning
    return nil
}
```

Build:
```bash
# Default: HTTP-only, smallest binary
go build -o crawly ./cmd/crawly

# With browser support
go build -tags headless -o crawly ./cmd/crawly
```

---

## 10. Profile-Guided Optimization (PGO)

Go 1.21+ supports PGO for 2-14% free performance improvement:

```bash
# Step 1: Build normally
go build -o crawly ./cmd/crawly

# Step 2: Collect production profile
# Run a representative crawl and collect pprof
curl http://localhost:6060/debug/pprof/profile?seconds=60 > default.pgo

# Step 3: Rebuild with profile (place default.pgo in main package dir)
cp default.pgo cmd/crawly/default.pgo
go build -o crawly ./cmd/crawly
# Go automatically detects default.pgo and applies PGO
```

Enable pprof endpoint:
```go
import _ "net/http/pprof"

func enableProfiling() {
    go func() {
        http.ListenAndServe(":6060", nil)
    }()
}
```

---

## 11. JSON Streaming Output (Don't Buffer Entire Crawl)

Stream results as JSONL (one JSON object per line) instead of buffering everything:

```go
func streamResults(ctx context.Context, results <-chan PageResult, w io.Writer) error {
    enc := json.NewEncoder(w)
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case result, ok := <-results:
            if !ok {
                return nil // Channel closed, crawl complete
            }
            if err := enc.Encode(result); err != nil {
                return err
            }
        }
    }
}
```

CLI flag: `--output jsonl` for streaming, `--output json` for buffered array output.

---

## 12. Graceful Shutdown

```go
func main() {
    ctx, cancel := signal.NotifyContext(context.Background(),
        syscall.SIGINT, syscall.SIGTERM)
    defer cancel()

    engine := NewCrawlEngine(optimalConcurrency())

    // Start crawl with context — cancellation cascades to all goroutines
    results := engine.BFSCrawl(ctx, targetURL, maxPages, maxDepth)

    // Stream results until crawl completes or signal received
    if err := streamResults(ctx, results, os.Stdout); err != nil {
        if errors.Is(err, context.Canceled) {
            log.Println("Crawl interrupted, shutting down gracefully...")
        } else {
            log.Fatalf("Crawl error: %v", err)
        }
    }
}
```

---

## 13. Error Handling Without Stopping

```go
type PageResult struct {
    URL          string    `json:"url"`
    Error        string    `json:"error,omitempty"`
    StatusCode   int       `json:"status_code"`
    // ... other fields
}

func (e *CrawlEngine) processPage(ctx context.Context, task CrawlTask) PageResult {
    result := PageResult{URL: task.URL}

    resp, err := e.fetch(ctx, task.URL)
    if err != nil {
        result.Error = err.Error()
        return result // Don't stop crawl, just record the error
    }

    result.StatusCode = resp.StatusCode
    if resp.StatusCode >= 400 {
        result.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
        return result
    }

    // Continue with extraction...
    return result
}
```

### Retry with Exponential Backoff

```go
func (e *CrawlEngine) fetchWithRetry(ctx context.Context, url string, maxRetries int) (*http.Response, error) {
    var lastErr error
    for attempt := 0; attempt <= maxRetries; attempt++ {
        if attempt > 0 {
            backoff := time.Duration(1<<uint(attempt-1)) * 500 * time.Millisecond
            select {
            case <-time.After(backoff):
            case <-ctx.Done():
                return nil, ctx.Err()
            }
        }

        resp, err := e.client.Do(req)
        if err == nil && resp.StatusCode < 500 {
            return resp, nil
        }
        if err != nil {
            lastErr = err
        } else {
            lastErr = fmt.Errorf("HTTP %d", resp.StatusCode)
            io.Copy(io.Discard, resp.Body)
            resp.Body.Close()
        }
    }
    return nil, fmt.Errorf("after %d retries: %w", maxRetries, lastErr)
}
```

---

## 14. Benchmarking Checklist

```bash
# CPU profile
go test -bench=. -cpuprofile=cpu.prof ./...
go tool pprof -http=:8080 cpu.prof

# Memory profile (allocations)
go test -bench=. -memprofile=mem.prof -memprofilerate=1 ./...
go tool pprof -http=:8080 mem.prof

# Allocation count per operation
go test -bench=. -benchmem ./...

# Trace (goroutine scheduling, GC events)
go test -bench=. -trace=trace.out ./...
go tool trace trace.out

# Compare before/after
go test -bench=. -count=10 > old.txt
# ... make changes ...
go test -bench=. -count=10 > new.txt
benchstat old.txt new.txt
```

### Key Metrics to Watch

| Metric | Target | Tool |
|---|---|---|
| allocs/op | Minimize | `go test -benchmem` |
| B/op | Minimize | `go test -benchmem` |
| GC pause time | < 1ms p99 | `GODEBUG=gctrace=1` |
| Goroutine count | Stable over time | `runtime.NumGoroutine()` |
| Heap allocation rate | Low and stable | `pprof heap` |
| HTTP connection reuse | > 90% | `httptrace` |

---

## 15. Project Structure

```
crawly/
├── cmd/
│   └── crawly/
│       ├── main.go              # CLI entry point
│       └── default.pgo          # PGO profile (once collected)
├── pkg/
│   ├── crawler/
│   │   ├── engine.go            # BFS engine, goroutine pool
│   │   ├── queue.go             # BFS queue with channel
│   │   └── dedup.go             # URL deduplication (sync.Map)
│   ├── fetcher/
│   │   ├── http.go              # HTTP fetcher with tuned Transport
│   │   └── browser.go           # go-rod headless renderer (build tag: headless)
│   ├── detector/
│   │   ├── spa.go               # SPA detection heuristics
│   │   └── pagetype.go          # Page type detection (article/app/auth)
│   ├── extractor/
│   │   ├── readability.go       # Readability-based extraction
│   │   ├── density.go           # Density-based extraction (for apps)
│   │   ├── structural.go        # Forms, headings, links, interactive elements
│   │   └── meta.go              # Meta tags, OG, JSON-LD
│   ├── markdown/
│   │   ├── converter.go         # html-to-markdown wrapper
│   │   └── citations.go         # Link citation footnotes
│   ├── normalize/
│   │   ├── dom.go               # DOM normalization pipeline
│   │   ├── url.go               # URL canonicalization
│   │   └── simhash.go           # SimHash near-duplicate detection
│   └── output/
│       ├── json.go              # JSON/JSONL output
│       └── types.go             # PageResult, CrawlResult structs
├── internal/
│   └── pool/
│       ├── buffer.go            # sync.Pool for buffers
│       └── browser.go           # Browser pool with health tracking
├── go.mod
├── go.sum
├── Makefile
├── Dockerfile
├── README.md
└── LICENSE
```

---

## 16. errgroup + Semaphore (Idiomatic Cancel-on-Error)

From deep research — better than raw WaitGroup for crawlers because a fatal error cancels remaining work:

```go
import (
    "context"
    "golang.org/x/sync/errgroup"
)

func crawlMany(ctx context.Context, urls []string, maxConc int) error {
    g, ctx := errgroup.WithContext(ctx)
    sem := make(chan struct{}, maxConc)
    for _, u := range urls {
        u := u
        sem <- struct{}{} // acquire before g.Go to bound goroutine creation
        g.Go(func() error {
            defer func() { <-sem }()
            return fetchWithContext(ctx, u)
        })
    }
    return g.Wait() // returns first error, cancels ctx for remaining
}
```

Use this for the HTTP-fetch tier. Use raw WaitGroup + semaphore for the browser tier (where individual page failures shouldn't cancel the crawl).

---

## 17. Colly's Per-Domain Limiter Pattern

From deep research on Colly internals — elegant slot-based rate limiting per host:

```go
type DomainSlot struct {
    waitCh chan struct{} // sized to max parallelism for this domain
    delay  time.Duration
}

func NewDomainSlot(parallelism int, delay time.Duration) *DomainSlot {
    return &DomainSlot{
        waitCh: make(chan struct{}, parallelism),
        delay:  delay,
    }
}

func (s *DomainSlot) Acquire() { s.waitCh <- struct{}{} }
func (s *DomainSlot) Release() {
    time.Sleep(s.delay) // Politeness delay BEFORE releasing
    <-s.waitCh
}
```

Combine with a `map[string]*DomainSlot` to enforce per-domain concurrency limits AND crawl delays.

---

## 18. HTML Tokenizer for Fast Extraction (Skip Full Parse)

Deep research revealed: for targeted extraction (title, meta tags, SPA detection), use streaming tokenizer instead of full goquery parse. 3-5x faster for large pages:

```go
import (
    "io"
    "golang.org/x/net/html"
)

func extractTitle(r io.Reader) string {
    z := html.NewTokenizer(r)
    for {
        tt := z.Next()
        switch tt {
        case html.ErrorToken:
            return "" // EOF or error
        case html.StartTagToken:
            t := z.Token()
            if t.Data == "title" {
                if z.Next() == html.TextToken {
                    return string(z.Text())
                }
            }
        }
    }
}
```

Use tokenizer for: SPA detection (scan for framework markers), title extraction, meta tag extraction. Use goquery for: structural extraction (forms, headings, links) where CSS selectors are needed.

---

## 19. Compiled CSS Selectors (goquery + cascadia)

When the same selector runs on every page, compile it once:

```go
import "github.com/andybalholm/cascadia"

// Compile ONCE at init, reuse across all pages
var (
    headingSel = cascadia.MustCompile("h1, h2, h3, h4, h5, h6")
    formSel    = cascadia.MustCompile("form")
    linkSel    = cascadia.MustCompile("a[href]")
    buttonSel  = cascadia.MustCompile("button, input[type=submit], a[role=button]")
)

// Use FindMatcher instead of Find (avoids re-parsing selector string)
headings := doc.FindMatcher(headingSel)
```

---

## 20. URL Canonicalization Function

Copy-paste-ready from deep research:

```go
func normalizeURL(raw string) (string, error) {
    u, err := url.Parse(raw)
    if err != nil { return "", err }
    u.Scheme = strings.ToLower(u.Scheme)
    u.Host = strings.ToLower(u.Host)
    u.Path = path.Clean(u.Path)
    u.Fragment = ""
    if u.RawQuery != "" {
        vals, _ := url.ParseQuery(u.RawQuery)
        keys := make([]string, 0, len(vals))
        for k := range vals { keys = append(keys, k) }
        sort.Strings(keys)
        var b strings.Builder
        for i, k := range keys {
            vs := vals[k]
            sort.Strings(vs)
            for j, v := range vs {
                if i > 0 || j > 0 { b.WriteByte('&') }
                b.WriteString(url.QueryEscape(k))
                if v != "" { b.WriteByte('='); b.WriteString(url.QueryEscape(v)) }
            }
        }
        u.RawQuery = b.String()
    }
    if u.Path != "/" { u.Path = strings.TrimRight(u.Path, "/") }
    return u.String(), nil
}
```

---

## 21. Bloom Filter for Scale (10K+ URLs)

For very large crawls where memory matters:

```go
import "github.com/bits-and-blooms/bloom/v3"

bf := bloom.NewWithEstimates(100000, 0.01) // 100K URLs, 1% false positive

normalized := normalizeURL(rawURL)
if bf.TestString(normalized) {
    return // Probably already visited (1% false positive rate)
}
bf.AddString(normalized)
```

Use Bloom filter as a fast pre-check, with exact map as backup for critical dedup decisions.

---

## 22. Graceful Shutdown with State Checkpointing

From deep research — save crawl frontier on interrupt for resume:

```go
func main() {
    ctx, cancel := signal.NotifyContext(context.Background(),
        syscall.SIGINT, syscall.SIGTERM)
    defer cancel()

    engine := NewCrawlEngine(optimalConcurrency())

    // Load checkpoint if resuming
    frontier, _ := loadState("crawl_checkpoint.json")

    results := engine.BFSCrawl(ctx, frontier, maxPages, maxDepth)
    streamResults(ctx, results, os.Stdout)

    // On shutdown, save remaining frontier
    if ctx.Err() != nil {
        saveState("crawl_checkpoint.json", engine.RemainingFrontier())
        log.Println("State saved. Resume with --resume flag.")
    }
}
```

---

## 23. DNS Caching (Go Doesn't Cache!)

Critical finding: Go's net resolver does NOT cache DNS lookups. For a crawler hitting the same domain repeatedly:

```go
import "github.com/viki-org/dnscache"

resolver := dnscache.New(5 * time.Minute) // 5 min TTL

transport := &http.Transport{
    DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
        host, port, _ := net.SplitHostPort(addr)
        ips, _ := resolver.FetchOneString(host)
        return (&net.Dialer{
            Timeout:   5 * time.Second,
            KeepAlive: 30 * time.Second,
        }).DialContext(ctx, network, net.JoinHostPort(ips, port))
    },
}
```

This avoids a DNS lookup on every request to the same host.

---

## 24. Goroutine Leak Detection in Tests

```go
import "go.uber.org/goleak"

func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}
```

Run in CI to catch goroutine leaks early. Also monitor `runtime.NumGoroutine()` in production — spike or unbounded growth = leak.

---

## 25. Technology Stack Updates

Based on deep research findings, add these to the tech stack:

| Component | Library | Why |
|---|---|---|
| **errgroup** | `golang.org/x/sync/errgroup` | Cancel-on-error fan-out |
| **DNS Cache** | `github.com/viki-org/dnscache` | Go doesn't cache DNS! |
| **Bloom Filter** | `github.com/bits-and-blooms/bloom/v3` | Memory-efficient dedup at scale |
| **Selector Compiler** | `github.com/andybalholm/cascadia` | Compile CSS selectors once |
| **Leak Detector** | `go.uber.org/goleak` | Catch goroutine leaks in tests |
| **Robots.txt** | `github.com/samclarke/robotstxt` | Parse crawl-delay directives |
| **Retryable HTTP** | `github.com/hashicorp/go-retryablehttp` | Exponential backoff built-in |

---

## Summary: Performance Priorities (Ordered by Impact)

1. **HTTP Transport tuning** — MaxIdleConnsPerHost=100 (10x default). Biggest single win.
2. **sync.Pool for buffers** — Reuse body buffers, string builders. ~2x throughput.
3. **Pre-allocate slices** — `make([]T, 0, N)` everywhere. Reduces GC pressure.
4. **Bounded concurrency via semaphore** — Simple `chan struct{}` pattern.
5. **GOGC=200 + GOMEMLIMIT** — Trade memory for throughput, prevent OOM.
6. **Streaming output (JSONL)** — Don't buffer entire crawl in memory.
7. **Connection reuse** — Always drain response bodies. Always.
8. **Context cascading** — Three timeout levels: crawl > page > request.
9. **PGO** — Free 2-14% with zero code changes.
10. **Build tags** — Keep default binary lean, gate heavy deps.
