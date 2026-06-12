import { describe, it, expect } from "vitest";
import { buildObservabilityFixture } from "../../../src/api/observability.js";
import type { AccessibilityCollector } from "../../../src/observability/collectors/accessibility-collector.js";
import type { AuditInvocation } from "../../../src/observability/collectors/accessibility-collector.js";
import type { AccessibilitySnapshot } from "../../../src/observability/types.js";

const runAction = async <T>(_label: string, fn: () => Promise<T>): Promise<T> => fn();

const snap = (
  summary: Partial<AccessibilitySnapshot["summary"]>,
  violations: AccessibilitySnapshot["violations"] = [],
): AccessibilitySnapshot => ({
  violations,
  summary: {
    violations: 0,
    passes: 0,
    incomplete: 0,
    dualEngine: false,
    enginesRequested: ["axe"],
    enginesErrored: [],
    ...summary,
  },
  standard: "WCAG21AA",
});

const fixtureFor = (
  result: AccessibilitySnapshot,
  capture?: (invocation: AuditInvocation) => void,
) => {
  const collector = {
    audit: async (invocation: AuditInvocation) => {
      capture?.(invocation);
      return result;
    },
  } as unknown as AccessibilityCollector;
  return buildObservabilityFixture({ runAction, collectors: { accessibility: collector } });
};

describe("expectAccessible — non-audit guard", () => {
  it("FAILS when every engine errored and nothing was checked (e.g. CSP blocks axe)", async () => {
    const fixture = fixtureFor(
      snap({
        violations: 0,
        passes: 0,
        incomplete: 0,
        enginesErrored: [{ engine: "axe", reason: "CSP blocked axe injection" }],
      }),
    );
    await expect(fixture.expectAccessible()).rejects.toThrow(/could not run/i);
  });

  it("does NOT fail when one engine errored but another produced results", async () => {
    const fixture = fixtureFor(
      snap({
        violations: 0,
        passes: 12,
        incomplete: 0,
        dualEngine: true,
        enginesRequested: ["axe", "equal-access"],
        enginesErrored: [{ engine: "equal-access", reason: "engine not loaded" }],
      }),
    );
    await expect(fixture.expectAccessible()).resolves.toBeUndefined();
  });

  it("passes a clean audit with no errors and no violations", async () => {
    const fixture = fixtureFor(snap({ violations: 0, passes: 30, incomplete: 0 }));
    await expect(fixture.expectAccessible()).resolves.toBeUndefined();
  });

  it("still throws the violation error when violations are present", async () => {
    const fixture = fixtureFor(
      snap({ violations: 1, passes: 5 }, [
        { ruleId: "color-contrast", impact: "serious", engine: "axe", help: "Contrast too low", nodes: [] },
      ]),
    );
    await expect(fixture.expectAccessible()).rejects.toThrow(/1 a11y violation/);
  });

  it("does not throw the non-audit error on legacy snapshots without enginesErrored", async () => {
    const legacy: AccessibilitySnapshot = {
      violations: [],
      summary: { violations: 0, passes: 8, incomplete: 0, dualEngine: false },
      standard: "WCAG21AA",
    };
    const fixture = fixtureFor(legacy);
    await expect(fixture.expectAccessible()).resolves.toBeUndefined();
  });

  it("threads the impacts option through to the collector audit", async () => {
    let seen: AuditInvocation | undefined;
    const fixture = fixtureFor(snap({ passes: 1 }), (inv) => {
      seen = inv;
    });
    await fixture.expectAccessible({ impacts: ["critical", "serious"] });
    expect(seen?.impacts).toEqual(["critical", "serious"]);
    expect(seen?.standard).toBe("WCAG21AA");
  });
});
