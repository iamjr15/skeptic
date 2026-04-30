import { describe, expect, it } from "vitest";
import { parseThreshold, checkThreshold } from "../../../src/observability/assert-parser.js";

describe("parseThreshold", () => {
  it("parses time thresholds with seconds suffix", () => {
    const t = parseThreshold("<2.5s", "ms");
    expect(t).toEqual({ operator: "<", value: 2500, raw: "<2.5s" });
  });

  it("parses time thresholds with ms suffix", () => {
    const t = parseThreshold("<200ms", "ms");
    expect(t).toEqual({ operator: "<", value: 200, raw: "<200ms" });
  });

  it("parses bare numeric as ms for time metrics", () => {
    const t = parseThreshold("<=500", "ms");
    expect(t).toEqual({ operator: "<=", value: 500, raw: "<=500" });
  });

  it("parses unitless thresholds for CLS", () => {
    const t = parseThreshold("<0.1", "unitless");
    expect(t).toEqual({ operator: "<", value: 0.1, raw: "<0.1" });
  });

  it("accepts all five operators", () => {
    for (const op of ["<", "<=", ">", ">=", "="] as const) {
      const t = parseThreshold(`${op}100ms`, "ms");
      expect(t.operator).toBe(op);
      expect(t.value).toBe(100);
    }
  });

  it("tolerates whitespace around operator and value", () => {
    const t = parseThreshold("<  2.5s  ", "ms");
    expect(t.value).toBe(2500);
  });

  it("throws on malformed input", () => {
    expect(() => parseThreshold("foo", "ms")).toThrow(/Invalid threshold/);
    expect(() => parseThreshold("2.5s", "ms")).toThrow(/Invalid threshold/);
    expect(() => parseThreshold("<abc", "ms")).toThrow(/Invalid threshold/);
  });

  it("throws when unitless metric has a unit suffix", () => {
    expect(() => parseThreshold("<0.1ms", "unitless")).toThrow(/should not have a unit/);
  });

  it("throws on unsupported unit", () => {
    expect(() => parseThreshold("<2.5min", "ms")).toThrow(/Invalid threshold/);
  });
});

describe("checkThreshold", () => {
  const t = (raw: string, unit: "ms" | "unitless" = "ms") => parseThreshold(raw, unit);

  it("< is strict less-than", () => {
    expect(checkThreshold(2499, t("<2.5s"))).toBe(true);
    expect(checkThreshold(2500, t("<2.5s"))).toBe(false);
  });

  it("<= is inclusive", () => {
    expect(checkThreshold(2500, t("<=2.5s"))).toBe(true);
    expect(checkThreshold(2501, t("<=2.5s"))).toBe(false);
  });

  it("> is strict greater-than", () => {
    expect(checkThreshold(2501, t(">2.5s"))).toBe(true);
    expect(checkThreshold(2500, t(">2.5s"))).toBe(false);
  });

  it(">= is inclusive", () => {
    expect(checkThreshold(2500, t(">=2.5s"))).toBe(true);
    expect(checkThreshold(2499, t(">=2.5s"))).toBe(false);
  });

  it("= is exact equality", () => {
    expect(checkThreshold(2500, t("=2.5s"))).toBe(true);
    expect(checkThreshold(2499, t("=2.5s"))).toBe(false);
  });

  it("works with unitless values", () => {
    expect(checkThreshold(0.09, t("<0.1", "unitless"))).toBe(true);
    expect(checkThreshold(0.1, t("<0.1", "unitless"))).toBe(false);
  });
});
