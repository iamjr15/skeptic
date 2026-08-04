import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const dist = resolve(process.argv[2] ?? join(repoRoot, "dist"));
const binaries = ["skeptic", "skeptic-runner", "skeptic-doctor", "skeptic-mobile", "skeptic-report"];
const platforms = [
  "darwin-arm64", "darwin-x64", "linux-arm64", "linux-musl-arm64",
  "linux-musl-x64", "linux-x64", "win32-x64",
];

for (const platform of platforms) {
  const extension = platform.startsWith("win32-") ? ".exe" : "";
  const destination = join(repoRoot, "npm", "platforms", platform, "bin");
  mkdirSync(destination, { recursive: true });
  for (const binary of binaries) {
    const source = join(dist, `${binary}-${platform}${extension}`);
    if (!existsSync(source)) throw new Error(`missing release asset ${basename(source)}`);
    const target = join(destination, `${binary}${extension}`);
    copyFileSync(source, target);
    if (!extension) chmodSync(target, 0o755);
  }
  const packageData = JSON.parse(readFileSync(join(dirname(destination), "package.json"), "utf8"));
  if (packageData.skepticBinary !== `bin/skeptic${extension}`) {
    throw new Error(`${platform} has an invalid skepticBinary field`);
  }
}

console.log(`Staged complete Skeptic runtime bundles from ${dist}`);
