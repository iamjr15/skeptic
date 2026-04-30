// Source: agent-browser/cli/src/native/daemon.rs:115-255 © Vercel Inc., Apache 2.0
// (lifecycle skeleton — pid/version/engine sidecar files written on start and
//  unlinked on exit; idle-timer-with-reset that re-arms on every accepted
//  command; SIGINT/SIGTERM/SIGHUP handlers close the BrowserServer before
//  process exit so destructors fire and Chrome processes don't get orphaned —
//  agent-browser issue #1113. The handshake fields and engine-parameterized
//  launchServer call are skeptic-original.)

import * as fs from "node:fs";
import { createRequire } from "node:module";
import type { BrowserServer } from "playwright";
import { loadPlaywright } from "../utils/playwright-loader.js";
import {
  ensureDaemonDir,
  getEnginePath,
  getPidPath,
  getSocketPath,
  getVersionPath,
  unlinkStaleSocket,
  startSocketServer,
  type DaemonRpcHandler,
  type SocketServerHandle,
} from "./socket.js";
import { dispatch, type DaemonRuntimeState } from "./rpc.js";

export type Engine = "chromium" | "firefox" | "webkit";

export interface DaemonStartOptions {
  engine: Engine;
  headed: boolean;
  cliVersion: string;
  /** Idle timeout in seconds. 0 disables. Default 300. */
  idleTimeoutSeconds?: number;
}

export interface DaemonHandle {
  state: DaemonRuntimeState;
  socket: SocketServerHandle;
  shutdown(reason: string): Promise<void>;
}

/** Returns whether `pid` is alive. Mirrors agent-browser/connection.rs:157-175 —
 *  EPERM (live but signal denied) counts as alive; only ESRCH counts as dead. */
export const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
};

/**
 * Atomic-create-or-fail PID lockfile. If the file already exists with a live
 * PID, throws — the caller should refuse to start a duplicate daemon. If the
 * existing PID is stale (process gone), we remove all sidecars and reclaim.
 */
export const acquirePidLock = (): void => {
  const pidPath = getPidPath();
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(pidPath, "utf8").trim();
  } catch {
    /* no existing lock */
  }
  if (existing) {
    const pid = Number(existing);
    if (Number.isFinite(pid) && pid > 0 && isPidAlive(pid) && pid !== process.pid) {
      throw new Error(
        `daemon already running at PID ${pid} (lockfile ${pidPath}). Use 'skeptic daemon stop' first.`,
      );
    }
    // Stale — clean.
    cleanupSidecarFiles();
  }
  fs.writeFileSync(pidPath, String(process.pid), { mode: 0o600 });
};

export const cleanupSidecarFiles = (): void => {
  for (const p of [getPidPath(), getVersionPath(), getEnginePath()]) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* best-effort */
    }
  }
};

/**
 * Idle-timer-with-reset (agent-browser pattern at daemon.rs:221-237). A single
 * pending timer is held; every accepted command calls `reset()` which clears
 * and rearms. When the timer fires with no resets, the daemon shuts down.
 */
export class IdleTimer {
  private timer: NodeJS.Timeout | null = null;
  private readonly ms: number;
  private readonly onFire: () => void;

  constructor(seconds: number, onFire: () => void) {
    this.ms = Math.max(0, Math.floor(seconds * 1000));
    this.onFire = onFire;
  }

  arm(): void {
    if (this.ms === 0) return;
    this.disarm();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onFire();
    }, this.ms);
    this.timer.unref?.();
  }

  reset(): void {
    if (this.ms === 0) return;
    this.arm();
  }

  disarm(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

const localRequire = createRequire(import.meta.url);
const PLAYWRIGHT_VERSION = (() => {
  try {
    return (localRequire("playwright/package.json") as { version: string }).version;
  } catch {
    try {
      return (localRequire("playwright-core/package.json") as { version: string }).version;
    } catch {
      return "unknown";
    }
  }
})();

/**
 * Start the daemon: launch BrowserServer, write sidecars, bind socket,
 * arm idle timer, install signal handlers. Resolves once the socket is listening.
 *
 * The returned handle's `shutdown()` is idempotent — safe to call from a SIGTERM
 * handler and from the `daemon.shutdown` RPC.
 */
export const startDaemon = async (opts: DaemonStartOptions): Promise<DaemonHandle> => {
  ensureDaemonDir();
  acquirePidLock();
  fs.writeFileSync(getVersionPath(), `${opts.cliVersion}\n${PLAYWRIGHT_VERSION}`, { mode: 0o600 });
  fs.writeFileSync(getEnginePath(), `${opts.engine}\n${opts.headed ? "headed" : "headless"}`, {
    mode: 0o600,
  });

  const pw = await loadPlaywright();
  const launcher = pw[opts.engine];
  let browserServer: BrowserServer;
  try {
    browserServer = await launcher.launchServer({ headless: !opts.headed });
  } catch (err) {
    cleanupSidecarFiles();
    throw new Error(
      `daemon: BrowserServer launch failed for engine=${opts.engine} headed=${opts.headed}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const startedAt = Date.now();
  let clients = 0;

  const state: DaemonRuntimeState = {
    engine: opts.engine,
    headed: opts.headed,
    cliVersion: opts.cliVersion,
    playwrightVersion: PLAYWRIGHT_VERSION,
    startedAt,
    get clients() {
      return clients;
    },
    incClients: () => {
      clients += 1;
    },
    decClients: () => {
      clients = Math.max(0, clients - 1);
    },
    wsEndpoint: () => browserServer.wsEndpoint(),
  };

  const socketPath = getSocketPath();
  unlinkStaleSocket(socketPath);

  let shutdownInFlight: Promise<void> | null = null;
  const shutdown = async (reason: string): Promise<void> => {
    if (shutdownInFlight) return shutdownInFlight;
    shutdownInFlight = (async () => {
      idle.disarm();
      try {
        await socket.close();
      } catch {
        /* best-effort */
      }
      try {
        await browserServer.close();
      } catch {
        /* best-effort */
      }
      cleanupSidecarFiles();
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* best-effort */
      }
      // Allow the test harness to inspect `reason` if a logger is wired up.
      void reason;
    })();
    return shutdownInFlight;
  };

  const idle = new IdleTimer(opts.idleTimeoutSeconds ?? 300, () => {
    void shutdown("idle-timeout");
  });

  const rpcHandler: DaemonRpcHandler = (req, ctx) => {
    ctx.onActivity();
    idle.reset();
    return dispatch(req, state, () => {
      ctx.close();
      void shutdown("rpc-shutdown");
    });
  };

  const socket = await startSocketServer(socketPath, rpcHandler, {
    onAccept: () => idle.reset(),
  });
  idle.arm();

  // SIGTERM + Notify graceful close (agent-browser daemon.rs:439-482). We must
  // close the BrowserServer before exiting; process.exit() short-circuits
  // destructors and can orphan Chrome processes (agent-browser issue #1113).
  const onSignal = (sig: NodeJS.Signals): void => {
    void shutdown(`signal:${sig}`).then(() => {
      process.exit(0);
    });
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  process.on("SIGHUP", onSignal);

  return { state, socket, shutdown };
};
