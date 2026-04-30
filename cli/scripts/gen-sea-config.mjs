#!/usr/bin/env node
// Walk dist/templates/** and emit a sea-config.json with absolute paths.
// Node SEA resolves non-absolute config paths relative to the cwd at build
// time (NOT relative to the config file), so the build script generates a
// fresh `dist/sea-config.absolute.json` on every run with absolute paths
// for `main`, `output`, and every `assets` entry.
//
// Usage:
//   node scripts/gen-sea-config.mjs --base /path/to/cli --output /path/to/binary
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const base = resolve(args.base ?? process.cwd());
const outputPath = resolve(args.output ?? join(base, "dist/skeptic"));
const distDir = join(base, "dist");
const templatesDir = join(distDir, "templates");

function walk(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) entries.push(...walk(full));
    else entries.push(full);
  }
  return entries;
}

const assets = {};

// Template files (recursive — guidance/ has nested .md files).
for (const file of walk(templatesDir)) {
  const rel = relative(distDir, file).replaceAll("\\", "/");
  assets[rel] = file;
}

// Recorder script.
assets["recorder-script.js"] = join(distDir, "recorder-script.js");

// web-vitals (Phase 1 onSuccess copies it into dist/).
assets["web-vitals.iife.js"] = join(distDir, "web-vitals.iife.js");

const config = {
  main: join(distDir, "skeptic.mjs"),
  output: outputPath,
  mainFormat: "module",
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  // useCodeCache stays false until we confirm the user's Node has the
  // commit that allows useCodeCache + mainFormat: "module" together
  // (Node commit 9ff27fd, March 2026 — may not be in stable v25.5).
  useCodeCache: false,
  assets,
};

const outFile = join(distDir, "sea-config.absolute.json");
writeFileSync(outFile, JSON.stringify(config, null, 2));
console.log(outFile);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}
