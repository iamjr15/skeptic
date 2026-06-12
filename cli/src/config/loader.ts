import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { skepticConfigSchema, CONFIG_FILENAME } from "./schema.js";
import type { skepticConfig } from "./schema.js";
import { interpolateEnvDeep } from "../utils/env.js";
import { logger } from "../utils/logger.js";

export interface LoadConfigOptions {
  /** Explicit path to config file (overrides search). */
  configPath?: string;
  /** CLI overrides merged on top of file config. */
  overrides?: Record<string, unknown>;
  /**
   * Override the directory from which the upward walk-up starts when no
   * `configPath` is provided. Defaults to `process.cwd()`.
   *
   * Used by long-lived servers (ACP) that load config relative to a session's
   * working directory without mutating `process.cwd()`. Ignored when
   * `configPath` is set.
   */
  searchCwd?: string;
}

export interface LoadConfigResult {
  config: skepticConfig;
  /** Absolute path to the resolved config file, or null if none was found. */
  configPath: string | null;
}

/**
 * Load and validate skeptic.config.yaml, returning both the parsed config and
 * the absolute path it was loaded from. Used by commands that need to anchor
 * relative paths (globs, guidance overrides) to the config file's directory.
 */
export function loadConfigWithMeta(opts: LoadConfigOptions = {}): LoadConfigResult {
  const filePath: string | null = opts.configPath
    ? path.resolve(opts.configPath)
    : findConfigFile(opts.searchCwd ?? process.cwd());
  let raw: Record<string, unknown> = {};

  if (filePath) {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed: unknown = parseYaml(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
    logger.debug(`Loaded config from ${filePath}`);
  } else {
    logger.debug("No config file found, using defaults");
  }

  // Apply SKEPTIC_* env var overrides
  raw = applyEnvOverrides(raw);

  // Merge CLI overrides
  if (opts.overrides) {
    raw = deepMerge(raw, opts.overrides);
  }

  // Interpolate env vars
  const interpolated = interpolateEnvDeep(raw) as Record<string, unknown>;

  // Validate + apply defaults
  const result = skepticConfigSchema.safeParse(interpolated);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config in ${filePath ?? CONFIG_FILENAME}:\n${issues}`);
  }

  return { config: result.data, configPath: filePath };
}

/**
 * Load and validate skeptic.config.yaml.
 *
 * Precedence (highest wins):
 *   1. CLI flags (overrides)
 *   2. SKEPTIC_* environment variables
 *   3. Config file values
 *   4. Schema defaults
 *
 * Environment variable interpolation runs on the raw YAML before validation.
 */
export function loadConfig(opts: LoadConfigOptions = {}): skepticConfig {
  return loadConfigWithMeta(opts).config;
}

/**
 * Apply SKEPTIC_* environment variable overrides to raw config.
 *
 *   SKEPTIC_URL → url
 *   SKEPTIC_TIMEOUT → browser.timeout
 *   SKEPTIC_HEADED → browser.headless = false
 *   SKEPTIC_COOKIES → auth.cookies = true
 */
function applyEnvOverrides(raw: Record<string, unknown>): Record<string, unknown> {
  const result = { ...raw };

  const urlOverride = process.env["SKEPTIC_URL"];
  if (urlOverride) {
    result["url"] = urlOverride;
  }

  const timeoutStr = process.env["SKEPTIC_TIMEOUT"];
  if (timeoutStr) {
    const timeout = Number(timeoutStr);
    if (!Number.isNaN(timeout)) {
      const browser = (result["browser"] ?? {}) as Record<string, unknown>;
      result["browser"] = { ...browser, timeout };
    }
  }

  if (process.env["SKEPTIC_HEADED"]) {
    const browser = (result["browser"] ?? {}) as Record<string, unknown>;
    result["browser"] = { ...browser, headless: false };
  }

  if (process.env["SKEPTIC_COOKIES"]) {
    const auth = (result["auth"] ?? {}) as Record<string, unknown>;
    result["auth"] = { ...auth, cookies: true };
  }

  return result;
}

/** Walk up from cwd to find the config file. */
function findConfigFile(from: string): string | null {
  let dir = path.resolve(from);
  const root = path.parse(dir).root;

  while (dir !== root) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

/** Deep merge b into a (b wins). */
function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...a };
  for (const [key, val] of Object.entries(b)) {
    const existing = result[key];
    if (
      val &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      result[key] = deepMerge(
        existing as Record<string, unknown>,
        val as Record<string, unknown>,
      );
    } else {
      result[key] = val;
    }
  }
  return result;
}
