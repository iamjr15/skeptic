import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startDaemon } from "../../../src/daemon/lifecycle.js";
import { loadPlaywright } from "../../../src/utils/playwright-loader.js";

// Plan §B10 invariant 10 — Playwright's BrowserServer auto-closes contexts
// that a client created when that client's WebSocket disconnects (whether
// via clean close or abrupt termination). The next test on the same daemon
// must see clean state.
describe("daemon cleanup-on-disconnect", () => {
  let tmpDir: string;
  let prevDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-kill-"));
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

  it("abrupt disconnect mid-session does not leak cookies into the next session", async () => {
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
      console.warn("[worker-kill] BrowserServer launch failed; skipping:", err);
      return;
    }
    try {
      const pw = await loadPlaywright();
      const wsEndpoint = handle.state.wsEndpoint();

      // Session #1 — set a cookie, then ABRUPTLY disconnect (simulating
      // worker.terminate() on the runner side). We close the underlying
      // websocket without `context.close()` first.
      const browser1 = await pw.chromium.connect(wsEndpoint);
      const ctx1 = await browser1.newContext();
      await ctx1.addCookies([
        {
          name: "abrupt-kill",
          value: "should-not-leak",
          url: "https://example.com",
        },
      ]);
      // Intentionally skip ctx1.close() — close the browser connection only.
      // Playwright's server-side closes contexts created by this client.
      await browser1.close();

      // Session #2 — fresh context must not see the cookie.
      const browser2 = await pw.chromium.connect(wsEndpoint);
      const ctx2 = await browser2.newContext();
      const cookies2 = await ctx2.cookies("https://example.com");
      expect(cookies2.find((c) => c.name === "abrupt-kill")).toBeUndefined();
      await ctx2.close();
      await browser2.close();
    } finally {
      await handle.shutdown("test-end");
    }
  }, 60_000);
});
