import { expect, test } from "skeptic-cli";

test("real timers fire and cancellation is respected", async () => {
  let fired = false;
  setTimeout(() => {
    fired = true;
  }, 5);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  expect(fired).toBe(true);

  let cancelled = false;
  const timer = setTimeout(() => {
    cancelled = true;
  }, 5);
  clearTimeout(timer);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  expect(cancelled).toBe(false);
});
