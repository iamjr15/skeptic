import { redirectStdoutLogsToStderr } from "../utils/log-stdio.js";
import { startSessionDaemon, type SessionEngine } from "../daemon/session-daemon.js";

export interface SessionDaemonCmdOptions {
  engine?: string;
  headed?: boolean;
  headless?: boolean;
  idleTimeout?: number;
  sessionIdle?: number;
}

const ENGINES: SessionEngine[] = ["chromium", "firefox", "webkit", "android", "ios-sim"];

/**
 * Entry for the hidden `skeptic session-daemon` command. Auto-spawned (detached)
 * by the interactive verbs via `ensureSessionDaemon`; not meant to be run by hand.
 * Keeps the process alive until idle-timeout, signal, or `daemon.shutdown`.
 */
export const runSessionDaemon = async (opts: SessionDaemonCmdOptions): Promise<void> => {
  // The session daemon talks a binary-clean RPC protocol on its socket; keep
  // stray library logs off stdout (parity with the test daemon's discipline).
  redirectStdoutLogsToStderr();

  const engine = (ENGINES.includes(opts.engine as SessionEngine) ? opts.engine : "chromium") as SessionEngine;
  // Default headed — this is the interactive slot. `--headless` opts out. Must
  // mirror the client's `headed: opts.headless !== true` so the handshake matches.
  const headed = opts.headless !== true;

  try {
    await startSessionDaemon({
      engine,
      headed,
      cliVersion: __SKEPTIC_CLI_VERSION__,
      ...(typeof opts.idleTimeout === "number" ? { idleTimeoutSeconds: opts.idleTimeout } : {}),
      ...(typeof opts.sessionIdle === "number" ? { sessionIdleSeconds: opts.sessionIdle } : {}),
    });
  } catch (err) {
    console.error(`session-daemon: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  // Keep the event loop alive; the socket server + signal handlers own the lifecycle.
  await new Promise<never>(() => {});
};
