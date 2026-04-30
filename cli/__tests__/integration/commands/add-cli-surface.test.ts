import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

// ESM: package.json has `"type": "module"`, so use `import.meta.dirname` (Node 20+),
// mirroring cli/__tests__/integration/commands/test-command.test.ts:10.
const skepticBin = path.resolve(import.meta.dirname, "../../../dist/skeptic.mjs");

describe("skeptic add github-action CLI surface", () => {
  beforeAll(() => {
    if (!fs.existsSync(skepticBin)) {
      throw new Error(`Build required: ${skepticBin} not found. Run 'npm run build' first.`);
    }
  });

  it("advertises --provider, -c/--config, --ai, --dev-command, --dev-url in --help", () => {
    const help = execFileSync("node", [skepticBin, "add", "github-action", "--help"], {
      encoding: "utf-8",
    });
    expect(help).toContain("--ai");
    expect(help).toContain("--dev-command");
    expect(help).toContain("--dev-url");
    expect(help).toContain("--provider");
    expect(help).toContain("-c, --config");
  });
});
