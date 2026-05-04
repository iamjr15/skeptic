import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { PlaywrightEngine } from "../../../src/executor/playwright-engine.js";
import { OBSERVABILITY_SETTLE_PROFILE } from "../../../src/executor/visual-settle.js";
import type { TestInput } from "../../../src/executor/types.js";
import type { CollectorName } from "../../../src/observability/types.js";

let browser: Browser | null = null;
try {
  browser = await chromium.launch({ headless: true });
} catch (err) {
  console.warn("[sidecar-write] chromium launch failed; tests will be skipped:", err);
  browser = null;
}

const FIXTURE_DIR = path.resolve(import.meta.dirname, "../../fixtures/observability/bundle4");

describe.skipIf(!browser)("--observability-write-sidecars produces the three sidecar files", () => {
  let server: http.Server;
  let baseUrl: string;
  let outputDir: string;

  beforeAll(async () => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-sidecars-"));
    const html = fs.readFileSync(path.join(FIXTURE_DIR, "index.html"), "utf-8");
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

  it("writes perf-trace.md, console.json, network.json with the expected shape", async () => {
    const collectors: CollectorName[] = ["performance", "network", "console", "accessibility"];
    const engine = new PlaywrightEngine({
      outputDir,
      observability: {
        collectors,
        networkCaptureLimit: 500,
        duplicateWindowMs: 500,
        accessibilityDualEngine: false,
        accessibilityHtmlSnippetLimit: 500,
        consoleCaptureLimit: 200,
        consoleRedaction: true,
        autoAccessibilityAudit: true,
        accessibilityStandard: "WCAG21AA",
      },
      artifactConfig: {
        fullPageScreenshots: true,
        visualSettle: OBSERVABILITY_SETTLE_PROFILE,
        blankFrameDetection: "warn",
        writeSidecars: true,
      },
    });

    await engine.launch();
    try {
      const input: TestInput = {
        url: baseUrl,
        name: "sidecar-smoke",
        file: path.join(FIXTURE_DIR, "virtual.spec.ts"),
        runFn: async (page) => {
          await page.goto(baseUrl);
        },
      };

      const result = await engine.runTest(input);
      expect(result.status).toBe("passed");

      // Three sidecar paths populated.
      expect(result.artifacts.perfTrace).toBeDefined();
      expect(result.artifacts.consoleSnapshot).toBeDefined();
      expect(result.artifacts.networkSnapshot).toBeDefined();

      // Files exist on disk
      expect(fs.existsSync(result.artifacts.perfTrace!)).toBe(true);
      expect(fs.existsSync(result.artifacts.consoleSnapshot!)).toBe(true);
      expect(fs.existsSync(result.artifacts.networkSnapshot!)).toBe(true);

      // perf-trace.md has the expected sections
      const md = fs.readFileSync(result.artifacts.perfTrace!, "utf-8");
      expect(md).toContain("# Performance Trace");
      expect(md).toContain("## Web Vitals");
      expect(md).toContain("## Network");
      expect(md).toContain("## Console");
      expect(md).toContain("## Accessibility");

      // console.json round-trips through JSON
      const consoleJson = JSON.parse(
        fs.readFileSync(result.artifacts.consoleSnapshot!, "utf-8"),
      ) as { summary: { total: number; redactionDisabled: boolean } };
      expect(consoleJson.summary.total).toBeGreaterThan(0);
      expect(consoleJson.summary.redactionDisabled).toBe(false);

      // network.json round-trips and contains at least the document request
      const networkJson = JSON.parse(
        fs.readFileSync(result.artifacts.networkSnapshot!, "utf-8"),
      ) as { requests: unknown[] };
      expect(networkJson.requests.length).toBeGreaterThan(0);
    } finally {
      await engine.close();
    }
  }, 60_000);

  it("does not write sidecars when writeSidecars is false", async () => {
    const collectors: CollectorName[] = ["performance"];
    const engine = new PlaywrightEngine({
      outputDir,
      observability: {
        collectors,
        networkCaptureLimit: 500,
        duplicateWindowMs: 500,
        accessibilityDualEngine: false,
        accessibilityHtmlSnippetLimit: 500,
      },
      artifactConfig: {
        fullPageScreenshots: false,
        visualSettle: { enabled: false, networkIdleMs: 0, animationFrames: 0, pixelStableMs: 0, hardCeilingMs: 0 },
        blankFrameDetection: "warn",
        writeSidecars: false,
      },
    });

    await engine.launch();
    try {
      const input: TestInput = {
        url: baseUrl,
        name: "sidecar-off",
        file: path.join(FIXTURE_DIR, "virtual.spec.ts"),
        runFn: async (page) => {
          await page.goto(baseUrl);
        },
        testIndex: 1,
      };

      const result = await engine.runTest(input);
      expect(result.artifacts.perfTrace).toBeUndefined();
      expect(result.artifacts.consoleSnapshot).toBeUndefined();
      expect(result.artifacts.networkSnapshot).toBeUndefined();
    } finally {
      await engine.close();
    }
  }, 60_000);
});
