import { format } from "node:util";
import chalk from "chalk";
import { PRODUCT_NAME } from "../constants.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

const prefix = chalk.bold.hex("#FFD700")(`[${PRODUCT_NAME}]`);

/**
 * When non-null, every logger method writes formatted output to this stream
 * via `util.format` + `stream.write`, bypassing `console.*`. ACP server mode
 * sets this to `process.stderr` so the protocol's stdout NDJSON channel stays
 * pure. Default null = use `console.*` (which mixes stdout/stderr per method).
 */
let outputStream: NodeJS.WritableStream | null = null;

export function setStream(stream: NodeJS.WritableStream | null): void {
  outputStream = stream;
}

function emit(consoleFn: (...a: unknown[]) => void, args: unknown[]): void {
  if (outputStream) {
    outputStream.write(format(...args) + "\n");
  } else {
    consoleFn(...args);
  }
}

export const logger = {
  debug(...args: unknown[]): void {
    if (shouldLog("debug")) emit(console.debug, [chalk.gray(`${prefix}`), ...args]);
  },

  info(...args: unknown[]): void {
    if (shouldLog("info")) emit(console.log, [prefix, ...args]);
  },

  success(...args: unknown[]): void {
    if (shouldLog("info")) emit(console.log, [prefix, chalk.green("✓"), ...args]);
  },

  warn(...args: unknown[]): void {
    if (shouldLog("warn")) emit(console.warn, [prefix, chalk.yellow("⚠"), ...args]);
  },

  error(...args: unknown[]): void {
    if (shouldLog("error")) emit(console.error, [prefix, chalk.red("✗"), ...args]);
  },

  /** Print without prefix — for raw output like tables. */
  raw(...args: unknown[]): void {
    if (shouldLog("info")) emit(console.log, args);
  },

  /** Like raw(), but error-level gated and written to stderr so --quiet still shows it. */
  errorRaw(...args: unknown[]): void {
    if (shouldLog("error")) emit(console.error, args);
  },

  /** Styled step header, e.g. "Step 1/5 — Navigate to /login" */
  step(current: number, total: number, label: string): void {
    if (shouldLog("info")) {
      emit(console.log, [
        prefix,
        chalk.cyan(`Step ${current}/${total}`),
        chalk.dim("—"),
        label,
      ]);
    }
  },
};
