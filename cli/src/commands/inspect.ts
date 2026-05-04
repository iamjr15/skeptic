// Source: agent-browser/cli/src/native/cdp/discovery.rs:1-100 © Vercel Inc., Apache 2.0
// (CDP discovery sequence — `/json/version` → `/json/list` → `/devtools/browser` —
//  ported with IPv6-bracketed hostnames. The skeptic-grammar `selectorHint:` lines
//  and the cross-process-vs-volatile-ref footer are original.)

import { setTimeout as delay } from "node:timers/promises";
import { resolve as resolvePath } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { loadPlaywright } from "../utils/playwright-loader.js";
import { getDeviceProfile } from "../config/device-profiles.js";
import { logger } from "../utils/logger.js";
import { ExecutionContext } from "../executor/context.js";
import { snapshot, type SnapshotOptions, type SnapshotStats } from "../api/snapshot.js";
import type { AnnotationMapEntry } from "../api/screenshot.js";
import type { AriaRefEntry } from "../executor/aria-ref-types.js";

export interface InspectCommandOptions {
  interactive?: boolean;
  compact?: boolean;
  selector?: string;
  json?: boolean;
  device?: string;
  headed?: boolean;
  wait?: string;
  connect?: string;
  withPlaywrightHints?: boolean;
  /** When set, capture an annotated PNG (numbered badges over each interactive ref)
   *  in addition to the YAML tree. Pairs with `--annotate-output` to override the
   *  default `./skeptic-inspect-<ts>.png` path. */
  annotated?: boolean;
  annotateOutput?: string;
  /** Commander surfaces `--no-daemon` as `daemon: false`. */
  daemon?: boolean;
}

interface InspectJsonOutput {
  url: string;
  yaml: string;
  refs: Array<{
    ref: string;
    kind: AriaRefEntry["kind"];
    role: string;
    name: string;
    nth: number;
    selectorHint: string;
    href?: string;
    playwrightHint?: string;
  }>;
  stats: SnapshotStats;
  summary: {
    total: number;
    aria: number;
    cursorInteractive: number;
    rendered: number;
    interactive: number;
  };
  annotations?: AnnotationMapEntry[];
  annotatedPath?: string;
}

const DEFAULT_WAIT_MS = 1500;

/**
 * Run `skeptic inspect <url>` — open a page, capture an ARIA + cursor-interactive
 * snapshot, render it in the agent-browser-compatible format with stable
 * `selectorHint:` lines per ref, and exit. The selectorHint is the ONLY artifact
 * the agent should copy into a `*.spec.ts`; refs are volatile.
 */
export const runInspect = async (
  url: string,
  opts: InspectCommandOptions,
): Promise<void> => {
  const wait = parseWait(opts.wait);
  const pw = await loadPlaywright();

  // Pre-warm the daemon from the main process so `process.argv[1]` resolves
  // to the CLI entry. Inspect runs in the main process, but routing through
  // the shared helper keeps browser-command gating identical to `run`.
  const { prewarmDaemonIfNeeded } = await import("../daemon/auto-spawn.js");
  const prewarmed = await prewarmDaemonIfNeeded(process.argv, {
    engine: "chromium",
    headed: opts.headed === true,
    cliVersion: __SKEPTIC_CLI_VERSION__,
    noDaemon: opts.daemon === false || opts.connect !== undefined,
  });

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  // CDP-attached browsers stay open after the command exits — we only close
  // the page we opened. Daemon-attached browsers also stay open; the daemon
  // owns the BrowserServer. Only the `--no-daemon` (one-shot launch) path
  // truly owns and must close the browser. Commander parses `--no-daemon`
  // as `daemon: false`.
  //
  // Re-audit finding #2: when pre-warm fails, fall back to the one-shot
  // launch path so the inspect command still runs. The user has already seen
  // the "falling back to fresh launches" warning from prewarmDaemonIfNeeded.
  // The second clause is reachable only when `opts.daemon !== false` (the
  // short-circuit handles that case first), so the redundant `!== false`
  // check is dropped to satisfy TS narrowing.
  const noDaemon = opts.daemon === false || (!opts.connect && !prewarmed);
  const ownsBrowser = !opts.connect && noDaemon;
  let daemonDisconnect: (() => Promise<void>) | null = null;

  try {
    if (opts.connect) {
      // Path 1 — explicit CDP attach.
      const wsUrl = await discoverCdpUrl(opts.connect);
      browser = await pw.chromium.connectOverCDP(wsUrl);
      const contexts = browser.contexts();
      context = contexts[0] ?? (await browser.newContext());
      page = context.pages()[0] ?? (await context.newPage());
    } else if (noDaemon) {
      // Path 2 — `--no-daemon` opt-out with a one-shot browser launch.
      browser = await pw.chromium.launch({ headless: !opts.headed });
      const ctxOpts = buildContextOptions(opts);
      context = await browser.newContext(ctxOpts);
      page = await context.newPage();
    } else {
      // Path 3 — daemon (default). Connect to the persistent BrowserServer
      // and own our own BrowserContext (refs stay session-local — plan §B10
      // invariants 1-2). Disconnect at the end severs the WebSocket; the
      // daemon's BrowserServer keeps running for the next caller.
      const { connectDaemon } = await import("../daemon/client.js");
      const conn = await connectDaemon({
        engine: "chromium",
        headed: opts.headed === true,
        cliVersion: __SKEPTIC_CLI_VERSION__,
      });
      browser = conn.browser;
      daemonDisconnect = conn.disconnect;
      const ctxOpts = buildContextOptions(opts);
      context = await browser.newContext(ctxOpts);
      page = await context.newPage();
    }

    await page.goto(url, { waitUntil: "domcontentloaded" });
    try {
      await page.waitForLoadState("networkidle", { timeout: 5_000 });
    } catch {
      // networkidle is heuristic — proceed even if it never quiesces
    }
    if (wait > 0) await delay(wait);

    const ctx = new ExecutionContext(page, url);
    const snapshotOpts: SnapshotOptions = {
      interactive: opts.interactive ?? false,
      compact: opts.compact ?? false,
      selector: opts.selector,
      includeCursorInteractive: true,
      viewportAware: false, // inspect shows the full tree, not just visible
    };
    const tree = await snapshot(page, ctx, snapshotOpts);

    let annotations: AnnotationMapEntry[] | undefined;
    let annotatedPath: string | undefined;
    if (opts.annotated) {
      const outPath = resolvePath(
        opts.annotateOutput ?? `./skeptic-inspect-${Date.now()}.png`,
      );
      // Reuse the fixture's annotation pipeline so PNG layout, cleanup-in-finally,
      // and the PII-safe annotation-map shape stay byte-identical between the
      // `screenshot()` fixture method and `skeptic inspect --annotated`.
      const { captureAnnotatedScreenshot } = await import("../api/screenshot.js");
      const result = await captureAnnotatedScreenshot(page, outPath, {
        fullPage: false,
        scope: opts.selector ?? "body",
      });
      annotations = result.annotations;
      annotatedPath = result.path;
    }

    if (opts.json) {
      emitJson(url, tree, opts, annotations, annotatedPath);
    } else {
      emitYaml(tree, opts, annotations, annotatedPath);
    }
  } finally {
    try {
      if (daemonDisconnect) {
        // Close the inspect-owned context, then sever the WebSocket. The
        // daemon's BrowserServer stays alive for the next caller.
        await context?.close().catch(() => {});
        await daemonDisconnect();
      } else if (ownsBrowser) {
        await browser?.close();
      } else {
        // CDP-attached: close only the page we opened to avoid disrupting the
        // user's existing tabs.
        await page?.close();
        // Don't close the context or disconnect the browser.
      }
    } catch {
      // best-effort
    }
  }
};

const parseWait = (raw?: string): number => {
  if (!raw) return DEFAULT_WAIT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_WAIT_MS;
  return n;
};

interface ContextOptions {
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  userAgent?: string;
}

const buildContextOptions = (opts: InspectCommandOptions): ContextOptions => {
  const ctxOpts: ContextOptions = {};
  if (opts.device) {
    const profile = getDeviceProfile(opts.device);
    if (!profile) {
      logger.warn(`[inspect] unknown device profile "${opts.device}" — using browser defaults`);
    } else {
      ctxOpts.viewport = { width: profile.width, height: profile.height };
      ctxOpts.deviceScaleFactor = profile.dpr;
      if (profile.userAgent) ctxOpts.userAgent = profile.userAgent;
    }
  }
  return ctxOpts;
};

interface RenderedTree {
  yaml: string;
  rawYaml: string;
  refs: Map<string, AriaRefEntry>;
  stats: SnapshotStats;
  ariaRefCount: number;
  cursorInteractiveCount: number;
}

/**
 * Build the per-ref `selectorHint` line. Priority:
 *   1. Cursor-interactive entries already carry one (recorder-helper output).
 *   2. ARIA entry with name → `role=<role>:<name>`
 *   3. ARIA entry with href → `css=<tag>[href*="<host>"]`
 *   4. Otherwise → `role=<role>` (caller may need to disambiguate further)
 *
 * All three forms validate against the existing `element-resolver.ts` skeptic-grammar parser.
 */
export const buildSelectorHint = (entry: AriaRefEntry): string => {
  if (entry.selectorHint && entry.selectorHint.length > 0) {
    return entry.selectorHint;
  }
  if (entry.kind === "aria") {
    if (entry.name && entry.name.length > 0 && entry.name.length < 60) {
      return `role=${entry.role}:${entry.name}`;
    }
    if (entry.role === "link" && entry.href) {
      // Link with no accessible name (icon-only) — fall back to a stable href substring.
      const host = extractHrefHostFragment(entry.href);
      if (host) return `css=a[href*="${host}"]`;
    }
    return `role=${entry.role}`;
  }
  return "css=*";
};

const extractHrefHostFragment = (href: string): string | null => {
  try {
    const u = new URL(href, "http://dummy.invalid");
    if (u.host && u.host !== "dummy.invalid") {
      return u.host.replace(/^www\./, "");
    }
    // Relative or path-only — pick the last non-empty segment as a hint.
    const seg = u.pathname.split("/").filter(Boolean).pop();
    return seg ?? null;
  } catch {
    return null;
  }
};

const buildPlaywrightHint = (entry: AriaRefEntry): string | undefined => {
  if (entry.kind !== "aria") return undefined;
  const namePart = entry.name ? `, { name: ${JSON.stringify(entry.name)}, exact: true }` : "";
  const nthPart = entry.nth > 0 ? `.nth(${entry.nth})` : "";
  return `page.getByRole(${JSON.stringify(entry.role)}${namePart})${nthPart}`;
};

const emitYaml = (
  tree: RenderedTree,
  opts: InspectCommandOptions,
  annotations?: AnnotationMapEntry[],
  annotatedPath?: string,
): void => {
  // Emit the rendered tree first.
  process.stdout.write(tree.yaml);
  if (!tree.yaml.endsWith("\n")) process.stdout.write("\n");

  // Per-ref selectorHint table.
  if (tree.refs.size > 0) {
    const renderedRefs = new Set(
      [...tree.yaml.matchAll(/\[ref=(e\d+)\]/g)].map((match) => match[1]!),
    );
    process.stdout.write("\n");
    for (const entry of tree.refs.values()) {
      if (!renderedRefs.has(entry.ref)) continue;
      const hint = buildSelectorHint(entry);
      process.stdout.write(`  ${entry.ref} selectorHint: ${hint}\n`);
      if (entry.href) {
        process.stdout.write(`  ${entry.ref} /url: ${entry.href}\n`);
      }
      if (opts.withPlaywrightHints) {
        const ph = buildPlaywrightHint(entry);
        if (ph) process.stdout.write(`  ${entry.ref} playwrightHint: ${ph}\n`);
      }
    }
  }

  // Annotated-PNG ladder. One line per labeled badge — agent-browser-compatible
  // shape: `[<label>] @<ref> <role> "<name>" /url: <href>`.
  if (annotations && annotations.length > 0) {
    process.stdout.write("\nAnnotations:\n");
    for (const a of annotations) {
      const refEntry = tree.refs.get(a.ref);
      const namePart =
        refEntry && refEntry.name && refEntry.name.length > 0 ? ` "${refEntry.name}"` : ` ""`;
      const urlPart = refEntry?.href ? ` /url: ${refEntry.href}` : "";
      process.stdout.write(`  [${a.label}] @${a.ref} ${a.role}${namePart}${urlPart}\n`);
    }
    if (annotatedPath) process.stdout.write(`\nAnnotated PNG: ${annotatedPath}\n`);
  }

  // Footer.
  process.stdout.write(
    `\nStats: ${formatNumber(tree.stats.lines)} lines, ${formatNumber(tree.stats.characters)} chars, ` +
      `~${formatNumber(tree.stats.estimatedTokens)} tokens; ` +
      `${formatNumber(tree.stats.renderedRefs)} refs rendered / ${formatNumber(tree.stats.totalRefs)} captured ` +
      `(${formatNumber(tree.stats.ariaRefs)} ARIA, ${formatNumber(tree.stats.cursorInteractiveRefs)} cursor-interactive), ` +
      `${formatNumber(tree.stats.interactiveRefs)} interactive.\n` +
      `Stable artifact: copy a selectorHint into your test — refs are NOT portable across inspect calls. ` +
      `Inside a test, use @eN only after a snapshot(page) call in the same run.\n`,
  );
};

const emitJson = (
  url: string,
  tree: RenderedTree,
  opts: InspectCommandOptions,
  annotations?: AnnotationMapEntry[],
  annotatedPath?: string,
): void => {
  const out: InspectJsonOutput = {
    url,
    yaml: tree.yaml,
    refs: [...tree.refs.values()].filter((e) => tree.yaml.includes(`[ref=${e.ref}]`)).map((e) => {
      const item: InspectJsonOutput["refs"][number] = {
        ref: e.ref,
        kind: e.kind,
        role: e.role,
        name: e.name,
        nth: e.nth,
        selectorHint: buildSelectorHint(e),
      };
      if (e.href) item.href = e.href;
      if (opts.withPlaywrightHints) {
        const ph = buildPlaywrightHint(e);
        if (ph) item.playwrightHint = ph;
      }
      return item;
    }),
    stats: tree.stats,
    summary: {
      total: tree.stats.totalRefs,
      aria: tree.stats.ariaRefs,
      cursorInteractive: tree.stats.cursorInteractiveRefs,
      rendered: tree.stats.renderedRefs,
      interactive: tree.stats.interactiveRefs,
    },
  };
  if (annotations && annotations.length > 0) {
    out.annotations = annotations;
  }
  if (annotatedPath) out.annotatedPath = annotatedPath;
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
};

const formatNumber = (value: number): string => new Intl.NumberFormat("en-US").format(value);

/**
 * CDP discovery: try `/json/version` → `/json/list` → direct `/devtools/browser`
 * WebSocket. IPv6 hosts are bracketed correctly. Accepts:
 *   - full ws URL: `ws://host:port/devtools/browser/<id>` (returned verbatim)
 *   - http URL: `http://host:port` → fetch `/json/version`
 *   - bare `host:port` or `:port` (defaults to 127.0.0.1)
 */
export const discoverCdpUrl = async (raw: string): Promise<string> => {
  const trimmed = raw.trim();
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return trimmed;
  }

  const { host, port } = parseHostPort(trimmed);
  const bracket = (h: string): string => (h.includes(":") && !h.startsWith("[") ? `[${h}]` : h);

  // 1. /json/version
  try {
    const res = await fetch(`http://${bracket(host)}:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const body = (await res.json()) as { webSocketDebuggerUrl?: string };
      if (body.webSocketDebuggerUrl) {
        return rewriteWsHost(body.webSocketDebuggerUrl, host, port);
      }
    }
  } catch {
    // fall through
  }

  // 2. /json/list — find a target with type "page" or "browser"
  try {
    const res = await fetch(`http://${bracket(host)}:${port}/json/list`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const list = (await res.json()) as Array<{ webSocketDebuggerUrl?: string; type?: string }>;
      const target = list.find((t) => t.type === "browser") ?? list[0];
      if (target?.webSocketDebuggerUrl) {
        return rewriteWsHost(target.webSocketDebuggerUrl, host, port);
      }
    }
  } catch {
    // fall through
  }

  // 3. Direct WebSocket — agent-browser's final fallback for Chrome 136+ UI debugging.
  return `ws://${bracket(host)}:${port}/devtools/browser`;
};

const parseHostPort = (raw: string): { host: string; port: number } => {
  let s = raw;
  if (s.startsWith("http://")) s = s.slice("http://".length);
  if (s.startsWith("https://")) s = s.slice("https://".length);
  if (s.startsWith(":")) s = `127.0.0.1${s}`;
  // strip path
  const slashIdx = s.indexOf("/");
  if (slashIdx >= 0) s = s.slice(0, slashIdx);

  let host = s;
  let port = 9222;
  // IPv6 in brackets
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close > 0) {
      host = s.slice(1, close);
      const after = s.slice(close + 1);
      if (after.startsWith(":")) port = Number(after.slice(1)) || 9222;
    }
  } else {
    const colon = s.lastIndexOf(":");
    if (colon > 0) {
      host = s.slice(0, colon);
      port = Number(s.slice(colon + 1)) || 9222;
    }
  }
  return { host, port };
};

const rewriteWsHost = (wsUrl: string, host: string, port: number): string => {
  try {
    const u = new URL(wsUrl);
    u.hostname = host;
    u.port = String(port);
    return u.toString();
  } catch {
    return wsUrl;
  }
};
