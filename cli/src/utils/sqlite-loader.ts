import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type DatabaseConstructor from "better-sqlite3";

// Load node:sea via createRequire so esbuild leaves the `node:` prefix alone.
const nodeSea = createRequire(import.meta.url)("node:sea") as {
  isSea?: () => boolean;
};
const isSea: () => boolean = nodeSea.isSea ?? (() => false);

let cached: typeof DatabaseConstructor | null = null;

/**
 * SEA-aware loader for the `better-sqlite3` default export. Returns
 * synchronously because the cookie code paths (`extractChromiumCookies`,
 * `extractFirefoxCookies`) are sync and converting them to async would
 * cascade through `extractor.ts` → `playwright-engine.ts:cookies` and the
 * `skeptic cookies list` command.
 *
 * Inside SEA, we createRequire bound to the binary's directory so the
 * sidecar `node_modules/` resolves. Outside SEA (npm install or dev), we
 * createRequire bound to this module's URL so the user's `node_modules/`
 * resolves the same way the original `import Database from "better-sqlite3"`
 * did.
 *
 * Only reachable when `__SKEPTIC_FEATURE_COOKIE_EXTRACTION__` is true; the
 * gate is enforced before this function is called.
 */
export function getDatabaseConstructor(): typeof DatabaseConstructor {
  if (cached) return cached;
  const anchor = isSea()
    ? join(dirname(process.execPath), "_pkg.js")
    : import.meta.url;
  const req = createRequire(anchor);
  // better-sqlite3 publishes a CommonJS module whose `module.exports` is
  // the constructor itself (no .default); the npm-style `import Database
  // from "better-sqlite3"` is just esbuild interop sugar.
  cached = req("better-sqlite3") as typeof DatabaseConstructor;
  return cached;
}
