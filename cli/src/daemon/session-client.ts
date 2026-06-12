import * as fs from "node:fs";
import * as net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  ensureDaemonDir,
  getSessionSocketPath,
  probeDaemon,
  resolveIpcPath,
  type DaemonRpcResponse,
} from "./socket.js";
import { sendRpc } from "./client.js";
import type { SessionEngine } from "./session-daemon.js";

export interface SessionDaemonOptions {
  engine: SessionEngine;
  headed: boolean;
  cliVersion: string;
  autoSpawn?: boolean;
  spawnTimeoutMs?: number;
}

const isSocketConnectable = (socketPath: string): Promise<boolean> =>
  new Promise((resolve) => {
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

const resolveSkepticEntry = (): string => {
  const override = process.env["SKEPTIC_DAEMON_BIN"];
  if (override) return override;
  const argv1 = process.argv[1];
  if (argv1) return argv1;
  return fileURLToPath(new URL("../../dist/skeptic.mjs", import.meta.url));
};

/**
 * Ensure the interactive-session daemon (the headed slot) is running, spawning a
 * detached `skeptic session-daemon` if needed. Unlike the test daemon, this one
 * holds the page/refs in-process — the CLI verbs marshal `session.*` RPC to it.
 */
export const ensureSessionDaemon = async (opts: SessionDaemonOptions): Promise<{ ok: boolean; reason?: string }> => {
  ensureDaemonDir();
  const socketPath = getSessionSocketPath();
  if (await isSocketConnectable(socketPath)) return { ok: true };
  if (opts.autoSpawn === false) return { ok: false, reason: "no-session-daemon" };

  const args = ["session-daemon", "--engine", opts.engine, opts.headed ? "--headed" : "--headless"];
  const child = spawn(process.execPath, [resolveSkepticEntry(), ...args], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();
  child.on("error", () => {
    /* surfaced via poll timeout */
  });

  const deadline = Date.now() + (opts.spawnTimeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    if (await isSocketConnectable(socketPath)) return { ok: true };
    await delay(100);
  }
  return { ok: false, reason: "session-daemon-spawn-timeout" };
};

/** Send one `session.*` RPC to the session daemon. Generous default timeout —
 *  snapshots/screenshots/waits can take seconds. */
export const sendSessionRpc = async (
  method: string,
  params: Record<string, unknown>,
  opts: SessionDaemonOptions,
  timeoutMs = 30_000,
): Promise<DaemonRpcResponse> => {
  const ensured = await ensureSessionDaemon(opts);
  if (!ensured.ok) throw new Error(`session daemon: ${ensured.reason}`);
  const socketPath = getSessionSocketPath();
  const authToken = process.env["SKEPTIC_DAEMON_AUTH_TOKEN"];
  // The session daemon's headed-ness is fixed when it spawns (first `open`).
  // Subsequent verbs just drive whatever session is running, so the handshake
  // checks only engine (+ auth) — NOT headed/version — otherwise a `snapshot`
  // without a repeated `--headless` would spuriously mismatch the running daemon.
  const handshake = {
    engine: opts.engine,
    ...(authToken ? { authToken } : {}),
  };
  const probe = await probeDaemon(socketPath, handshake);
  if (!probe.ok) throw new Error(`session daemon handshake failed: ${probe.reason ?? "unknown"}`);
  return sendRpc(
    socketPath,
    { method, params: authToken ? { ...params, authToken } : params },
    timeoutMs,
  );
};
