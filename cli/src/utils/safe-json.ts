import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const DEFAULT_MAX_STRING_LENGTH = 16_000;

const NON_SERIALIZABLE_CONSTRUCTORS = new Set([
  "Locator",
  "ElementHandle",
  "JSHandle",
  "Frame",
  "Page",
  "BrowserContext",
  "Browser",
  "CDPSession",
]);

const safeToString = (value: unknown): string => {
  try {
    return String(value);
  } catch {
    return "[unserializable]";
  }
};

export interface SafeJsonStringifyOptions {
  maxStringLength?: number;
  spaces?: number;
}

export const safeJsonStringify = (
  data: unknown,
  options: SafeJsonStringifyOptions = {},
): string => {
  const seen = new WeakSet<object>();
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
  const spaces = options.spaces ?? 2;

  return JSON.stringify(
    data,
    (_key, value: unknown) => {
      if (value === undefined) return undefined;
      if (value === null) return null;

      switch (typeof value) {
        case "bigint":
          return `${value}n`;
        case "function":
          return `[Function: ${(value as { name?: string }).name || "anonymous"}]`;
        case "symbol":
          return safeToString(value);
        case "string":
          if (value.length > maxStringLength) {
            return `${value.slice(0, maxStringLength)}... [truncated ${value.length - maxStringLength} chars]`;
          }
          return value;
        case "object":
          break;
        default:
          return value;
      }

      const objectValue = value as object;
      if (seen.has(objectValue)) return "[Circular]";
      seen.add(objectValue);

      if (Buffer.isBuffer(value)) return `[Buffer: ${value.length} bytes]`;
      if (value instanceof RegExp) return safeToString(value);
      if (value instanceof Error) {
        return {
          error: value.name,
          message: value.message,
          stack: value.stack,
        };
      }
      if (value instanceof Map) return Array.from(value.entries());
      if (value instanceof Set) return Array.from(value.values());

      const constructorName = (value as { constructor?: { name?: string } }).constructor?.name;
      if (
        typeof constructorName === "string" &&
        NON_SERIALIZABLE_CONSTRUCTORS.has(constructorName)
      ) {
        return `[${constructorName}: ${safeToString(value)}]`;
      }

      return value;
    },
    spaces,
  );
};

export const truncateText = (text: string, maxChars: number): string => {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`;
};

export const wrapContentBoundaries = (text: string, label = "skeptic-output"): string =>
  `<${label}>\n${text}\n</${label}>`;

export const writeJsonResultFile = async (
  data: unknown,
  options: { directory?: string; prefix?: string; maxStringLength?: number } = {},
): Promise<string> => {
  const directory =
    options.directory ?? path.join(os.tmpdir(), "skeptic-artifacts", "playwright-results");
  const prefix = options.prefix ?? "result";
  await mkdir(directory, { recursive: true });
  const id = crypto.randomBytes(4).toString("hex");
  const filePath = path.join(directory, `${prefix}-${id}.json`);
  await writeFile(
    filePath,
    safeJsonStringify(data, { maxStringLength: options.maxStringLength }),
    "utf-8",
  );
  return filePath;
};
