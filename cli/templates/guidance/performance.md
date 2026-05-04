---
name: performance
description: Latency budgets, observable jank, and network-boundary checks for E2E runs.
version: 1.0.0
---

# Performance Testing Guidance

For threshold assertions on Core Web Vitals (FCP, LCP, CLS, INP, TTFB) during a test run, use `observability.expectPerformance(...)`. It captures `web-vitals` metrics from the page and asserts against your thresholds. See the README's Observability section.

Performance assertions belong in E2E only when they check user-observable thresholds, not lab metrics.

## Things worth asserting

- [ ] Interaction-to-Next-Paint (INP) is under 200ms for primary actions. Capture via `observability.expectPerformance({ inp: "<200ms" })` when the browser reports it.
- [ ] Response to input within 400ms (Doherty threshold) — extend action timeout only when the test genuinely awaits work, not to mask slowness.
- [ ] Page-level waits don't exceed 5s in staging with warm cache. Longer means you're testing something other than the UI.
- [ ] Time-to-interactive hooks exist: assert a known element becomes clickable, not just that DOM loaded.

## Test patterns

Measure, don't estimate:

```ts
await page.goto("/dashboard");
await observability.expectPerformance({ lcp: "<2500ms", cls: "<0.1" });
await ai.assert("The dashboard's first meaningful content is visible, not a skeleton loader.");
```

For flaky network-bound tests, prefer `--retries <n>` or focused waiting on the resulting UI over bumping timeouts indefinitely.

## Red flags — file a bug

- Any step requiring `timeout: 30000+` for a staging environment — indicates a real regression, not a flaky test.
- Waiting on a spinner element instead of the downstream content that's supposed to appear.
- `page.waitForTimeout(...)` as a synchronization primitive. Convert to `expect(locator).toBeVisible()` or another state-based wait.
- Layout shift during the first 2.5s after navigate (assert via an AI step that reports visible CLS-adjacent movement).
