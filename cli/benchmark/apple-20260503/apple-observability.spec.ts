import { test, expect } from "skeptic-cli";

test.use({
  viewport: { width: 1440, height: 1000 },
  timeout: 20_000,
  hardTimeout: 90_000,
});

test("apple.com observability parity smoke", async ({
  page,
  snapshot,
  screenshot,
  settle,
  observability,
}) => {
  await page.goto("https://www.apple.com/", { waitUntil: "domcontentloaded" });
  await settle();

  await page
    .getByRole("button", { name: /Close country or region selector/i })
    .click({ timeout: 3_000 })
    .catch(() => {});

  await expect(page).toHaveTitle(/Apple/);

  const homeTree = await snapshot(page, { compact: true });
  await expect(homeTree.byRole("navigation", { name: /Global/i })).toBeVisible();
  await expect(homeTree.byRole("link", { name: "iPhone", index: 0 })).toBeVisible();

  await screenshot("01-home", { fullPage: false });
  await screenshot("02-home-annotated", { annotate: true, fullPage: false });

  await homeTree.byRole("link", { name: "iPhone", index: 0 }).click();
  await page.waitForURL(/\/iphone\/?/, { timeout: 20_000 });
  await settle();

  const iphoneTree = await snapshot(page, { compact: true });
  await expect(iphoneTree.byRole("heading", { name: /iPhone/i, index: 0 })).toBeVisible();
  await screenshot("03-iphone", { fullPage: false });

  const obs = await observability.snapshot();
  expect(obs.performance, "performance collector should produce a snapshot").toBeTruthy();
  expect(obs.network, "network collector should produce a snapshot").toBeTruthy();
  expect(obs.console, "console collector should produce a snapshot").toBeTruthy();
});
