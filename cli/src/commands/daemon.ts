// Source: agent-browser/cli/src/native/daemon.rs:19-150 © Vercel Inc., Apache 2.0
// (foreground-blocking daemon entry; the auto-spawn path in client.ts launches
//  this with `spawn(node, [skeptic, daemon, start, ...], { detached: true }).unref()`.
//  The status/stop/logs subcommands are skeptic-original wrappers around the
//  sidecar files written by lifecycle.ts.)

import * as fs from "node:fs";
import * as net from "node:net";
import { logger } from "../utils/logger.js";
import {
  getEnginePath,
  getLogPath,
  getPidPath,
  getSocketPath,
  getVersionPath,
} from "../daemon/socket.js";
import { isPidAlive, startDaemon, type Engine } from "../daemon/lifecycle.js";
import { sendRpc } from "../daemon/client.js";
import type { DaemonStatusResult } from "../daemon/rpc.js";

interface DaemonStartOptions {
  engine?: string;
  headed?: boolean;
  daemonIdleTimeout?: number;
}

const VALID_ENGINES: ReadonlySet<Engine> = new Set(["chromium", "firefox", "webkit"]);

/**
 * `skeptic daemon start` — bind socket, launch BrowserServer, install signal
 * handlers, block until `daemon.shutdown` / SIGTERM / idle timeout. The
 * auto-spawn path in `client.ts` calls this via a detached subprocess.
 */
export const runDaemonStart = async (opts: DaemonStartOptions): Promise<void> => {
  const engine = (opts.engine ?? "chromium") as Engine;
  if (!VALID_ENGINES.has(engine)) {
    logger.error(`daemon start: unknown engine "${engine}" (expected chromium|firefox|webkit)`);
    process.exitCode = 2;
    return;
  }
  try {
    const handle = await startDaemon({
      engine,
      headed: opts.headed === true,
      cliVersion: __SKEPTIC_CLI_VERSION__,
      ...(typeof opts.daemonIdleTimeout === "number"
        ? { idleTimeoutSeconds: opts.daemonIdleTimeout }
        : {}),
    });
    logger.info(
      `[skeptic daemon] listening at ${handle.socket.socketPath} ` +
        `(engine=${handle.state.engine} headed=${handle.state.headed} ` +
        `pw=${handle.state.playwrightVersion} cli=${handle.state.cliVersion})`,
    );
    // Block forever; signal handlers + RPC handle shutdown.
    await new Promise<void>(() => {});
  } catch (err) {
    logger.error(
      `daemon start failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
};

/** `skeptic daemon stop` — RPC shutdown if running, else best-effort kill. */
export const runDaemonStop = async (): Promise<void> => {
  const socketPath = getSocketPath();
  if (!fs.existsSync(socketPath)) {
    // Try the PID lockfile as a secondary signal.
    const pid = readPid();
    if (pid && isPidAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        logger.info(`[skeptic daemon] sent SIGTERM to PID ${pid}`);
      } catch (err) {
        logger.warn(
          `daemon stop: kill failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    logger.info("[skeptic daemon] not running");
    return;
  }
  try {
    await sendRpc(socketPath, { method: "daemon.shutdown" }, 1500);
    logger.info("[skeptic daemon] shutdown requested");
  } catch (err) {
    logger.warn(
      `daemon stop: rpc failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

/** `skeptic daemon status` — print uptime/clients/engine, exit 0. */
export const runDaemonStatus = async (): Promise<void> => {
  const socketPath = getSocketPath();
  if (!fs.existsSync(socketPath)) {
    logger.info("[skeptic daemon] not running");
    return;
  }
  // Use a raw RPC (no ping required for `daemon.status` per rpc.ts).
  try {
    const resp = await sendRpc(socketPath, { method: "daemon.status" }, 1500);
    if (resp.error) {
      logger.warn(`daemon status: ${resp.error}`);
      return;
    }
    const r = resp.result as DaemonStatusResult;
    const uptimeS = Math.round(r.uptimeMs / 1000);
    logger.raw(
      `[skeptic daemon] running — engine=${r.engine} headed=${r.headed} ` +
        `clients=${r.clients} uptime=${uptimeS}s ` +
        `cli=${r.cliVersion} pw=${r.playwrightVersion}`,
    );
  } catch (err) {
    logger.warn(
      `daemon status: rpc failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

/** `skeptic daemon logs` — tail the daemon log file (best-effort). */
export const runDaemonLogs = async (opts: { lines?: number }): Promise<void> => {
  const path = getLogPath();
  if (!fs.existsSync(path)) {
    logger.info(`[skeptic daemon] no log at ${path}`);
    return;
  }
  const n = opts.lines ?? 200;
  try {
    const content = fs.readFileSync(path, "utf8");
    const lines = content.split("\n");
    const tail = lines.slice(-n).join("\n");
    process.stdout.write(tail);
    if (!tail.endsWith("\n")) process.stdout.write("\n");
  } catch (err) {
    logger.warn(
      `daemon logs: read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

const readPid = (): number | null => {
  try {
    const raw = fs.readFileSync(getPidPath(), "utf8").trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

// Mark unused imports as referenced for tsc strictness.
void getVersionPath;
void getEnginePath;
void net;
