import { test } from "skeptic-cli";

// Top-level type error — `validate_tests` should surface this as a TS diagnostic.
const intentionalTypeError: number = "this is not a number";

test("broken spec: never runs", async () => {
  void intentionalTypeError;
});
