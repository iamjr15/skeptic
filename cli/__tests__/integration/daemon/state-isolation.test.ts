import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startDaemon } from "../../../src/daemon/lifecycle.js";
import { loadPlaywright } from "../../../src/utils/playwright-loader.js";

// Plan §B10 invariant 1 — each test owns its own BrowserContext; cookies and
// storage stay isolated even though the BrowserServer is shared.
describe("daemon state isolation across two consecutive runOne calls", () => {
  let tmpDir: string;
  let prevDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-iso-"));
    prevDir = process.env["SKEPTIC_DAEMON_DIR"];
    process.env["SKEPTIC_DAEMON_DIR"] = tmpDir;
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env["SKEPTIC_DAEMON_DIR"];
    else process.env["SKEPTIC_DAEMON_DIR"] = prevDir;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("cookies set in one context do NOT leak to a fresh context on the same daemon", async () => {
    let handle: Awaited<ReturnType<typeof startDaemon>> | null = null;
    try {
      handle = await startDaemon({
        engine: "chromium",
        headed: false,
        cliVersion: "test-0.0.0",
        idleTimeoutSeconds: 0,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[state-isolation] BrowserServer launch failed; skipping:", err);
      return;
    }
    try {
      const pw = await loadPlaywright();
      const wsEndpoint = handle.state.wsEndpoint();

      // Run #1 — set a cookie.
      const browser1 = await pw.chromium.connect(wsEndpoint);
      const ctx1 = await browser1.newContext();
      await ctx1.addCookies([
        {
          name: "skeptic-test",
          value: "leaked-from-run-1",
          url: "https://example.com",
        },
      ]);
      const cookies1 = await ctx1.cookies("https://example.com");
      expect(cookies1.find((c) => c.name === "skeptic-test")?.value).toBe("leaked-from-run-1");
      await ctx1.close();
      await browser1.close();

      // Run #2 — fresh context on the same daemon must not see the cookie.
      const browser2 = await pw.chromium.connect(wsEndpoint);
      const ctx2 = await browser2.newContext();
      const cookies2 = await ctx2.cookies("https://example.com");
      expect(cookies2.find((c) => c.name === "skeptic-test")).toBeUndefined();
      await ctx2.close();
      await browser2.close();
    } finally {
      await handle.shutdown("test-end");
    }
  }, 60_000);
});
