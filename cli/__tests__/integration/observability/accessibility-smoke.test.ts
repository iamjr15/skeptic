import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { PlaywrightEngine } from "../../../src/executor/playwright-engine.js";
import type { TestInput } from "../../../src/executor/types.js";
import { AccessibilityCollector } from "../../../src/observability/collectors/accessibility-collector.js";
import type { AccessibilitySnapshot } from "../../../src/observability/types.js";

let browser: Browser | null = null;
try {
  browser = await chromium.launch({ headless: true });
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn("[a11y-smoke] chromium launch failed; tests will be skipped:", err);
  browser = null;
}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../fixtures/observability/a11y-test.html",
);

describe.skipIf(!browser)("accessibility smoke", () => {
  let server: http.Server;
  let baseUrl: string;
  let outputDir: string;

  beforeAll(async () => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-a11y-smoke-"));
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

  const baseEngineOpts = (suffix: string) => ({
    outputDir: path.join(outputDir, suffix),
    observability: {
      collectors: ["accessibility" as const],
      networkCaptureLimit: 500,
      duplicateWindowMs: 500,
      accessibilityDualEngine: false,
      accessibilityHtmlSnippetLimit: 500,
    },
  });

  it("axe surfaces deliberate violations on the fixture", async () => {
    const engine = new PlaywrightEngine(baseEngineOpts("a"));
    await engine.launch();
    try {
      const input: TestInput = {
        url: baseUrl,
        name: "a11y-smoke-fail",
        file: path.join(outputDir, "virtual.spec.ts"),
        runFn: async (page, ctx) => {
          await page.goto(baseUrl);
          const a11y = ctx.collectors.get("accessibility");
          if (a11y instanceof AccessibilityCollector) {
            await a11y.audit({ standard: "WCAG2AA" });
          }
        },
      };
      const result = await engine.runTest(input);
      const a11ySnap = result.metrics?.["accessibility"] as
        | AccessibilitySnapshot
        | undefined;
      expect(a11ySnap?.summary.violations).toBeGreaterThan(0);
    } finally {
      await engine.close();
    }
  }, 60_000);

  it("exclude selector filters out the violation", async () => {
    const engine = new PlaywrightEngine(baseEngineOpts("b"));
    await engine.launch();
    try {
      const input: TestInput = {
        url: baseUrl,
        name: "a11y-smoke-exclude",
        file: path.join(outputDir, "virtual.spec.ts"),
        runFn: async (page, ctx) => {
          await page.goto(baseUrl);
          const a11y = ctx.collectors.get("accessibility");
          if (a11y instanceof AccessibilityCollector) {
            await a11y.audit({ standard: "WCAG2AA", exclude: ["img", "button"] });
          }
        },
      };
      const result = await engine.runTest(input);
      const a11ySnap = result.metrics?.["accessibility"] as
        | AccessibilitySnapshot
        | undefined;
      expect(a11ySnap?.summary.violations ?? 0).toBe(0);
    } finally {
      await engine.close();
    }
  }, 60_000);
});
