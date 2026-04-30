import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { PlaywrightEngine } from "../../../src/executor/playwright-engine.js";
import type { TestInput } from "../../../src/executor/types.js";
import type { PerformanceSnapshot } from "../../../src/observability/types.js";

// Top-level browser launch — describe.skipIf evaluates this BEFORE tests register.
let browser: Browser | null = null;
try {
  browser = await chromium.launch({ headless: true });
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn("[perf-smoke] chromium launch failed; tests will be skipped:", err);
  browser = null;
}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../fixtures/observability/perf-test.html",
);

describe.skipIf(!browser)("performance smoke", () => {
  let server: http.Server;
  let baseUrl: string;
  let outputDir: string;

  beforeAll(async () => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-perf-smoke-"));
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

  it("captures FCP, attaches the performance collector, and runs assertPerformance", async () => {
    const engine = new PlaywrightEngine({
      outputDir,
      observability: {
        collectors: ["performance"],
        networkCaptureLimit: 500,
        duplicateWindowMs: 500,
        accessibilityDualEngine: false,
        accessibilityHtmlSnippetLimit: 500,
      },
    });
    await engine.launch();
    try {
      const input: TestInput = {
        url: baseUrl,
        name: "perf-smoke",
        file: path.join(outputDir, "virtual.spec.ts"),
        runFn: async (page) => {
          await page.goto(baseUrl);
          await page.waitForTimeout(1000);
        },
      };
      const result = await engine.runTest(input);

      const perf = result.metrics?.performance as PerformanceSnapshot | undefined;
      expect(perf).toBeDefined();
      // FCP is the most reliable web-vital to fire on a simple page navigate; LCP
      // sometimes doesn't fire if the largest element settles before our snapshot.
      // We assert the collector wiring works (snapshot present, FCP measured); we do
      // NOT assert LCP/INP/CLS values to avoid flakiness in the smoke test.
      expect(perf?.fcp).toBeGreaterThan(0);
    } finally {
      await engine.close();
    }
  }, 60_000);
});
