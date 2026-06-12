// CLI interaction verbs over a persistent daemon-held browser session — the
// agent-native replacement for the deleted MCP tools. `@eN` refs persist between
// invocations because the session lives in the headed session daemon.

import { sendSessionRpc, type SessionDaemonOptions } from "../daemon/session-client.js";
import { formatSnapshotText, type RenderedRef } from "./snapshot-render.js";
import type { SnapshotStats } from "../api/snapshot.js";

export interface BrowserVerbOptions {
  session?: string;
  json?: boolean;
  headed?: boolean;
  headless?: boolean;
  /** web (default) | android. Selects the session driver when the daemon spawns. */
  platform?: string;
}

const daemonOpts = (opts: BrowserVerbOptions): SessionDaemonOptions => ({
  // Platform folds into the session-daemon engine identity: android sessions use
  // the adb driver, web sessions a browser. Fixed at the daemon's first spawn.
  engine: opts.platform === "android" ? "android" : "chromium",
  // Interactive sessions default headed (the dedicated slot); --headless opts out.
  headed: opts.headless !== true,
  cliVersion: __SKEPTIC_CLI_VERSION__,
});

const sessionParams = (opts: BrowserVerbOptions, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  session: opts.session ?? "default",
  ...extra,
});

/** Run a session RPC and print either the --json envelope or `textFn(data)`. */
const dispatch = async (
  method: string,
  params: Record<string, unknown>,
  opts: BrowserVerbOptions,
  textFn: (data: unknown) => string,
): Promise<void> => {
  let resp;
  try {
    resp = await sendSessionRpc(method, params, daemonOpts(opts));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) process.stdout.write(`${JSON.stringify({ success: false, error: message })}\n`);
    else process.stderr.write(`skeptic: ${message}\n`);
    process.exitCode = 3;
    return;
  }
  if (resp.error) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ success: false, error: resp.error })}\n`);
    else process.stderr.write(`skeptic: ${resp.error}\n`);
    process.exitCode = 1;
    return;
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ success: true, data: resp.result })}\n`);
  } else {
    process.stdout.write(textFn(resp.result));
  }
};

export interface OpenVerbOptions extends BrowserVerbOptions {
  waitUntil?: string;
}
export const runOpen = (url: string, opts: OpenVerbOptions): Promise<void> =>
  dispatch(
    "session.open",
    sessionParams(opts, { url, ...(opts.waitUntil ? { waitUntil: opts.waitUntil } : {}) }),
    opts,
    (d) => {
      const r = d as { url: string; title: string };
      return `opened ${r.url}${r.title ? ` — "${r.title}"` : ""}\n`;
    },
  );

export interface SnapshotVerbOptions extends BrowserVerbOptions {
  interactive?: boolean;
  compact?: boolean;
}
export const runSnapshot = (opts: SnapshotVerbOptions): Promise<void> =>
  dispatch(
    "session.snapshot",
    sessionParams(opts, { interactive: Boolean(opts.interactive), compact: Boolean(opts.compact) }),
    opts,
    (d) => {
      const r = d as { yaml: string; refs: RenderedRef[]; stats: SnapshotStats; note?: string };
      return formatSnapshotText(
        { yaml: r.yaml, refs: r.refs, stats: r.stats },
        { ...(r.note ? { portabilityNote: r.note } : {}) },
      );
    },
  );

/** Map a CLI selector/ref arg to session.act params. `@eN` → ref, otherwise selector. */
const targetParams = (target: string): Record<string, unknown> =>
  target.startsWith("@") ? { ref: target.slice(1) } : { selector: target };

const actVerb =
  (verb: string, label: string) =>
  (target: string, extra: Record<string, unknown>, opts: BrowserVerbOptions): Promise<void> =>
    dispatch(
      "session.act",
      sessionParams(opts, { verb, ...targetParams(target), ...extra }),
      opts,
      () => `${label} ${target}\n`,
    );

export const runClick = (target: string, opts: BrowserVerbOptions) => actVerb("click", "clicked")(target, {}, opts);
export const runHover = (target: string, opts: BrowserVerbOptions) => actVerb("hover", "hovered")(target, {}, opts);
export const runCheck = (target: string, opts: BrowserVerbOptions) => actVerb("check", "checked")(target, {}, opts);
export const runUncheck = (target: string, opts: BrowserVerbOptions) => actVerb("uncheck", "unchecked")(target, {}, opts);
export const runPress = (target: string, key: string, opts: BrowserVerbOptions) =>
  actVerb("press", `pressed ${key} on`)(target, { key }, opts);
export const runFill = (target: string, text: string, opts: BrowserVerbOptions) =>
  actVerb("fill", "filled")(target, { text }, opts);
export const runType = (target: string, text: string, opts: BrowserVerbOptions) =>
  actVerb("type", "typed into")(target, { text }, opts);
export const runSelect = (target: string, value: string, opts: BrowserVerbOptions) =>
  actVerb("select", "selected in")(target, { value }, opts);

export interface ScreenshotVerbOptions extends BrowserVerbOptions {
  name?: string;
  full?: boolean;
  annotate?: boolean;
}
export const runScreenshot = (opts: ScreenshotVerbOptions): Promise<void> =>
  dispatch(
    "session.screenshot",
    sessionParams(opts, { name: opts.name ?? "screenshot", fullPage: Boolean(opts.full), annotate: Boolean(opts.annotate) }),
    opts,
    (d) => `screenshot: ${(d as { path: string }).path}\n`,
  );

export const runGet = (query: string, target: string | undefined, opts: BrowserVerbOptions): Promise<void> =>
  dispatch(
    "session.query",
    sessionParams(opts, { query, ...(target ? targetParams(target) : {}) }),
    opts,
    (d) => `${JSON.stringify((d as { value: unknown }).value)}\n`,
  );

export interface ConsoleVerbOptions extends BrowserVerbOptions {
  errors?: boolean;
}
export const runConsole = (opts: ConsoleVerbOptions): Promise<void> =>
  dispatch(
    "session.observe",
    sessionParams(opts, { collector: opts.errors ? "errors" : "console" }),
    opts,
    (d) => `${JSON.stringify(d, null, 2)}\n`,
  );

export interface WaitVerbOptions extends BrowserVerbOptions {
  ms?: number;
  selector?: string;
  state?: string;
  timeoutMs?: number;
}
export const runWait = (opts: WaitVerbOptions): Promise<void> =>
  dispatch(
    "session.wait",
    sessionParams(opts, {
      ...(opts.ms !== undefined ? { ms: opts.ms } : {}),
      ...(opts.selector ? { selector: opts.selector } : {}),
      ...(opts.state ? { state: opts.state } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    }),
    opts,
    () => `ok\n`,
  );

export interface CloseVerbOptions extends BrowserVerbOptions {
  all?: boolean;
}
export const runClose = (opts: CloseVerbOptions): Promise<void> =>
  dispatch("session.close", sessionParams(opts), opts, (d) => {
    const r = d as { closed: boolean; session: string };
    return r.closed ? `closed session "${r.session}"\n` : `no open session "${r.session}"\n`;
  });

export const runList = (opts: BrowserVerbOptions): Promise<void> =>
  dispatch("session.list", {}, opts, (d) => {
    const sessions = (d as { sessions: Array<{ name: string; url: string; ageMs: number }> }).sessions;
    if (sessions.length === 0) return "no open sessions\n";
    return sessions.map((s) => `${s.name}\t${s.url || "(blank)"}\t${Math.round(s.ageMs / 1000)}s\n`).join("");
  });
