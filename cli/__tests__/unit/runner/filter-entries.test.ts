import { describe, it, expect } from "vitest";
import { filterEntries, type ManifestEntry } from "../../../src/runner/index.js";

const entry = (name: string, extra: Partial<ManifestEntry> = {}): ManifestEntry => ({
  id: `f.spec.ts#${name}`,
  file: "f.spec.ts",
  ordinal: 0,
  name,
  skip: false,
  only: false,
  use: {},
  ...extra,
});

describe("filterEntries — name filter (-t/--grep substring)", () => {
  const entries = [entry("login flow"), entry("logout flow"), entry("checkout")];

  it("keeps tests whose name CONTAINS the substring (not exact match)", () => {
    const kept = filterEntries(entries, undefined, ["log"]).map((e) => e.name);
    expect(kept).toEqual(["login flow", "logout flow"]);
  });

  it("matches a multi-word substring", () => {
    expect(filterEntries(entries, undefined, ["out flow"]).map((e) => e.name)).toEqual(["logout flow"]);
  });

  it("returns nothing when no name contains the substring (so a typo'd grep exits empty)", () => {
    expect(filterEntries(entries, undefined, ["nope"])).toHaveLength(0);
  });

  it("an empty/undefined name filter keeps everything", () => {
    expect(filterEntries(entries, undefined, undefined)).toHaveLength(3);
    expect(filterEntries(entries, undefined, [])).toHaveLength(3);
  });

  it("is case-sensitive (mirrors vitest/playwright -t)", () => {
    expect(filterEntries(entries, undefined, ["LOGIN"])).toHaveLength(0);
  });

  it("applies the name filter first, then focuses test.only among the survivors", () => {
    const withOnly = [entry("login basic"), entry("login special", { only: true }), entry("checkout")];
    // "login" keeps the two login tests; .only then focuses just the special one.
    expect(filterEntries(withOnly, undefined, ["login"]).map((e) => e.name)).toEqual(["login special"]);
    // A .only test excluded by the name filter does not run (filter wins over focus).
    expect(filterEntries(withOnly, undefined, ["checkout"]).map((e) => e.name)).toEqual(["checkout"]);
  });
});
