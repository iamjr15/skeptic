import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../../../src/config/loader.js";

let tmpA: string;
let tmpB: string;

beforeEach(() => {
  tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-cfg-a-"));
  tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-cfg-b-"));
  fs.writeFileSync(
    path.join(tmpA, "skeptic.config.yaml"),
    "url: http://a.example\ntests: tests/**/*.yaml\n",
  );
  fs.writeFileSync(
    path.join(tmpB, "skeptic.config.yaml"),
    "url: http://b.example\ntests: tests/**/*.yaml\n",
  );
});

afterEach(() => {
  fs.rmSync(tmpA, { recursive: true, force: true });
  fs.rmSync(tmpB, { recursive: true, force: true });
});

describe("loadConfig({ searchCwd })", () => {
  it("walks up from process.cwd() when searchCwd is not supplied (regression)", () => {
    // No config exists alongside process.cwd() (the cli/ workspace root has no skeptic.config.yaml
    // checked in), so this should fall back to schema defaults.
    const config = loadConfig({});
    expect(config.url).toBeUndefined();
  });

  it("walks up from searchCwd when provided", () => {
    const config = loadConfig({ searchCwd: tmpA });
    expect(config.url).toBe("http://a.example");
  });

  it("ignores searchCwd when configPath is also supplied", () => {
    const config = loadConfig({
      configPath: path.join(tmpA, "skeptic.config.yaml"),
      searchCwd: tmpB,
    });
    expect(config.url).toBe("http://a.example");
  });

  it("two concurrent calls with different searchCwd values do not interfere", async () => {
    const [a, b] = await Promise.all([
      Promise.resolve(loadConfig({ searchCwd: tmpA })),
      Promise.resolve(loadConfig({ searchCwd: tmpB })),
    ]);
    expect(a.url).toBe("http://a.example");
    expect(b.url).toBe("http://b.example");
  });
});
