import type * as Playwright from "playwright";
import type * as PlaywrightCore from "playwright-core";

/**
 * Cached dynamic loader so repeated calls do not re-resolve Playwright.
 */
let cachedPlaywright: typeof Playwright | null = null;

export async function loadPlaywright(): Promise<typeof Playwright> {
  if (cachedPlaywright) return cachedPlaywright;
  cachedPlaywright = await import("playwright");
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
  // Type cast: playwright-core's package.json exposes ./lib/server but
  // the published types don't include it as a typed export.
  cachedPlaywrightCoreServer = (await import(
    "playwright-core/lib/server" as string
  )) as typeof import("playwright-core/lib/server");
  return cachedPlaywrightCoreServer;
}

// Type-only re-exports so call sites can still write `Page`, `Browser`, etc.
// without a separate import line for types.
export type { Browser, BrowserContext, Page } from "playwright";
// PlaywrightCore type re-export for any internal call sites that need it.
export type { /* re-export only as needed */ } from "playwright-core";
// Explicit unused-token to keep the import alive for tsc.
export type _PlaywrightCore = typeof PlaywrightCore;
