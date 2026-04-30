import { describe, expect, it } from "vitest";
import {
  buildCollectors,
  type ObservabilityRuntimeConfig,
} from "../../../src/observability/registry.js";
import { PerformanceCollector } from "../../../src/observability/collectors/performance-collector.js";
import { NetworkCollector } from "../../../src/observability/collectors/network-collector.js";
import { AccessibilityCollector } from "../../../src/observability/collectors/accessibility-collector.js";
import type { CollectorName } from "../../../src/observability/types.js";

const DEFAULT_CONFIG: ObservabilityRuntimeConfig = {
  collectors: [],
  networkCaptureLimit: 500,
  duplicateWindowMs: 500,
  accessibilityDualEngine: false,
  accessibilityHtmlSnippetLimit: 500,
};

describe("buildCollectors", () => {
  it("returns only collectors in the required set", () => {
    const collectors = buildCollectors({
      required: new Set<CollectorName>(["performance"]),
      configured: [],
      config: DEFAULT_CONFIG,
    });
    expect(collectors).toHaveLength(1);
    expect(collectors[0]).toBeInstanceOf(PerformanceCollector);
  });

  it("deduplicates required and configured", () => {
    const collectors = buildCollectors({
      required: new Set<CollectorName>(["network"]),
      configured: ["network", "performance"],
      config: DEFAULT_CONFIG,
    });
    expect(collectors).toHaveLength(2);
    expect(collectors.find((c) => c.name === "network")).toBeInstanceOf(NetworkCollector);
    expect(collectors.find((c) => c.name === "performance")).toBeInstanceOf(PerformanceCollector);
  });

  it("returns empty array when nothing is required or configured", () => {
    const collectors = buildCollectors({
      required: new Set(),
      configured: [],
      config: DEFAULT_CONFIG,
    });
    expect(collectors).toHaveLength(0);
  });

  it("passes network options through to the NetworkCollector", () => {
    const collectors = buildCollectors({
      required: new Set<CollectorName>(["network"]),
      configured: [],
      config: { ...DEFAULT_CONFIG, networkCaptureLimit: 42, duplicateWindowMs: 999 },
    });
    expect(collectors[0]).toBeInstanceOf(NetworkCollector);
  });

  it("passes dualEngine and htmlSnippetLimit to the AccessibilityCollector", () => {
    const collectors = buildCollectors({
      required: new Set<CollectorName>(["accessibility"]),
      configured: [],
      config: { ...DEFAULT_CONFIG, accessibilityDualEngine: true, accessibilityHtmlSnippetLimit: 100 },
    });
    expect(collectors[0]).toBeInstanceOf(AccessibilityCollector);
  });
});

// inferRequiredCollectors was deleted in B1 — YAML step-scanning has no analogue
// in the TS-pivot. Collectors are now resolved up front from `--observability` and
// per-test `test.use({ collectors: [...] })`. See plan §4.0.1.
