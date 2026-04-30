import { describe, expect, it } from "vitest";
import { buildCollectors, type ObservabilityRuntimeConfig } from "../../../src/observability/registry.js";
import type { CollectorName } from "../../../src/observability/types.js";

const baseConfig = (): ObservabilityRuntimeConfig => ({
  collectors: [],
  networkCaptureLimit: 500,
  duplicateWindowMs: 500,
  accessibilityDualEngine: false,
  accessibilityHtmlSnippetLimit: 500,
});

/**
 * The plan §4.0.1 calls for two activation policies:
 *   A. `--observability` forces every collector regardless of `test.use`.
 *   C. `test.use({ collectors: [...] })` declares a subset.
 *
 * The runner translates these into the `required` set fed into buildCollectors.
 * This unit test isolates the resolution shape — the real worker codepath is
 * verified end-to-end by the integration runner test in
 * `__tests__/integration/runner/runner-acceptance.test.ts`.
 */
describe("collector activation timing", () => {
  it("forceAll mode attaches all four collectors before the test runs", () => {
    const required = new Set<CollectorName>(["performance", "network", "accessibility", "console"]);
    const collectors = buildCollectors({ required, configured: [], config: baseConfig() });
    expect(collectors.map((c) => c.name).sort()).toEqual(
      ["accessibility", "console", "network", "performance"].sort(),
    );
  });

  it("test.use({ collectors: ['network'] }) attaches only network", () => {
    const required = new Set<CollectorName>(["network"]);
    const collectors = buildCollectors({ required, configured: [], config: baseConfig() });
    expect(collectors.map((c) => c.name)).toEqual(["network"]);
  });

  it("no flag, no test.use → empty collector list (and observability.* throws downstream)", () => {
    const collectors = buildCollectors({
      required: new Set(),
      configured: [],
      config: baseConfig(),
    });
    expect(collectors).toEqual([]);
  });
});
