
import { test } from "skeptic-cli";
test("smoke", async ({ page }) => {
  await page.goto("/");
});
