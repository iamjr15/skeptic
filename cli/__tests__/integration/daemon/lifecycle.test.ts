import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startDaemon, IdleTimer } from "../../../src/daemon/lifecycle.js";
import { getPidPath, getSocketPath } from "../../../src/daemon/socket.js";
import { sendRpc } from "../../../src/daemon/client.js";

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

  it("idle timer defers shutdown while clients are active, then reclaims when they drop", async () => {
    // Regression: a `skeptic run` connects once over WS then drives the
    // BrowserServer with no further control-socket RPC, so the idle timer must
    // not shut the daemon down while a client still holds a session. This
    // mirrors the onFire gate wired in startDaemon (clients > 0 -> re-arm).
    vi.useFakeTimers();
    let clients = 1;
    let shutdowns = 0;
    let timer: IdleTimer;
    timer = new IdleTimer(0.1, () => {
      if (clients > 0) {
        timer.arm();
        return;
      }
      shutdowns += 1;
    });
    try {
      timer.arm();
      // Several full intervals elapse while a client is active — no shutdown.
      await vi.advanceTimersByTimeAsync(350);
      expect(shutdowns).toBe(0);
      // The client disconnects; the next interval reclaims the BrowserServer.
      clients = 0;
      await vi.advanceTimersByTimeAsync(150);
      expect(shutdowns).toBe(1);
    } finally {
      timer.disarm();
      vi.useRealTimers();
    }
  });

  it("tracks active clients and keeps the daemon alive past the idle timeout", async () => {
    let handle: Awaited<ReturnType<typeof startDaemon>> | null = null;
    try {
      handle = await startDaemon({
        engine: "chromium",
        headed: false,
        cliVersion: "test-0.0.0",
        idleTimeoutSeconds: 0.3,
      });
    } catch (err) {
      // Browser binary may be missing in the test sandbox — soft-skip.
      // eslint-disable-next-line no-console
      console.warn("[lifecycle] BrowserServer launch failed; skipping:", err);
      return;
    }
    try {
      // A client connecting bumps the active-client count (browser.getEndpoint).
      const ep = await sendRpc(getSocketPath(), { method: "browser.getEndpoint" }, 2000);
      expect(ep.error).toBeUndefined();
      const status1 = await sendRpc(getSocketPath(), { method: "daemon.status" }, 2000);
      expect((status1.result as { clients: number }).clients).toBe(1);

      // Sleep well past the 0.3s idle timeout — the daemon must still be alive
      // because a client is active.
      await new Promise((r) => setTimeout(r, 700));
      expect(fs.existsSync(getSocketPath())).toBe(true);
      const status2 = await sendRpc(getSocketPath(), { method: "daemon.status" }, 2000);
      expect(status2.error).toBeUndefined();
      expect((status2.result as { clients: number }).clients).toBe(1);

      // Releasing the session drops the count so the idle timer can reclaim it.
      const rel = await sendRpc(getSocketPath(), { method: "browser.release" }, 2000);
      expect(rel.result).toEqual({ ok: true });
      const status3 = await sendRpc(getSocketPath(), { method: "daemon.status" }, 2000);
      expect((status3.result as { clients: number }).clients).toBe(0);
    } finally {
      await handle.shutdown("test").catch(() => {});
    }
  }, 30_000);

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
    const status = await sendRpc(getSocketPath(), { method: "daemon.status" }, 1500);
    expect(status.error).toBeUndefined();
    await handle.shutdown("test");
    expect(fs.existsSync(getPidPath())).toBe(false);
    expect(fs.existsSync(getSocketPath())).toBe(false);
  }, 30_000);

  it("startDaemon refuses to start while a live PID lockfile exists", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      expect(child.pid).toBeTypeOf("number");
      fs.writeFileSync(getPidPath(), String(child.pid));
      await expect(
        startDaemon({
          engine: "chromium",
          headed: false,
          cliVersion: "test-0.0.0",
          idleTimeoutSeconds: 0,
        }),
      ).rejects.toThrow(/already running/);
    } finally {
      child.kill();
    }
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
