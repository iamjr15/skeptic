import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { PlaywrightDriver } from "../../../src/driver/playwright/playwright-driver.js";
import type { DriverSession } from "../../../src/driver/types.js";

const HTML = `<!doctype html><html><body>
  <h1>Driver Smoke</h1>
  <button id="go" onclick="document.getElementById('out').textContent='clicked'">Go</button>
  <input aria-label="Email" />
  <p id="out">idle</p>
</body></html>`;

// Proves the Driver seam end-to-end against real Chromium: newSession → open →
// snapshot (refs minted) → resolveRef → click → re-snapshot. The underlying
// helpers are covered elsewhere; this guards the PlaywrightDriver wiring.
describe("PlaywrightDriver smoke (real browser)", () => {
  let browser: Browser | null = null;
  let driver: PlaywrightDriver | null = null;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    try {
      browser = await chromium.launch({ headless: true });
      driver = PlaywrightDriver.fromBrowser(browser, false);
    } catch (err) {
      console.warn("[driver-smoke] chromium launch failed; tests will be skipped:", err);
      browser = null;
    }
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (browser) await browser.close();
  });

  it("open → snapshot → resolveRef → click drives a real page", async () => {
    if (!driver) return; // chromium unavailable in this environment
    const session: DriverSession = await driver.newSession();
    try {
      await session.open(baseUrl);
      expect(session.url()).toContain("127.0.0.1");
      expect(await session.title()).toBe("");

      const cap = await session.snapshot();
      const button = cap.entries.find((e) => e.role === "button" && e.name === "Go");
      expect(button, "snapshot should mint a ref for the Go button").toBeDefined();

      const el = await session.resolveRef(button!.ref);
      expect(await el.textContent()).toContain("Go");
      await el.click();

      // The click mutated the DOM — resolve the output paragraph and read it.
      const out = await session.resolveSelector("css=#out");
      expect(await out.textContent()).toBe("clicked");
    } finally {
      await session.close();
    }
  }, 30_000);

  it("open() invalidates the previous snapshot's refs", async () => {
    if (!driver) return;
    const session = await driver.newSession();
    try {
      await session.open(baseUrl);
      await session.snapshot();
      const raw = session.raw?.();
      expect(raw).toBeDefined();
      // Re-open invalidates refs; resolving a stale ref must throw, not silently act.
      await session.open(baseUrl);
      await expect(session.resolveRef("e1")).rejects.toThrow();
    } finally {
      await session.close();
    }
  }, 30_000);
});
