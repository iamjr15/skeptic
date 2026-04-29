import { test } from "skeptic-cli";

test("mcp smoke: trivial pass", async () => {
  // No browser interaction — exercises the runner's spec import + registration
  // path without needing a network hop, which is what list_tests/validate_tests
  // care about.
});
