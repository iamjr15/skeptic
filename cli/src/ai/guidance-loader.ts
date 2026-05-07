import * as fs from "node:fs";
import * as path from "node:path";
import { findSimilar } from "../utils/levenshtein.js";
import { logger } from "../utils/logger.js";
import { readTemplate } from "../utils/asset-path.js";

export const GUIDANCE_DOMAINS = [
  "animation",
  "accessibility",
  "performance",
  "design",
  "security",
  "seo",
  "responsive",
  "react",
] as const;

export type GuidanceDomain = (typeof GUIDANCE_DOMAINS)[number];

export interface GuidanceLoadResult {
  domain: GuidanceDomain;
  /** "builtin" or the absolute path to a user-supplied override. */
  source: "builtin" | string;
  /** Raw markdown body (frontmatter included). */
  content: string;
}

export const isGuidanceDomain = (s: string): s is GuidanceDomain =>
  (GUIDANCE_DOMAINS as readonly string[]).includes(s);

/**
 * Walk up from `from` looking for `.skeptic/guidance/<domain>.md`.
 * Returns the absolute path if found, else null. Mirrors findConfigFile.
 */
function findUserGuidance(from: string, domain: string): string | null {
  let dir = path.resolve(from);
  const root = path.parse(dir).root;
  while (dir !== root) {
    const candidate = path.join(dir, ".skeptic", "guidance", `${domain}.md`);
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

export interface LoadGuidanceOptions {
  /** Starting dir for user-override walk-up; defaults to process.cwd(). */
  cwd?: string;
}

export function loadGuidance(
  domain: string,
  opts: LoadGuidanceOptions = {},
): GuidanceLoadResult {
  if (!isGuidanceDomain(domain)) {
    const suggestions = findSimilar(domain, GUIDANCE_DOMAINS);
    const hint =
      suggestions.length === 1
        ? ` Did you mean '${suggestions[0]}'?`
        : suggestions.length > 1
          ? ` Did you mean one of: ${suggestions.join(", ")}?`
          : "";
    throw new Error(
      `Unknown guidance domain '${domain}'.${hint} Available: ${GUIDANCE_DOMAINS.join(", ")}`,
    );
  }

  const override = findUserGuidance(opts.cwd ?? process.cwd(), domain);
  if (override) {
    // Visibility: overrides feed the AI `system` prompt — warn every time.
    logger.warn(`Using guidance override: ${override} (builtin superseded)`);
    return { domain, source: override, content: fs.readFileSync(override, "utf-8") };
  }

  try {
    return {
      domain,
      source: "builtin",
      content: readTemplate(`guidance/${domain}.md`).toString("utf-8"),
    };
  } catch {
    throw new Error(
      `Bundled guidance missing: guidance/${domain}.md — run 'npm run build' in cli/`,
    );
  }
}
