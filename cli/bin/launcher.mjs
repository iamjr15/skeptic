#!/usr/bin/env node
// Per-platform binary dispatcher with JS fallback.
//
// `npm install -g skeptic-cli` resolves an `optionalDependencies` entry like
// `skeptic-cli-bin-darwin-arm64` matching the host's os+cpu, which itself
// contains the platform binary. This launcher tries to spawn that binary;
// if no platform package matched (e.g. unsupported platform like FreeBSD,
// or a corporate registry that doesn't mirror the bin packages), it falls
// back to the bundled JS at `dist/skeptic.mjs` running on the user's Node.
//
// This file is intentionally NOT processed by tsup — it's hand-written and
// stays under `bin/` in the published tarball (declared in package.json
// `files`). tsup output goes to `dist/skeptic.mjs` as the JS fallback path.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const platform = `${process.platform}-${process.arch}`;
const pkgName = `skeptic-cli-bin-${platform}`;

try {
  const binName = process.platform === "win32" ? "skeptic.exe" : "skeptic";
  const binPath = require.resolve(`${pkgName}/${binName}`);
  // Use spawn (not spawnSync) with `inherit` so signals (Ctrl-C),
  // long-running output, and TTY behavior pass through cleanly.
  const child = spawn(binPath, process.argv.slice(2), { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  child.on("error", (err) => {
    console.error(`skeptic: failed to spawn ${binPath}: ${err.message}`);
    process.exit(1);
  });
} catch {
  // No platform binary available (FreeBSD, mirror without bin packages,
  // local dev). Fall back to the bundled JS.
  const here = dirname(fileURLToPath(import.meta.url));
  const fallback = join(here, "..", "dist", "skeptic.mjs");
  // ESM `import()` rejects raw Windows paths like `C:\...`; convert to
  // `file://` URL first.
  await import(pathToFileURL(fallback).href);
}
