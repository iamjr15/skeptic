import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);
const repoRoot = resolve(packageRoot, "../..");
const mainPackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const cargo = readFileSync(join(repoRoot, "Cargo.toml"), "utf8");
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

if (!cargoVersion) throw new Error("workspace version is missing from Cargo.toml");

const platformDirectories = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-musl-arm64",
  "linux-musl-x64",
  "linux-x64",
  "win32-x64",
];

const versions = new Map([["Cargo.toml", cargoVersion], ["skeptic-cli", mainPackage.version]]);
for (const directory of platformDirectories) {
  const data = JSON.parse(
    readFileSync(join(repoRoot, "npm", "platforms", directory, "package.json"), "utf8"),
  );
  versions.set(data.name, data.version);
}

for (const filename of readdirSync(join(repoRoot, "schemas"))) {
  if (!filename.endsWith(".schema.json")) continue;
  const schema = JSON.parse(readFileSync(join(repoRoot, "schemas", filename), "utf8"));
  versions.set(`schema:${filename}`, schema["x-skeptic-version"]);
}

const mismatches = [...versions].filter(([, version]) => version !== cargoVersion);
if (mismatches.length) {
  for (const [source, version] of mismatches) {
    console.error(`${source} has ${version}; expected ${cargoVersion}`);
  }
  process.exit(1);
}

for (const [name, version] of Object.entries(mainPackage.optionalDependencies)) {
  if (version !== cargoVersion) {
    console.error(`${name} optional dependency has ${version}; expected ${cargoVersion}`);
    process.exit(1);
  }
}

console.log(`Skeptic version invariant: ${cargoVersion}`);
