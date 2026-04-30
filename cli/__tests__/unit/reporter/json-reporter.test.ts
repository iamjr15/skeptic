import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { JsonReporter } from "../../../src/reporter/json-reporter.js";
import type { RunSummary } from "../../../src/reporter/types.js";

describe("JsonReporter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-json-"));
  });

  afterEach(() => {
    delete process.env["SKEPTIC_JSON_PRETTY"];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSummary(): RunSummary {
    return {
      total: 2,
      passed: 1,
      failed: 1,
      duration_ms: 3000,
      tests: [
        {
          name: "Login Flow",
          file: "flows/login.yaml",
          status: "passed",
          duration_ms: 1500,
          steps: [
            { command: "navigate", args: { value: "/login" }, status: "passed", duration_ms: 300 },
          ],
        },
        {
          name: "Dashboard Flow",
          file: "flows/dashboard.yaml",
          status: "failed",
          duration_ms: 1500,
          steps: [
            { command: "click", args: { target: "#btn" }, status: "failed", duration_ms: 200, error: "Not found" },
          ],
        },
      ],
    };
  }

  it("writes results.json to output directory", () => {
    const reporter = new JsonReporter(tmpDir);
    reporter.onRunComplete(makeSummary());

    expect(fs.existsSync(path.join(tmpDir, "results.json"))).toBe(true);
  });

  it("writes valid JSON with expected fields", () => {
    const reporter = new JsonReporter(tmpDir);
    reporter.onRunComplete(makeSummary());

    const raw = fs.readFileSync(path.join(tmpDir, "results.json"), "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;

    expect(data["version"]).toBe("0.3.0");
    expect(data["timestamp"]).toBeDefined();
    expect(data["total"]).toBe(2);
    expect(data["passed"]).toBe(1);
    expect(data["failed"]).toBe(1);
    expect(data["duration_ms"]).toBe(3000);
    expect(data["tests"]).toHaveLength(2);
  });

  it("includes flow steps in output", () => {
    const reporter = new JsonReporter(tmpDir);
    reporter.onRunComplete(makeSummary());

    const raw = fs.readFileSync(path.join(tmpDir, "results.json"), "utf-8");
    const data = JSON.parse(raw) as { tests: Array<{ steps: unknown[] }> };

    expect(data.tests[0]!.steps).toHaveLength(1);
    expect(data.tests[1]!.steps).toHaveLength(1);
  });

  it("creates output directory if it does not exist", () => {
    const nested = path.join(tmpDir, "deep", "nested");
    const reporter = new JsonReporter(nested);
    reporter.onRunComplete(makeSummary());

    expect(fs.existsSync(path.join(nested, "results.json"))).toBe(true);
  });

  it("writes compact JSON by default", () => {
    const reporter = new JsonReporter(tmpDir);
    reporter.onRunComplete(makeSummary());

    const raw = fs.readFileSync(path.join(tmpDir, "results.json"), "utf-8");
    expect(raw).not.toContain("\n  ");
    expect(JSON.parse(raw)).toMatchObject({ total: 2, passed: 1, failed: 1 });
  });

  it("pretty-prints JSON when SKEPTIC_JSON_PRETTY=true", () => {
    process.env["SKEPTIC_JSON_PRETTY"] = "true";
    const reporter = new JsonReporter(tmpDir);
    reporter.onRunComplete(makeSummary());

    const raw = fs.readFileSync(path.join(tmpDir, "results.json"), "utf-8");
    expect(raw).toContain("\n  ");
    expect(JSON.parse(raw)).toMatchObject({ total: 2, passed: 1, failed: 1 });
  });
});
