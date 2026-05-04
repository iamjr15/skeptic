---
name: accessibility
description: WCAG-adjacent quality checks — visible focus, hit targets, keyboard reachability, ARIA hygiene.
version: 1.0.0
---

# Accessibility Testing Guidance

For automated WCAG checks during a test run, use `observability.expectAccessible(...)` — it runs axe-core and, when available, IBM Equal Access against the live page and surfaces violations as test failures. See the README's Observability section.

Use the checks below alongside `ai.assertNoDefects()` or `ai.assert(...)` when your test touches interactive surfaces.

## Things worth asserting

- [ ] Every interactive target is at least 44×44 px (tap) or 24×24 css-px with 8px spacing (pointer).
- [ ] `aria-label` or visible text exists on every `button`, `a`, `[role="button"]` the test touches.
- [ ] Focus is visible after Tab: assert `:focus-visible` styles apply, not just that `document.activeElement` changed.
- [ ] Forms have a `<label>` (or `aria-label`) wired to each input.
- [ ] Error messages live in `[role="alert"]` or `aria-live="polite"` so screen readers announce them.
- [ ] Modal traps focus inside itself — Tab from the last focusable element lands on the first, not outside.

## Test patterns

Keyboard-only reachability:

```ts
await page.keyboard.press("Tab");
await expect(page.locator("[data-testid=cta]:focus-visible")).toBeVisible();
await page.keyboard.press("Enter");
await expect(page.getByRole("dialog")).toBeVisible();
```

Avoid `locator.click()` on controls meant to be keyboard-activated — use
`page.keyboard.press("Enter")` after focus so broken keyboard handlers do not pass.

## Red flags — file a bug

- An interactive element with `role="button"` but no `tabindex` (not keyboard-reachable).
- `aria-hidden="true"` on a container that holds focusable children (screen readers announce nothing, keyboard still reaches them → inconsistent).
- Focus lands on `<body>` after a modal closes — means the opener wasn't re-focused.
- Inputs without visible labels, using placeholder-as-label (disappears on focus, poor for AT).
