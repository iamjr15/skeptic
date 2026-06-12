// The interactive-session daemon — the dedicated headed slot. Separate process
// and socket (`session.sock`) from the headless test daemon, so the two never
// clobber each other. Holds a Browser + SessionRegistry in-process and drives
// the pages itself (no wsEndpoint hand-out); the CLI verbs marshal session.*
// RPC over the socket.

import * as fs from "node:fs";
import {
  ensureDaemonDir,
  getSessionEnginePath,
  getSessionPidPath,
  getSessionSocketPath,
  getSessionVersionPath,
  unlinkStaleSocket,
  startSocketServer,
  validateAuthToken,
  type DaemonRpcHandler,
  type DaemonRpcResponse,
  type SocketServerHandle,
} from "./socket.js";
import { IdleTimer, isPidAlive, type Engine } from "./lifecycle.js";
import { SessionRegistry } from "./session-registry.js";
import { dispatchSession } from "./session-rpc.js";
import type { Driver, DriverSession } from "../driver/types.js";
import { ConsoleCollector } from "../observability/collectors/console-collector.js";
import { NetworkCollector } from "../observability/collectors/network-collector.js";

/** Session-daemon identity: a web browser engine, or a mobile platform. */
export type SessionEngine = Engine | "android";
const isWebEngine = (e: SessionEngine): e is Engine =>
  e === "chromium" || e === "firefox" || e === "webkit";

// The session daemon socket accepts larger frames than the 8 KB control plane —
// `fill`/`type` payloads can be multi-KB. Binary artifacts are never inlined
// (screenshots return disk paths), so 1 MB is ample headroom.
const SESSION_MAX_LINE_BYTES = 1024 * 1024;

export interface SessionDaemonOptions {
  engine: SessionEngine;
  headed: boolean;
  cliVersion: string;
  /** Daemon idle timeout (seconds) once no sessions remain. 0 disables. Default 600. */
  idleTimeoutSeconds?: number;
  /** Per-session idle reap (seconds). Default 180. */
  sessionIdleSeconds?: number;
}

export interface SessionDaemonHandle {
  registry: SessionRegistry;
  socket: SocketServerHandle;
  shutdown(reason: string): Promise<void>;
}

const acquireSessionPidLock = (): void => {
  const pidPath = getSessionPidPath();
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(pidPath, "utf8").trim();
  } catch {
    /* none */
  }
  if (existing) {
    const pid = Number(existing);
    if (Number.isFinite(pid) && pid > 0 && isPidAlive(pid) && pid !== process.pid) {
      throw new Error(`session daemon already running at PID ${pid}`);
    }
    cleanupSessionSidecars();
  }
  fs.writeFileSync(pidPath, String(process.pid), { mode: 0o600 });
};

const cleanupSessionSidecars = (): void => {
  for (const p of [getSessionPidPath(), getSessionVersionPath(), getSessionEnginePath()]) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* best-effort */
    }
  }
};

/** Attach the always-on console + network collectors to a freshly created
 *  session so console errors and requests are captured from the first load. */
const attachSessionCollectors = async (session: DriverSession): Promise<void> => {
  await session.attachCollectors([
    new ConsoleCollector({ captureLimit: 500, redact: true }),
    new NetworkCollector({ captureLimit: 500, duplicateWindowMs: 50 }),
  ]);
};

export const startSessionDaemon = async (
  opts: SessionDaemonOptions,
): Promise<SessionDaemonHandle> => {
  ensureDaemonDir();
  acquireSessionPidLock();
  fs.writeFileSync(getSessionVersionPath(), opts.cliVersion, { mode: 0o600 });
  fs.writeFileSync(getSessionEnginePath(), `${opts.engine}\n${opts.headed ? "headed" : "headless"}`, {
    mode: 0o600,
  });

  let shutdownInFlight: Promise<void> | null = null;

  const web = isWebEngine(opts.engine);
  // Android sessions use an adb driver (lazily picks the attached device) and
  // surface evidence via on-demand logcat — no web collectors to attach.
  const createDriver: (() => Promise<Driver>) | undefined = web
    ? undefined
    : async (): Promise<Driver> => {
        const { AdbDriver } = await import("../driver/mobile/adb-driver.js");
        return AdbDriver.create();
      };

  const registry = new SessionRegistry({
    engine: isWebEngine(opts.engine) ? opts.engine : "chromium", // placeholder; createDriver overrides for mobile
    headed: opts.headed,
    sessionIdleSeconds: opts.sessionIdleSeconds ?? 180,
    ...(createDriver ? { createDriver } : { onSessionCreate: attachSessionCollectors }),
    onChange: () => idle.reset(),
  });

  const socketPath = getSessionSocketPath();
  unlinkStaleSocket(socketPath);

  // Idle only when no sessions are held — an open interactive session keeps the
  // daemon alive exactly like a running test does for the test daemon.
  const idle = new IdleTimer(opts.idleTimeoutSeconds ?? 600, () => {
    if (registry.size > 0) {
      idle.arm();
      return;
    }
    void shutdown("idle-timeout");
  });

  const shutdown = (reason: string): Promise<void> => {
    if (shutdownInFlight) return shutdownInFlight;
    shutdownInFlight = (async () => {
      idle.disarm();
      try {
        await registry.closeAll();
      } catch {
        /* best-effort */
      }
      try {
        await socket.close();
      } catch {
        /* best-effort */
      }
      cleanupSessionSidecars();
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* best-effort */
      }
      void reason;
    })();
    return shutdownInFlight;
  };

  const rpcHandler: DaemonRpcHandler = (req, ctx) => {
    ctx.onActivity();
    idle.reset();
    if (req.method === "daemon.ping") {
      return Promise.resolve(handlePing(req.params, opts));
    }
    if (req.method === "daemon.shutdown") {
      ctx.close();
      void shutdown("rpc-shutdown");
      return Promise.resolve({ result: { ok: true } });
    }
    if (req.method === "daemon.status") {
      return Promise.resolve({
        result: { ok: true, engine: opts.engine, headed: opts.headed, sessions: registry.size },
      });
    }
    return dispatchSession(req, registry);
  };

  const socket = await startSocketServer(socketPath, rpcHandler, {
    onAccept: () => idle.reset(),
    maxLineBytes: SESSION_MAX_LINE_BYTES,
  });
  idle.arm();

  const onSignal = (sig: NodeJS.Signals): void => {
    void shutdown(`signal:${sig}`).then(() => process.exit(0));
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  process.on("SIGHUP", onSignal);

  return { registry, socket, shutdown };
};

const handlePing = (params: Record<string, unknown> | undefined, opts: SessionDaemonOptions): DaemonRpcResponse => {
  const p = params ?? {};
  if (!validateAuthToken(p["authToken"] as string | undefined)) {
    return { result: { ok: false, reason: "auth-failed" } };
  }
  if (typeof p["engine"] === "string" && p["engine"] !== opts.engine) {
    return { result: { ok: false, reason: "engine-mismatch" } };
  }
  if (typeof p["headed"] === "boolean" && p["headed"] !== opts.headed) {
    return { result: { ok: false, reason: "headed-mismatch" } };
  }
  if (typeof p["cliVersion"] === "string" && p["cliVersion"] !== opts.cliVersion) {
    return { result: { ok: false, reason: "version-mismatch" } };
  }
  return { result: { ok: true, sessions: opts.engine } };
};
