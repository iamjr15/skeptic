// Source: agent-browser/cli/src/native/daemon.rs:357-430 © Vercel Inc., Apache 2.0
// (control-plane-only RPC dispatch — no browser-context/page operations are
//  marshaled over the socket. Workers connect to BrowserServer.wsEndpoint()
//  via Playwright's `pw[engine].connect(wsEndpoint)` directly and own their
//  own BrowserContext. The handshake fields and engine-mismatch / version-mismatch
//  rejection logic are skeptic-original — see plan §B10 invariant 7.)

import { validateAuthToken } from "./socket.js";
import type { DaemonRpcRequest, DaemonRpcResponse } from "./socket.js";
import type { Engine } from "./lifecycle.js";

export interface DaemonRuntimeState {
  readonly engine: Engine;
  readonly headed: boolean;
  readonly cliVersion: string;
  readonly playwrightVersion: string;
  readonly startedAt: number;
  readonly clients: number;
  incClients(): void;
  decClients(): void;
  wsEndpoint(): string;
}

export interface DaemonPingParams {
  engine?: Engine;
  headed?: boolean;
  playwrightVersion?: string;
  cliVersion?: string;
  authToken?: string;
}

export interface DaemonPingResult {
  ok: boolean;
  reason?:
    | "engine-mismatch"
    | "headed-mismatch"
    | "version-mismatch"
    | "auth-failed"
    | "missing-fields";
  engine?: Engine;
  headed?: boolean;
  playwrightVersion?: string;
  cliVersion?: string;
}

export interface DaemonStatusResult {
  uptimeMs: number;
  clients: number;
  engine: Engine;
  headed: boolean;
  cliVersion: string;
  playwrightVersion: string;
}

export interface BrowserGetEndpointResult {
  wsEndpoint: string;
}

/**
 * Validate a `daemon.ping` handshake. Returns `ok:true` only when every field
 * matches and the optional auth-token check passes. Mismatches return a
 * specific reason so the client can decide whether to retry, restart, or fail.
 */
export const checkPing = (
  params: DaemonPingParams,
  state: DaemonRuntimeState,
): DaemonPingResult => {
  if (!validateAuthToken(params.authToken)) {
    return { ok: false, reason: "auth-failed" };
  }
  if (
    params.engine === undefined ||
    params.headed === undefined ||
    params.playwrightVersion === undefined ||
    params.cliVersion === undefined
  ) {
    return {
      ok: false,
      reason: "missing-fields",
      engine: state.engine,
      headed: state.headed,
      playwrightVersion: state.playwrightVersion,
      cliVersion: state.cliVersion,
    };
  }
  if (params.engine !== state.engine) {
    return {
      ok: false,
      reason: "engine-mismatch",
      engine: state.engine,
      headed: state.headed,
      playwrightVersion: state.playwrightVersion,
      cliVersion: state.cliVersion,
    };
  }
  if (params.headed !== state.headed) {
    return {
      ok: false,
      reason: "headed-mismatch",
      engine: state.engine,
      headed: state.headed,
      playwrightVersion: state.playwrightVersion,
      cliVersion: state.cliVersion,
    };
  }
  if (params.playwrightVersion !== state.playwrightVersion) {
    return {
      ok: false,
      reason: "version-mismatch",
      engine: state.engine,
      headed: state.headed,
      playwrightVersion: state.playwrightVersion,
      cliVersion: state.cliVersion,
    };
  }
  if (params.cliVersion !== state.cliVersion) {
    return {
      ok: false,
      reason: "version-mismatch",
      engine: state.engine,
      headed: state.headed,
      playwrightVersion: state.playwrightVersion,
      cliVersion: state.cliVersion,
    };
  }
  return {
    ok: true,
    engine: state.engine,
    headed: state.headed,
    playwrightVersion: state.playwrightVersion,
    cliVersion: state.cliVersion,
  };
};

/**
 * Dispatch one RPC request. The control plane has four methods:
 *   - daemon.ping       : compatibility handshake (engine + headed + versions + token)
 *   - daemon.status     : uptime + connected-client count
 *   - daemon.shutdown   : graceful close, signaled to lifecycle via `requestShutdown`
 *   - browser.getEndpoint : returns BrowserServer.wsEndpoint() for `pw[engine].connect()`
 *
 * `requestShutdown` is invoked when `daemon.shutdown` runs — the lifecycle
 * layer awaits the response and closes after a small delay so the response
 * makes it back to the client before the socket is severed.
 */
export const dispatch = async (
  req: DaemonRpcRequest,
  state: DaemonRuntimeState,
  requestShutdown: () => void,
): Promise<DaemonRpcResponse> => {
  switch (req.method) {
    case "daemon.ping": {
      const params = (req.params ?? {}) as DaemonPingParams;
      const result = checkPing(params, state);
      return { result };
    }
    case "daemon.status": {
      const result: DaemonStatusResult = {
        uptimeMs: Date.now() - state.startedAt,
        clients: state.clients,
        engine: state.engine,
        headed: state.headed,
        cliVersion: state.cliVersion,
        playwrightVersion: state.playwrightVersion,
      };
      return { result };
    }
    case "browser.getEndpoint": {
      // Only authorised pings may discover the wsEndpoint — defense in depth on
      // top of the 0700 dir + token. The first `daemon.ping` already validated
      // the handshake; we re-check the token here so a client that skipped
      // ping can't sneak in a getEndpoint call.
      const params = (req.params ?? {}) as { authToken?: string };
      if (!validateAuthToken(params.authToken)) {
        return { error: "auth-failed" };
      }
      state.incClients();
      const result: BrowserGetEndpointResult = { wsEndpoint: state.wsEndpoint() };
      return { result };
    }
    case "daemon.shutdown": {
      requestShutdown();
      return { result: { ok: true } };
    }
    default:
      return { error: `unknown-method: ${req.method}` };
  }
};
