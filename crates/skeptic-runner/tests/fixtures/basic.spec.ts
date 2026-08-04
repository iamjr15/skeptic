import { expect, test } from "skeptic-cli";

test("value matchers execute in TypeScript", () => {
  const answer: number = 42;
  expect(answer).toBe(42);
  expect(["web", "mobile"]).toContain("mobile");
});

test.skip("skips are represented", () => {});
