import { describe, it, expect } from "vitest";
import { buildCookieHostKeys } from "../../../src/cookies/chromium.js";

// Regression: cookie extraction must include the registrable parent-domain
// cookies a real browser would send (e.g. `.example.com` for `app.example.com`),
// not just the exact host and its own dotted form.
describe("buildCookieHostKeys", () => {
  it("includes the exact host, its domain cookie, and registrable parents", () => {
    expect(new Set(buildCookieHostKeys("app.example.com"))).toEqual(
      new Set(["app.example.com", ".app.example.com", ".example.com"]),
    );
  });

  it("walks every parent up to (but not including) the bare TLD", () => {
    expect(new Set(buildCookieHostKeys("a.b.example.com"))).toEqual(
      new Set([
        "a.b.example.com",
        ".a.b.example.com",
        ".b.example.com",
        ".example.com",
      ]),
    );
  });

  it("never emits a bare TLD key for a two-label host", () => {
    const keys = buildCookieHostKeys("example.com");
    expect(new Set(keys)).toEqual(new Set(["example.com", ".example.com"]));
    expect(keys).not.toContain(".com");
  });

  it("does not generate sibling or unrelated-domain keys", () => {
    const keys = buildCookieHostKeys("app.example.com");
    expect(keys).not.toContain("other.example.com");
    expect(keys).not.toContain(".other.example.com");
    expect(keys).not.toContain(".com");
  });

  it("normalizes a leading dot and case, and preserves single-label hosts", () => {
    expect(new Set(buildCookieHostKeys(".App.Example.com"))).toEqual(
      new Set(["app.example.com", ".app.example.com", ".example.com"]),
    );
    expect(new Set(buildCookieHostKeys("localhost"))).toEqual(
      new Set(["localhost", ".localhost"]),
    );
  });

  it("returns no keys for an empty domain", () => {
    expect(buildCookieHostKeys("")).toEqual([]);
    expect(buildCookieHostKeys(".")).toEqual([]);
  });
});
