import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureDaemonDir,
  getDaemonDir,
  getSocketPath,
  startSocketServer,
  unlinkStaleSocket,
  validateAuthToken,
  probeDaemon,
  MAX_LINE_BYTES,
  type DaemonRpcHandler,
} from "../../../src/daemon/socket.js";

const sendLine = (socketPath: string, line: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("response timeout"));
    }, 2000);
    conn.on("connect", () => conn.write(`${line}\n`));
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        conn.destroy();
        resolve(buf.slice(0, nl));
      }
    });
    conn.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

describe("daemon/socket.ts", () => {
  let tmpDir: string;
  let prevDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-socket-"));
    prevDir = process.env["SKEPTIC_DAEMON_DIR"];
    process.env["SKEPTIC_DAEMON_DIR"] = tmpDir;
    delete process.env["SKEPTIC_DAEMON_AUTH_TOKEN"];
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env["SKEPTIC_DAEMON_DIR"];
    else process.env["SKEPTIC_DAEMON_DIR"] = prevDir;
    delete process.env["SKEPTIC_DAEMON_AUTH_TOKEN"];
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("ensureDaemonDir creates ~/.skeptic with 0700 permissions", () => {
    expect(fs.existsSync(tmpDir)).toBe(true);
    // Pre-existing tmpDir starts at 0700 anyway from mkdtemp; chmod-down it
    // first to verify the function tightens.
    fs.chmodSync(tmpDir, 0o755);
    expect(fs.statSync(tmpDir).mode & 0o777).toBe(0o755);
    ensureDaemonDir();
    expect(fs.statSync(tmpDir).mode & 0o777).toBe(0o700);
  });

  it("getDaemonDir respects SKEPTIC_DAEMON_DIR env override", () => {
    expect(getDaemonDir()).toBe(tmpDir);
  });

  it("validateAuthToken: unset env passes any/no token (timing-safe path is the env-set branch)", () => {
    delete process.env["SKEPTIC_DAEMON_AUTH_TOKEN"];
    expect(validateAuthToken(undefined)).toBe(true);
    expect(validateAuthToken("anything")).toBe(true);
  });

  it("validateAuthToken: env set, correct token accepted, wrong rejected, missing rejected", () => {
    process.env["SKEPTIC_DAEMON_AUTH_TOKEN"] = "correct-horse-battery-staple";
    expect(validateAuthToken("correct-horse-battery-staple")).toBe(true);
    expect(validateAuthToken("wrong")).toBe(false);
    expect(validateAuthToken(undefined)).toBe(false);
    expect(validateAuthToken("")).toBe(false);
    // Length-mismatch must not throw or short-circuit before timingSafeEqual.
    expect(validateAuthToken("correct-horse-battery-staple-extra")).toBe(false);
  });

  it("unlinkStaleSocket: removes stale socket file", () => {
    const sockPath = path.join(tmpDir, "daemon.sock");
    fs.writeFileSync(sockPath, "");
    expect(fs.existsSync(sockPath)).toBe(true);
    expect(unlinkStaleSocket(sockPath)).toBe(true);
    expect(fs.existsSync(sockPath)).toBe(false);
  });

  it("unlinkStaleSocket: refuses to follow symlink pointing outside daemon dir", () => {
    ensureDaemonDir();
    const outsideTarget = path.join(os.tmpdir(), `skeptic-sym-target-${Date.now()}`);
    fs.writeFileSync(outsideTarget, "do not delete me");
    const sockPath = getSocketPath();
    fs.symlinkSync(outsideTarget, sockPath);
    expect(unlinkStaleSocket(sockPath)).toBe(false);
    expect(fs.existsSync(outsideTarget)).toBe(true);
    fs.unlinkSync(sockPath);
    fs.unlinkSync(outsideTarget);
  });

  it("line-delimited JSON framing: happy path round-trip", async () => {
    ensureDaemonDir();
    const sockPath = path.join(tmpDir, "happy.sock");
    const handler: DaemonRpcHandler = async (req) => ({
      result: { echoed: req.method, params: req.params },
    });
    const server = await startSocketServer(sockPath, handler);
    try {
      const reply = await sendLine(
        sockPath,
        JSON.stringify({ method: "test.echo", params: { hello: "world" } }),
      );
      const parsed = JSON.parse(reply) as { result: { echoed: string; params: unknown } };
      expect(parsed.result.echoed).toBe("test.echo");
      expect(parsed.result.params).toEqual({ hello: "world" });
    } finally {
      await server.close();
    }
  });

  it("line-delimited JSON framing: malformed JSON yields parse-failed but keeps connection alive", async () => {
    ensureDaemonDir();
    const sockPath = path.join(tmpDir, "malformed.sock");
    const handler: DaemonRpcHandler = async () => ({ result: { ok: true } });
    const server = await startSocketServer(sockPath, handler);
    try {
      const reply = await sendLine(sockPath, "{ not valid json");
      expect(reply).toMatch(/parse-failed/);
    } finally {
      await server.close();
    }
  });

  it("line-delimited JSON framing: oversized frames replied to with frame-too-large", async () => {
    ensureDaemonDir();
    const sockPath = path.join(tmpDir, "big.sock");
    const handler: DaemonRpcHandler = async () => ({ result: { ok: true } });
    const server = await startSocketServer(sockPath, handler);
    try {
      const huge = "x".repeat(MAX_LINE_BYTES + 100);
      const reply = await sendLine(sockPath, huge);
      expect(reply).toMatch(/frame-too-large/);
    } finally {
      await server.close();
    }
  });

  it("probeDaemon: returns ok:false when no daemon is listening", async () => {
    const sockPath = path.join(tmpDir, "nope.sock");
    const result = await probeDaemon(sockPath, { engine: "chromium" }, 500);
    expect(result.ok).toBe(false);
  });

  it("probeDaemon: returns ok:true when daemon answers with ok:true", async () => {
    ensureDaemonDir();
    const sockPath = path.join(tmpDir, "ping.sock");
    const handler: DaemonRpcHandler = async (req) => {
      if (req.method === "daemon.ping") return { result: { ok: true } };
      return { error: "unknown" };
    };
    const server = await startSocketServer(sockPath, handler);
    try {
      const result = await probeDaemon(sockPath, {});
      expect(result.ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("HTTP-shaped lines drop the connection without replying (defense against accidental browser hits)", async () => {
    ensureDaemonDir();
    const sockPath = path.join(tmpDir, "http.sock");
    const handler: DaemonRpcHandler = async () => ({ result: { ok: true } });
    const server = await startSocketServer(sockPath, handler);
    try {
      // The server must destroy the connection (no reply, no further data).
      const outcome = await new Promise<"closed" | "data" | "timeout">((resolve) => {
        const conn = net.createConnection(sockPath);
        const timer = setTimeout(() => {
          conn.destroy();
          resolve("timeout");
        }, 1000);
        conn.on("connect", () => conn.write("GET /admin HTTP/1.1\n"));
        conn.on("data", () => {
          clearTimeout(timer);
          conn.destroy();
          resolve("data");
        });
        conn.on("close", () => {
          clearTimeout(timer);
          resolve("closed");
        });
        conn.on("error", () => {
          clearTimeout(timer);
          resolve("closed");
        });
      });
      expect(outcome).toBe("closed");
    } finally {
      await server.close();
    }
  });
});
