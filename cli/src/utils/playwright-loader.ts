import { createRequire } from "node:module";
import { requireExternal } from "./sea-require.js";
import type * as Playwright from "playwright";
import type * as PlaywrightCore from "playwright-core";

// Load node:sea via createRequire so esbuild leaves the `node:` prefix alone.
const nodeSea = createRequire(import.meta.url)("node:sea") as {
  isSea?: () => boolean;
};
const isSea: () => boolean = nodeSea.isSea ?? (() => false);

/**
 * SEA-aware loader for the `playwright` package. Inside a SEA binary,
 * dynamic `import()` of filesystem modules throws — `requireExternal`
 * resolves through the sidecar `node_modules/`. Outside SEA (npm install,
 * dev), we use the bundler-friendly dynamic import.
 *
 * Cached so repeated calls don't re-resolve. Type narrows to Playwright's
 * type surface so call sites can keep their existing chromium/firefox/webkit
 * destructure.
 */
let cachedPlaywright: typeof Playwright | null = null;

export async function loadPlaywright(): Promise<typeof Playwright> {
  if (cachedPlaywright) return cachedPlaywright;
  if (isSea()) {
    cachedPlaywright = requireExternal<typeof Playwright>("playwright");
  } else {
    cachedPlaywright = await import("playwright");
  }
  return cachedPlaywright;
}

let cachedPlaywrightCoreServer:
  | typeof import("playwright-core/lib/server")
  | null = null;

/**
 * Load `playwright-core/lib/server` (the documented export that exposes
 * `registry.resolveBrowsers`, `registry.install`, `registry.installDeps`).
 * Used by `skeptic browsers install` to perform the equivalent of
 * `npx playwright install` without requiring npx on the user's machine.
 */
export async function loadPlaywrightCoreServer(): Promise<
  typeof import("playwright-core/lib/server")
> {
  if (cachedPlaywrightCoreServer) return cachedPlaywrightCoreServer;
  if (isSea()) {
    cachedPlaywrightCoreServer = requireExternal<
      typeof import("playwright-core/lib/server")
    >("playwright-core/lib/server");
  } else {
    // Type cast: playwright-core's package.json exposes ./lib/server but
    // the published types don't include it as a typed export.
    cachedPlaywrightCoreServer = (await import(
      "playwright-core/lib/server" as string
    )) as typeof import("playwright-core/lib/server");
  }
  return cachedPlaywrightCoreServer;
}

// Type-only re-exports so call sites can still write `Page`, `Browser`, etc.
// without a separate import line for types.
export type { Browser, BrowserContext, Page } from "playwright";
// PlaywrightCore type re-export for any internal call sites that need it.
export type { /* re-export only as needed */ } from "playwright-core";
// Explicit unused-token to keep the import alive for tsc.
export type _PlaywrightCore = typeof PlaywrightCore;
