import { test } from "skeptic-cli";

test.use({ session: "shared-session", platform: "android", device: "emulator-5554", app: "dev.skeptic.fixture" });

test("routes through the selected session", ({ page }) => {
  page.open("dev.skeptic.fixture");
});
