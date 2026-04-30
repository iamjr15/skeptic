import { test } from "skeptic-cli";

test("skip-only: plain", async () => {});
test.skip("skip-only: skipped", async () => {});
test("skip-only: another", async () => {});
