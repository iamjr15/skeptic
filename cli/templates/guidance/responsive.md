---
name: responsive
description: Viewport adaptations, breakpoint behavior, and orientation correctness.
version: 1.0.0
---

# Responsive Testing Guidance

skeptic's `device:` metadata lets you emulate specific viewports. Use that plus cropped screenshot assertions for responsive-layout claims — don't try to test every breakpoint in one flow.

## Things worth asserting

- [ ] Primary navigation collapses to a menu button below the mobile breakpoint — assert both the button is visible and the full-nav list is NOT.
- [ ] Tap targets meet 44×44 px on mobile profiles even if they're smaller on desktop.
- [ ] Content doesn't require horizontal scroll at 320px wide (smallest practical mobile).
- [ ] Images use `srcset` / `<picture>` and the correct variant loads for the emulated DPR.
- [ ] Sticky headers respect `safe-area-inset-top` on notched devices (assert via `evalScript` reading the computed style).

## Flow patterns

One flow per critical breakpoint using `device:`:

```yaml
name: Nav on mobile
device: iphone_16
---
- navigate: /
- assertVisible: "[data-testid=hamburger]"
- assertNotVisible: "[data-testid=desktop-nav]"
- click: "[data-testid=hamburger]"
- assertVisible: "[data-testid=mobile-drawer]"
```

Orientation change via `travel:` — don't rely on DOM assertions alone, screenshot the before/after:

```yaml
- assertScreenshot: orientation-portrait.png
- travel: "landscape"
- assertScreenshot: orientation-landscape.png
```

## Red flags — file a bug

- Any element that sits outside the viewport at 320px after normal scroll.
- Content that overflows with `overflow: visible` + a wrapper with `overflow: hidden` — fragile clipping.
- Font sizes that don't scale via `clamp()` / viewport units between breakpoints — pixel-fixed typography reads as "broken" on small screens.
- Interactions that depend on hover state without a fallback (mobile has no hover).
