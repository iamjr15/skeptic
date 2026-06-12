import { describe, it, expect, vi, beforeEach } from "vitest";

// Spies must be hoisted so the vi.mock factory (itself hoisted above imports) can reference them.
const { installSpy, installDepsSpy, resolveBrowsersSpy, validateSpy } = vi.hoisted(() => ({
  installSpy: vi.fn(async () => {}),
  installDepsSpy: vi.fn(async () => {}),
  resolveBrowsersSpy: vi.fn(() => [{ name: "chromium" }]),
  validateSpy: vi.fn(async () => {}),
}));

vi.mock("../../../src/utils/playwright-loader.js", () => ({
  loadPlaywrightCoreServer: async () => ({
    registry: {
      resolveBrowsers: resolveBrowsersSpy,
      install: installSpy,
      installDeps: installDepsSpy,
      validateHostRequirementsForExecutablesIfNeeded: validateSpy,
    },
  }),
}));

import { runBrowsersInstall } from "../../../src/commands/browsers-install.js";

beforeEach(() => {
  installSpy.mockClear();
  installDepsSpy.mockClear();
  resolveBrowsersSpy.mockClear();
  validateSpy.mockClear();
});

describe("browsers install --dry-run (#4)", () => {
  it("does NOT download browsers or validate host requirements on --dry-run", async () => {
    await runBrowsersInstall(["chromium"], { dryRun: true });
    expect(installSpy).not.toHaveBeenCalled();
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it("forwards dryRun=true to installDeps under --with-deps, still without downloading", async () => {
    await runBrowsersInstall(["chromium"], { dryRun: true, withDeps: true });
    expect(installDepsSpy).toHaveBeenCalledWith(expect.anything(), true);
    expect(installSpy).not.toHaveBeenCalled();
  });

  it("actually installs when --dry-run is absent", async () => {
    await runBrowsersInstall(["chromium"], {});
    expect(installSpy).toHaveBeenCalledTimes(1);
  });

  it("passes dryRun=false to installDeps on a real --with-deps install", async () => {
    await runBrowsersInstall(["chromium"], { withDeps: true });
    expect(installDepsSpy).toHaveBeenCalledWith(expect.anything(), false);
    expect(installSpy).toHaveBeenCalledTimes(1);
  });
});
