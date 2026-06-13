import { describe, it, expect } from "vitest";
import { axeAvailable, assertIosSimReady, findAxeBinary, listBootedSimulators } from "../../../src/driver/mobile/ios-tools.js";

describe("ios-tools — axe availability + preflight", () => {
  it("axeAvailable: an explicit path must exist", () => {
    expect(axeAvailable("/definitely/not/installed/axe")).toBe(false);
    expect(axeAvailable(__filename)).toBe(true); // this test file exists
  });

  it("findAxeBinary falls back to bare `axe` when no override / brew path", () => {
    expect(findAxeBinary("/custom/axe")).toBe("/custom/axe");
    expect(typeof findAxeBinary()).toBe("string");
  });

  it("assertIosSimReady throws an ACTIONABLE error when axe is missing", () => {
    // Pass an axePath that can't exist so the axe branch fails deterministically
    // (Xcode resolves on this CI box; on non-darwin the platform guard fires first).
    if (process.platform !== "darwin") {
      expect(() => assertIosSimReady({ axePath: "/nope/axe" })).toThrow(/macOS-only/);
      return;
    }
    try {
      assertIosSimReady({ axePath: "/nope/axe" });
      // If it didn't throw, Xcode must be missing — that's also an actionable message.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/brew install cameroncooke\/axe\/axe|no full Xcode/);
    }
  });

  it("listBootedSimulators degrades to [] without a usable simctl (never throws)", async () => {
    const sims = await listBootedSimulators({ simctlPath: "/definitely/not/simctl" });
    expect(Array.isArray(sims)).toBe(true);
  });
});
