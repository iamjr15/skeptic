// Smoke test for the B1 runner. Hits a static page so the run is deterministic.
import { test, expect } from "skeptic-cli";

test("smoke: example.com loads", async ({ page }) => {
  await page.goto("https://example.com");
  await expect(page).toHaveTitle(/Example Domain/);
});
