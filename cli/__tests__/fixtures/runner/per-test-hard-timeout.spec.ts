import { test } from "skeptic-cli";

test(
  "per-test hard timeout override",
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  },
  { hardTimeout: 1_000 },
);
