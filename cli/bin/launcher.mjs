#!/usr/bin/env node
// JS package launcher.
//
// The published package always includes the JS bundle at `dist/skeptic.mjs`.
//
// This file is intentionally NOT processed by tsup — it's hand-written and
// stays under `bin/` in the published tarball (declared in package.json
// `files`). tsup output goes to `dist/skeptic.mjs`.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = join(here, "..", "dist", "skeptic.mjs");

// ESM `import()` rejects raw Windows paths like `C:\...`; convert to
// `file://` URL first.
await import(pathToFileURL(entrypoint).href);
