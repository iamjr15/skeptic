import { createRequire } from "node:module";
import type DatabaseConstructor from "better-sqlite3";

let cached: typeof DatabaseConstructor | null = null;

/**
 * Returns synchronously because cookie extraction is sync and converting it to
 * async would cascade through the executor and `skeptic cookies list`.
 */
export function getDatabaseConstructor(): typeof DatabaseConstructor {
  if (cached) return cached;
  const req = createRequire(import.meta.url);
  // better-sqlite3 publishes a CommonJS module whose `module.exports` is
  // the constructor itself (no .default); the npm-style `import Database
  // from "better-sqlite3"` is just esbuild interop sugar.
  cached = req("better-sqlite3") as typeof DatabaseConstructor;
  return cached;
}
