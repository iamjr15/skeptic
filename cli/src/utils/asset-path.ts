import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load node:sea via createRequire so esbuild leaves the `node:` prefix alone.
// (Marking it external in tsup wasn't enough — the prefix still got stripped
// in the bundle, producing a runtime "Cannot find package 'sea'" error.)
const nodeSea = createRequire(import.meta.url)("node:sea") as {
  isSea?: () => boolean;
  getAsset?: (key: string) => ArrayBuffer | undefined;
};

const isSea: () => boolean = nodeSea.isSea ?? (() => false);

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Returns the templates directory. In SEA mode there's no on-disk
 * templates/ — readers must use `readTemplate(relPath)` instead. Callers
 * that genuinely need a directory path (e.g. `skeptic init` walking the
 * tree) call `getTemplatesDir()` only in non-SEA mode.
 */
export const getTemplatesDir = (): string => {
  // Production: dist/skeptic.mjs lives next to dist/templates/.
  const bundled = join(here, "templates");
  if (fs.existsSync(bundled)) return bundled;

  // Dev: cli/src/utils/asset-path.ts → ../../templates → cli/templates.
  return resolve(here, "../../templates");
};

/**
 * Read a template file by relative path (e.g. "skeptic.config.yaml" or
 * "guidance/accessibility.md"). Resolves through three layouts:
 *   - SEA: node:sea.getAsset("templates/<relPath>") via the embedded blob
 *   - Bundled (npm dist):  dist/templates/<relPath> on disk
 *   - Dev (tsx, vitest):   cli/templates/<relPath> on disk
 */
export const readTemplate = (relPath: string): Buffer => {
  if (isSea()) {
    const getAsset = nodeSea.getAsset;
    if (!getAsset) throw new Error("readTemplate: SEA detected but getAsset unavailable");
    const blob = getAsset(`templates/${relPath}`);
    if (!blob) throw new Error(`readTemplate: missing SEA asset templates/${relPath}`);
    return Buffer.from(blob);
  }
  return fs.readFileSync(join(getTemplatesDir(), relPath));
};

/**
 * Path to web-vitals.iife.js for the page-injection performance collector.
 * 3-tier resolution:
 *   - SEA:                node:sea.getAsset("web-vitals.iife.js") → temp file
 *   - Bundled (npm dist): dist/web-vitals.iife.js on disk
 *   - Dev:                node_modules/web-vitals/dist/web-vitals.iife.js
 */
let cachedWebVitalsPath: string | null = null;
export const getWebVitalsIifeScript = (): string => {
  if (isSea()) {
    if (cachedWebVitalsPath) return cachedWebVitalsPath;
    const getAsset = nodeSea.getAsset;
    if (!getAsset) throw new Error("getWebVitalsIifeScript: SEA detected but getAsset unavailable");
    const blob = getAsset("web-vitals.iife.js");
    if (!blob) throw new Error("getWebVitalsIifeScript: missing SEA asset web-vitals.iife.js");
    const dir = fs.mkdtempSync(join(os.tmpdir(), "skeptic-wv-"));
    const filePath = join(dir, "web-vitals.iife.js");
    fs.writeFileSync(filePath, Buffer.from(blob), { mode: 0o600 });
    cachedWebVitalsPath = filePath;
    process.on("exit", () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    });
    return filePath;
  }

  // Production: dist/web-vitals.iife.js (Phase 1 onSuccess copies it).
  const bundled = join(here, "web-vitals.iife.js");
  if (fs.existsSync(bundled)) return bundled;

  // Dev: walk to node_modules from this file.
  return resolve(here, "../../node_modules/web-vitals/dist/web-vitals.iife.js");
};
