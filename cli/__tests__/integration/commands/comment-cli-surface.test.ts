import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

const skepticBin = path.resolve(import.meta.dirname, "../../../dist/skeptic.mjs");

describe("skeptic comment CLI surface", () => {
  beforeAll(() => {
    if (!fs.existsSync(skepticBin)) {
      throw new Error(`Build required: ${skepticBin} not found. Run 'npm run build' first.`);
    }
  });

  it("advertises --results, --pr, --marker, --run-url, --dry-run, -c/--config in --help", () => {
    const help = execFileSync("node", [skepticBin, "comment", "--help"], {
      encoding: "utf-8",
    });
    expect(help).toContain("--results");
    expect(help).toContain("--pr");
    expect(help).toContain("--marker");
    expect(help).toContain("--run-url");
    expect(help).toContain("--dry-run");
    expect(help).toContain("-c, --config");
  });

  it("appears in the top-level command list", () => {
    const help = execFileSync("node", [skepticBin, "--help"], { encoding: "utf-8" });
    expect(help).toContain("comment");
  });
});
