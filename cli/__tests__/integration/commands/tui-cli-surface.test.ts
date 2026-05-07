import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

const skepticBin = path.resolve(import.meta.dirname, "../../../dist/skeptic.mjs");

describe("skeptic tui CLI surface", () => {
  beforeAll(() => {
    if (!fs.existsSync(skepticBin)) {
      throw new Error(`Build required: ${skepticBin} not found. Run 'npm run build' first.`);
    }
  });

  it("appears in the top-level command list", () => {
    const help = execFileSync("node", [skepticBin, "--help"], { encoding: "utf-8" });
    expect(help).toContain("tui");
    expect(help).toContain("Open the interactive test runner TUI");
  });

  it("shares the run command options customers expect", () => {
    const help = execFileSync("node", [skepticBin, "tui", "--help"], {
      encoding: "utf-8",
    });
    expect(help).toContain("Usage: skeptic tui [options] [specs...]");
    expect(help).toContain("--reporter");
    expect(help).toContain("--headed");
    expect(help).toContain("--parallel");
    expect(help).toContain("--no-daemon");
    expect(help).not.toContain("--no-tui");
    expect(help).not.toContain("--watch");
  });
});
