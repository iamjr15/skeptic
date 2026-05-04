# skeptic Test Execution Optimization Research

## Executive Summary

This document synthesizes deep research across 10 optimization vectors to make skeptic's AI-powered browser test execution 10x faster, cheaper, and more reliable than competitors. Each section contains actionable strategies with implementation priorities for skeptic's architecture (Temporal workflows + Morph Browser SDK + Daytona sandboxes).

**Key targets:**
- Per-test time: 3min → <1min (3x improvement)
- Cost per test: reduce LLM spend by 80-90%
- Reliability: flaky rate <2% (industry average: 10-15%)
- Throughput: 100+ parallel tests per run
- Smart selection: run only 30-40% of tests per PR, catch 95%+ of failures

---

## 1. Action Caching / Deterministic Replay

### How Stagehand Does It (The Gold Standard)

Stagehand by Browserbase implements the most sophisticated caching in the AI testing space:

**Cache Key Generation:**
- Hash of: method name + normalized URL + DOM snapshot fingerprint + project scope + method-specific fields
- DOM fingerprint captures page structure, text content, images, and state
- Variables supported — cached selectors reused with different input values (e.g., different usernames in forms)

**What Gets Cached:**
- Resolved CSS/XPath selectors from LLM inference
- Action configuration metadata
- Prompt-response pairs for identical page states

**Cache Invalidation:**
- Current page snapshot fingerprint compared against cached fingerprint
- If significant structural divergence detected → invalidate, re-run LLM, update cache
- Conservative strategy: prioritizes correctness over cache hit rate

**Performance Claims:**
- ~80% speedup on repeat runs
- 10-100x faster execution by skipping LLM calls
- Free for all Stagehand users

### Competitor Approaches

| Tool | Strategy | Details |
|------|----------|---------|
| **Stagehand** | Selector + action caching with DOM fingerprinting | Most sophisticated; open source |
| **Momentic** | Step caching — CSS selectors, HTML attributes, accessibility metadata, screenshots, element positions | Cloud-based; 90-day expiry; git-based isolation |
| **Octomind** | No runtime AI — generates deterministic Playwright code upfront | "AI doesn't belong in test runtime" philosophy |
| **Shortest** | Caches exact tool call results + agent state snapshots | Full deterministic replay from first run |

### Implementation for skeptic

**Phase 1: Page Fingerprinting + Selector Cache**
```
Cache key = hash(test_case_id + step_number + normalized_url + dom_fingerprint)
Cache value = {selector, action_type, action_params, timestamp}
```

Store in Redis alongside run data. On repeat runs:
1. Compute DOM fingerprint for current page
2. Look up cache by key
3. If cache hit + fingerprint similarity > threshold → use cached selector, skip Morph LLM call
4. If miss or diverged → execute via Morph, store result

**Phase 2: Full Action Sequence Replay**
- After first successful run, store complete action sequence (selectors + actions + waits)
- On subsequent runs with same test case + similar page state, replay deterministically
- Fall back to AI execution only when page structure changes significantly

**Phase 3: Cross-Run Learning**
- Build a selector stability index per element (how often selectors break)
- Prefer stable selectors (data-testid, aria-label) over fragile ones (nth-child, class names)
- Auto-generate Playwright-compatible deterministic scripts from cached action sequences

**Expected Impact:**
- First run: normal speed (1.5-3min)
- Subsequent runs: 10-30 seconds (skip all LLM calls)
- Cost reduction: 80-95% on repeat runs

---

## 2. Parallel Execution at Scale

### QA Wolf's Architecture (Industry Leader)

QA Wolf achieves massive parallelism through:
- **Kubernetes-based infrastructure** with pre-booted nodes
- Each pod runs a dedicated container with preloaded Playwright environment
- Tests are completely independent — no shared state
- Containers spun up dynamically as demand scales
- Total suite time = duration of longest individual test

### Browser Pooling Strategies

| Approach | Pros | Cons | Best For |
|----------|------|------|----------|
| **Container per test** (QA Wolf) | Complete isolation, clean state | Resource-intensive, startup latency | Production CI |
| **Shared browser pool** (Playwright) | Fast allocation, low overhead | State leakage risk, reset needed | Development |
| **Cloud browser farm** (BrowserStack) | Massive scale, managed | Cost, network latency | Cross-browser |
| **Warm pool + checkout** | Balance of speed and isolation | Pool management complexity | skeptic's sweet spot |

### Bottlenecks at 100+ Parallel Tests

1. **Database contention** — shared test data creates conflicts
2. **Network bandwidth** — concurrent browser sessions are bandwidth-heavy
3. **Port conflicts** — dynamic port allocation needed
4. **Orchestration overhead** — distributing tests evenly
5. **Flaky tests amplification** — more parallelism = more timing-related flakes

### Implementation for skeptic

**Current State:** skeptic uses Temporal's `ParallelRunWorkflow` with Morph Browser SDK tasks.

**Optimization Strategy:**
1. **Daytona sandbox pooling** — maintain warm pool of pre-provisioned sandboxes with apps already built and running
2. **Morph task parallelism** — fire all Morph tasks simultaneously (they're already independent cloud browser sessions)
3. **Temporal worker scaling** — auto-scale worker replicas based on queue depth
4. **Test sharding** — group tests by estimated duration for even distribution

**Architecture:**
```
PR Trigger → Temporal Workflow
  ├── Sandbox provisioning (parallel, from warm pool)
  ├── App deployment + health check
  └── Test execution fan-out
       ├── Test 1 → Morph task (cloud browser)
       ├── Test 2 → Morph task (cloud browser)
       ├── Test 3 → Morph task (cloud browser)
       └── ... (N concurrent Morph tasks)
  └── Fan-in: collect results, save to DB, post to GitHub
```

**Expected Impact:**
- 10 tests that take 2min each: from 20min sequential → 2min parallel
- Morph's cloud infrastructure handles browser isolation
- Daytona warm pool eliminates 30-60s sandbox provisioning overhead

---

## 3. Smart Test Selection

### Industry Leaders

**Google TAP (Test Automation Platform):**
- Models codebase as a dependency graph
- Tests affected if they transitively depend on changed files
- Uses empirical failure rates, commit authorship, dependency proximity
- >30% improvement in transition detection
- Manages 150+ million test runs daily

**Meta Predictive Test Selection:**
- Gradient-boosted decision trees
- Features: code change metadata, historical test outcomes, dependency graphs, flaky-test signals
- Runs only ~33% of affected tests
- 50% infrastructure cost reduction
- Catches 95%+ of test failures and 99.9% of faulty changes

**Launchable:**
- ML-powered commercial product
- 60-90% reduction in total test time
- Gradient-boosted decision trees trained on change history + failure rates

### Signals That Matter

| Signal | Weight | Source |
|--------|--------|--------|
| File dependency graph | High | Static analysis of imports/requires |
| Historical failure rate | High | Test result database |
| Code coverage mapping | Medium | Instrumentation data |
| Code-test distance | Medium | Git blame + file proximity |
| Flaky test indicator | Medium | Failure pattern analysis |
| Commit author history | Low | Git metadata |
| Time since last failure | Low | Test result database |

### Implementation for skeptic

**Phase 1: Change-Based Selection (Simple, High Impact)**
- On PR trigger, get changed files from GitHub diff
- Map changed files → affected pages/routes using a simple config
- Select only tests whose `base_url` paths overlap with changed routes
- Fall back to full suite if mapping is ambiguous

**Phase 2: Failure-History-Based Selection**
- Track per-test failure rate over last N runs
- Always run tests that failed recently (last 5 runs)
- De-prioritize tests that haven't failed in 30+ runs
- Score: `priority = failure_rate * recency_weight + change_overlap_score`

**Phase 3: ML-Powered Selection**
- Train lightweight model on: {changed_files, test_id, outcome}
- Use gradient-boosted trees (XGBoost/LightGBM)
- Predict P(failure | change) for each test
- Run tests where P(failure) > threshold (tune for 95%+ recall)

**Expected Impact:**
- Run 30-40% of tests per PR
- Catch 95%+ of real failures
- 60-70% reduction in total test execution time per PR

---

## 4. Flaky Test Detection and Quarantine

### Detection Algorithms

**Repeated Runs:**
- Execute test N times (typically 3-5) under identical conditions
- If pass/fail ratio is inconsistent → flag as flaky
- Simple but resource-intensive

**Statistical Analysis (Atlassian's Flakinator):**
- Collect historical results across millions of runs
- Calculate failure rate, pass/fail sequences, burst patterns
- Flag tests exceeding flakiness threshold (e.g., 5% failure rate on passing code)

**ML-Based Detection:**
- Features: test history, code complexity, environment metadata
- Classifiers predict flakiness probability
- Google's De-Flake: automatically locates root causes at code level

### Industry Approaches

| Company | Tool | Approach |
|---------|------|----------|
| **Google** | De-Flake | Automated root cause analysis; quarantine + strategic reruns |
| **Uber** | Testopedia | State machine tracking test health; auto-files tickets |
| **Spotify** | Odeneye + Flakybot | Visualization + re-triggering + prioritized fixing |
| **Atlassian** | Flakinator | ML-powered detection + Jira/Slack integration |
| **GitLab** | Built-in dashboards | Automated retries + group responsibility model |

### Common Browser Test Flake Causes

1. **Timing/synchronization** — interacting before elements are ready
2. **Race conditions** — parallel execution + shared resources
3. **Environment instability** — browser version differences, network conditions
4. **External dependencies** — third-party API fluctuations
5. **UI dynamism** — animations, dynamic content, DOM re-rendering
6. **Stale elements** — DOM re-renders between action and assertion

### Implementation for skeptic

**Flakiness Score Per Test:**
```python
flakiness_score = inconsistent_results / total_runs_on_same_code
# A test is "flaky" if flakiness_score > 0.1 (10% inconsistency)
```

**Quarantine Strategy:**
1. Auto-detect: if test flips pass/fail on same code within last 10 runs → flag
2. Quarantine: move to separate "flaky" group, run separately from main suite
3. Still run quarantined tests but don't block PR merge on their failures
4. Surface flaky tests in UI with owner attribution
5. Auto-create tickets for flaky test investigation
6. Graduation: if test passes consistently for 20 runs → un-quarantine

**AI-Specific Flake Mitigation:**
- Morph CU tasks are inherently more variable than deterministic tests
- Build in tolerance: if AI test fails once, auto-retry before marking as failed
- Track which test steps are most variable (flake hotspots)
- Use stricter assertions for deterministic checks, looser for AI exploration

**Expected Impact:**
- Reduce false-positive failures by 70-80%
- Developer trust in test results increases significantly
- Flaky tests don't block deployments but are still tracked

---

## 5. Test Execution Speed Optimization

### Strategy Breakdown (3min → <1min)

**Browser Startup (saves 5-15s):**
- Warm browser pools: maintain pre-started browser instances
- Reuse browser contexts between steps (not between tests)
- Agent-Browser pattern: resident daemon managing browser lifecycle

**Page Load (saves 10-30s):**
- Disable CSS animations: `* { animation: none !important; transition: none !important; }`
- Block analytics/ads via request interception (save 200-500ms per page)
- Pre-warm pages: navigate to target URL before test officially starts
- Mock external APIs to eliminate network round-trips

**LLM Latency (saves 30-90s — BIGGEST WIN):**
- Cache LLM responses for identical page states (see Section 1)
- Use smaller/faster models for simple actions (see Section 6)
- Parallel LLM calls: analyze next action while current one executes
- Streaming responses: start acting on partial LLM output
- DOM pruning: send only relevant DOM subtree, not full page (25-50x token reduction)

**Step Reduction (saves 15-45s):**
- Combine multiple simple actions into compound actions
- "Fill form" = single compound action vs 5+ individual field fills
- Reduce screenshot frequency: only capture on assertions, not every step
- Skip navigation steps when URL can be directly accessed

**Network Optimization:**
- Request interception: block images, fonts, ads (Playwright's `page.route()`)
- API mocking for external services
- Local network for sandbox-to-browser communication

### Headless vs Headed Benchmarks

- Headless browsers: 2-15x faster than headed
- For AI testing: headless sufficient since Morph uses cloud browsers
- Playwright headless: ~4.7s per test (vs ~10s+ headed)

### Implementation for skeptic

**Quick Wins (implement immediately):**
1. Inject animation-disabling CSS into Daytona sandbox apps
2. Configure Morph to use headless mode (if not already)
3. Set aggressive timeouts: reduce default waits from 30s → 10s
4. Pre-warm sandbox URL: verify app is ready before sending to Morph

**Medium-term:**
1. DOM pruning before sending to Morph (reduce token consumption)
2. Request interception in sandbox apps to block non-essential resources
3. Compound action support in test case definitions

**Expected Impact:**
- With caching (Section 1): 3min → 15-30s for repeat runs
- Without caching (first run): 3min → 1-1.5min with above optimizations
- Combined: average test time across a suite drops to ~45s

---

## 6. Cost Optimization

### Model Routing Strategy

| Action Type | Model Tier | Example Models | Cost/1K tokens |
|------------|------------|----------------|----------------|
| Click button, fill field | Cheap/Fast | GPT-4o-mini, Gemini Flash, Haiku | $0.00015-0.001 |
| Navigate, scroll | Cheap/Fast | GPT-4o-mini, Gemini Flash | $0.00015-0.001 |
| Complex assertion | Mid-tier | GPT-4o, Claude Sonnet, Gemini Pro | $0.005-0.015 |
| Visual verification | Mid-tier | GPT-4o (vision), Claude Sonnet | $0.005-0.015 |
| Multi-step reasoning | Expensive | GPT-4 Turbo, Claude Opus | $0.015-0.075 |

### Token Optimization Techniques

**DOM Pruning (25-50x reduction):**
- Tools like Prune4Web filter irrelevant DOM elements
- Send only the relevant subtree for the current action
- Use accessibility tree extraction (10-15x token reduction) instead of full HTML

**Vision vs Text-Only:**
- Text-only (DOM/accessibility tree): faster, cheaper, more precise for standard web apps
- Vision (screenshots): necessary for canvas, dynamic rendering, visual verification
- Hybrid: use text-only by default, fall back to vision for complex layouts

**Caching (up to 90% cost reduction):**
- Exact match cache: hash(prompt + DOM snapshot) → cached response
- Semantic cache: embedding similarity for paraphrased queries
- Multi-layer: in-memory (hot) → Redis (warm) → persistent (cold)

### Cost Per Test Estimation

```
Base cost (no optimization):
  ~10 LLM calls/test * ~4000 tokens/call * $0.01/1K tokens = $0.40/test

With optimizations:
  Token reduction (50%):    $0.40 * 0.5 = $0.20
  Model routing (60% cheap): $0.20 * 0.5 = $0.10
  Caching (30% hit rate):   $0.10 * 0.7 = $0.07

  Optimized cost: ~$0.07/test (82% reduction)

With mature caching (80% hit rate):
  $0.10 * 0.2 = $0.02/test (95% reduction)
```

### Implementation for skeptic

Since skeptic uses Morph Browser SDK (which handles its own LLM calls), cost optimization requires:

1. **Reduce steps per test** — compound actions, direct URL navigation
2. **Reduce Morph max_steps** — from 30 → 15 for simple tests
3. **Tiered test complexity** — simple tests get lower max_steps budget
4. **Cache at skeptic level** — if test + page state matches previous run, skip Morph entirely
5. **Negotiate Morph pricing** — volume discounts for high-throughput usage

**Expected Impact:**
- 80-95% cost reduction on repeat runs (via caching bypass)
- 40-60% cost reduction on first runs (via step reduction + tiering)

---

## 7. Retry Strategies

### Retry Patterns

| Pattern | Description | Best For |
|---------|-------------|----------|
| **Immediate retry** | Re-execute immediately | Transient network errors |
| **Exponential backoff** | Double delay between retries | Rate limiting, server overload |
| **Selective retry** | Retry only failed step | Isolated UI flake |
| **Full test retry** | Re-run entire test | Environment-wide issues |

### Failure Classification Framework

```
Failure Type → Retry Strategy:

  NETWORK_ERROR (timeout, connection refused) → Retry with backoff (max 2)
  ELEMENT_NOT_FOUND (selector failed)        → Retry once (UI may be loading)
  ASSERTION_FAILURE (wrong text/state)        → NO retry (likely real bug)
  MORPH_TIMEOUT (task exceeded 600s)          → Retry once with higher timeout
  MORPH_ERROR (internal error)               → Retry once
  SANDBOX_ERROR (app crashed)                → Retry once (rebuild sandbox)
```

### Error Fingerprinting

Group similar errors to detect patterns:
- Stack trace similarity (strip dynamic content)
- Error message normalization (remove IDs, timestamps)
- Failure step + selector combination as fingerprint
- Same fingerprint across multiple tests → systemic issue, not individual flake

### Retry Budget

- Per-test limit: 2 retries maximum
- Per-run limit: no more than 20% of tests should be retried
- If >20% of tests need retries → likely systemic issue, abort and report
- Token bucket: burst of retries allowed, but rate-limited overall

### Implementation for skeptic

```python
class RetryPolicy:
    max_retries_per_test = 2
    max_retry_percentage = 0.20  # 20% of total tests

    def should_retry(self, failure):
        if failure.type == "ASSERTION_FAILURE":
            return False  # Real bug, don't retry
        if failure.type in ("NETWORK_ERROR", "MORPH_TIMEOUT"):
            return self.retries_remaining > 0
        if failure.type == "ELEMENT_NOT_FOUND":
            return self.retries_remaining > 0 and self.retry_count < 1
        return False

    def classify_failure(self, morph_result):
        if morph_result.status == "error":
            return "MORPH_ERROR"
        if morph_result.status == "failed":
            # Analyze last step to classify
            last_step = morph_result.steps[-1]
            if "timeout" in last_step.error.lower():
                return "MORPH_TIMEOUT"
            if "not found" in last_step.error.lower():
                return "ELEMENT_NOT_FOUND"
            return "ASSERTION_FAILURE"
```

**AI-Powered Failure Analysis (Future):**
- Send failure screenshot + DOM state to LLM
- Ask: "Is this a real bug or a flaky failure? Should we retry?"
- Use cheap model (Gemini Flash) for triage
- Log decision for model improvement

**Expected Impact:**
- Reduce false negatives (real bugs marked as flaky) by 60%
- Reduce unnecessary retries by 50%
- Average 1.1 runs per test (instead of current naive 2-3 retries)

---

## 8. Test Prioritization Algorithms

### Algorithm Comparison

| Algorithm | Type | Strengths | Weaknesses |
|-----------|------|-----------|------------|
| **Thompson Sampling** | Bayesian bandit | Adapts over time, balances explore/exploit | Requires history, cold start |
| **UCB1** | Confidence bound | Theoretical guarantees, simple | Assumes stationary distribution |
| **Failure-history** | Heuristic | Simple, effective, interpretable | Doesn't account for code changes |
| **Code-coverage** | Static analysis | Directly tied to changes | Requires instrumentation |
| **Time-based** | Sorting | Fast feedback, simple | Ignores failure likelihood |
| **RL (RETECS/ROCKET)** | Deep learning | Learns complex patterns | Training overhead, black box |

### Combined Priority Score

```python
def compute_priority(test, change_context):
    """Weighted multi-signal priority score."""

    # Failure history: recent failures weighted more
    failure_score = sum(
        (1 if run.failed else 0) * decay(run.age_days)
        for run in test.recent_runs[-20:]
    ) / len(test.recent_runs[-20:])

    # Code overlap: does this test cover changed files?
    overlap_score = len(
        set(test.covered_routes) & set(change_context.affected_routes)
    ) / max(len(test.covered_routes), 1)

    # Execution time: prefer fast tests for quick feedback
    speed_score = 1.0 / (test.avg_execution_seconds + 1)

    # Flakiness penalty: de-prioritize flaky tests
    flakiness_penalty = 1.0 - test.flakiness_score

    # Weighted combination
    priority = (
        0.35 * failure_score +
        0.30 * overlap_score +
        0.20 * speed_score +
        0.15 * flakiness_penalty
    )

    return priority
```

### Implementation for skeptic

**Phase 1: Simple Heuristic (Now)**
- Sort tests by: recently failed first → covers changed routes → fastest first
- Run top 50% immediately, queue remaining

**Phase 2: Thompson Sampling (After Enough Data)**
- Model each test as Beta(alpha, beta) where alpha=failures, beta=successes
- On each PR: sample from each test's distribution
- Run tests in order of sampled probability
- Update distributions after each run

**Phase 3: Time-Based Partitioning**
- Partition tests into "fast" (<30s) and "slow" (>30s)
- Run all fast tests first → report early results
- Then run slow tests → report complete results
- Developer gets 80% signal in first 2 minutes

**Expected Impact:**
- First-failure detection time: 10min → 2min
- Critical bugs caught in first 30% of test execution
- Optimal resource utilization (no wasted runs on stable tests)

---

## 9. Snapshot Testing (Fast Regression Alternative)

### When to Use Snapshots vs Full Browser Tests

| Scenario | Best Approach |
|----------|---------------|
| Component rendering check | DOM/Visual snapshot |
| Layout regression | Visual screenshot comparison |
| User interaction flow | Full browser test |
| Form submission + API | Full browser test |
| Static page content | DOM snapshot |
| Cross-browser rendering | Visual regression |

### Tool Landscape

| Tool | Type | Speed | AI-Powered |
|------|------|-------|------------|
| **Chromatic** | Visual (Storybook) | 100s of snapshots/min | No |
| **Percy** | Visual (cross-browser) | Fast, cloud-based | Yes (AI review agent) |
| **Applitools Eyes** | Visual AI | Fast | Yes (Visual AI) |
| **Playwright** | Built-in screenshot compare | Very fast | No |

### Performance Comparison

- **Full browser test**: ~4.7s per test (Playwright), 1.5-3min (AI-powered)
- **Visual snapshot**: milliseconds to few seconds
- **DOM snapshot**: milliseconds

Snapshot tests are 28-100x faster than full browser tests.

### Implementation for skeptic

**Phase 1: Post-Test Visual Baselines**
- After each successful AI test run, capture final-state screenshots
- Store as visual baselines per test case
- On subsequent runs, compare new screenshots against baselines
- If screenshot matches baseline → skip full AI execution, mark as passed

**Phase 2: Hybrid Regression Tier**
```
Tier 1 (Seconds):  Visual snapshot comparison for stable pages
Tier 2 (Seconds):  DOM snapshot for content verification
Tier 3 (Minutes):  Full AI browser test for interaction flows
```

Run Tier 1 on every commit, Tier 2 on PRs, Tier 3 on merge to main.

**Phase 3: LLM-Powered Visual Diff Analysis**
- When visual diff detected, send before/after screenshots to LLM
- Ask: "Is this an expected UI change or a regression?"
- Auto-approve expected changes, flag regressions

**Expected Impact:**
- 60-70% of regression checks handled by snapshots (seconds, not minutes)
- Full AI tests reserved for interaction-heavy scenarios
- Cost per regression check drops by 90%+ for snapshot-eligible tests

---

## 10. Hybrid Testing (AI + Deterministic)

### The Octomind Philosophy: "AI Doesn't Belong in Test Runtime"

Octomind's approach: use AI to **author** tests, then execute them deterministically as Playwright scripts. This eliminates runtime LLM costs and non-determinism.

### Hybrid Strategy for skeptic

**"Record with AI, Replay Deterministically":**

1. **AI Exploration Phase** (first run):
   - Morph executes test via CU (computer use)
   - Capture every action: selector, coordinates, input values, assertions
   - Store as structured action sequence

2. **Playwright Script Generation** (automated):
   - Convert action sequence to Playwright test code
   - Use resilient selectors (data-testid > aria-label > text content > CSS)
   - Include explicit waits and assertions

3. **Deterministic Execution** (subsequent runs):
   - Run generated Playwright script directly (no LLM needed)
   - ~5-10 seconds per test instead of 1.5-3 minutes
   - If Playwright script fails → fall back to AI execution
   - AI re-explores, generates updated script

4. **Self-Healing** (on failure):
   - When deterministic test breaks (selector changed, flow changed)
   - Auto-trigger AI re-exploration of the same test case
   - Generate updated Playwright script
   - No human intervention needed

### Test Maintenance Cost Comparison

| Approach | Creation Time | Maintenance Effort | Per-Run Cost | Reliability |
|----------|--------------|-------------------|-------------|-------------|
| Pure AI (Morph) | Minutes | None (self-healing) | High ($0.10-0.40) | Medium (non-deterministic) |
| Pure Playwright | Hours | High (selector updates) | Near-zero | High (deterministic) |
| **Hybrid (skeptic)** | Minutes (AI creates) | Low (AI self-heals) | Near-zero (95% cached) | High (deterministic + AI fallback) |

### Implementation for skeptic

**Architecture:**
```
Test Case Execution:
  ├── Check: Does deterministic script exist?
  │   ├── YES → Run Playwright script (5-10s, $0.00)
  │   │   ├── PASS → Done
  │   │   └── FAIL → Trigger AI re-exploration
  │   └── NO → Run via Morph AI (1.5-3min, $0.10-0.40)
  │       └── Generate Playwright script from actions
  │           └── Store for future runs
```

**Playwright Script Generation from Morph Actions:**
```javascript
// Generated from Morph AI execution
import { test, expect } from '@playwright/test';

test('Homepage hero and navigation', async ({ page }) => {
  await page.goto('https://app.example.com');
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.getByRole('link', { name: 'About' }).click();
  await expect(page).toHaveURL(/.*about/);
  await expect(page.getByText('Our Team')).toBeVisible();
});
```

**Expected Impact:**
- 95%+ of test runs execute deterministically (5-10s, near-zero cost)
- Only 5% of runs need AI exploration (new tests, broken scripts)
- Total per-test cost approaches $0.01 average (vs $0.10-0.40 for pure AI)
- Reliability increases (deterministic > AI for stable pages)

---

## Implementation Roadmap

### Phase 1: Quick Wins (Week 1-2)
- [ ] Inject animation-disabling CSS in Daytona sandboxes
- [ ] Reduce Morph max_steps for simple tests (30 → 15)
- [ ] Implement basic retry classification (don't retry assertion failures)
- [ ] Sort tests by recent failure rate before execution
- [ ] Track per-test execution time and failure history in DB

### Phase 2: Core Infrastructure (Week 3-6)
- [ ] Redis-based action cache with DOM fingerprinting
- [ ] Daytona warm sandbox pool (pre-provisioned, ready to deploy)
- [ ] Flaky test detection (statistical analysis over last 20 runs)
- [ ] Change-based test selection (PR diff → affected routes → test subset)
- [ ] Retry budget enforcement (max 20% of tests retried)

### Phase 3: Hybrid Execution (Week 7-10)
- [ ] Playwright script generation from Morph action sequences
- [ ] Deterministic replay for cached tests (skip Morph entirely)
- [ ] Self-healing: auto-regenerate broken deterministic scripts
- [ ] Visual baseline capture and comparison (snapshot tier)
- [ ] Two-tier execution: fast deterministic + slow AI

### Phase 4: Intelligence Layer (Week 11-16)
- [ ] Thompson Sampling for test prioritization
- [ ] ML-powered test selection (train on failure history + change data)
- [ ] AI-powered failure triage (is it a bug or a flake?)
- [ ] LLM-based visual diff analysis
- [ ] Cost dashboard: per-test, per-run, per-project cost tracking

---

## Competitive Analysis

| Capability | QA Wolf | Momentic | Octomind | **skeptic (Target)** |
|-----------|---------|----------|----------|---------------------|
| Parallel execution | Yes (K8s) | Limited | Yes | Yes (Temporal + Morph) |
| Action caching | No | Step cache | N/A (deterministic) | DOM fingerprint cache |
| Smart test selection | No | No | No | ML-powered (Phase 4) |
| Flaky detection | Manual | Basic | Basic | Statistical + ML |
| Hybrid execution | No | No | Yes (pure deterministic) | AI + deterministic |
| Self-healing | Basic | Yes | Basic | AI-powered fallback |
| Cost per test | ~$2-5 (managed) | ~$0.50 | ~$0.10 | ~$0.01-0.07 |
| Test creation time | Hours (coded) | Minutes (AI) | Minutes (AI) | Minutes (AI) |

**skeptic's differentiator: the full stack.** No competitor combines all 10 optimization vectors. Most focus on one or two. skeptic can own the "fast, cheap, reliable" positioning by systematically implementing this playbook.

---

## Key Metrics to Track

| Metric | Current | Phase 2 Target | Phase 4 Target |
|--------|---------|----------------|----------------|
| Avg test execution time | ~2 min | ~45s | ~15s |
| Cost per test | ~$0.30 | ~$0.10 | ~$0.02 |
| Flaky test rate | Unknown | <5% | <2% |
| Tests run per PR | 100% | 60% | 35% |
| Failure detection rate | ~100% | >95% | >97% |
| Time to first result | ~2 min | ~30s | ~10s |
| Parallel capacity | ~5 tests | ~20 tests | ~100 tests |

---

## References

### Caching & Deterministic Replay
- [Stagehand Caching Architecture](https://www.browserbase.com/blog/stagehand-caching)
- [Stagehand Caching Docs](https://docs.stagehand.dev/v3/best-practices/caching)
- [Momentic Step Cache](https://momentic.ai/docs/step-cache)
- [Octomind: AI Doesn't Belong in Test Runtime](https://octomind.dev/blog/ai-doesnt-belong-in-test-runtime/index.html)

### Parallel Execution
- [QA Wolf Parallel Infrastructure](https://www.qawolf.com/blog/how-qa-wolfs-parallel-infra-works)
- [Building a Browser Pool with Playwright](https://medium.com/@devcriston/building-a-robust-browser-pool-for-web-automation-with-playwright-2c750eb0a8e7)
- [BrowserStack Parallel Testing Guide](https://www.browserstack.com/guide/parallel-test-execution-automation)

### Smart Test Selection
- [Google TAP Paper](https://research.google.com/pubs/archive/45861.pdf)
- [Meta Predictive Test Selection](https://engineering.fb.com/2018/11/21/developer-tools/predictive-test-selection)
- [Launchable Predictive Test Selection](https://www.launchableinc.com/eng/predictive-test-selection-efficient-software-test-execution)
- [Martin Fowler: Rise of Test Impact Analysis](https://martinfowler.com/articles/rise-test-impact-analysis.html)

### Flaky Tests
- [Google: Flaky Tests and How We Mitigate Them](https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html)
- [Google De-Flake](https://research.google/pubs/de-flake-your-tests-automatically-locating-root-causes-of-flaky-tests-in-code-at-google)
- [Uber Flaky Tests Overhaul](https://www.uber.com/en-US/blog/flaky-tests-overhaul)
- [Atlassian Flakinator](https://www.atlassian.com/blog/atlassian-engineering/taming-test-flakiness-how-we-built-a-scalable-tool-to-detect-and-manage-flaky-tests)
- [Spotify Flaky Test Detection](https://trunk.io/learn/how-spotify-identifies-flaky-tests)

### Speed Optimization
- [Speed Up Playwright with Request Interception](https://www.checklyhq.com/blog/speed-up-playwright-scripts-request-interception)
- [Headless vs Headed Performance](https://latenode.com/blog/web-automation-scraping/headless-browser-overview/headless-vs-headed-browsers-differences-and-best-use-cases)
- [DOM Pruning (Prune4Web)](https://arxiv.org/html/2511.21398v1)

### Cost Optimization
- [Stagehand Cost Optimization](https://docs.stagehand.dev/v3/best-practices/cost-optimization)
- [Accessibility Tree Token Reduction](https://dev.to/kuroko1t/how-accessibility-tree-formatting-affects-token-cost-in-browser-mcps-n2a)
- [LLM Caching Best Practices](https://aws.amazon.com/blogs/database/optimize-llm-response-costs-and-latency-with-effective-caching)
- [Browser Use Agent Benchmarks](https://browser-use.com/posts/ai-browser-agent-benchmark)

### Retry Strategies
- [Playwright Retry Docs](https://playwright.dev/docs/test-retries)
- [Trivago E2E Retry Strategies](https://tech.trivago.com/post/2023-09-27-end-to-end-tests-retry-strategies)
- [Datadog Auto Test Retries](https://docs.datadoghq.com/tests/flaky_tests/auto_test_retries)
- [Error Fingerprinting (Sentry)](https://docs.sentry.io/concepts/data-management/event-grouping)

### Test Prioritization
- [Thompson Sampling Tutorial (Stanford)](https://web.stanford.edu/~bvr/pubs/TS_Tutorial.pdf)
- [UCB1 Algorithm](https://www.jeremykun.com/2013/10/28/optimism-in-the-face-of-uncertainty-the-ucb1-algorithm)
- [RETECS: RL for Test Selection](https://arxiv.org/abs/1811.04122)
- [History-Based Prioritization (HPI)](https://www.hirschfeld.org/writings/media/DuerschReinMattisHirschfeld_2022_LearningFromFailureAHistoryBasedLightweightTestPrioritizationTechniqueConnectingSoftwareChangesToTestFailures_HPI145.pdf)

### Visual/Snapshot Testing
- [Chromatic Visual Testing](https://www.chromatic.com/storybook)
- [Percy by BrowserStack](https://www.browserstack.com/percy)
- [Applitools Visual AI](https://applitools.com/platform/eyes)
- [Playwright Visual Comparisons](https://playwright.dev/docs/test-snapshots)

### Hybrid Testing
- [Docker cagent Deterministic AI Testing](https://www.docker.com/blog/deterministic-ai-testing-with-session-recording-in-cagent)
- [Playwright Codegen](https://playwright.dev/docs/codegen)
- [Self-Healing Test Automation (QA Wolf)](https://www.qawolf.com/blog/self-healing-test-automation-types)
- [Stagehand Deterministic Agent Scripts](https://docs.stagehand.dev/v3/best-practices/deterministic-agent)
