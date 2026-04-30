import { describe, it, expect, beforeEach, vi } from "vitest";

// B10 audit fix (task #17) — `commandUsesBrowser` must gate `prewarmDaemonIfNeeded`
// from the MAIN process before any worker_threads fork, so `process.argv[1]`
// resolves to `dist/skeptic.mjs` (not `dist/worker.mjs`). This test asserts:
//   1. The predicate gates pre-warm correctly across argvs.
//   2. `--no-daemon` always skips the pre-warm.
//   3. The underlying `ensureDaemonRunning` is invoked from the helper, NOT
//      from inside a worker module.

// Mock the spawn-or-no-op heart of the helper. The helper imports
// `ensureDaemonRunning` from `daemon/client.js`; if we mock that module,
// `prewarmDaemonIfNeeded` becomes deterministic without touching real
// sockets or subprocesses.
//
// `vi.hoisted` is REQUIRED here: `vi.mock(...)` is hoisted to the top of the
// file before any `const` declarations, so a top-level `const ensureSpy = ...`
// would not exist when the mock factory runs (ReferenceError on first import).
// `vi.hoisted` runs in the hoisted phase so the spy is constructed before the
// mock factory references it.
const { ensureSpy } = vi.hoisted(() => ({
  ensureSpy: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock("../../../src/daemon/client.js", async () => {
  // Avoid pulling Playwright into the unit test by stubbing the entire module.
  return {
    ensureDaemonRunning: ensureSpy,
    connectDaemon: vi.fn(),
    sendRpc: vi.fn(),
  };
});

// Stub the socket-helper to avoid touching the filesystem in unit tests.
vi.mock("../../../src/daemon/socket.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/daemon/socket.js")>(
    "../../../src/daemon/socket.js",
  );
  return {
    ...actual,
    ensureDaemonDir: vi.fn(),
    getSocketPath: () => "/tmp/skeptic-mock.sock",
  };
});

import {
  commandUsesBrowser,
  prewarmDaemonIfNeeded,
} from "../../../src/daemon/auto-spawn.js";

const baseOpts = {
  engine: "chromium" as const,
  headed: false,
  cliVersion: "test-1.0.0",
};

describe("main-spawn discipline (task #17 audit fix)", () => {
  beforeEach(() => {
    ensureSpy.mockClear();
  });

  it("commandUsesBrowser is exported from daemon/auto-spawn (production path)", () => {
    // Dead-code regression check — the predicate must be reachable from the
    // module that owns `prewarmDaemonIfNeeded`, NOT just `index.ts`.
    expect(typeof commandUsesBrowser).toBe("function");
  });

  it("pre-warms when argv is `run` and noDaemon is false", async () => {
    await prewarmDaemonIfNeeded(["node", "skeptic", "run"], { ...baseOpts, noDaemon: false });
    expect(ensureSpy).toHaveBeenCalledTimes(1);
  });

  it("pre-warms when argv is `inspect <url>` and noDaemon is false", async () => {
    await prewarmDaemonIfNeeded(
      ["node", "skeptic", "inspect", "https://example.com"],
      { ...baseOpts, noDaemon: false },
    );
    expect(ensureSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT pre-warm when noDaemon is true (regardless of command)", async () => {
    await prewarmDaemonIfNeeded(["node", "skeptic", "run"], { ...baseOpts, noDaemon: true });
    await prewarmDaemonIfNeeded(["node", "skeptic", "inspect", "https://example.com"], {
      ...baseOpts,
      noDaemon: true,
    });
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it("does NOT pre-warm when argv is `run --list`", async () => {
    await prewarmDaemonIfNeeded(["node", "skeptic", "run", "--list"], {
      ...baseOpts,
      noDaemon: false,
    });
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it("does NOT pre-warm when argv is `run --no-daemon` even if caller forgot to pass noDaemon=true", async () => {
    // The predicate is the second line of defense — in practice run.ts/
    // inspect.ts also pass `noDaemon: opts.daemon === false`.
    await prewarmDaemonIfNeeded(["node", "skeptic", "run", "--no-daemon"], {
      ...baseOpts,
      noDaemon: false,
    });
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["init"],
    ["audit"],
    ["comment"],
    ["browsers", "install"],
    ["mcp"],
    ["acp"],
    ["generate"],
    ["daemon", "start"],
  ])("does NOT pre-warm for non-browser command %s", async (...cmd) => {
    await prewarmDaemonIfNeeded(["node", "skeptic", ...cmd], {
      ...baseOpts,
      noDaemon: false,
    });
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it("forwards engine + headed + cliVersion + idleTimeout to ensureDaemonRunning", async () => {
    await prewarmDaemonIfNeeded(["node", "skeptic", "run"], {
      engine: "firefox",
      headed: true,
      cliVersion: "9.9.9",
      noDaemon: false,
      idleTimeoutSeconds: 600,
    });
    expect(ensureSpy).toHaveBeenCalledTimes(1);
    const call = ensureSpy.mock.calls[0];
    if (!call) throw new Error("expected ensureSpy to have been called");
    const [, passedOpts] = call;
    expect(passedOpts).toMatchObject({
      engine: "firefox",
      headed: true,
      cliVersion: "9.9.9",
      idleTimeoutSeconds: 600,
    });
  });

  it("returns false (and logs a warning) when ensureDaemonRunning fails — workers fall back to fresh launches", async () => {
    ensureSpy.mockResolvedValueOnce({ ok: false, reason: "spawn-timeout" });
    const result = await prewarmDaemonIfNeeded(["node", "skeptic", "run"], {
      ...baseOpts,
      noDaemon: false,
    });
    expect(result).toBe(false);
  });

  it("returns true when ensureDaemonRunning succeeds", async () => {
    const result = await prewarmDaemonIfNeeded(["node", "skeptic", "run"], {
      ...baseOpts,
      noDaemon: false,
    });
    expect(result).toBe(true);
  });
});
