---
name: accessibility
description: WCAG-adjacent quality checks — visible focus, hit targets, keyboard reachability, ARIA hygiene.
version: 1.0.0
---

# Accessibility Testing Guidance

For automated WCAG checks during a test run, use the `accessibilityAudit:` step handler — it runs axe-core (and optionally IBM Equal Access) against the live page and surfaces violations as step failures. See the README's Observability section.

Use the checks below alongside `assertNoDefects` or `assertWithAI` when your flow touches interactive surfaces.

## Things worth asserting

- [ ] Every interactive target is at least 44×44 px (tap) or 24×24 css-px with 8px spacing (pointer).
- [ ] `aria-label` or visible text exists on every `button`, `a`, `[role="button"]` the flow touches.
- [ ] Focus is visible after Tab: assert `:focus-visible` styles apply, not just that `document.activeElement` changed.
- [ ] Forms have a `<label>` (or `aria-label`) wired to each input.
- [ ] Error messages live in `[role="alert"]` or `aria-live="polite"` so screen readers announce them.
- [ ] Modal traps focus inside itself — Tab from the last focusable element lands on the first, not outside.

## Flow patterns

Keyboard-only reachability:

```yaml
- press: Tab
- assertVisible: "[data-testid=cta]:focus-visible"
- press: Enter
- assertVisible: "[role=dialog]"
```

Avoid `click:` on links meant to be keyboard-activated — use `press: Enter` after focus so broken keyboard handlers don't pass.

## Red flags — file a bug

- An interactive element with `role="button"` but no `tabindex` (not keyboard-reachable).
- `aria-hidden="true"` on a container that holds focusable children (screen readers announce nothing, keyboard still reaches them → inconsistent).
- Focus lands on `<body>` after a modal closes — means the opener wasn't re-focused.
- Inputs without visible labels, using placeholder-as-label (disappears on focus, poor for AT).
