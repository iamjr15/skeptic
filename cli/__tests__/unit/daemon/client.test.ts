import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  startSocketServer,
  ensureDaemonDir,
  type DaemonRpcHandler,
} from "../../../src/daemon/socket.js";
import { sendRpc } from "../../../src/daemon/client.js";

// `connectDaemon` itself touches Playwright + spawns subprocesses, so it's
// covered by the daemon integration tests. These unit tests target the
// observable RPC contract pieces (sendRpc, error paths) without launching
// Chromium.
describe("daemon/client.ts — sendRpc + auth path", () => {
  let tmpDir: string;
  let prevDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-client-"));
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

  it("sendRpc round-trips a method and returns the result", async () => {
    ensureDaemonDir();
    const sockPath = path.join(tmpDir, "echo.sock");
    const handler: DaemonRpcHandler = async (req) => ({
      result: { method: req.method, ok: true },
    });
    const server = await startSocketServer(sockPath, handler);
    try {
      const resp = await sendRpc(sockPath, { method: "test.method" }, 2000);
      expect(resp.result).toEqual({ method: "test.method", ok: true });
    } finally {
      await server.close();
    }
  });

  it("sendRpc rejects with a timeout when the server never replies", async () => {
    ensureDaemonDir();
    const sockPath = path.join(tmpDir, "stalled.sock");
    const handler: DaemonRpcHandler = () => new Promise(() => {});
    const server = await startSocketServer(sockPath, handler);
    try {
      await expect(
        sendRpc(sockPath, { method: "test.never" }, 250),
      ).rejects.toThrow(/timeout/);
    } finally {
      await server.close();
    }
  });

  it("sendRpc rejects when no socket exists at the path", async () => {
    const sockPath = path.join(tmpDir, "missing.sock");
    await expect(
      sendRpc(sockPath, { method: "anything" }, 500),
    ).rejects.toBeTruthy();
  });
});
