#!/usr/bin/env node
// Copy the dependency closure required by a platform-specific SEA package.
//
// The release job already runs `npm ci` in cli/, so installing again inside
// every cli-bin-* package is slower and can emit npm deprecation warnings from
// transitive native-build tooling. This script stages the exact package tree
// from cli/node_modules instead.
import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
if (!args["bin-pkg"]) {
  console.error("Usage: stage-bin-sidecars.mjs --bin-pkg <dir>");
  process.exit(1);
}

const cliDir = resolve(__dirname, "..");
const sourceNodeModules = join(cliDir, "node_modules");
const binPkgDir = resolve(args["bin-pkg"]);
const targetNodeModules = join(binPkgDir, "node_modules");
const binPkg = readPackageJson(join(binPkgDir, "package.json"));
const directDependencies = Object.keys(binPkg.dependencies ?? {});

if (directDependencies.length === 0) {
  throw new Error(`${binPkgDir}/package.json has no dependencies to stage`);
}

fs.rmSync(targetNodeModules, { recursive: true, force: true });
fs.mkdirSync(targetNodeModules, { recursive: true });

const staged = new Set();
for (const dependency of directDependencies) {
  stagePackage(dependency, false);
}

console.log(`Staged ${staged.size} sidecar package(s) in ${targetNodeModules}`);

function stagePackage(name, optional) {
  if (staged.has(name)) return;

  const src = join(sourceNodeModules, ...name.split("/"));
  const pkgPath = join(src, "package.json");
  if (!fs.existsSync(pkgPath)) {
    if (optional) return;
    throw new Error(`Missing dependency ${name} in ${sourceNodeModules}`);
  }

  const dest = join(targetNodeModules, ...name.split("/"));
  fs.mkdirSync(dirname(dest), { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
  });
  staged.add(name);

  const pkg = readPackageJson(pkgPath);
  for (const child of Object.keys(pkg.dependencies ?? {})) {
    stagePackage(child, false);
  }
  for (const child of Object.keys(pkg.optionalDependencies ?? {})) {
    stagePackage(child, true);
  }
}

function readPackageJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}
