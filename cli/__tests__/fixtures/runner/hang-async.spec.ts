import { test } from "skeptic-cli";

test("hard-timeout async: hangs forever", async () => {
  // Event-loop-yielding hang. Soft-timeout path closes the page; the page-close
  // surfaces as a Playwright error inside the runFn (not raw "test timeout" yet).
  await new Promise(() => {
    /* never resolves */
  });
});
