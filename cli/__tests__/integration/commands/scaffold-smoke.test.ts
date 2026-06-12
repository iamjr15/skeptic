import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runScaffold } from "../../../src/commands/scaffold.js";

const URL =
  "data:text/html,<title>Demo Shop</title><h1>Shop</h1><button>Buy</button><a href=/cart>Cart</a>";

describe("scaffold smoke (real browser)", () => {
  let browserOk = false;
  let tmp: string;
  let cwd: string;

  beforeAll(async () => {
    try {
      const b: Browser = await chromium.launch({ headless: true });
      await b.close();
      browserOk = true;
    } catch (err) {
      console.warn("[scaffold-smoke] chromium unavailable; skipping:", err);
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-scaffold-"));
    cwd = process.cwd();
    process.chdir(tmp);
  }, 30_000);

  afterAll(() => {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("emits a valid spec skeleton from a live page's interactive elements", async () => {
    if (!browserOk) return;
    await runScaffold(URL, { output: "tests" });
    const files = fs.readdirSync(path.join(tmp, "tests")).filter((f) => f.endsWith(".spec.ts"));
    expect(files).toHaveLength(1);
    const spec = fs.readFileSync(path.join(tmp, "tests", files[0]!), "utf-8");
    expect(spec).toContain('import { test, expect } from "skeptic-cli"');
    expect(spec).toContain("await page.goto(");
    expect(spec).toContain("toHaveTitle(/Demo Shop/)");
    // discovered elements show up as commented byRole interactions
    expect(spec).toContain('button "Buy"');
    expect(spec).toContain('tree.byRole("button", { name: "Buy" })');
    expect(spec).toContain("expectNoConsoleErrors()");
  }, 30_000);
});
