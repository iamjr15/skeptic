import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Stub the browsers-install helper so tests don't actually download
// Playwright. init.ts dynamic-imports this module; vi.mock hoists, so the
// mock is in place by the time the import resolves.
vi.mock("../../../src/commands/browsers-install.js", () => ({
  runBrowsersInstall: vi.fn().mockResolvedValue(undefined),
}));

describe("runInit", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-init-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates tests/ directory, config file, tsconfig, and example test", async () => {
    const { runInit } = await import("../../../src/commands/init.js");
    await runInit(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, "tests"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "tsconfig.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "skeptic.config.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "tests/example.spec.ts"))).toBe(true);
  });

  it("does not overwrite existing config file", async () => {
    const configPath = path.join(tmpDir, "skeptic.config.yaml");
    fs.writeFileSync(configPath, "existing: true\n", "utf-8");

    const { runInit } = await import("../../../src/commands/init.js");
    await runInit(tmpDir);

    const content = fs.readFileSync(configPath, "utf-8");
    expect(content).toBe("existing: true\n");
  });

  it("does not overwrite existing example flow", async () => {
    const testsDir = path.join(tmpDir, "tests");
    fs.mkdirSync(testsDir, { recursive: true });
    const examplePath = path.join(testsDir, "example.flow.yaml");
    fs.writeFileSync(examplePath, "my-flow: true\n", "utf-8");

    const { runInit } = await import("../../../src/commands/init.js");
    await runInit(tmpDir);

    const content = fs.readFileSync(examplePath, "utf-8");
    expect(content).toBe("my-flow: true\n");
  });

  it("creates tests/ directory even if it already exists", async () => {
    fs.mkdirSync(path.join(tmpDir, "tests"), { recursive: true });

    const { runInit } = await import("../../../src/commands/init.js");
    await runInit(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, "tests"))).toBe(true);
  });
});
