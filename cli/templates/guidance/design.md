---
name: design
description: Visual correctness — layout integrity, typography, and spacing claims provable in E2E.
version: 1.0.0
---

# Design Testing Guidance

E2E is the right place for layout-integrity checks; it's the wrong place for pixel-perfect screenshot diffing of every page.

## Things worth asserting

- [ ] Primary CTA is visible without scroll on the target viewport (use `device:` metadata + `assertVisible`).
- [ ] Text doesn't overflow its container — screen-dimension edge cases on long strings (German, tokens with no break points).
- [ ] Z-index ordering holds: modal above page chrome, toast above modal, dropdown above sticky header.
- [ ] Hover / active / focus states don't collapse the layout (no shift on interaction).

## Flow patterns

Visual regression on a key component, not the whole page:

```yaml
- navigate: /checkout
- assertScreenshot:
    path: checkout-cta.png
    cropOn: "[data-testid=primary-cta]"
    threshold: 0.02
```

For text-overflow checks, use `assertWithAI` with a specific prompt — deterministic DOM assertions miss rendered ellipsis/clipping:

```yaml
- assertWithAI:
    assertion: "The product title is fully visible (no '...' truncation) within its card."
```

## Red flags — file a bug

- Horizontal scrollbars on the target viewport (any form of `overflow-x: scroll` on body or main).
- Touch targets within 8px of each other on a mobile profile.
- Elements with `display: none` but still taking DOM space during measurement — suggests reflow timing issue.
- Color combinations where contrast ratio falls below 4.5:1 for body text (flag for a11y review too).
