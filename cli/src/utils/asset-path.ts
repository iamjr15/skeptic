import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Returns the templates directory for both bundled npm installs and local dev.
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
 * "guidance/accessibility.md"). Resolves through two layouts:
 *   - Bundled (npm dist):  dist/templates/<relPath> on disk
 *   - Dev (tsx, vitest):   cli/templates/<relPath> on disk
 */
export const readTemplate = (relPath: string): Buffer => {
  return fs.readFileSync(join(getTemplatesDir(), relPath));
};

/**
 * Path to web-vitals.iife.js for the page-injection performance collector.
 * Resolves through bundled npm installs first and local dev second.
 */
export const getWebVitalsIifeScript = (): string => {
  // Production: dist/web-vitals.iife.js (tsup onSuccess copies it).
  const bundled = join(here, "web-vitals.iife.js");
  if (fs.existsSync(bundled)) return bundled;

  // Dev: walk to node_modules from this file.
  return resolve(here, "../../node_modules/web-vitals/dist/web-vitals.iife.js");
};
