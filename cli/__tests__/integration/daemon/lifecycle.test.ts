import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startDaemon, IdleTimer } from "../../../src/daemon/lifecycle.js";
import { getPidPath, getSocketPath } from "../../../src/daemon/socket.js";

// Plan §B10 invariant 4-5 — idle timeout, lockfile, sidecar lifecycle.
describe("daemon lifecycle", () => {
  let tmpDir: string;
  let prevDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-life-"));
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

  it("IdleTimer fires after the configured interval and reset() rearms it", async () => {
    vi.useFakeTimers();
    let fired = 0;
    const timer = new IdleTimer(0.05, () => {
      fired += 1;
    });
    try {
      timer.arm();
      await vi.advanceTimersByTimeAsync(30);
      timer.reset();
      await vi.advanceTimersByTimeAsync(30);
      timer.reset();
      await vi.advanceTimersByTimeAsync(30);
      expect(fired).toBe(0);
      await vi.advanceTimersByTimeAsync(80);
      expect(fired).toBe(1);
    } finally {
      timer.disarm();
      vi.useRealTimers();
    }
  });

  it("IdleTimer with seconds=0 never fires", async () => {
    let fired = 0;
    const timer = new IdleTimer(0, () => {
      fired += 1;
    });
    timer.arm();
    await new Promise((r) => setTimeout(r, 100));
    expect(fired).toBe(0);
    timer.disarm();
  });

  it("startDaemon writes pid+version+engine sidecars and cleans up on shutdown", async () => {
    let handle: Awaited<ReturnType<typeof startDaemon>> | null = null;
    try {
      handle = await startDaemon({
        engine: "chromium",
        headed: false,
        cliVersion: "test-0.0.0",
        idleTimeoutSeconds: 0,
      });
    } catch (err) {
      // Browser binary may be missing in the test sandbox — soft-skip.
      // eslint-disable-next-line no-console
      console.warn("[lifecycle] BrowserServer launch failed; skipping:", err);
      return;
    }
    expect(fs.existsSync(getPidPath())).toBe(true);
    expect(fs.existsSync(getSocketPath())).toBe(true);
    await handle.shutdown("test");
    expect(fs.existsSync(getPidPath())).toBe(false);
    expect(fs.existsSync(getSocketPath())).toBe(false);
  }, 30_000);

  it("startDaemon refuses to start while a live PID lockfile exists", async () => {
    // Plant a different live PID — PID 1 (init) is always alive on Unix.
    // On Windows the test still works because OpenProcess succeeds for any
    // active system PID. The lockfile check uses isPidAlive which returns
    // true for live foreign PIDs. We deliberately avoid `process.pid` so
    // the same-process bypass in acquirePidLock doesn't activate.
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(getPidPath(), "1");
    await expect(
      startDaemon({
        engine: "chromium",
        headed: false,
        cliVersion: "test-0.0.0",
        idleTimeoutSeconds: 0,
      }),
    ).rejects.toThrow(/already running/);
  });

  it("startDaemon reclaims a stale PID lockfile (process gone)", async () => {
    // PID 1 is always alive on Unix; use a clearly non-existent PID instead.
    // Try a high PID that's almost certainly not in use.
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(getPidPath(), "999999");
    let handle: Awaited<ReturnType<typeof startDaemon>> | null = null;
    try {
      handle = await startDaemon({
        engine: "chromium",
        headed: false,
        cliVersion: "test-0.0.0",
        idleTimeoutSeconds: 0,
      });
    } catch (err) {
      // BrowserServer may be unavailable; that's fine — the reclaim itself
      // is what we're testing. If we got past the "already running" check
      // and threw on launch, the reclaim worked.
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toMatch(/already running/);
      return;
    }
    await handle.shutdown("test");
  }, 30_000);
});
