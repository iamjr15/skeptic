import type { Collector, CollectorName } from "./types.js";
import { PerformanceCollector } from "./collectors/performance-collector.js";
import { NetworkCollector } from "./collectors/network-collector.js";
import { AccessibilityCollector } from "./collectors/accessibility-collector.js";
import { ConsoleCollector } from "./collectors/console-collector.js";

export interface ObservabilityRuntimeConfig {
  collectors: readonly CollectorName[];
  networkCaptureLimit: number;
  duplicateWindowMs: number;
  accessibilityDualEngine: boolean;
  accessibilityHtmlSnippetLimit: number;
  consoleCaptureLimit?: number;
  consoleRedaction?: boolean;
  /** When set, the engine fires AccessibilityCollector.audit() once per test before onTestComplete. */
  autoAccessibilityAudit?: boolean;
  accessibilityStandard?: "WCAG2A" | "WCAG2AA" | "WCAG21A" | "WCAG21AA" | "WCAG22AA";
  accessibilityImpacts?: Array<"critical" | "serious" | "moderate" | "minor">;
  /**
   * Per-impact-bucket cap for the `perf-trace.md` Accessibility section. When the
   * bucket holds more than this many rules, the markdown shows `cap` plus a
   * "...and N more — see audit.md" footer. The full set is always written to
   * the per-test `audit.md` sidecar (no rule-level truncation there).
   * Default = 100.
   */
  accessibilityMaxRulesPerImpact?: number;
}

export interface BuildCollectorsInput {
  required: Set<CollectorName>;
  configured: readonly CollectorName[];
  config: ObservabilityRuntimeConfig;
}

export const buildCollectors = (input: BuildCollectorsInput): Collector[] => {
  const active = new Set<CollectorName>([...input.required, ...input.configured]);
  const collectors: Collector[] = [];
  if (active.has("performance")) {
    collectors.push(new PerformanceCollector());
  }
  if (active.has("network")) {
    collectors.push(
      new NetworkCollector({
        captureLimit: input.config.networkCaptureLimit,
        duplicateWindowMs: input.config.duplicateWindowMs,
      }),
    );
  }
  if (active.has("accessibility")) {
    collectors.push(
      new AccessibilityCollector({
        dualEngine: input.config.accessibilityDualEngine,
        htmlSnippetLimit: input.config.accessibilityHtmlSnippetLimit,
      }),
    );
  }
  if (active.has("console")) {
    collectors.push(
      new ConsoleCollector({
        captureLimit: input.config.consoleCaptureLimit ?? 200,
        redact: input.config.consoleRedaction ?? true,
      }),
    );
  }
  return collectors;
};
