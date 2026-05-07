// Source: agent-browser/cli/src/native/daemon.rs:357-430 © Vercel Inc., Apache 2.0
// (line-delimited JSON framing on a Unix socket — one JSON object per "\n"-terminated
//  line, malformed lines reply with `{"error":"..."}` and continue, "looks_like_http"
//  early-exit, idle-reset signal on each accepted command. Stale-socket cleanup with
//  realpath check + 0700 parent-dir + optional shared-secret auth are skeptic-original
//  hardenings on top of the agent-browser pattern.)

import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import * as os from "node:os";
import * as crypto from "node:crypto";

export interface DaemonRpcRequest {
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface DaemonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: string;
}

export type DaemonRpcHandler = (
  req: DaemonRpcRequest,
  ctx: { onActivity: () => void; close: () => void },
) => Promise<DaemonRpcResponse>;

/** Maximum length of one JSON-RPC line. The daemon control plane is small; an
 *  8 KB cap is generous and defends against runaway clients sending huge frames. */
export const MAX_LINE_BYTES = 8 * 1024;

/** `~/.skeptic/` parent directory (overridable via `SKEPTIC_DAEMON_DIR` for tests). */
export const getDaemonDir = (): string => {
  const env = process.env["SKEPTIC_DAEMON_DIR"];
  if (env && env.length > 0) return env;
  return path.join(os.homedir(), ".skeptic");
};

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

const isWindowsPipePath = (p: string): boolean =>
  p.toLowerCase().startsWith(WINDOWS_PIPE_PREFIX.toLowerCase());

/**
 * Node's IPC transport is a filesystem socket on POSIX and a named pipe on
 * Windows. Keep the public sidecar path stable, but translate it at the
 * networking boundary so all callers can pass the same `getSocketPath()` value.
 */
export const resolveIpcPath = (socketPath: string): string => {
  if (process.platform !== "win32" || isWindowsPipePath(socketPath)) return socketPath;
  const resolved = path.resolve(socketPath);
  const safeBase = path
    .basename(resolved)
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 32) || "daemon";
  const hash = crypto
    .createHash("sha256")
    .update(resolved.toLowerCase())
    .digest("hex")
    .slice(0, 32);
  return `${WINDOWS_PIPE_PREFIX}skeptic-${safeBase}-${hash}`;
};

export const getSocketPath = (): string => path.join(getDaemonDir(), "daemon.sock");
export const getPidPath = (): string => path.join(getDaemonDir(), "daemon.pid");
export const getVersionPath = (): string => path.join(getDaemonDir(), "daemon.version");
export const getEnginePath = (): string => path.join(getDaemonDir(), "daemon.engine");
export const getLogPath = (): string => path.join(getDaemonDir(), "daemon.log");

/**
 * Ensure the daemon dir exists with `0700` permissions. The directory is the
 * primary access boundary — only the user's own UID can `connect()` to a
 * socket inside it (Codex round 2 #2 / plan §B10 invariant 9).
 */
export const ensureDaemonDir = (): string => {
  const dir = getDaemonDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* best-effort */
    }
  }
  return dir;
};

/**
 * Realpath-checked stale-socket unlink. Refuses to unlink anything that isn't
 * inside the daemon dir (defeats symlink-races where an attacker leaves a
 * symlink at `daemon.sock` pointing at a sensitive file). Returns `true` if a
 * stale file was removed (or didn't exist), `false` if it looked occupied by
 * something we shouldn't touch.
 */
export const unlinkStaleSocket = (socketPath: string): boolean => {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(socketPath);
  } catch {
    return true;
  }
  if (stat.isSymbolicLink()) {
    let resolved: string;
    try {
      resolved = fs.realpathSync(socketPath);
    } catch {
      return false;
    }
    const dir = getDaemonDir();
    let dirReal: string;
    try {
      dirReal = fs.realpathSync(dir);
    } catch {
      dirReal = dir;
    }
    if (!resolved.startsWith(dirReal + path.sep) && resolved !== dirReal) {
      return false;
    }
  }
  try {
    fs.unlinkSync(socketPath);
    return true;
  } catch {
    return false;
  }
};

/**
 * Constant-time auth-token comparison. When `SKEPTIC_DAEMON_AUTH_TOKEN` is
 * set on the daemon process, every connecting client must send the same
 * token in its `daemon.ping` params. Validation goes through
 * `crypto.timingSafeEqual` so the comparison cost doesn't depend on how
 * many leading bytes match.
 *
 * When the env is unset on the daemon, the `0700` directory is the only
 * boundary — clients can omit the token.
 */
export const validateAuthToken = (provided: string | undefined): boolean => {
  const expected = process.env["SKEPTIC_DAEMON_AUTH_TOKEN"];
  if (!expected || expected.length === 0) return true;
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

const HTTP_PREFIXES = [
  "GET ",
  "POST ",
  "PUT ",
  "DELETE ",
  "PATCH ",
  "HEAD ",
  "OPTIONS ",
  "CONNECT ",
  "TRACE ",
];
const looksLikeHttp = (line: string): boolean => HTTP_PREFIXES.some((p) => line.startsWith(p));

export interface SocketServerHandle {
  readonly server: net.Server;
  readonly socketPath: string;
  close(): Promise<void>;
}

/**
 * Bind a Unix-socket server at `socketPath` with line-delimited JSON framing.
 * Each socket connection accumulates bytes into a buffer, splitting on `\n`;
 * lines longer than `MAX_LINE_BYTES` cause a parse-error reply on the same
 * connection (we don't kill the connection — agent-browser's pattern at
 * daemon.rs:386-395). The handler can opt to close the daemon via `ctx.close()`
 * for `daemon.shutdown`.
 */
export const startSocketServer = async (
  socketPath: string,
  handler: DaemonRpcHandler,
  opts: { onAccept?: () => void; onClose?: () => void } = {},
): Promise<SocketServerHandle> => {
  const ipcPath = resolveIpcPath(socketPath);
  const server = net.createServer((conn) => {
    let buf = Buffer.alloc(0);
    let dropFrame = false;

    conn.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) {
          if (buf.length > MAX_LINE_BYTES) {
            dropFrame = true;
            buf = Buffer.alloc(0);
          }
          break;
        }
        if (nl > MAX_LINE_BYTES) {
          // Single physical line exceeds the cap — reject and continue with
          // any trailing bytes after the newline.
          buf = buf.subarray(nl + 1);
          dropFrame = false;
          writeJson(conn, { error: "frame-too-large" });
          continue;
        }
        const line = buf.subarray(0, nl).toString("utf8").trim();
        buf = buf.subarray(nl + 1);
        if (dropFrame) {
          dropFrame = false;
          writeJson(conn, { error: "frame-too-large" });
          continue;
        }
        if (line.length === 0) continue;
        if (looksLikeHttp(line)) {
          conn.destroy();
          return;
        }
        let req: DaemonRpcRequest;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (
            !parsed ||
            typeof parsed !== "object" ||
            typeof (parsed as { method?: unknown }).method !== "string"
          ) {
            writeJson(conn, { error: "invalid-request" });
            continue;
          }
          req = parsed as DaemonRpcRequest;
        } catch (err) {
          writeJson(conn, { error: `parse-failed: ${(err as Error).message}` });
          continue;
        }
        // Dispatch on a microtask — never block the data event.
        const closeRequested = { value: false };
        handler(req, {
          onActivity: () => opts.onAccept?.(),
          close: () => {
            closeRequested.value = true;
          },
        })
          .then((resp) => {
            if (req.id !== undefined) resp.id = req.id;
            writeJson(conn, resp);
            if (closeRequested.value) {
              setTimeout(() => opts.onClose?.(), 50);
            }
          })
          .catch((err: unknown) => {
            writeJson(conn, {
              ...(req.id !== undefined ? { id: req.id } : {}),
              error: `dispatch-failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          });
      }
    });

    conn.on("error", () => {
      /* peer hangup is normal — quiet */
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(ipcPath, () => {
      server.removeListener("error", reject);
      try {
        if (process.platform === "win32" && ipcPath !== socketPath) {
          fs.writeFileSync(socketPath, `${ipcPath}\n`, { mode: 0o600 });
        } else {
          // Belt-and-suspenders — narrow the socket file too. The 0700 dir
          // already gates access; this just keeps the file from being more
          // permissive than the parent.
          fs.chmodSync(socketPath, 0o600);
        }
      } catch {
        /* best-effort */
      }
      resolve();
    });
  });

  return {
    server,
    socketPath: ipcPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          if (process.platform === "win32" && ipcPath !== socketPath) {
            try {
              fs.unlinkSync(socketPath);
            } catch {
              /* best-effort */
            }
          }
          resolve();
        });
      }),
  };
};

const writeJson = (conn: net.Socket, payload: unknown): void => {
  try {
    const line = `${JSON.stringify(payload)}\n`;
    conn.write(line);
  } catch {
    /* connection dropped — ignore */
  }
};

/**
 * Probe the daemon socket: open a connection, send `daemon.ping` with optional
 * auth token, return whether the daemon answered with `ok:true`. Used by
 * `connectDaemon` to decide whether to spawn a fresh daemon, and by `socket.test.ts`.
 */
export const probeDaemon = async (
  socketPath: string,
  ping: Record<string, unknown>,
  timeoutMs = 1500,
): Promise<{ ok: boolean; reason?: string; result?: unknown }> => {
  return new Promise((resolve) => {
    const conn = net.createConnection(resolveIpcPath(socketPath));
    let buf = "";
    const done = (out: { ok: boolean; reason?: string; result?: unknown }): void => {
      conn.removeAllListeners();
      conn.destroy();
      resolve(out);
    };
    const timer = setTimeout(() => done({ ok: false, reason: "probe-timeout" }), timeoutMs);
    conn.on("connect", () => {
      conn.write(`${JSON.stringify({ method: "daemon.ping", params: ping })}\n`);
    });
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(buf.slice(0, nl)) as DaemonRpcResponse & { result?: unknown };
          if (parsed.error) {
            done({ ok: false, reason: parsed.error });
            return;
          }
          const result = parsed.result as { ok?: boolean; reason?: string } | undefined;
          if (result && result.ok === true) {
            done({ ok: true, result });
          } else {
            done({ ok: false, reason: result?.reason ?? "ping-failed", result });
          }
        } catch (err) {
          done({ ok: false, reason: `bad-response: ${(err as Error).message}` });
        }
      }
    });
    conn.on("error", (err) => {
      clearTimeout(timer);
      done({ ok: false, reason: err.message });
    });
  });
};
