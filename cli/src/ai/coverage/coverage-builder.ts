/**
 * Build a coverage report by walking *.spec.ts files in a project and
 * extracting the literal URLs each spec navigates to or asserts against.
 *
 * The output shape (`coveredBy`: changed-file → spec[] map) is preserved from
 * the YAML era so downstream consumers (`coverage-prompt.ts`, the diff-aware
 * generate flow) work unchanged. The "covered" relation is now: a spec covers
 * a changed UI file if its extracted URLs include a path that matches the
 * file's route. The matcher is intentionally lossy — pathname overlap is
 * treated as evidence; this is a hint, not a proof.
 *
 * Documented limitation: coverage misses dynamic URLs. A spec that does
 * `await page.goto(\`/users/\${id}\`)` produces NO covered URLs from this
 * walker. Document escape hatch: declare `test.use({ urls: ["..."] })`
 * (reserved for a future bundle).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import fastGlob from "fast-glob";
import { extractRouteUrlsFromFile } from "./route-resolver.js";

export interface CoverageReport {
  /** Absolute changed-file path → list of absolute spec paths that "cover" it. */
  coveredBy: Map<string, string[]>;
  /** All spec files scanned. */
  allFiles: string[];
  /** True when at least one *.spec.ts was found. Mirrors the YAML-era flag. */
  hasFlows: boolean;
}

export interface BuildCoverageReportOptions {
  projectRoot: string;
  /** Glob (or list) for *.spec.ts files. Falls back to "**\/*.spec.ts". */
  flowGlob: string | string[];
  configDir?: string;
  baseUrl?: string;
  excludePaths?: string[];
}

const SPEC_IGNORE = ["**/node_modules/**", "**/dist/**", "**/.skeptic/**"];

/** Best-effort pathname extractor: strips origin from full URLs, leaves relative paths. */
const toPathname = (raw: string, baseUrl?: string): string | null => {
  if (raw.length === 0) return null;
  try {
    const url = new URL(raw, baseUrl ?? "http://localhost");
    return url.pathname || "/";
  } catch {
    return raw.startsWith("/") ? raw : `/${raw}`;
  }
};

/**
 * Heuristic: does spec URL `urlPath` plausibly cover changed file `relFile`?
 *
 * The route map for arbitrary frameworks (Next.js, Remix, etc.) is out of
 * scope post-pivot. We use a lossy substring match: the file's basename
 * (sans extension, sans `index`) appears in the URL pathname, OR the URL
 * is "/" and the file is a top-level route entry. False positives are
 * preferred over missed coverage at this layer.
 */
const matchesFile = (urlPath: string, relFile: string): boolean => {
  const lower = urlPath.toLowerCase();
  const baseRaw = path.basename(relFile, path.extname(relFile)).toLowerCase();
  const base = baseRaw === "index" || baseRaw === "page" ? "" : baseRaw;

  if (base.length === 0) {
    // Top-level page: match only against "/" so we don't blanket-match every spec.
    return lower === "/" || lower === "";
  }
  // Substring match against URL segments — `/products/list` covers `productsList.tsx`.
  return lower.includes(base);
};

/**
 * Walk every *.spec.ts under `projectRoot`, extract literal URLs, and build
 * the changed-file → spec[] map. The set of "changed files" is taken from
 * the project's source tree (filtered to UI-ish extensions) so unchanged
 * callers can still ask "what's covered?". Real diff filtering happens in
 * the generate.ts pipeline before formatCoverageSection runs.
 */
export const buildCoverageReport = async (
  opts: BuildCoverageReportOptions,
): Promise<CoverageReport> => {
  const { projectRoot, baseUrl } = opts;
  const patterns = Array.isArray(opts.flowGlob) ? opts.flowGlob : [opts.flowGlob];
  const specFiles = await fastGlob(patterns, {
    cwd: projectRoot,
    absolute: true,
    onlyFiles: true,
    ignore: SPEC_IGNORE,
  });

  const coveredBy = new Map<string, string[]>();

  if (specFiles.length === 0) {
    return { coveredBy, allFiles: [], hasFlows: false };
  }

  // Pre-extract URLs for every spec (one AST walk each).
  const specUrls = new Map<string, string[]>();
  for (const spec of specFiles) {
    const urls = await extractRouteUrlsFromFile(spec);
    const paths = urls
      .map((u) => toPathname(u, baseUrl))
      .filter((u): u is string => u !== null);
    specUrls.set(spec, paths);
  }

  // Listing UI-ish files in the project gives the universe of potential
  // "covered" targets. Callers (generate.ts) intersect this with the diff
  // to focus on changed files; we keep the map dense for that.
  const projectFiles = await fastGlob(
    ["**/*.tsx", "**/*.jsx", "**/*.ts", "**/*.js"],
    {
      cwd: projectRoot,
      absolute: true,
      onlyFiles: true,
      ignore: [
        ...SPEC_IGNORE,
        "**/*.spec.ts",
        "**/*.test.ts",
        "**/*.d.ts",
        "**/*.config.*",
      ],
    },
  );

  for (const abs of projectFiles) {
    if (!fs.existsSync(abs)) continue;
    const rel = path.relative(projectRoot, abs);
    const matchingSpecs: string[] = [];
    for (const [spec, urls] of specUrls) {
      if (urls.some((u) => matchesFile(u, rel))) {
        matchingSpecs.push(spec);
      }
    }
    if (matchingSpecs.length > 0) {
      coveredBy.set(abs, matchingSpecs);
    }
  }

  return { coveredBy, allFiles: specFiles, hasFlows: true };
};
