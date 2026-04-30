import { test } from "skeptic-cli";

test("sidecar: collectors attached", async ({ page }) => {
  await page.goto("data:text/html,<h1>sidecar fixture</h1>");
});
