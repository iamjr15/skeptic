import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { PlaywrightEngine } from "../../../src/executor/playwright-engine.js";
import type { TestInput } from "../../../src/executor/types.js";
import type { AccessibilitySnapshot, CollectorName } from "../../../src/observability/types.js";

let browser: Browser | null = null;
try {
  browser = await chromium.launch({ headless: true });
} catch (err) {
  console.warn("[auto-a11y] chromium launch failed; tests will be skipped:", err);
  browser = null;
}

const FIXTURE_DIR = path.resolve(import.meta.dirname, "../../fixtures/observability/bundle4");

describe.skipIf(!browser)("auto a11y audit (Bundle 2 §5.6)", () => {
  let server: http.Server;
  let baseUrl: string;
  let outputDir: string;

  beforeAll(async () => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-auto-a11y-"));
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

  const collectors: CollectorName[] = ["accessibility"];

  it("auto-fires audit when autoAccessibilityAudit=true and no explicit step ran", async () => {
    const engine = new PlaywrightEngine({
      outputDir,
      observability: {
        collectors,
        networkCaptureLimit: 500,
        duplicateWindowMs: 500,
        accessibilityDualEngine: false,
        accessibilityHtmlSnippetLimit: 500,
        autoAccessibilityAudit: true,
        accessibilityStandard: "WCAG21AA",
      },
    });

    await engine.launch();
    try {
      const input: TestInput = {
        url: baseUrl,
        name: "auto-a11y-no-step",
        file: path.join(FIXTURE_DIR, "virtual.spec.ts"),
        runFn: async (page) => {
          await page.goto(baseUrl);
        },
      };

      const result = await engine.runTest(input);
      expect(result.status).toBe("passed");

      const a11y = result.metrics?.["accessibility"] as AccessibilitySnapshot | undefined;
      expect(a11y).toBeDefined();
      // Fixture has unlabeled <button> + <img> without alt — axe should flag at least one violation
      expect(a11y!.summary.violations).toBeGreaterThan(0);
      expect(a11y!.standard).toBe("WCAG21AA");
    } finally {
      await engine.close();
    }
  }, 60_000);

  it("does NOT auto-fire when autoAccessibilityAudit=false", async () => {
    const engine = new PlaywrightEngine({
      outputDir,
      observability: {
        collectors,
        networkCaptureLimit: 500,
        duplicateWindowMs: 500,
        accessibilityDualEngine: false,
        accessibilityHtmlSnippetLimit: 500,
        autoAccessibilityAudit: false,
      },
    });

    await engine.launch();
    try {
      const input: TestInput = {
        url: baseUrl,
        name: "auto-a11y-disabled",
        file: path.join(FIXTURE_DIR, "virtual.spec.ts"),
        runFn: async (page) => {
          await page.goto(baseUrl);
        },
        testIndex: 1,
      };

      const result = await engine.runTest(input);
      // Collector attached but no audit ran — snapshot returns undefined → metrics.accessibility absent
      expect(result.metrics?.["accessibility"]).toBeUndefined();
    } finally {
      await engine.close();
    }
  }, 60_000);

  it("does NOT clobber an explicit accessibilityAudit step's results", async () => {
    const engine = new PlaywrightEngine({
      outputDir,
      observability: {
        collectors,
        networkCaptureLimit: 500,
        duplicateWindowMs: 500,
        accessibilityDualEngine: false,
        accessibilityHtmlSnippetLimit: 500,
        autoAccessibilityAudit: true,
        accessibilityStandard: "WCAG21AA",
      },
    });

    await engine.launch();
    try {
      const input: TestInput = {
        url: baseUrl,
        name: "auto-a11y-explicit-step",
        file: path.join(FIXTURE_DIR, "virtual.spec.ts"),
        runFn: async (page, ctx) => {
          await page.goto(baseUrl);
          const a11y = ctx.collectors.get("accessibility");
          if (a11y) {
            await (a11y as { audit: (i: { standard: string }) => Promise<unknown> }).audit({
              standard: "WCAG2A",
            });
          }
        },
        testIndex: 2,
      };

      const result = await engine.runTest(input);
      // The fixture has real WCAG violations, so the explicit step is expected to fail —
      // that's the user's chosen contract. We're testing that the auto-audit doesn't
      // overwrite the explicit step's snapshot, not that the flow passes.
      const a11y = result.metrics?.["accessibility"] as AccessibilitySnapshot | undefined;
      expect(a11y).toBeDefined();
      // The explicit step ran with WCAG2A, so the snapshot should reflect that — auto-audit
      // saw lastSnapshot already set and skipped.
      expect(a11y!.standard).toBe("WCAG2A");
    } finally {
      await engine.close();
    }
  }, 60_000);
});
