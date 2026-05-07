// Source: agent-browser/cli/src/connection.rs:574-602 © Vercel Inc., Apache 2.0
// (the "ensure daemon running before doing browser work" gate. agent-browser
//  calls `ensure_daemon` from the CLI main, never from a worker. This helper
//  enforces the same discipline for skeptic — see B10 audit findings on
//  task #17 / `dist/worker.mjs` vs `dist/skeptic.mjs` mis-resolution.)

import { ensureDaemonRunning, type ConnectDaemonOptions } from "./client.js";
import { ensureDaemonDir, getSocketPath } from "./socket.js";
import { logger } from "../utils/logger.js";

/**
 * Single source of truth for whether a given argv invokes a Commander command
 * that needs a browser. Used by the auto-spawn discipline (plan §B10 invariant
 * 8) — only `run` / `tui` (without `--list`) and `inspect` should auto-launch
 * the daemon. Every other command (init/audit/comment/cookies/browsers
 * install/run --list/mcp/acp/add/generate/help) returns false.
 *
 * Also returns false when `--no-daemon` is present — that flag is the
 * opt-out. The caller is responsible for re-checking this predicate before
 * any pre-warm so the dead-code regression caught in the B10 audit doesn't
 * recur.
 *
 * Argv shape is whatever `process.argv` would look like — typically
 * `["node", "skeptic", "<cmd>", ...]` or just `["<cmd>", ...]`.
 */
export const commandUsesBrowser = (argv: readonly string[]): boolean => {
  // Skip leading `node` / `skeptic` / path-shaped args (real process.argv has
  // absolute paths for argv[0] = node and argv[1] = skeptic.mjs; tests often
  // pass simplified `["node", "skeptic", "run"]` shapes too).
  let i = 0;
  while (i < argv.length) {
    const a = argv[i] ?? "";
    if (/node|skeptic/.test(a) || a.includes("/")) {
      i += 1;
      continue;
    }
    break;
  }
  const cmd = argv[i];
  if (cmd === "inspect") {
    // `--no-daemon` short-circuits auto-spawn; it still needs a browser but
    // not the daemon. The auto-spawn predicate's only consumer is the
    // daemon path, so we honor `--no-daemon` here.
    return !argv.includes("--no-daemon");
  }
  if (cmd === "run" || cmd === "tui") {
    if (argv.includes("--list")) return false;
    if (argv.includes("--no-daemon")) return false;
    return true;
  }
  return false;
};

export interface PrewarmOptions {
  /** Engine the upcoming workers / inspect will request. */
  engine: ConnectDaemonOptions["engine"];
  /** Headed flag the upcoming workers / inspect will request. */
  headed: boolean;
  /** CLI version for the handshake. */
  cliVersion: string;
  /** When true, the caller already ran `--no-daemon` — skip pre-warm. */
  noDaemon: boolean;
  /** Forwarded to the spawned daemon. */
  idleTimeoutSeconds?: number;
}

/**
 * Main-process pre-warm. When the predicate matches AND `--no-daemon` is
 * absent, spawn the daemon now (before any workers fork) so subsequent
 * worker-side `connectDaemon` calls hit the fast path (`isSocketConnectable`
 * returns true and no spawn happens inside the worker).
 *
 * Returns true when the daemon is alive (or was made alive), false when we
 * skipped the pre-warm. On spawn failure the function logs a warning and
 * returns false — workers will then fall back to fresh launches per the
 * `--no-daemon` semantics, so the run still proceeds.
 */
export const prewarmDaemonIfNeeded = async (
  argv: readonly string[],
  opts: PrewarmOptions,
): Promise<boolean> => {
  if (opts.noDaemon) return false;
  if (!commandUsesBrowser(argv)) return false;
  ensureDaemonDir();
  const socketPath = getSocketPath();
  const result = await ensureDaemonRunning(socketPath, {
    engine: opts.engine,
    headed: opts.headed,
    cliVersion: opts.cliVersion,
    ...(typeof opts.idleTimeoutSeconds === "number"
      ? { idleTimeoutSeconds: opts.idleTimeoutSeconds }
      : {}),
  });
  if (!result.ok) {
    logger.warn(
      `[skeptic daemon] pre-warm failed (${result.reason ?? "unknown"}); falling back to fresh launches`,
    );
    return false;
  }
  return true;
};
