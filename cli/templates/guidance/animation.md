---
name: animation
description: Timing, transitions, and reduced-motion checks to make animated UI provable in E2E tests.
version: 1.0.0
---

# Animation Testing Guidance

Animations are where flaky E2E tests breed. Assert what's stable, not what's moving.

## Things worth asserting

- [ ] Element reaches its final state within 500ms of the trigger. Use `waitForElement` with an explicit `timeout`, not a fixed `wait:` sleep.
- [ ] Transitions respect `prefers-reduced-motion`: if the test environment sets it, motion duration collapses to ≤10ms.
- [ ] Enter animations complete before the next interaction is allowed (no click-through on fade-in modals).
- [ ] Exit animations don't leave ghost elements behind — assert `assertNotVisible` after dismissal, not just "clicked the X".

## Flow patterns

Wait for the final state, not the start:

```yaml
- click: "[data-testid=open-modal]"
- waitForElement: "[data-testid=modal]:not(.entering)"
- assertVisible: "[data-testid=modal-title]"
```

For reduced-motion suites, set the media query via Playwright config (browser emulation) and assert the "no motion" path — do NOT `wait: 50` to approximate a fast animation.

## Red flags — file a bug

- Any animation longer than 400ms on a user-initiated interaction (Doherty threshold).
- Elements with a visible transition but no `transition-property` — implies JS-driven animation; harder to interrupt cleanly on navigation.
- `pointer-events: none` lingering after an animation ends — blocks clicks on what looks interactive.
- Missing `@media (prefers-reduced-motion: reduce)` block at all.
