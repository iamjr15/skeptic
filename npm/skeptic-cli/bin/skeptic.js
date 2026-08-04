#!/usr/bin/env node

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function usesMusl() {
  if (process.platform !== "linux") return false;

  try {
    const report = process.report?.getReport();
    if (report?.header?.glibcVersionRuntime) return false;
  } catch {
    // Fall through to the loader check used by minimal Linux images.
  }

  return (
    existsSync("/lib/ld-musl-x86_64.so.1") ||
    existsSync("/lib/ld-musl-aarch64.so.1")
  );
}

function target() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";

  if (process.platform === "darwin") {
    return { packageName: `@skeptic/cli-darwin-${arch}` };
  }

  if (process.platform === "linux") {
    const libc = usesMusl() ? "-musl" : "";
    return {
      packageName: `@skeptic/cli-linux${libc}-${arch}`,
    };
  }

  if (process.platform === "win32") {
    // Windows ARM64 runs x64 executables through the OS compatibility layer.
    return { packageName: "@skeptic/cli-win32-x64" };
  }

  throw new Error(`Skeptic does not publish a binary for ${process.platform}-${process.arch}`);
}

function optionalPackageBinary(packageName) {
  try {
    const packageJson = require.resolve(`${packageName}/package.json`);
    const packageData = JSON.parse(readFileSync(packageJson, "utf8"));
    const binaryName = process.platform === "win32" ? "skeptic.exe" : "skeptic";
    const binary = join(dirname(packageJson), packageData.skepticBinary ?? `bin/${binaryName}`);
    return existsSync(binary) ? binary : undefined;
  } catch {
    return undefined;
  }
}

function resolveBinary() {
  if (process.env.SKEPTIC_BINARY_PATH) return process.env.SKEPTIC_BINARY_PATH;

  const current = target();
  const packaged = optionalPackageBinary(current.packageName);
  if (packaged) return packaged;

  const binaryName = process.platform === "win32" ? "skeptic.exe" : "skeptic";
  const downloaded = join(packageRoot, "vendor", binaryName);
  if (existsSync(downloaded)) return downloaded;

  throw new Error(
    `No Skeptic binary found for ${process.platform}-${process.arch}. ` +
      `Reinstall with lifecycle scripts enabled, or install ${current.packageName}.`,
  );
}

try {
  const result = spawnSync(resolveBinary(), process.argv.slice(2), {
    stdio: "inherit",
    env: process.env,
    windowsHide: false,
  });

  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  process.exit(result.status ?? 10);
} catch (error) {
  console.error(`skeptic: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(6);
}
