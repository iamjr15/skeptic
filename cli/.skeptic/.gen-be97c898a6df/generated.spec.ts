
import { test } from "skeptic-cli";
const x: number = "not a number";
test("broken", async ({ page }) => { await page.goto("/"); });
