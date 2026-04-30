import { test } from "skeptic-cli";

// B8 fixture — declare a `videoSize` override via `test.use`. The runner
// integration test asserts the produced WebM is exactly 1920x1080 even
// though the viewport is the default (1280x720).
test.use({ videoSize: { width: 1920, height: 1080 } });

test("video-size: 1920x1080 webm", async ({ page }) => {
  await page.goto("data:text/html,<h1>video-size fixture</h1>");
});
