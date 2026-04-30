import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { PlaywrightEngine } from "../../../src/executor/playwright-engine.js";
import type { TestInput } from "../../../src/executor/types.js";
import { AccessibilityCollector } from "../../../src/observability/collectors/accessibility-collector.js";
import type { AccessibilitySnapshot } from "../../../src/observability/types.js";

// Optional peer dep — skip the entire suite if not installed.
let ibmInstalled = false;
try {
  const req = createRequire(import.meta.url);
  req.resolve("accessibility-checker-engine/ace.js");
  ibmInstalled = true;
} catch {
  // not installed — describe.skipIf handles it
}

let browser: Browser | null = null;
if (ibmInstalled) {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[ibm-dual-engine] chromium launch failed; tests will be skipped:", err);
    browser = null;
  }
}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../fixtures/observability/a11y-test.html",
);

// Run sequentially — IBM Equal Access has known "ace.Checker is not a constructor"
// failures under parallel page-evaluate invocations against the same page context.
describe.skipIf(!ibmInstalled || !browser).sequential("IBM Equal Access dual-engine", () => {
  let server: http.Server;
  let baseUrl: string;
  let outputDir: string;

  beforeAll(async () => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-ibm-"));
    const html = fs.readFileSync(FIXTURE_PATH, "utf-8");
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(outputDir, { recursive: true, force: true });
    if (browser) await browser.close();
  });

  it("runs both engines and reports dualEngine: true", async () => {
    const engine = new PlaywrightEngine({
      outputDir,
      observability: {
        collectors: ["accessibility"],
        networkCaptureLimit: 500,
        duplicateWindowMs: 500,
        accessibilityDualEngine: true,
        accessibilityHtmlSnippetLimit: 500,
      },
    });
    await engine.launch();
    try {
      const input: TestInput = {
        url: baseUrl,
        name: "ibm-dual",
        file: path.join(outputDir, "virtual.spec.ts"),
        runFn: async (page, ctx) => {
          await page.goto(baseUrl);
          const a11y = ctx.collectors.get("accessibility");
          if (a11y instanceof AccessibilityCollector) {
            await a11y.audit({ standard: "WCAG22AA" });
          }
        },
      };
      const result = await engine.runTest(input);
      const a11y = result.metrics?.accessibility as AccessibilitySnapshot | undefined;
      expect(a11y).toBeDefined();
      expect(a11y!.summary.dualEngine).toBe(true);
      expect(a11y!.summary.enginesRequested).toEqual(["axe", "equal-access"]);
      // Both engines should at minimum NOT have errored (this is the core wiring check)
      expect(a11y!.summary.enginesErrored).toEqual([]);
    } finally {
      await engine.close();
    }
  }, 120_000);
});
