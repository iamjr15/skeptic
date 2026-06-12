// Source: agent-browser/cli/src/connection.rs:574-602 © Vercel Inc., Apache 2.0
// (auto-spawn-with-detached-unref, version-mismatch restart loop with retry cap,
//  socket-readiness probe with bounded polling. The Playwright `pw[engine].connect`
//  + BrowserContext-per-test isolation model is skeptic-original — agent-browser
//  marshals every browser op over the socket; skeptic hands out the raw
//  BrowserServer wsEndpoint and lets Playwright's native client do the work.)

import * as fs from "node:fs";
import * as net from "node:net";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { Browser } from "playwright";
import { loadPlaywright } from "../utils/playwright-loader.js";
import { logger } from "../utils/logger.js";
import {
  getSocketPath,
  ensureDaemonDir,
  probeDaemon,
  resolveIpcPath,
  type DaemonRpcResponse,
  type DaemonRpcRequest,
} from "./socket.js";
import type {
  BrowserGetEndpointResult,
  DaemonPingParams,
  DaemonStatusResult,
} from "./rpc.js";
import type { Engine } from "./lifecycle.js";

export interface ConnectDaemonOptions {
  engine: Engine;
  headed: boolean;
  cliVersion: string;
  /** Override the auto-spawn behavior (tests use this to assert no-spawn paths). */
  autoSpawn?: boolean;
  /** Override max wait for socket-ready, ms. */
  spawnTimeoutMs?: number;
  /** Override the daemon idle timeout in seconds. Forwarded to the spawned daemon. */
  idleTimeoutSeconds?: number;
}

export interface DaemonConnection {
  browser: Browser;
  disconnect: () => Promise<void>;
}

/**
 * Connect to a running daemon (auto-spawning one if needed) and return a
 * Playwright `Browser` that the caller can hand to its existing `newContext`
 * call site.
 *
 * Disconnect contract: calling `disconnect()` closes the Browser, which severs
 * the WebSocket. Playwright's server-side then auto-closes any contexts this
 * client created (plan §B10 invariant 10). The daemon's BrowserServer stays
 * alive for the next caller.
 */
export const connectDaemon = async (
  opts: ConnectDaemonOptions,
): Promise<DaemonConnection> => {
  ensureDaemonDir();
  const socketPath = getSocketPath();
  const ping: DaemonPingParams = {
    engine: opts.engine,
    headed: opts.headed,
    cliVersion: opts.cliVersion,
    playwrightVersion: getPlaywrightVersion(),
    ...(process.env["SKEPTIC_DAEMON_AUTH_TOKEN"]
      ? { authToken: process.env["SKEPTIC_DAEMON_AUTH_TOKEN"] }
      : {}),
  };

  let attempts = 0;
  // Cap the restart-on-mismatch loop at 1 retry — plan §B10 client.ts spec.
  while (attempts < 2) {
    attempts += 1;
    const daemonReady = await ensureDaemonRunning(socketPath, opts);
    if (!daemonReady.ok) {
      throw new Error(`daemon: ${daemonReady.reason}`);
    }
    const probe = await probeDaemon(socketPath, ping as Record<string, unknown>);
    if (probe.ok) {
      const wsEndpoint = await getEndpoint(socketPath, ping.authToken);
      const pw = await loadPlaywright();
      const browser = await pw[opts.engine].connect(wsEndpoint);
      return {
        browser,
        disconnect: async () => {
          // Closing the Browser severs the WebSocket; Playwright's server-side
          // closes the context(s) this client created. The daemon's BrowserServer
          // keeps running for the next caller.
          await browser.close().catch(() => {});
          // Tell the daemon this session ended so its active-client count drops
          // and the idle timer can reclaim the BrowserServer (lifecycle.ts).
          await sendRelease(socketPath).catch(() => {});
        },
      };
    }

    const reason = probe.reason ?? "unknown";
    if (isMismatchReason(reason)) {
      // The daemon is a single global slot. Restarting it on a mismatch would
      // kill the BrowserServer out from under any other run already connected
      // to it. Only restart when nobody else is using it; otherwise this caller
      // falls back to its own private (non-daemon) browser and leaves the shared
      // daemon untouched.
      const activeClients = await getDaemonClientCount(socketPath);
      if (resolveMismatchAction(reason, activeClients) === "standalone") {
        logger.warn(
          `[daemon] ${reason} but ${activeClients} active client(s) — launching a private (non-daemon) browser for this run instead of restarting the shared daemon`,
        );
        return launchStandalone(opts);
      }
      logger.warn(
        `[daemon] ${reason} — restarting daemon with engine=${opts.engine} headed=${opts.headed}`,
      );
      // Ask the existing daemon to shut down cleanly, then loop to spawn a fresh one.
      await sendShutdown(socketPath).catch(() => {});
      // Wait for the daemon to actually exit before we try to spawn a replacement.
      await waitForSocketGone(socketPath, 3000);
      continue;
    }
    throw new Error(`daemon ping failed: ${reason}`);
  }
  throw new Error("daemon: handshake failed after 2 attempts");
};

const getEndpoint = async (
  socketPath: string,
  authToken: string | undefined,
): Promise<string> => {
  const req: DaemonRpcRequest = {
    method: "browser.getEndpoint",
    params: authToken ? { authToken } : {},
  };
  const resp = await sendRpc(socketPath, req, 3000);
  if (resp.error) throw new Error(`browser.getEndpoint failed: ${resp.error}`);
  const result = resp.result as BrowserGetEndpointResult | undefined;
  if (!result || typeof result.wsEndpoint !== "string") {
    throw new Error("browser.getEndpoint: malformed response");
  }
  return result.wsEndpoint;
};

const sendShutdown = async (socketPath: string): Promise<void> => {
  await sendRpc(socketPath, { method: "daemon.shutdown" }, 1500).catch(() => {});
};

/** Signal the daemon that this client's browser session has ended so the
 *  daemon's active-client count drops (handled in lifecycle.ts's rpcHandler). */
const sendRelease = async (socketPath: string): Promise<void> => {
  await sendRpc(socketPath, { method: "browser.release" }, 1500).catch(() => {});
};

/** Handshake reasons that mean the running daemon can't serve this caller and
 *  would otherwise trigger a restart. */
export const isMismatchReason = (reason: string): boolean =>
  reason === "engine-mismatch" ||
  reason === "headed-mismatch" ||
  reason === "version-mismatch";

/**
 * Decide what a mismatched caller should do. When other clients are actively
 * connected, restarting the shared daemon would kill their BrowserServer
 * mid-run, so the mismatched caller launches its own private browser instead.
 * Only when nobody else is using the daemon is it safe to restart it.
 */
export const resolveMismatchAction = (
  reason: string,
  activeClients: number,
): "standalone" | "restart" => {
  if (!isMismatchReason(reason)) return "restart";
  return activeClients > 0 ? "standalone" : "restart";
};

/** Read the daemon's current active-client count. Returns 0 if the status RPC
 *  fails or is malformed — a conservative default that allows the caller to
 *  restart a daemon that looks unused rather than spuriously refusing. */
export const getDaemonClientCount = async (socketPath: string): Promise<number> => {
  const resp = await sendRpc(socketPath, { method: "daemon.status" }, 1500).catch(
    () => null,
  );
  if (!resp || resp.error) return 0;
  const result = resp.result as DaemonStatusResult | undefined;
  return typeof result?.clients === "number" ? result.clients : 0;
};

/** Launch a private, non-daemon browser for this caller. Used when the shared
 *  daemon can't satisfy this run (engine/headed/version mismatch) but other
 *  clients are still using it, so we must not kill the shared BrowserServer. */
const launchStandalone = async (
  opts: ConnectDaemonOptions,
): Promise<DaemonConnection> => {
  const pw = await loadPlaywright();
  const browser = await pw[opts.engine].launch({ headless: !opts.headed });
  return {
    browser,
    disconnect: async () => {
      await browser.close().catch(() => {});
    },
  };
};

/** Generic line-delimited JSON RPC round-trip. Used for follow-up calls after
 *  the initial probe. */
export const sendRpc = async (
  socketPath: string,
  req: DaemonRpcRequest,
  timeoutMs: number,
): Promise<DaemonRpcResponse> => {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(resolveIpcPath(socketPath));
    let buf = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error(`rpc timeout: ${req.method}`));
    }, timeoutMs);
    conn.on("connect", () => {
      conn.write(`${JSON.stringify(req)}\n`);
    });
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(buf.slice(0, nl)) as DaemonRpcResponse;
          conn.destroy();
          resolve(parsed);
        } catch (err) {
          conn.destroy();
          reject(err as Error);
        }
      }
    });
    conn.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
};

interface EnsureResult {
  ok: boolean;
  reason?: string;
}

/**
 * If the socket is connectable, return ok. Otherwise (and `autoSpawn !== false`)
 * spawn a detached `skeptic daemon start` subprocess and poll until the socket
 * shows up.
 *
 * **Must be called from the main CLI process, not from a worker_thread.**
 * `resolveSkepticEntry()` reads `process.argv[1]`, which inside a worker
 * thread is `dist/worker.mjs`, not `dist/skeptic.mjs`. The spawned subprocess
 * would then hang on a `parentPort.on('message')` that never arrives. Run
 * pre-warm in `commands/run.ts` and `commands/inspect.ts` before spinning
 * workers — see `daemon/auto-spawn.ts#prewarmDaemonIfNeeded`. Once the daemon
 * is alive, this function's call from inside a worker becomes a no-op (the
 * socket-connectable fast path returns immediately).
 */
export const ensureDaemonRunning = async (
  socketPath: string,
  opts: ConnectDaemonOptions,
): Promise<EnsureResult> => {
  if (await isSocketConnectable(socketPath)) return { ok: true };
  if (opts.autoSpawn === false) return { ok: false, reason: "no-daemon" };

  const args = buildDaemonStartArgs(opts);
  const cmd = resolveSkepticEntry();
  const child = spawn(process.execPath, [cmd, ...args], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();
  child.on("error", () => {
    /* surfaced via socket-poll-timeout below */
  });

  // 15 s default: cold BrowserServer launch (Playwright + Chromium subprocess)
  // routinely takes 5-10 s on a fresh `~/.skeptic`. The earlier 5 s default
  // produced spurious `spawn-timeout` warnings on cold-start (audit re-run
  // finding #1). Override with `opts.spawnTimeoutMs` for tests.
  const deadline = Date.now() + (opts.spawnTimeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    if (await isSocketConnectable(socketPath)) return { ok: true };
    await delay(100);
  }
  return { ok: false, reason: "spawn-timeout" };
};

const isSocketConnectable = (socketPath: string): Promise<boolean> => {
  return new Promise((resolve) => {
    if (process.platform !== "win32" && !fs.existsSync(socketPath)) {
      resolve(false);
      return;
    }
    const conn = net.createConnection(resolveIpcPath(socketPath));
    const done = (ok: boolean): void => {
      conn.removeAllListeners();
      conn.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 800);
    conn.on("connect", () => {
      clearTimeout(timer);
      done(true);
    });
    conn.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
};

const waitForSocketGone = async (socketPath: string, ms: number): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await isSocketConnectable(socketPath))) return;
    await delay(50);
  }
};

const buildDaemonStartArgs = (opts: ConnectDaemonOptions): string[] => {
  const args: string[] = ["daemon", "start"];
  args.push("--engine", opts.engine);
  if (opts.headed) args.push("--headed");
  if (typeof opts.idleTimeoutSeconds === "number") {
    args.push("--daemon-idle-timeout", String(opts.idleTimeoutSeconds));
  }
  return args;
};

const resolveSkepticEntry = (): string => {
  // Prefer the actual launched script (process.argv[1]) so a caller running
  // out of `dist/skeptic.mjs` re-uses the same bundle. Tests can set
  // SKEPTIC_DAEMON_BIN to point at a fake.
  const override = process.env["SKEPTIC_DAEMON_BIN"];
  if (override) return override;
  const argv1 = process.argv[1];
  if (argv1) return argv1;
  // Last-resort fallback inside the package layout.
  return fileURLToPath(new URL("../../dist/skeptic.mjs", import.meta.url));
};

// Use createRequire so Node's standard module resolution finds Playwright in
// `cli/node_modules/...`. The earlier URL-relative path
// (`new URL("../../node_modules/playwright/package.json", import.meta.url)`)
// resolved one directory too high in the bundled `dist/skeptic.mjs` and
// returned `"unknown"`, triggering a `version-mismatch` against the daemon
// (which uses createRequire successfully) on every ping. lifecycle.ts:128
// uses the same pattern.
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

const getPlaywrightVersion = (): string => PLAYWRIGHT_VERSION;
