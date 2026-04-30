---
name: react
description: React-specific pitfalls observable from E2E — hydration mismatches, key collisions, stale effects.
version: 1.0.0
---

# React Testing Guidance

E2E sees React as a black box, but a handful of pathologies show up as user-visible bugs that deterministic DOM assertions miss.

## Things worth asserting

- [ ] No hydration mismatches: after `navigate`, the first pass should not visibly flicker between two DOMs. Use `assertScreenshot` with a tight `threshold` on the hero area before any interaction.
- [ ] Keys in lists are stable across re-renders — add a flow that triggers a filter change and assert items retain their expected state (checked checkbox, focused input).
- [ ] Suspense fallbacks disappear once data arrives, AND don't flash when navigating between already-cached routes.
- [ ] Errors caught by an error boundary render a specific fallback UI, not a blank screen.

## Flow patterns

Check that state survives a re-render:

```yaml
- type:
    selector: "[data-testid=search]"
    value: "foo"
- click: "[data-testid=filter-active]"  # triggers re-render
- assertText:
    selector: "[data-testid=search]"
    text: "foo"
```

Verify an error boundary:

```yaml
- click: "[data-testid=trigger-error]"
- assertVisible: "[data-testid=error-boundary-fallback]"
- assertNotVisible: "[data-testid=raw-error-screen]"
```

For route-transition bugs (stale effects persisting), navigate away and back, then assert no duplicate elements:

```yaml
- navigate: /profile
- navigate: /home
- navigate: /profile
- evalScript: |
    return document.querySelectorAll('[data-testid=profile-header]').length;
# Assert the result is 1, not 2 or more.
```

## Red flags — file a bug

- Any `setState` visible as a two-frame flicker (render → microtask → render) — usually a missing `useMemo` or a stale closure.
- Controlled inputs that lag by one keystroke (state-update bug or ref mismatch).
- `key={index}` on lists that can reorder — unexplained UI state corruption after filter changes.
- Portal-rendered content that survives its parent unmount (leaked modal).
