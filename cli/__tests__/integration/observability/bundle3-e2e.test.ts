import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { PlaywrightEngine } from "../../../src/executor/playwright-engine.js";
import type { TestInput } from "../../../src/executor/types.js";
import type {
  AccessibilitySnapshot,
  CollectorName,
  NetworkSnapshot,
  PerformanceSnapshot,
} from "../../../src/observability/types.js";
import { AccessibilityCollector } from "../../../src/observability/collectors/accessibility-collector.js";

let browser: Browser | null = null;
try {
  browser = await chromium.launch({ headless: true });
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn("[bundle3-e2e] chromium launch failed; tests will be skipped:", err);
  browser = null;
}

const FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "../../fixtures/observability/bundle3",
);

describe.skipIf(!browser)("Bundle 3 combined E2E", () => {
  let server: http.Server;
  let baseUrl: string;
  let outputDir: string;

  beforeAll(async () => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-bundle3-e2e-"));
    const html = fs.readFileSync(path.join(FIXTURE_DIR, "index.html"), "utf-8");
    server = http.createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/" || url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } else if (url === "/api/data") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      } else {
        res.writeHead(404);
        res.end();
      }
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

  it("runs all three collectors against one test and populates TestResult.metrics", async () => {
    const collectors: CollectorName[] = ["performance", "network", "accessibility"];
    const engine = new PlaywrightEngine({
      outputDir,
      observability: {
        collectors,
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
        name: "bundle3-e2e",
        file: path.join(FIXTURE_DIR, "virtual.spec.ts"),
        runFn: async (page, ctx) => {
          await page.goto(baseUrl);
          // Trigger the in-page fetch button so the network collector sees /api/data.
          await page.click("#load-data").catch(() => {});
          await page.waitForLoadState("networkidle").catch(() => {});
          await page.waitForTimeout(300);
          // Run an explicit accessibility audit so the collector populates a snapshot
          // (the YAML pipeline used to do this via the accessibilityAudit step).
          const a11y = ctx.collectors.get("accessibility");
          if (a11y instanceof AccessibilityCollector) {
            await a11y.audit({ standard: "WCAG21AA" });
          }
        },
      };

      const result = await engine.runTest(input);

      // TestResult.metrics has all three namespaces
      expect(result.metrics).toBeDefined();
      const perf = result.metrics?.performance as PerformanceSnapshot | undefined;
      const net = result.metrics?.network as NetworkSnapshot | undefined;
      const a11y = result.metrics?.accessibility as AccessibilitySnapshot | undefined;

      // Performance collector ran (FCP at minimum should fire on a real navigation)
      expect(perf).toBeDefined();
      expect(perf?.fcp).toBeGreaterThan(0);

      // Network collector captured both the initial doc and the /api/data fetch
      expect(net).toBeDefined();
      expect(net!.requests.length).toBeGreaterThan(0);
      const urls = net!.requests.map((r) => r.url);
      expect(urls.some((u) => u.endsWith("/api/data"))).toBe(true);

      // Accessibility collector ran; snapshot has structured engine status
      expect(a11y).toBeDefined();
      expect(typeof a11y!.summary.violations).toBe("number");
      expect(a11y!.summary.enginesRequested).toEqual(["axe"]);
    } finally {
      await engine.close();
    }
  }, 90_000);
});
