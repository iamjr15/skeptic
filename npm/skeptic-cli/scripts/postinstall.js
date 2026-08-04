import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { get } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageData = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const binaries = ["skeptic", "skeptic-runner", "skeptic-doctor", "skeptic-mobile", "skeptic-report"];

function usesMusl() {
  if (process.platform !== "linux") return false;
  try {
    if (process.report?.getReport()?.header?.glibcVersionRuntime) return false;
  } catch {
    // Minimal runtimes may not expose process.report.
  }
  return existsSync("/lib/ld-musl-x86_64.so.1") || existsSync("/lib/ld-musl-aarch64.so.1");
}

function target() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "darwin") {
    return { packageName: `@skeptic/cli-darwin-${arch}`, suffix: `darwin-${arch}` };
  }
  if (process.platform === "linux") {
    const libc = usesMusl() ? "-musl" : "";
    return { packageName: `@skeptic/cli-linux${libc}-${arch}`, suffix: `linux${libc}-${arch}` };
  }
  if (process.platform === "win32") {
    return { packageName: "@skeptic/cli-win32-x64", suffix: "win32-x64" };
  }
  throw new Error(`unsupported platform ${process.platform}-${process.arch}`);
}

function hasCompleteOptionalPackage(packageName) {
  try {
    const packageJson = require.resolve(`${packageName}/package.json`);
    const root = dirname(packageJson);
    const extension = process.platform === "win32" ? ".exe" : "";
    return binaries.every((name) => existsSync(join(root, "bin", `${name}${extension}`)));
  } catch {
    return false;
  }
}

function request(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    get(url, { headers: { "User-Agent": "skeptic-cli-installer" } }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        if (!response.headers.location || redirects >= 5) {
          reject(new Error(`invalid redirect while downloading ${url}`));
          return;
        }
        response.resume();
        request(new URL(response.headers.location, url), destination, redirects + 1).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`download returned HTTP ${response.statusCode} for ${url}`));
        return;
      }

      const output = createWriteStream(destination, { mode: 0o755 });
      response.pipe(output);
      output.on("finish", () => output.close(resolve));
      output.on("error", reject);
    }).on("error", reject);
  });
}

async function downloadText(url) {
  const chunks = [];
  await new Promise((resolve, reject) => {
    get(url, { headers: { "User-Agent": "skeptic-cli-installer" } }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        downloadText(new URL(response.headers.location, url)).then((text) => {
          chunks.push(Buffer.from(text));
          resolve();
        }, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`download returned HTTP ${response.statusCode} for ${url}`));
        return;
      }
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", resolve);
      response.on("error", reject);
    }).on("error", reject);
  });
  return Buffer.concat(chunks).toString("utf8");
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function installFallback(current) {
  const base = `https://github.com/iamjr15/skeptic/releases/download/v${packageData.version}`;
  const sums = await downloadText(`${base}/SHA256SUMS`);
  const vendor = join(packageRoot, "vendor");
  mkdirSync(vendor, { recursive: true });

  const checksumEntries = new Map(
    sums.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((entry) => entry.length >= 2).map(([sum, name]) => [name.replace(/^\*/, ""), sum]),
  );
  const extension = process.platform === "win32" ? ".exe" : "";
  for (const binary of binaries) {
    const asset = `${binary}-${current.suffix}${extension}`;
    const expected = checksumEntries.get(asset);
    if (!expected) throw new Error(`SHA256SUMS does not contain ${asset}`);
    const destination = join(vendor, `${binary}${extension}`);
    const temporary = `${destination}.tmp-${process.pid}`;
    try {
      await request(`${base}/${asset}`, temporary);
      const actual = sha256(temporary);
      if (actual !== expected.toLowerCase()) {
        throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
      }
      if (process.platform !== "win32") chmodSync(temporary, 0o755);
      if (existsSync(destination)) unlinkSync(destination);
      renameSync(temporary, destination);
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
  }
}

if (process.env.SKEPTIC_SKIP_DOWNLOAD === "1" || process.env.SKEPTIC_SKIP_DOWNLOAD === "true") {
  process.exit(0);
}

try {
  const current = target();
  if (!hasCompleteOptionalPackage(current.packageName)) await installFallback(current);
} catch (error) {
  console.error(`skeptic postinstall: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
