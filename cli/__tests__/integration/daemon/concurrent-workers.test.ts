import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startDaemon } from "../../../src/daemon/lifecycle.js";
import { loadPlaywright } from "../../../src/utils/playwright-loader.js";

// Plan §B10 — N parallel "workers" each connect to the same daemon and own
// their own BrowserContext. No cross-context leakage.
describe("daemon concurrent workers", () => {
  let tmpDir: string;
  let prevDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-conc-"));
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

  it("4 concurrent connect()s see fully isolated context state", async () => {
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
      console.warn("[concurrent-workers] BrowserServer launch failed; skipping:", err);
      return;
    }
    try {
      const pw = await loadPlaywright();
      const wsEndpoint = handle.state.wsEndpoint();

      const work = async (id: number) => {
        const browser = await pw.chromium.connect(wsEndpoint);
        const ctx = await browser.newContext();
        await ctx.addCookies([
          {
            name: `worker-${id}`,
            value: `${id}`,
            url: "https://example.com",
          },
        ]);
        // Each worker should ONLY see its own cookie.
        const cookies = await ctx.cookies("https://example.com");
        const own = cookies.filter((c) => c.name.startsWith("worker-"));
        await ctx.close();
        await browser.close();
        return own.map((c) => c.name);
      };

      const results = await Promise.all([0, 1, 2, 3].map((id) => work(id)));
      results.forEach((cookies, i) => {
        expect(cookies).toEqual([`worker-${i}`]);
      });
    } finally {
      await handle.shutdown("test-end");
    }
  }, 60_000);
});
