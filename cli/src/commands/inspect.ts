// Source: agent-browser/cli/src/native/cdp/discovery.rs:1-100 © Vercel Inc., Apache 2.0
// (CDP discovery flow — `/json/version` → `/json/list` → `/devtools/browser` —
//  ported with IPv6-bracketed hostnames. The skeptic-grammar `selectorHint:` lines
//  and the cross-process-vs-volatile-ref footer are original.)

import { setTimeout as delay } from "node:timers/promises";
import type { Browser, BrowserContext, Page } from "playwright";
import { loadPlaywright } from "../utils/playwright-loader.js";
import { getDeviceProfile } from "../config/device-profiles.js";
import { logger } from "../utils/logger.js";
import { ExecutionContext } from "../executor/context.js";
import { snapshot, type SnapshotOptions } from "../api/snapshot.js";
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
  // TODO(B4): --annotated and --annotate-output land with annotated-screenshot bundle.
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
  summary: {
    total: number;
    aria: number;
    cursorInteractive: number;
  };
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

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  const ownsBrowser = !opts.connect;

  try {
    if (opts.connect) {
      const wsUrl = await discoverCdpUrl(opts.connect);
      browser = await pw.chromium.connectOverCDP(wsUrl);
      const contexts = browser.contexts();
      context = contexts[0] ?? (await browser.newContext());
      page = context.pages()[0] ?? (await context.newPage());
    } else {
      browser = await pw.chromium.launch({ headless: !opts.headed });
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

    if (opts.json) {
      emitJson(url, tree, opts);
    } else {
      emitYaml(tree, opts);
    }
  } finally {
    try {
      if (ownsBrowser) {
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

const emitYaml = (tree: RenderedTree, opts: InspectCommandOptions): void => {
  // Emit the rendered tree first.
  process.stdout.write(tree.yaml);
  if (!tree.yaml.endsWith("\n")) process.stdout.write("\n");

  // Per-ref selectorHint table.
  if (tree.refs.size > 0) {
    process.stdout.write("\n");
    for (const entry of tree.refs.values()) {
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

  // Footer.
  const total = tree.ariaRefCount + tree.cursorInteractiveCount;
  process.stdout.write(
    `\n${total} refs (${tree.ariaRefCount} ARIA, ${tree.cursorInteractiveCount} cursor-interactive). ` +
      `Stable artifact: copy a selectorHint into your test — refs are NOT portable across inspect calls. ` +
      `Inside a test, use @eN only after a snapshot(page) call in the same run.\n`,
  );
};

const emitJson = (url: string, tree: RenderedTree, opts: InspectCommandOptions): void => {
  const out: InspectJsonOutput = {
    url,
    yaml: tree.yaml,
    refs: [...tree.refs.values()].map((e) => {
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
    summary: {
      total: tree.ariaRefCount + tree.cursorInteractiveCount,
      aria: tree.ariaRefCount,
      cursorInteractive: tree.cursorInteractiveCount,
    },
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
};

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
