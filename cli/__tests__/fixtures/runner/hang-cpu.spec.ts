import { test } from "skeptic-cli";

test("hard-timeout CPU: spins forever", () => {
  // Synchronous infinite loop — Promise.race can't preempt this, so the main
  // process must terminate the worker after `hardTimeout + grace`.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    /* spin */
  }
});

test("hard-timeout CPU: never reached", async () => {
  // This test should be requeued in a fresh worker per plan §4.0.
});
