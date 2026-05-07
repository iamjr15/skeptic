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

  it("creates package metadata, tests/ directory, config file, tsconfig, example test, and ignored cache directory", async () => {
    const { runInit } = await import("../../../src/commands/init.js");
    await runInit(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, "tests"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "tests/package.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "tsconfig.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "skeptic.config.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "tests/example.spec.ts"))).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8")) as {
      type?: string;
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.type).toBe("module");
    expect(pkg.scripts?.["test:e2e"]).toBe("skeptic run");
    expect(pkg.devDependencies?.["skeptic-cli"]).toBe("^0.0.0-dev");
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, "tests/package.json"), "utf-8"))).toEqual({
      type: "module",
    });
    expect(fs.readFileSync(path.join(tmpDir, ".skeptic/.gitignore"), "utf-8")).toBe("*\n!.gitignore\n");
    expect(fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8")).toContain(".skeptic/");
    expect(fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8")).toContain("skeptic-output/");
  });

  it("does not overwrite existing config file", async () => {
    const configPath = path.join(tmpDir, "skeptic.config.yaml");
    fs.writeFileSync(configPath, "existing: true\n", "utf-8");

    const { runInit } = await import("../../../src/commands/init.js");
    await runInit(tmpDir);

    const content = fs.readFileSync(configPath, "utf-8");
    expect(content).toBe("existing: true\n");
  });

  it("does not overwrite existing example test", async () => {
    const testsDir = path.join(tmpDir, "tests");
    fs.mkdirSync(testsDir, { recursive: true });
    const examplePath = path.join(testsDir, "example.spec.ts");
    fs.writeFileSync(examplePath, "export const untouched = true;\n", "utf-8");

    const { runInit } = await import("../../../src/commands/init.js");
    await runInit(tmpDir);

    const content = fs.readFileSync(examplePath, "utf-8");
    expect(content).toBe("export const untouched = true;\n");
  });

  it("updates an existing package.json without changing its module type", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "app", type: "commonjs", scripts: { test: "vitest" } }, null, 2),
      "utf-8",
    );

    const { runInit } = await import("../../../src/commands/init.js");
    await runInit(tmpDir);

    const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8")) as {
      type?: string;
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.type).toBe("commonjs");
    expect(pkg.scripts?.test).toBe("vitest");
    expect(pkg.scripts?.["test:e2e"]).toBe("skeptic run");
    expect(pkg.devDependencies?.["skeptic-cli"]).toBe("^0.0.0-dev");
  });

  it("does not overwrite an existing tests/package.json", async () => {
    fs.mkdirSync(path.join(tmpDir, "tests"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "tests/package.json"), "{\"type\":\"commonjs\"}\n", "utf-8");

    const { runInit } = await import("../../../src/commands/init.js");
    await runInit(tmpDir);

    expect(fs.readFileSync(path.join(tmpDir, "tests/package.json"), "utf-8")).toBe("{\"type\":\"commonjs\"}\n");
  });

  it("creates tests/ directory even if it already exists", async () => {
    fs.mkdirSync(path.join(tmpDir, "tests"), { recursive: true });

    const { runInit } = await import("../../../src/commands/init.js");
    await runInit(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, "tests"))).toBe(true);
  });

  it("preserves existing .gitignore content and only appends missing skeptic entries", async () => {
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "node_modules/\n.skeptic\n", "utf-8");

    const { runInit } = await import("../../../src/commands/init.js");
    await runInit(tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules/\n");
    expect(content.match(/\.skeptic\/?/g)).toHaveLength(1);
    expect(content).toContain("skeptic-output/");
  });

  it("does not overwrite an existing .skeptic/.gitignore", async () => {
    fs.mkdirSync(path.join(tmpDir, ".skeptic"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".skeptic/.gitignore"), "custom\n", "utf-8");

    const { runInit } = await import("../../../src/commands/init.js");
    await runInit(tmpDir);

    expect(fs.readFileSync(path.join(tmpDir, ".skeptic/.gitignore"), "utf-8")).toBe("custom\n");
  });
});
