#!/usr/bin/env node
// Stamp a `cli-bin-<platform>/package.json` with versions resolved from the
// root `cli/package-lock.json`. The committed bin-package.json files use
// `0.0.0-LOCKFILE` placeholders so a forgotten gen-step fails publish loudly
// (npm rejects 0.0.0-LOCKFILE).
//
// Usage:
//   node scripts/gen-bin-package.mjs --bin-pkg ../cli-bin-darwin-arm64 --version 0.2.0
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
if (!args["bin-pkg"]) {
  console.error("Usage: gen-bin-package.mjs --bin-pkg <dir> [--version <semver>]");
  process.exit(1);
}

const cliDir = resolve(__dirname, "..");
const binPkgDir = resolve(args["bin-pkg"]);
const version = args.version ?? null;

const lockfilePath = join(cliDir, "package-lock.json");
const lockfile = JSON.parse(readFileSync(lockfilePath, "utf8"));

const versions = resolveLockfileVersions(lockfile, [
  "playwright",
  "playwright-core",
  "better-sqlite3",
  "oxc-resolver",
]);

const binPkgPath = join(binPkgDir, "package.json");
const binPkg = JSON.parse(readFileSync(binPkgPath, "utf8"));

if (version) binPkg.version = version;

binPkg.dependencies = {
  playwright: versions.playwright,
  "playwright-core": versions["playwright-core"],
  "better-sqlite3": versions["better-sqlite3"],
  "oxc-resolver": versions["oxc-resolver"],
};

writeFileSync(binPkgPath, JSON.stringify(binPkg, null, 2) + "\n");
console.log(
  `Updated ${binPkgPath}:`,
  Object.fromEntries(Object.entries(binPkg.dependencies)),
);

function resolveLockfileVersions(lock, names) {
  // npm v7+ lockfile format has all packages under `packages` keyed by path.
  const out = {};
  if (!lock.packages) {
    throw new Error("package-lock.json missing 'packages' map (npm v7+ required)");
  }
  for (const name of names) {
    const entry =
      lock.packages[`node_modules/${name}`] ??
      lock.packages[name];
    if (!entry?.version) {
      throw new Error(
        `package-lock.json: could not resolve version for ${name}; expected at packages["node_modules/${name}"].version`,
      );
    }
    out[name] = entry.version;
  }
  return out;
}

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
