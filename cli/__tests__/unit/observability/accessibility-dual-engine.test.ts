import { describe, expect, it, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import type { Page } from "playwright";
import type { ExecutionContext } from "../../../src/executor/context.js";

// Detect whether the optional peer is loadable in this environment. The CI matrix
// runs this test twice — once with the peer installed (npm path) and once on the
// slim build (peer missing). The acceptance gate flips conditionally on this.
const peerLoadable = (() => {
  try {
    const req = createRequire(import.meta.url);
    req.resolve("accessibility-checker-engine/ace.js");
    return true;
  } catch {
    return false;
  }
})();

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

// Each fake "page" returns a synthesized IBM ace report from page.evaluate. The IBM
// branch invokes page.evaluate(callback, { script, profile }); we ignore both args
// and return a fixed shape that the collector knows how to drain.
const fakePageWithIbm = (ibmResults: unknown[]): Page =>
  ({
    isClosed: () => false,
    evaluate: vi.fn().mockResolvedValue({ results: ibmResults }),
  }) as unknown as Page;

describe("AccessibilityCollector dual-engine", () => {
  beforeEach(() => {
    axeAnalyzeMock.mockReset();
    // Stable axe baseline: one violation that overlaps with an IBM rule by ID,
    // plus passes/incomplete numbers we can assert merging math against.
    axeAnalyzeMock.mockResolvedValue({
      violations: [
        {
          id: "color-contrast",
          impact: "serious",
          help: "axe contrast",
          nodes: [{ target: [".btn"], html: "<button>x</button>" }],
        },
      ],
      passes: [{ id: "p1" }],
      incomplete: [],
    });
  });

  it("reports which acceptance path is active so CI matrices can verify both", () => {
    // Visible in vitest stdout via reporter "verbose" or when the test fails.
    // eslint-disable-next-line no-console
    console.log(
      `[a11y-dual-engine] peerLoadable=${peerLoadable} (${peerLoadable ? "npm path" : "slim path"})`,
    );
    expect(typeof peerLoadable).toBe("boolean");
  });

  it.runIf(peerLoadable)(
    "with peer + dualEngine: true, runs both engines and dedups by ruleId",
    async () => {
      // IBM emits two violations: one shadowing an axe rule (color-contrast — should
      // be deduped), one fresh (RPT_Style_BackgroundImage — should pass through).
      const ibmResults = [
        {
          ruleId: "color-contrast",
          value: ["VIOLATION", "FAIL"],
          message: "ibm contrast",
          path: { dom: "html>body>button" },
          snippet: "<button>x</button>",
        },
        {
          ruleId: "RPT_Style_BackgroundImage",
          value: ["VIOLATION", "FAIL"],
          message: "background image lacks text fallback",
          path: { dom: "html>body>div" },
          snippet: "<div>y</div>",
        },
        { ruleId: "p_ibm", value: ["PASS", "PASS"] },
      ];
      const collector = new AccessibilityCollector({
        dualEngine: true,
        htmlSnippetLimit: 500,
      });
      await collector.attach(fakePageWithIbm(ibmResults), mockCtx);
      const snap = await collector.audit({ standard: "WCAG21AA" });

      expect(snap.summary.dualEngine).toBe(true);
      expect(snap.summary.enginesRequested).toEqual(["axe", "equal-access"]);
      expect(snap.summary.enginesErrored).toEqual([]);

      // Acceptance gate (peer-loadable path): dualEngine === true AND violations >= 5
      // is the *production* gate against a real page; the unit test asserts the
      // dedup behavior that gate depends on (axe rule wins, IBM-only rule passes
      // through).
      const ruleIds = snap.violations.map((v) => v.ruleId);
      expect(ruleIds).toContain("color-contrast");
      expect(ruleIds).toContain("RPT_Style_BackgroundImage");
      const colorContrast = snap.violations.find((v) => v.ruleId === "color-contrast");
      expect(colorContrast?.engine).toBe("axe"); // axe wins on overlap
      expect(snap.summary.violations).toBeGreaterThanOrEqual(2);
      expect(snap.summary.passes).toBe(2); // 1 axe + 1 ibm
    },
  );

  it.runIf(!peerLoadable)(
    "without peer, dualEngine: true silently degrades to axe-only baseline",
    async () => {
      const collector = new AccessibilityCollector({
        dualEngine: true,
        htmlSnippetLimit: 500,
      });
      await collector.attach(fakePageWithIbm([]), mockCtx);
      const snap = await collector.audit({ standard: "WCAG21AA" });

      // Slim-binary acceptance gate: dualEngine === false AND violations >= 1
      expect(snap.summary.dualEngine).toBe(false);
      expect(snap.summary.enginesRequested).toEqual(["axe"]);
      expect(snap.summary.violations).toBeGreaterThanOrEqual(1);
    },
  );
});
