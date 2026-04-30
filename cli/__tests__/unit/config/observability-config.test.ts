import { describe, expect, it } from "vitest";
import { skepticConfigSchema } from "../../../src/config/schema.js";

describe("observability config schema", () => {
  it("applies defaults when observability block is absent", () => {
    const parsed = skepticConfigSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.observability).toEqual({
      collectors: [],
      networkCaptureLimit: 500,
      duplicateWindowMs: 500,
      accessibilityDualEngine: false,
      accessibilityHtmlSnippetLimit: 500,
      defaultsForReports: "passive",
      consoleCaptureLimit: 200,
      consoleRedaction: true,
      autoAccessibilityAudit: false,
      accessibilityStandard: "WCAG21AA",
      fullPageScreenshots: false,
      blankFrameDetection: "warn",
    });
  });

  it("accepts valid collector names", () => {
    const parsed = skepticConfigSchema.safeParse({
      observability: { collectors: ["performance", "network", "accessibility"] },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.observability.collectors).toEqual([
      "performance",
      "network",
      "accessibility",
    ]);
  });

  it("rejects invalid collector names", () => {
    const parsed = skepticConfigSchema.safeParse({
      observability: { collectors: ["bogus"] },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects negative networkCaptureLimit", () => {
    const parsed = skepticConfigSchema.safeParse({
      observability: { networkCaptureLimit: -1 },
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts networkCaptureLimit: 0 as 'unlimited'", () => {
    const parsed = skepticConfigSchema.safeParse({
      observability: { networkCaptureLimit: 0 },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.observability.networkCaptureLimit).toBe(0);
  });

  it("rejects non-positive duplicateWindowMs", () => {
    const zero = skepticConfigSchema.safeParse({
      observability: { duplicateWindowMs: 0 },
    });
    const neg = skepticConfigSchema.safeParse({
      observability: { duplicateWindowMs: -5 },
    });
    expect(zero.success).toBe(false);
    expect(neg.success).toBe(false);
  });

  it("rejects negative accessibilityHtmlSnippetLimit", () => {
    const parsed = skepticConfigSchema.safeParse({
      observability: { accessibilityHtmlSnippetLimit: -5 },
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts accessibilityHtmlSnippetLimit: 0 (suppress)", () => {
    const parsed = skepticConfigSchema.safeParse({
      observability: { accessibilityHtmlSnippetLimit: 0 },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.observability.accessibilityHtmlSnippetLimit).toBe(0);
  });

  it("accepts custom values across the block", () => {
    const parsed = skepticConfigSchema.safeParse({
      observability: {
        collectors: ["performance"],
        networkCaptureLimit: 1000,
        duplicateWindowMs: 200,
        accessibilityDualEngine: true,
        accessibilityHtmlSnippetLimit: 100,
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.observability).toEqual({
      collectors: ["performance"],
      networkCaptureLimit: 1000,
      duplicateWindowMs: 200,
      accessibilityDualEngine: true,
      accessibilityHtmlSnippetLimit: 100,
      defaultsForReports: "passive",
      consoleCaptureLimit: 200,
      consoleRedaction: true,
      autoAccessibilityAudit: false,
      accessibilityStandard: "WCAG21AA",
      fullPageScreenshots: false,
      blankFrameDetection: "warn",
    });
  });

  it("accepts the new defaults knobs", () => {
    const parsed = skepticConfigSchema.safeParse({
      observability: {
        defaultsForReports: "full",
        consoleCaptureLimit: 50,
        consoleRedaction: false,
        autoAccessibilityAudit: true,
        accessibilityStandard: "WCAG22AA",
        accessibilityImpacts: ["critical"],
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.observability.defaultsForReports).toBe("full");
    expect(parsed.data.observability.consoleCaptureLimit).toBe(50);
    expect(parsed.data.observability.consoleRedaction).toBe(false);
    expect(parsed.data.observability.autoAccessibilityAudit).toBe(true);
    expect(parsed.data.observability.accessibilityStandard).toBe("WCAG22AA");
  });

  it("accepts 'console' as a collector name", () => {
    const parsed = skepticConfigSchema.safeParse({
      observability: { collectors: ["console"] },
    });
    expect(parsed.success).toBe(true);
  });
});
