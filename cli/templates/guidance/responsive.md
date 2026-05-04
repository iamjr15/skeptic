---
name: responsive
description: Viewport adaptations, breakpoint behavior, and orientation correctness.
version: 1.0.0
---

# Responsive Testing Guidance

Skeptic device profiles let you emulate specific viewports. Use `test.use({ device })` or CLI `--device` plus targeted screenshots for responsive-layout claims; don't try to test every breakpoint in one test.

## Things worth asserting

- [ ] Primary navigation collapses to a menu button below the mobile breakpoint — assert both the button is visible and the full-nav list is NOT.
- [ ] Tap targets meet 44×44 px on mobile profiles even if they're smaller on desktop.
- [ ] Content doesn't require horizontal scroll at 320px wide (smallest practical mobile).
- [ ] Images use `srcset` / `<picture>` and the correct variant loads for the emulated DPR.
- [ ] Sticky headers respect `safe-area-inset-top` on notched devices (assert via `evalScript` reading the computed style).

## Test patterns

One test per critical breakpoint:

```ts
test("nav on mobile", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("hamburger")).toBeVisible();
  await expect(page.getByTestId("desktop-nav")).toBeHidden();
  await page.getByTestId("hamburger").click();
  await expect(page.getByTestId("mobile-drawer")).toBeVisible();
}, { device: "iphone_16" });
```

Orientation changes should assert layout before and after:

```ts
await screenshot("orientation-portrait", { fullPage: true });
await page.setViewportSize({ width: 844, height: 390 });
await screenshot("orientation-landscape", { fullPage: true });
```

## Red flags — file a bug

- Any element that sits outside the viewport at 320px after normal scroll.
- Content that overflows with `overflow: visible` + a wrapper with `overflow: hidden` — fragile clipping.
- Font sizes that don't scale via `clamp()` / viewport units between breakpoints — pixel-fixed typography reads as "broken" on small screens.
- Interactions that depend on hover state without a fallback (mobile has no hover).
