import { execFile } from "node:child_process";

/**
 * Injectable adb command runner. The default shells out to the real `adb`; tests
 * inject a stub. All device interaction in the Android driver goes through this
 * one seam so the snapshot/resolve/action logic is unit-testable without a device.
 */
export interface Adb {
  /** Run `adb -s <serial> <args...>` and resolve stdout (utf8). Rejects on non-zero exit. */
  text(args: string[]): Promise<string>;
  /** Run and resolve raw stdout bytes (for screencap PNGs). */
  bytes(args: string[]): Promise<Buffer>;
}

export interface AdbOptions {
  serial: string;
  adbPath?: string;
  /** Per-command timeout, ms. */
  timeoutMs?: number;
}

const resolveAdbPath = (override?: string): string => {
  if (override) return override;
  const home = process.env["ANDROID_HOME"] ?? process.env["ANDROID_SDK_ROOT"];
  if (home) return `${home}/platform-tools/adb`;
  return "adb";
};

export const createAdb = (opts: AdbOptions): Adb => {
  const bin = resolveAdbPath(opts.adbPath);
  const timeout = opts.timeoutMs ?? 15_000;
  const base = ["-s", opts.serial];

  const run = (args: string[], encoding: "utf8" | "buffer"): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      execFile(
        bin,
        [...base, ...args],
        { timeout, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
        (err, stdout) => {
          if (err) {
            reject(new Error(`adb ${args.join(" ")} failed: ${err.message}`));
            return;
          }
          resolve(stdout as Buffer);
        },
      );
      void encoding;
    });

  return {
    text: async (args) => (await run(args, "utf8")).toString("utf8"),
    bytes: (args) => run(args, "buffer"),
  };
};

/** `adb shell input text` is ASCII-only; reject anything that needs more. */
export const isAsciiInput = (text: string): boolean => /^[\x20-\x7e]*$/.test(text);

/** Escape a string for `adb shell input text` (spaces → %s, shell metachars). */
export const escapeInputText = (text: string): string =>
  text
    .replace(/(["\\$`])/g, "\\$1")
    .replace(/ /g, "%s")
    .replace(/[()<>|;&*~^]/g, "\\$&");

/** List attached devices+emulators with state. */
export const listDevices = async (adbPath?: string): Promise<Array<{ serial: string; state: string }>> => {
  const bin = resolveAdbPath(adbPath);
  const out = await new Promise<string>((resolve, reject) => {
    execFile(bin, ["devices"], { timeout: 10_000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
  return out
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [serial, state] = l.split(/\s+/);
      return { serial: serial ?? "", state: state ?? "unknown" };
    })
    .filter((d) => d.serial);
};
