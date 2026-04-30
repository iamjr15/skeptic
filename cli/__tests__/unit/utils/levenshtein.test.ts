import { describe, it, expect } from "vitest";
import { levenshtein, findSimilar } from "../../../src/utils/levenshtein.js";

describe("levenshtein", () => {
  it("returns 0 for equal strings", () => {
    expect(levenshtein("foo", "foo")).toBe(0);
  });

  it("returns length for empty inputs", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("", "")).toBe(0);
  });

  it("handles single-char diffs", () => {
    expect(levenshtein("click", "clik")).toBe(1);
    expect(levenshtein("click", "clicks")).toBe(1);
    expect(levenshtein("click", "blick")).toBe(1);
  });

  it("handles transpositions as distance 2", () => {
    expect(levenshtein("ab", "ba")).toBe(2);
  });

  it("handles totally different strings", () => {
    expect(levenshtein("abc", "xyz")).toBe(3);
  });
});

describe("findSimilar", () => {
  const commands = [
    "navigate",
    "click",
    "type",
    "assertVisible",
    "assertNotVisible",
    "scroll",
  ] as const;

  it("finds a single close match", () => {
    expect(findSimilar("clik", commands)).toEqual(["click"]);
  });

  it("finds multiple matches, sorted by distance", () => {
    // "assertVisible" matches at distance 0 (exact).
    // "assertNotVisible" matches at distance 3 (insert "Not"), within default threshold.
    const matches = findSimilar("assertVisible", commands);
    expect(matches[0]).toBe("assertVisible");
    expect(matches).toContain("assertNotVisible");
    expect(matches.indexOf("assertVisible")).toBeLessThan(matches.indexOf("assertNotVisible"));
  });

  it("returns exact match at distance 0 first", () => {
    const matches = findSimilar("click", commands);
    expect(matches[0]).toBe("click");
  });

  it("returns empty when no match within threshold", () => {
    expect(findSimilar("xyzqwerty", commands)).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(findSimilar("CLICK", commands)).toContain("click");
  });

  it("respects a custom threshold", () => {
    // "foobar" vs "navigate" is 7 edits
    expect(findSimilar("foobar", ["navigate"], 2)).toEqual([]);
    expect(findSimilar("foobar", ["navigate"], 10)).toContain("navigate");
  });

  it("returns substring matches for inputs ≥ 3 chars even past threshold", () => {
    const pool = ["assertVisible"];
    // "Visible" is a substring of "assertVisible"; distance is 6 (past default threshold 3)
    expect(findSimilar("Visible", pool)).toContain("assertVisible");
  });

  it("skips substring match for inputs < 3 chars", () => {
    // "a" is a substring of many commands, but we only fire substring match at len ≥ 3
    expect(findSimilar("a", ["navigate"])).toEqual([]);
  });

  it("de-duplicates identical candidates", () => {
    // Candidate list contains duplicates; findSimilar keeps each once.
    const pool = ["click", "click", "type"];
    expect(findSimilar("clik", pool)).toEqual(["click"]);
  });
});
