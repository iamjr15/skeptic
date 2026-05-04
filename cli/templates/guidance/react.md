---
name: react
description: React-specific pitfalls observable from E2E — hydration mismatches, key collisions, stale effects.
version: 1.0.0
---

# React Testing Guidance

E2E sees React as a black box, but a handful of pathologies show up as user-visible bugs that deterministic DOM assertions miss.

## Things worth asserting

- [ ] No hydration mismatches: after `page.goto`, the first pass should not visibly flicker between two DOMs. Use targeted screenshots around the hero area before any interaction.
- [ ] Keys in lists are stable across re-renders — add a test that triggers a filter change and assert items retain their expected state (checked checkbox, focused input).
- [ ] Suspense fallbacks disappear once data arrives, AND don't flash when navigating between already-cached routes.
- [ ] Errors caught by an error boundary render a specific fallback UI, not a blank screen.

## Test patterns

Check that state survives a re-render:

```ts
await page.getByTestId("search").fill("foo");
await page.getByTestId("filter-active").click();
await expect(page.getByTestId("search")).toHaveValue("foo");
```

Verify an error boundary:

```ts
await page.getByTestId("trigger-error").click();
await expect(page.getByTestId("error-boundary-fallback")).toBeVisible();
await expect(page.getByTestId("raw-error-screen")).toBeHidden();
```

For route-transition bugs (stale effects persisting), navigate away and back, then assert no duplicate elements:

```ts
await page.goto("/profile");
await page.goto("/home");
await page.goto("/profile");
await expect(page.getByTestId("profile-header")).toHaveCount(1);
```

## Red flags — file a bug

- Any `setState` visible as a two-frame flicker (render → microtask → render) — usually a missing `useMemo` or a stale closure.
- Controlled inputs that lag by one keystroke (state-update bug or ref mismatch).
- `key={index}` on lists that can reorder — unexplained UI state corruption after filter changes.
- Portal-rendered content that survives its parent unmount (leaked modal).
