// Example skeptic test. See https://github.com/iamjr15/skeptic for the full API.
import { test, expect } from "skeptic-cli";

test("homepage smoke", async ({ page, snapshot, observability, screenshot }) => {
  await page.goto("https://example.com");

  // Standard Playwright assertions are re-exported.
  await expect(page).toHaveTitle(/Example Domain/);

  // Snapshot returns an ARIA-tree primitive with ref-based locator helpers —
  // the same pattern AI agents use to discover element shapes.
  const tree = await snapshot(page);
  await expect(tree.byRole("heading", { name: "Example Domain" })).toBeVisible();

  // Observability assertions are opt-in via `--observability` or test.use.
  // Uncomment when you have collectors attached:
  // await observability.expectPerformance({ lcp: "<2500ms", cls: "<0.1" });

  await screenshot("homepage", { fullPage: true });
});
