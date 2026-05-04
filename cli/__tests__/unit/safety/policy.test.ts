import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertActionAllowed,
  assertUrlAllowed,
  isUrlAllowed,
  loadSafetyRuntime,
} from "../../../src/safety/policy.js";
import type { SafetyConfig } from "../../../src/config/schema.js";

const baseConfig = (overrides: Partial<SafetyConfig> = {}): SafetyConfig => ({
  allowedDomains: [],
  confirmActions: [],
  maxOutputChars: 120_000,
  contentBoundaries: false,
  ...overrides,
});

describe("safety policy", () => {
  it("allows all URLs when allowedDomains is empty", () => {
    expect(isUrlAllowed("https://example.com/path", [])).toBe(true);
  });

  it("matches exact hosts, wildcard hosts, and URL patterns", () => {
    expect(isUrlAllowed("https://example.com", ["example.com"])).toBe(true);
    expect(isUrlAllowed("https://www.example.com", ["*.example.com"])).toBe(true);
    expect(isUrlAllowed("https://example.com", ["*.example.com"])).toBe(true);
    expect(isUrlAllowed("https://example.org", ["https://example.com/app"])).toBe(false);
  });

  it("throws with an explicit allowedDomains message for blocked URLs", () => {
    expect(() => assertUrlAllowed("https://blocked.example", ["allowed.example"])).toThrow(
      /safety\.allowedDomains blocked/,
    );
  });

  it("loads deny/default policy files and fails confirmation-only actions closed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-policy-"));
    try {
      fs.writeFileSync(
        path.join(dir, "policy.json"),
        JSON.stringify({
          default: "deny",
          allow: ["browser_open"],
          deny: ["browser_playwright"],
          confirm: ["browser_screenshot"],
        }),
      );
      const runtime = loadSafetyRuntime(dir, baseConfig({ actionPolicy: "policy.json" }));
      expect(() => assertActionAllowed(runtime, "browser_open")).not.toThrow();
      expect(() => assertActionAllowed(runtime, "browser_playwright")).toThrow(/denied/);
      expect(() => assertActionAllowed(runtime, "browser_screenshot")).toThrow(
        /requires confirmation/,
      );
      expect(() => assertActionAllowed(runtime, "browser_network_requests")).toThrow(
        /default-denied/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
