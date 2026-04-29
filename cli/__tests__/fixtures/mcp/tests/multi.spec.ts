import { test } from "skeptic-cli";

// Multi-test fixture for the MCP run_test name-filter assertion. Each test
// writes its name to a sentinel file so the test harness can verify only the
// requested test ran.

test("multi: alpha", async () => {
  // intentionally trivial
});

test("multi: beta", async () => {
  // intentionally trivial
});
