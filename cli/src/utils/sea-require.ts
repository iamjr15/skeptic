import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * In SEA mode, the injected main script's `import`/`require` resolves only
 * built-in Node modules; filesystem modules throw. To load externals
 * (`playwright`, `playwright-core`, `better-sqlite3`, `oxc-resolver`) at
 * runtime, we create a `require()` bound to a known sibling `node_modules/`
 * directory next to the binary. The build pipeline stages those modules in
 * `dist/node_modules/` for SEA, and Phase 7 also stages them in the npm bin
 * package's `node_modules/` so the same code path works for both
 * distributions.
 *
 * `_pkg.js` doesn't have to exist — `createRequire` only needs a file URL
 * inside the directory whose `node_modules/` we want to resolve from. The
 * bound require then walks up from that path looking for `node_modules/<name>`.
 */
let cachedRequire: NodeJS.Require | null = null;

function getSeaRequire(): NodeJS.Require {
  if (cachedRequire) return cachedRequire;
  // process.execPath is the SEA binary itself. Its parent directory is where
  // we stage the sidecar `node_modules/`.
  const here = dirname(process.execPath);
  const anchor = join(here, "_pkg.js");
  cachedRequire = createRequire(anchor);
  return cachedRequire;
}

export function requireExternal<T>(specifier: string): T {
  return getSeaRequire()(specifier) as T;
}
