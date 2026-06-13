import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Injectable runner for the two iOS-simulator host tools — `simctl` (lifecycle /
 * screenshot / video / deep-links / logs) and `axe` (the maintained idb-framework
 * redistribution: accessibility tree + HID tap/type/swipe). Both need a FULL Xcode
 * (`xcode-select -p` honors the `DEVELOPER_DIR` env var, so we don't need sudo even
 * when the active developer dir is Command Line Tools). All sim interaction goes
 * through this one seam so the parse/resolve/action logic is unit-testable.
 */
export interface IosTools {
  /** Run `simctl <args...>` and resolve stdout (utf8). */
  simctl(args: string[], timeoutMs?: number): Promise<string>;
  /** Run `axe <args...>` and resolve stdout (utf8). */
  axe(args: string[], timeoutMs?: number): Promise<string>;
}

export interface IosToolsOptions {
  developerDir?: string;
  simctlPath?: string;
  axePath?: string;
  timeoutMs?: number;
}

/** A full Xcode developer dir (NOT Command Line Tools, which lacks simctl). */
export const resolveDeveloperDir = (override?: string): string | undefined => {
  const candidates = [
    override,
    process.env["DEVELOPER_DIR"],
    "/Applications/Xcode.app/Contents/Developer",
    "/Applications/Xcode-beta.app/Contents/Developer",
  ];
  for (const c of candidates) {
    if (c && existsSync(`${c}/usr/bin/simctl`)) return c;
  }
  return undefined;
};

const firstExisting = (...paths: Array<string | undefined>): string | undefined =>
  paths.find((p) => p && existsSync(p));

export const createIosTools = (opts: IosToolsOptions = {}): IosTools => {
  const developerDir = resolveDeveloperDir(opts.developerDir);
  const simctlBin =
    opts.simctlPath ??
    firstExisting(developerDir ? `${developerDir}/usr/bin/simctl` : undefined) ??
    "simctl";
  const axeBin = findAxeBinary(opts.axePath);
  const timeout = opts.timeoutMs ?? 30_000;
  // axe's vendored idb frameworks read `xcode-select -p`, which honors DEVELOPER_DIR;
  // setting it lets both tools find a full Xcode without `sudo xcode-select -s`.
  const env = { ...process.env, ...(developerDir ? { DEVELOPER_DIR: developerDir } : {}) };

  const run = (bin: string, args: string[], timeoutMs?: number): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { timeout: timeoutMs ?? timeout, maxBuffer: 64 * 1024 * 1024, encoding: "utf8", env },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`${bin} ${args.join(" ")} failed: ${err.message}${stderr ? ` — ${String(stderr).slice(0, 400)}` : ""}`));
            return;
          }
          resolve(stdout);
        },
      );
    });

  return {
    simctl: (args, timeoutMs) => run(simctlBin, args, timeoutMs),
    axe: (args, timeoutMs) => run(axeBin, args, timeoutMs),
  };
};

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  runtime: string;
}

/** Booted iOS simulators via `simctl list devices booted -j`. */
export const listBootedSimulators = async (opts: IosToolsOptions = {}): Promise<SimDevice[]> => {
  const tools = createIosTools(opts);
  const raw = await tools.simctl(["list", "devices", "booted", "-j"]).catch(() => "");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { devices: Record<string, Array<{ udid: string; name: string; state: string }>> };
    const out: SimDevice[] = [];
    for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
      for (const d of devices) {
        if (d.state === "Booted") out.push({ udid: d.udid, name: d.name, state: d.state, runtime: runtime.split(".").pop() ?? runtime });
      }
    }
    return out;
  } catch {
    return [];
  }
};

/** Resolve the `axe` binary (brew default locations, else bare `axe` on PATH). */
export const findAxeBinary = (override?: string): string =>
  override ?? firstExisting("/opt/homebrew/bin/axe", "/usr/local/bin/axe") ?? "axe";

const onPath = (bin: string): boolean =>
  (process.env["PATH"] ?? "").split(":").some((d) => d && existsSync(join(d, bin)));

/** True when `axe` is installed — an explicit `override` path must exist; otherwise
 *  check the brew locations and PATH. */
export const axeAvailable = (override?: string): boolean => {
  if (override) return existsSync(override);
  return firstExisting("/opt/homebrew/bin/axe", "/usr/local/bin/axe") !== undefined || onPath("axe");
};

/** True when a full Xcode (with simctl) is resolvable — gates `--platform ios-sim`. */
export const isIosSimAvailable = (): boolean => process.platform === "darwin" && resolveDeveloperDir() !== undefined;

/**
 * Preflight for `--platform ios-sim`: throws an ACTIONABLE error (not a raw ENOENT)
 * when the host is missing the externally-installed tools the driver shells out to.
 * Called at driver creation so `run`/`open`/`scaffold` all fail with the fix.
 */
export const assertIosSimReady = (opts: { axePath?: string; developerDir?: string } = {}): void => {
  if (process.platform !== "darwin") {
    throw new Error("[ios-sim] --platform ios-sim is macOS-only.");
  }
  if (!resolveDeveloperDir(opts.developerDir)) {
    throw new Error(
      "[ios-sim] no full Xcode found — --platform ios-sim needs Xcode (Command Line Tools lack simctl). " +
        "Install Xcode, then `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` or set DEVELOPER_DIR.",
    );
  }
  if (!axeAvailable(opts.axePath)) {
    throw new Error(
      "[ios-sim] the `axe` tool is required for iOS UI automation but isn't installed. " +
        "Install it: `brew install cameroncooke/axe/axe`  (`skeptic doctor` checks this).",
    );
  }
};
