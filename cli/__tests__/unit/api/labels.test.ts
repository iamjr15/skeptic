import { describe, it, expect } from "vitest";
import {
  friendlyLabel,
  PERSISTENT_LABEL_ACTIONS,
  __TEST_LABELS,
} from "../../../src/api/labels.js";

/**
 * Unit tests for the static-label resolver. The PII boundary lives here: any change
 * that lets caller-supplied data leak into the label must be caught by these tests.
 */

describe("friendlyLabel — fixture method coverage", () => {
  // Every fixture-routed action that runAction passes through must have a sentence-form
  // mapping; otherwise the recorded video would show the terse internal name.
  const FIXTURE_ACTIONS = [
    "screenshot",
    "screenshot.annotated",
    "snapshot",
    "settle",
    "observability.expectPerformance",
    "observability.expectNoNetworkErrors",
    "observability.expectNoConsoleErrors",
    "observability.expectAccessible",
    "observability.snapshot",
    "test",
  ];

  for (const action of FIXTURE_ACTIONS) {
    it(`maps ${action} to a sentence-form label`, () => {
      const label = friendlyLabel(action);
      expect(label).toBeTruthy();
      expect(label).not.toBe(action);
      // Sentence-form: starts uppercase, contains a space (not a dot/identifier).
      expect(label[0]).toBe(label[0]?.toUpperCase());
      expect(label).toContain(" ");
    });
  }
});

describe("friendlyLabel — Page Proxy synthetic actions", () => {
  // The Page Proxy fires `proxy.<method>` synthetic action names. Each canonical
  // interaction method must have a friendly mapping or the persistent tooltip will
  // show the bare proxy name.
  const PROXY_ACTIONS = [
    "proxy.click",
    "proxy.dblclick",
    "proxy.hover",
    "proxy.fill",
    "proxy.type",
    "proxy.press",
    "proxy.selectOption",
    "proxy.check",
    "proxy.uncheck",
  ];

  for (const action of PROXY_ACTIONS) {
    it(`maps ${action} to a sentence-form label`, () => {
      const label = friendlyLabel(action);
      expect(label).toBeTruthy();
      expect(label).not.toBe(action);
      expect(label).not.toMatch(/^proxy\./);
    });
  }
});

describe("friendlyLabel — fall-through behaviour", () => {
  it("returns the raw action name for an unknown action (documented escape hatch)", () => {
    expect(friendlyLabel("future.notMapped")).toBe("future.notMapped");
  });

  it("returns empty string for an empty input (defensive)", () => {
    expect(friendlyLabel("")).toBe("");
  });

  it("does not interpolate args into the label (PII safety)", () => {
    // Any caller-provided string is returned verbatim or via the lookup. Critically,
    // the resolver does not template-replace, so `password=secret` cannot end up in
    // a label that the table does not explicitly contain.
    const dangerous = "click[password=hunter2]";
    expect(friendlyLabel(dangerous)).toBe(dangerous);
    // No table entry contains the dangerous fragment.
    for (const value of Object.values(__TEST_LABELS)) {
      expect(value).not.toContain("hunter2");
      expect(value).not.toContain("=");
    }
  });
});

describe("PERSISTENT_LABEL_ACTIONS", () => {
  it("includes the long-running ops the plan calls out", () => {
    // These are the actions that take long enough that the 1.5 s default fade
    // hides the label before the action finishes — they must be persistent.
    const required = [
      "observability.expectAccessible",
      "screenshot.annotated",
      "snapshot",
      "settle",
    ];
    for (const action of required) {
      expect(PERSISTENT_LABEL_ACTIONS.has(action)).toBe(true);
    }
  });

  it("does NOT mark fast / discrete ops as persistent (they get the auto-fade)", () => {
    // The plain screenshot is a fast op; let it auto-fade.
    expect(PERSISTENT_LABEL_ACTIONS.has("screenshot")).toBe(false);
  });
});
