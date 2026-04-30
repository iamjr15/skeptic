---
name: performance
description: Latency budgets, observable jank, and network-boundary checks for E2E runs.
version: 1.0.0
---

# Performance Testing Guidance

For threshold assertions on Core Web Vitals (FCP, LCP, CLS, INP, TTFB) during a test run, use the `assertPerformance:` step handler — it captures `web-vitals` metrics from the page and asserts against your thresholds. See the README's Observability section.

Performance assertions belong in E2E only when they check user-observable thresholds, not lab metrics.

## Things worth asserting

- [ ] Interaction-to-Next-Paint (INP) is under 200ms for primary actions. Capture with `evalScript` + PerformanceObserver and assert against a budget.
- [ ] Response to input within 400ms (Doherty threshold) — extend step `timeout` only when the flow genuinely awaits work, not to mask slowness.
- [ ] Page-level waits don't exceed 5s in staging with warm cache. Longer means you're testing something other than the UI.
- [ ] Time-to-interactive hooks exist: assert a known element becomes clickable, not just that DOM loaded.

## Flow patterns

Measure, don't estimate:

```yaml
- navigate: /dashboard
- evalScript: |
    const entries = performance.getEntriesByType('navigation');
    return entries[0].domInteractive;
- assertWithAI:
    assertion: "The dashboard's first meaningful content (e.g. widget headers) is visible, not a skeleton loader."
```

For flaky network-bound flows, prefer `retry:` with a bounded `maxRetries` over bumping `timeout` indefinitely.

## Red flags — file a bug

- Any step requiring `timeout: 30000+` for a staging environment — indicates a real regression, not a flaky test.
- Waiting on a spinner element instead of the downstream content that's supposed to appear.
- `wait: <n>` as a synchronization primitive (fixed sleep). Always convert to `waitForElement` or `assertVisible`.
- Layout shift during the first 2.5s after navigate (assert via an AI step that reports visible CLS-adjacent movement).
