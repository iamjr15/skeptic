import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type {
  AccessibilitySnapshot,
  AccessibilityViolation,
  ConsoleSnapshot,
  NetworkSnapshot,
  PerformanceSnapshot,
} from "../observability/types.js";
import type { TestArtifacts } from "./types.js";
import type { ObservabilityRuntimeConfig } from "../observability/registry.js";
import { formatPerfTraceMarkdown } from "../reporter/perf-trace-md.js";
import { logger } from "../utils/logger.js";

export interface SidecarWriteInput {
  testDir: string;
  metrics: Record<string, unknown>;
  artifacts: TestArtifacts;
  /**
   * Optional observability runtime config — currently used to thread
   * `accessibilityMaxRulesPerImpact` into the perf-trace.md formatter so the
   * cap is consistent with the engine-level config. The audit.md sidecar
   * never honors this cap (it always renders the full violation list).
   */
  observabilityConfig?: ObservabilityRuntimeConfig;
}

/**
 * Writes the observability sidecars (`perf-trace.md`, `console.json`,
 * `network.json`, `accessibility.json`, and — when a11y violations are present — `audit.md`) into
 * the test's artifact directory and populates `artifacts` with their paths. Each write
 * is wrapped in its own try/catch — sidecar failures must never mask the
 * test result. Shared between the engine and the runner worker so both code
 * paths emit byte-identical sidecars.
 */
export const writeSidecars = async (input: SidecarWriteInput): Promise<void> => {
  const { testDir, metrics, artifacts, observabilityConfig } = input;
  const perf = metrics["performance"] as PerformanceSnapshot | undefined;
  const net = metrics["network"] as NetworkSnapshot | undefined;
  const con = metrics["console"] as ConsoleSnapshot | undefined;
  const a11y = metrics["accessibility"] as AccessibilitySnapshot | undefined;

  try {
    const md = formatPerfTraceMarkdown(
      {
        ...(perf !== undefined ? { performance: perf } : {}),
        ...(net !== undefined ? { network: net } : {}),
        ...(con !== undefined ? { console: con } : {}),
        ...(a11y !== undefined ? { accessibility: a11y } : {}),
      },
      observabilityConfig?.accessibilityMaxRulesPerImpact !== undefined
        ? { accessibilityMaxRulesPerImpact: observabilityConfig.accessibilityMaxRulesPerImpact }
        : {},
    );
    const perfTracePath = join(testDir, "perf-trace.md");
    await writeFile(perfTracePath, md, "utf-8");
    artifacts.perfTrace = perfTracePath;
  } catch (err) {
    logger.warn(`perf-trace.md write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (con) {
    try {
      const consolePath = join(testDir, "console.json");
      await writeFile(consolePath, JSON.stringify(con, null, 2), "utf-8");
      artifacts.consoleSnapshot = consolePath;
    } catch (err) {
      logger.warn(`console.json write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (net) {
    try {
      const networkPath = join(testDir, "network.json");
      await writeFile(networkPath, JSON.stringify(net, null, 2), "utf-8");
      artifacts.networkSnapshot = networkPath;
    } catch (err) {
      logger.warn(`network.json write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (a11y) {
    try {
      const accessibilityJsonPath = join(testDir, "accessibility.json");
      await writeFile(accessibilityJsonPath, JSON.stringify(a11y, null, 2), "utf-8");
      artifacts.accessibilityJson = accessibilityJsonPath;
    } catch (err) {
      logger.warn(`accessibility.json write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (a11y && a11y.violations.length > 0) {
    try {
      const auditPath = join(testDir, "audit.md");
      await writeFile(auditPath, formatAuditMarkdown(a11y), "utf-8");
      artifacts.accessibilityAudit = auditPath;
    } catch (err) {
      logger.warn(`audit.md write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
};

const IMPACT_ORDER: Array<AccessibilityViolation["impact"]> = [
  "critical",
  "serious",
  "moderate",
  "minor",
];

/** Maximum example nodes rendered per rule. Every RULE is rendered (no rule-level
 *  truncation), but for high-cardinality nodes we cap at 10 with a "+N more nodes"
 *  footer to keep audit.md readable on mega-pages. */
const MAX_NODES_PER_RULE = 10;

/**
 * Build the per-test `audit.md` sidecar — full Accessibility violation report
 * grouped by impact then by rule. **No rule-level truncation** (every rule from
 * both engines is rendered). Per-rule node examples are capped at 10 with a
 * "+N more nodes" footer when truncated. The axe vs equal-access engine is
 * marked with a `(axe)` / `(equal-access)` badge after the ruleId.
 */
export const formatAuditMarkdown = (a11y: AccessibilitySnapshot): string => {
  const parts: string[] = ["# Accessibility Audit", ""];
  parts.push(`Standard: ${a11y.standard}.`);
  parts.push(
    `Engines: ${a11y.summary.dualEngine ? "axe-core + IBM Equal Access" : "axe-core"}.`,
  );
  parts.push(
    `**${a11y.summary.violations} violation(s)**, ${a11y.summary.passes} pass(es), ${a11y.summary.incomplete} incomplete.`,
  );
  parts.push("");

  if (a11y.summary.enginesErrored && a11y.summary.enginesErrored.length > 0) {
    parts.push("> ⚠ Engine errors:");
    for (const e of a11y.summary.enginesErrored) {
      parts.push(`> - ${e.engine}: ${e.reason}`);
    }
    parts.push("");
  }

  // Group by impact → bucket holds rules in arrival order.
  const groups: Record<string, AccessibilityViolation[]> = {
    critical: [],
    serious: [],
    moderate: [],
    minor: [],
  };
  for (const v of a11y.violations) {
    const list = groups[v.impact];
    if (list) list.push(v);
  }

  for (const impact of IMPACT_ORDER) {
    const list = groups[impact];
    if (!list || list.length === 0) continue;
    parts.push(
      `## ${impact[0]!.toUpperCase()}${impact.slice(1)} (${list.length})`,
      "",
    );
    for (const v of list) {
      const badge = v.engine === "equal-access" ? "(equal-access)" : "(axe)";
      parts.push(`### \`${v.ruleId}\` ${badge}`, "");
      parts.push(v.help);
      if (v.helpUrl) {
        parts.push("");
        parts.push(`More: ${v.helpUrl}`);
      }
      parts.push("");
      if (v.nodes.length > 0) {
        const shownNodes = v.nodes.slice(0, MAX_NODES_PER_RULE);
        parts.push(`**Nodes (${v.nodes.length}):**`, "");
        for (const node of shownNodes) {
          const target = node.target.join(" ") || "(no selector)";
          parts.push(`- \`${target}\``);
          if (node.html) {
            parts.push("  HTML:");
            parts.push("  ```html");
            for (const line of node.html.split("\n")) {
              parts.push(`  ${line}`);
            }
            parts.push("  ```");
          }
          if (node.failureSummary) {
            // Indent the failure summary so it's grouped under the node bullet.
            const lines = node.failureSummary.split("\n");
            for (const line of lines) {
              if (line.trim()) parts.push(`  ${line}`);
            }
          }
        }
        if (v.nodes.length > MAX_NODES_PER_RULE) {
          parts.push(`- +${v.nodes.length - MAX_NODES_PER_RULE} more nodes`);
        }
        parts.push("");
      }
    }
  }

  return parts.join("\n");
};
