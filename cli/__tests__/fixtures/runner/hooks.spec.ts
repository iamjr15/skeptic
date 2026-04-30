import { test } from "skeptic-cli";

const order: string[] = [];

test.beforeEach(async () => {
  order.push("before");
});

test.afterEach(async () => {
  order.push("after");
});

test("hooks: a", async () => {
  order.push("a");
});

test("hooks: b", async () => {
  order.push("b");
  // Persist into globalThis so the integration test can inspect ordering. Workers
  // run with no shared memory with the main process; we round-trip through stdout.
  // eslint-disable-next-line no-console
  console.log(`HOOK_ORDER:${JSON.stringify(order)}`);
});
