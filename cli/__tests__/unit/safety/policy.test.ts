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

  it("denies non-http(s) schemes by default when an allowlist is active", () => {
    // Regression: a domain allowlist must not be a free pass for file:// /
    // chrome:// / data: — those would otherwise bypass the allowlist entirely.
    expect(isUrlAllowed("file:///etc/passwd", ["example.com"])).toBe(false);
    expect(isUrlAllowed("chrome://settings", ["example.com"])).toBe(false);
    expect(isUrlAllowed("data:text/html,<h1>x</h1>", ["example.com"])).toBe(false);
    // A bare hostname entry never authorizes a non-http scheme.
    expect(isUrlAllowed("file:///etc/passwd", ["*.example.com", "example.com"])).toBe(false);
  });

  it("still allows non-http(s) schemes when no allowlist is configured", () => {
    expect(isUrlAllowed("file:///etc/passwd", [])).toBe(true);
    expect(isUrlAllowed("chrome://settings", [])).toBe(true);
  });

  it("permits a non-http scheme only when explicitly allowlisted (or '*')", () => {
    expect(isUrlAllowed("file:///etc/passwd", ["*"])).toBe(true);
    expect(isUrlAllowed("file:///etc/passwd", ["file://"])).toBe(true);
    expect(isUrlAllowed("file:///etc/passwd", ["file:"])).toBe(true);
    expect(isUrlAllowed("chrome://settings", ["chrome://settings"])).toBe(true);
    // Explicit scheme entry must still match the host when one is pinned.
    expect(isUrlAllowed("chrome://flags", ["chrome://settings"])).toBe(false);
    // An https entry does not authorize a file URL.
    expect(isUrlAllowed("file:///etc/passwd", ["https://example.com"])).toBe(false);
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
