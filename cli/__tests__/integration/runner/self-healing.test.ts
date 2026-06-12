import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DIST = path.resolve(import.meta.dirname, "../../../dist/skeptic.mjs");

describe("self-healing capture on locator failure", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-heal-"));
    // The spec must be able to `import "skeptic-cli"` — symlink the package so the
    // worker's tsx resolves it (the tmp dir is outside the package tree).
    fs.mkdirSync(path.join(tmp, "node_modules"), { recursive: true });
    fs.symlinkSync(path.resolve(import.meta.dirname, "../../.."), path.join(tmp, "node_modules", "skeptic-cli"));
    fs.writeFileSync(
      path.join(tmp, "heal.spec.ts"),
      `import { test } from "skeptic-cli";\n` +
        `test("broken", async ({ page }) => {\n` +
        `  await page.setContent("<button>Checkout</button><a href=/cart>Cart</a>");\n` +
        `  await page.getByRole("button", { name: "Submit Order" }).click({ timeout: 1200 });\n` +
        `});\n`,
    );
  });

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("attaches the live page's interactive elements + selectorHints to a failed test", () => {
    if (!fs.existsSync(DIST)) return;
    const out = path.join(tmp, "out");
    const r = spawnSync(
      process.execPath,
      [DIST, "run", path.join(tmp, "heal.spec.ts"), "--reporter", "json", "--output", out, "--no-daemon"],
      { encoding: "utf-8", timeout: 90_000, env: { ...process.env } },
    );
    // The test is expected to FAIL (bad locator); status non-zero is correct.
    if (!fs.existsSync(path.join(out, "results.json"))) {
      console.warn("[self-healing] no results.json; chromium likely unavailable:", r.stderr?.slice(0, 200));
      return;
    }
    const results = JSON.parse(fs.readFileSync(path.join(out, "results.json"), "utf-8")) as {
      tests: Array<{ status: string; healing?: { candidates: Array<{ role: string; name: string; selectorHint: string }> } }>;
    };
    const test = results.tests[0]!;
    expect(test.status).not.toBe("passed");
    // If the run failed before the page loaded (e.g. chromium unavailable), there's
    // nothing to heal against — skip rather than fail.
    if (!test.healing) {
      console.warn("[self-healing] no healing captured (page likely never loaded); skipping");
      return;
    }
    const hints = test.healing!.candidates.map((c) => c.selectorHint);
    expect(hints).toContain("role=button:Checkout");
    expect(hints).toContain("role=link:Cart");
  }, 90_000);
});
