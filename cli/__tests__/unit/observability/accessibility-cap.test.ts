import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSidecars } from "../../../src/executor/sidecars.js";
import type { TestArtifacts } from "../../../src/executor/types.js";
import type { AccessibilitySnapshot } from "../../../src/observability/types.js";

/**
 * B9 — accessibility rule cap + per-test audit.md.
 *
 * The mocked snapshot has 30 violations split across two impact buckets
 * (15 critical + 15 serious). With the default cap (100), perf-trace.md
 * shows all 30 rules with NO truncation banner; audit.md always shows
 * every rule regardless of cap.
 */
const buildSnapshot = (perBucket: number): AccessibilitySnapshot => {
  const violations = [];
  for (let i = 0; i < perBucket; i++) {
    violations.push({
      ruleId: `critical-rule-${i}`,
      impact: "critical" as const,
      engine: i % 2 === 0 ? ("axe" as const) : ("equal-access" as const),
      help: `Critical issue ${i}`,
      helpUrl: `https://example.com/rules/critical-${i}`,
      nodes: [
        {
          target: [`#node-${i}`],
          html: `<div id="node-${i}">x</div>`,
          failureSummary: `Fix any of the following:\n  Element does not have alt`,
        },
      ],
    });
  }
  for (let i = 0; i < perBucket; i++) {
    violations.push({
      ruleId: `serious-rule-${i}`,
      impact: "serious" as const,
      engine: "axe" as const,
      help: `Serious issue ${i}`,
      nodes: [
        { target: [`.serious-${i}`], html: `<span>${i}</span>` },
      ],
    });
  }
  return {
    violations,
    summary: { violations: violations.length, passes: 100, incomplete: 0, dualEngine: true },
    standard: "WCAG21AA",
  };
};

describe("B9 — accessibility cap + audit.md", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "skeptic-b9-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes audit.md with every rule (no rule-level truncation) when violations are present", async () => {
    const snap = buildSnapshot(15); // 30 total
    const artifacts: TestArtifacts = {};
    await writeSidecars({
      flowDir: dir,
      metrics: { accessibility: snap },
      artifacts,
    });

    expect(artifacts.accessibilityAudit).toBe(join(dir, "audit.md"));
    const md = await readFile(artifacts.accessibilityAudit!, "utf-8");
    expect(md).toContain("# Accessibility Audit");
    expect(md).toContain("**30 violation(s)**");
    // Every rule must be rendered — no truncation in audit.md.
    for (let i = 0; i < 15; i++) {
      expect(md).toContain(`critical-rule-${i}`);
      expect(md).toContain(`serious-rule-${i}`);
    }
    // Engine badges
    expect(md).toContain("(axe)");
    expect(md).toContain("(equal-access)");
  });

  it("perf-trace.md renders all 30 rules with default cap=100 and no truncation banner", async () => {
    const snap = buildSnapshot(15);
    const artifacts: TestArtifacts = {};
    await writeSidecars({
      flowDir: dir,
      metrics: { accessibility: snap },
      artifacts,
    });

    const md = await readFile(artifacts.perfTrace!, "utf-8");
    expect(md).toContain("## Accessibility");
    // All 30 rules rendered.
    for (let i = 0; i < 15; i++) {
      expect(md).toContain(`**critical-rule-${i}**`);
      expect(md).toContain(`**serious-rule-${i}**`);
    }
    // No truncation banner with default cap.
    expect(md).not.toContain("see audit.md");
  });

  it("does not write audit.md when no a11y violations are present", async () => {
    const empty: AccessibilitySnapshot = {
      violations: [],
      summary: { violations: 0, passes: 0, incomplete: 0, dualEngine: false },
      standard: "WCAG21AA",
    };
    const artifacts: TestArtifacts = {};
    await writeSidecars({
      flowDir: dir,
      metrics: { accessibility: empty },
      artifacts,
    });
    expect(artifacts.accessibilityAudit).toBeUndefined();
  });

  it("honors a low cap in perf-trace.md (truncation banner) but still writes the full audit.md", async () => {
    const snap = buildSnapshot(15); // 15 per bucket
    const artifacts: TestArtifacts = {};
    await writeSidecars({
      flowDir: dir,
      metrics: { accessibility: snap },
      artifacts,
      observabilityConfig: {
        collectors: [],
        networkCaptureLimit: 500,
        duplicateWindowMs: 500,
        accessibilityDualEngine: true,
        accessibilityHtmlSnippetLimit: 500,
        accessibilityMaxRulesPerImpact: 5,
      },
    });

    const perf = await readFile(artifacts.perfTrace!, "utf-8");
    // Truncation banner appears in both buckets when cap < bucket size.
    expect(perf).toContain("...and 10 more — see audit.md");

    const audit = await readFile(artifacts.accessibilityAudit!, "utf-8");
    // audit.md always shows every rule regardless of cap.
    for (let i = 0; i < 15; i++) {
      expect(audit).toContain(`critical-rule-${i}`);
    }
  });
});
