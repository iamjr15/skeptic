import { describe, it, expect } from "vitest";
import { InvalidArgumentError } from "commander";
import { parsePositiveInt, parseNonNegativeInt } from "../../../src/index.js";

// Regression for #5: numeric flags (--retries, --timeout, --hard-timeout, --daemon-idle-timeout)
// used bare `parseInt`, which silently yields NaN on junk input. They now use validating parsers
// that throw InvalidArgumentError so bad values error clearly instead of poisoning arithmetic.

describe("parsePositiveInt (#5 — --timeout / --hard-timeout)", () => {
  it("accepts positive integers", () => {
    expect(parsePositiveInt("30000")).toBe(30000);
  });

  it("rejects zero", () => {
    expect(() => parsePositiveInt("0")).toThrow(InvalidArgumentError);
  });

  it("rejects non-numeric junk that parseInt would turn into NaN", () => {
    expect(() => parsePositiveInt("abc")).toThrow(InvalidArgumentError);
    expect(() => parsePositiveInt("12x")).toThrow(InvalidArgumentError);
  });

  it("rejects negatives", () => {
    expect(() => parsePositiveInt("-5")).toThrow(InvalidArgumentError);
  });
});

describe("parseNonNegativeInt (#5 — --retries / --daemon-idle-timeout)", () => {
  it("accepts zero (no retries / disabled idle timeout)", () => {
    expect(parseNonNegativeInt("0")).toBe(0);
  });

  it("accepts positive integers", () => {
    expect(parseNonNegativeInt("3")).toBe(3);
  });

  it("rejects non-numeric junk", () => {
    expect(() => parseNonNegativeInt("abc")).toThrow(InvalidArgumentError);
  });

  it("rejects negatives", () => {
    expect(() => parseNonNegativeInt("-1")).toThrow(InvalidArgumentError);
  });
});
