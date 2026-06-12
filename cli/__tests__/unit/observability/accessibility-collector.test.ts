import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Page } from "playwright";
import type { ExecutionContext } from "../../../src/executor/context.js";

const axeAnalyzeMock = vi.fn();

vi.mock("@axe-core/playwright", () => {
  class AxeBuilder {
    constructor(_opts: unknown) {}
    withTags(_tags: string[]): this {
      return this;
    }
    include(_selector: string | string[]): this {
      return this;
    }
    exclude(_selector: string | string[]): this {
      return this;
    }
    analyze() {
      return axeAnalyzeMock();
    }
  }
  return { AxeBuilder, default: AxeBuilder };
});

const { AccessibilityCollector } = await import(
  "../../../src/observability/collectors/accessibility-collector.js"
);

const mockCtx = {} as ExecutionContext;

const fakePage = (isClosed = false): Page =>
  ({
    isClosed: () => isClosed,
    evaluate: vi.fn(),
  }) as unknown as Page;

const DEFAULT_OPTS = { dualEngine: false, htmlSnippetLimit: 500 };

describe("AccessibilityCollector", () => {
  beforeEach(() => {
    axeAnalyzeMock.mockReset();
    axeAnalyzeMock.mockResolvedValue({
      violations: [],
      passes: [],
      incomplete: [],
    });
  });

  it("attach stores page reference", async () => {
    const collector = new AccessibilityCollector(DEFAULT_OPTS);
    const page = fakePage();
    await collector.attach(page, mockCtx);
    const snap = await collector.snapshot();
    expect(snap).toBeUndefined(); // no audit run yet
  });

  it("audit on a closed page returns empty snapshot", async () => {
    const collector = new AccessibilityCollector(DEFAULT_OPTS);
    await collector.attach(fakePage(true), mockCtx);
    const snap = await collector.audit({ standard: "WCAG2AA" });
    expect(snap.violations).toHaveLength(0);
    expect(snap.summary.violations).toBe(0);
  });

  it("audit returns axe violations normalized into AccessibilityViolation shape", async () => {
    axeAnalyzeMock.mockResolvedValue({
      violations: [
        {
          id: "color-contrast",
          impact: "serious",
          help: "contrast help",
          helpUrl: "http://help",
          nodes: [
            {
              target: [".btn"],
              html: "<button>click me</button>",
              failureSummary: "too low",
            },
          ],
        },
      ],
      passes: [{ id: "p1" }],
      incomplete: [],
    });
    const collector = new AccessibilityCollector(DEFAULT_OPTS);
    await collector.attach(fakePage(), mockCtx);
    const snap = await collector.audit({ standard: "WCAG2AA" });
    expect(snap.violations).toHaveLength(1);
    expect(snap.violations[0]).toMatchObject({
      ruleId: "color-contrast",
      impact: "serious",
      engine: "axe",
      help: "contrast help",
    });
    expect(snap.summary).toEqual({
      violations: 1,
      passes: 1,
      incomplete: 0,
      dualEngine: false,
      enginesRequested: ["axe"],
      enginesErrored: [],
    });
  });

  it("axe with critical impact is preserved", async () => {
    axeAnalyzeMock.mockResolvedValue({
      violations: [{ id: "x", impact: "critical", help: "h", nodes: [] }],
      passes: [],
      incomplete: [],
    });
    const collector = new AccessibilityCollector(DEFAULT_OPTS);
    await collector.attach(fakePage(), mockCtx);
    const snap = await collector.audit({ standard: "WCAG2AA" });
    expect(snap.violations[0]?.impact).toBe("critical");
  });

  it("violations sort by impact severity (critical before serious before moderate)", async () => {
    axeAnalyzeMock.mockResolvedValue({
      violations: [
        { id: "b", impact: "moderate", help: "h", nodes: [] },
        { id: "a", impact: "critical", help: "h", nodes: [] },
        { id: "c", impact: "serious", help: "h", nodes: [] },
      ],
      passes: [],
      incomplete: [],
    });
    const collector = new AccessibilityCollector(DEFAULT_OPTS);
    await collector.attach(fakePage(), mockCtx);
    const snap = await collector.audit({ standard: "WCAG2AA" });
    expect(snap.violations.map((v) => v.impact)).toEqual(["critical", "serious", "moderate"]);
  });

  it("htmlSnippetLimit truncates node.html with ellipsis", async () => {
    const long = "x".repeat(200);
    axeAnalyzeMock.mockResolvedValue({
      violations: [
        {
          id: "x",
          impact: "serious",
          help: "h",
          nodes: [{ target: ["a"], html: long, failureSummary: "" }],
        },
      ],
      passes: [],
      incomplete: [],
    });
    const collector = new AccessibilityCollector({ dualEngine: false, htmlSnippetLimit: 10 });
    await collector.attach(fakePage(), mockCtx);
    const snap = await collector.audit({ standard: "WCAG2AA" });
    expect(snap.violations[0]?.nodes[0]?.html).toBe("xxxxxxxxxx…");
  });

  it("htmlSnippetLimit: 0 suppresses snippets entirely", async () => {
    axeAnalyzeMock.mockResolvedValue({
      violations: [
        {
          id: "x",
          impact: "serious",
          help: "h",
          nodes: [{ target: ["a"], html: "<div>xxx</div>", failureSummary: "" }],
        },
      ],
      passes: [],
      incomplete: [],
    });
    const collector = new AccessibilityCollector({ dualEngine: false, htmlSnippetLimit: 0 });
    await collector.attach(fakePage(), mockCtx);
    const snap = await collector.audit({ standard: "WCAG2AA" });
    expect(snap.violations[0]?.nodes[0]?.html).toBe("");
  });

  it("snapshot returns undefined before audit is called", async () => {
    const collector = new AccessibilityCollector(DEFAULT_OPTS);
    await collector.attach(fakePage(), mockCtx);
    const s = await collector.snapshot();
    expect(s).toBeUndefined();
  });

  it("detach clears page reference", async () => {
    const collector = new AccessibilityCollector(DEFAULT_OPTS);
    await collector.attach(fakePage(), mockCtx);
    await collector.detach();
    const snap = await collector.audit({ standard: "WCAG2AA" });
    // After detach, audit short-circuits (page is null) and returns empty
    expect(snap.violations).toHaveLength(0);
  });

  it("axe throwing returns empty axe result, doesn't crash", async () => {
    axeAnalyzeMock.mockRejectedValue(new Error("axe boom"));
    const collector = new AccessibilityCollector(DEFAULT_OPTS);
    await collector.attach(fakePage(), mockCtx);
    const snap = await collector.audit({ standard: "WCAG2AA" });
    expect(snap.violations).toHaveLength(0);
    expect(snap.summary.violations).toBe(0);
  });

  it("accepts all five WCAG standards", async () => {
    const collector = new AccessibilityCollector(DEFAULT_OPTS);
    await collector.attach(fakePage(), mockCtx);
    for (const s of ["WCAG2A", "WCAG2AA", "WCAG21A", "WCAG21AA", "WCAG22AA"] as const) {
      const snap = await collector.audit({ standard: s });
      expect(snap.standard).toBe(s);
    }
  });

  it("filters violations to the requested impact levels", async () => {
    axeAnalyzeMock.mockResolvedValue({
      violations: [
        { id: "crit", impact: "critical", help: "h", nodes: [] },
        { id: "ser", impact: "serious", help: "h", nodes: [] },
        { id: "mod", impact: "moderate", help: "h", nodes: [] },
        { id: "min", impact: "minor", help: "h", nodes: [] },
      ],
      passes: [{ id: "p1" }, { id: "p2" }],
      incomplete: [],
    });
    const collector = new AccessibilityCollector(DEFAULT_OPTS);
    await collector.attach(fakePage(), mockCtx);
    const snap = await collector.audit({
      standard: "WCAG2AA",
      impacts: ["critical", "serious"],
    });
    expect(snap.violations.map((v) => v.ruleId)).toEqual(["crit", "ser"]);
    // summary.violations reflects the filtered count; passes are unaffected.
    expect(snap.summary.violations).toBe(2);
    expect(snap.summary.passes).toBe(2);
  });

  it("keeps all violations when no impact filter is supplied", async () => {
    axeAnalyzeMock.mockResolvedValue({
      violations: [
        { id: "crit", impact: "critical", help: "h", nodes: [] },
        { id: "min", impact: "minor", help: "h", nodes: [] },
      ],
      passes: [],
      incomplete: [],
    });
    const collector = new AccessibilityCollector(DEFAULT_OPTS);
    await collector.attach(fakePage(), mockCtx);
    const snap = await collector.audit({ standard: "WCAG2AA" });
    expect(snap.summary.violations).toBe(2);
  });

  it("populates enginesRequested + enginesErrored on a clean axe run", async () => {
    const collector = new AccessibilityCollector(DEFAULT_OPTS);
    await collector.attach(fakePage(), mockCtx);
    const snap = await collector.audit({ standard: "WCAG2AA" });
    expect(snap.summary.enginesRequested).toEqual(["axe"]);
    expect(snap.summary.enginesErrored).toEqual([]);
  });

  it("populates enginesErrored when axe throws", async () => {
    axeAnalyzeMock.mockRejectedValue(new Error("axe boom"));
    const collector = new AccessibilityCollector(DEFAULT_OPTS);
    await collector.attach(fakePage(), mockCtx);
    const snap = await collector.audit({ standard: "WCAG2AA" });
    expect(snap.summary.enginesRequested).toEqual(["axe"]);
    expect(snap.summary.enginesErrored).toHaveLength(1);
    expect(snap.summary.enginesErrored?.[0]).toMatchObject({
      engine: "axe",
      reason: expect.stringContaining("axe boom"),
    });
  });

  it("page-closed branch populates enginesErrored for every requested engine", async () => {
    const collector = new AccessibilityCollector(DEFAULT_OPTS);
    await collector.attach(fakePage(true), mockCtx);
    const snap = await collector.audit({ standard: "WCAG2AA" });
    expect(snap.summary.enginesRequested).toEqual(["axe"]);
    expect(snap.summary.enginesErrored).toHaveLength(1);
    expect(snap.summary.enginesErrored?.[0]).toMatchObject({
      engine: "axe",
      reason: expect.stringContaining("page closed"),
    });
  });
});
