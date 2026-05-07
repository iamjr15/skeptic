import { execFileSync } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { minimatch } from "minimatch";
import type { ResolverFactory as ResolverFactoryType } from "oxc-resolver";
import { matchExcludePath } from "../security.js";

let cachedResolverFactory: typeof ResolverFactoryType | null = null;
function getResolverFactory(): typeof ResolverFactoryType {
  if (cachedResolverFactory) return cachedResolverFactory;
  const req = createRequire(import.meta.url);
  const mod = req("oxc-resolver") as { ResolverFactory: typeof ResolverFactoryType };
  cachedResolverFactory = mod.ResolverFactory;
  return cachedResolverFactory;
}

/**
 * Static import graph: for each project source file, the set of project-internal files it imports.
 *
 * Lossy by design — regex extraction misses dynamic imports and conditional re-exports. The graph
 * is a coverage *hint*, not a correctness layer.
 */
export interface ImportGraph {
  /** Absolute source file path → list of absolute paths it imports (resolved, project-internal only). */
  edges: Map<string, string[]>;
  /** All files scanned, post-filter. Stable across calls in a single coverage build. */
  files: string[];
}

/**
 * Glob patterns excluded from the directory walker by default. Merged with caller-supplied opts.ignore.
 *
 * Patterns are matched via minimatch on project-root-relative paths, NOT substring contains —
 * `node_modules-test/foo.ts` must NOT match `**\/node_modules/**`.
 */
export const DEFAULT_IGNORE_PATTERNS: string[] = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/out/**",
  "**/.skeptic/**",
  "**/.git/**",
  "**/coverage/**",
];

const DEFAULT_EXTENSIONS: string[] = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
];

const IMPORT_PATTERNS: RegExp[] = [
  // ES module: import x from "y"; import { x } from "y"; import * as x from "y"; bare side-effect import "y"
  /\bimport\s+(?:[\w$*\s,{}]+\s+from\s+)?['"`]([^'"`]+)['"`]/g,
  // CommonJS: const x = require("y")
  /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  // Re-exports: export { x } from "y"; export * from "y";
  /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"`]([^'"`]+)['"`]/g,
];

const BUILTIN_MODULES = new Set<string>(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);

export interface BuildImportGraphOptions {
  extensions?: string[];
  /** Extra glob patterns merged with DEFAULT_IGNORE_PATTERNS for the directory walker. */
  ignore?: string[];
  /** ai.excludePaths — applied via the shared matchExcludePath helper for parity with diff filtering. */
  excludePaths?: string[];
}

export async function buildImportGraph(
  projectRoot: string,
  opts: BuildImportGraphOptions = {},
): Promise<ImportGraph> {
  const extensions = opts.extensions ?? DEFAULT_EXTENSIONS;
  const ignorePatterns = [...DEFAULT_IGNORE_PATTERNS, ...(opts.ignore ?? [])];
  const excludePaths = opts.excludePaths ?? [];

  const tsconfigPath = findTsconfig(projectRoot);
  const ResolverFactory = getResolverFactory();
  const resolver = new ResolverFactory({
    tsconfig: tsconfigPath
      ? { configFile: tsconfigPath, references: "auto" }
      : undefined,
    extensions,
    mainFields: ["module", "main"],
    conditionNames: ["import", "require", "default"],
    // Keep symlinked paths intact so resolver output matches the file-listing path strings
    // (git ls-files / readdirSync don't realpath, e.g. macOS /var/folders/... vs /private/var/...).
    symlinks: false,
  });

  const walkerFiles = listProjectFiles(projectRoot, extensions, ignorePatterns);
  const files = walkerFiles.filter(
    (abs) => !matchExcludePath(toPosix(path.relative(projectRoot, abs)), excludePaths),
  );
  // Edge resolution checks fileSet so an excluded file cannot re-enter the graph as someone
  // else's import target. Without this, src/page.tsx → src/secrets/foo.ts edges would still be
  // recorded even though src/secrets/foo.ts was excluded from `files`.
  const fileSet = new Set(files);
  const resolveCache = new Map<string, string | null>();

  const edges = new Map<string, string[]>();
  for (const file of files) {
    const content = readFileSafe(file);
    if (content === null) {
      edges.set(file, []);
      continue;
    }
    const specifiers = extractImportSpecifiers(content);
    const resolved: string[] = [];
    const seen = new Set<string>();
    const dir = path.dirname(file);
    for (const spec of specifiers) {
      if (BUILTIN_MODULES.has(spec)) continue;
      // Try to resolve EVERYTHING — `@/foo`, `@components/Button`, `src/utils`, `#imports`,
      // bare `react` — and filter post-resolve. Skipping non-relative specifiers up front
      // would drop tsconfig-paths and PackageJson `imports` entries.
      const cacheKey = `${dir}\0${spec}`;
      let target = resolveCache.get(cacheKey) ?? null;
      if (!resolveCache.has(cacheKey)) {
        try {
          target = resolver.sync(dir, spec).path ?? null;
        } catch {
          target = null;
        }
        resolveCache.set(cacheKey, target);
      }
      if (!target) continue;
      if (target.includes(`${path.sep}node_modules${path.sep}`)) continue;
      const relTarget = path.relative(projectRoot, target);
      if (relTarget.startsWith("..") || path.isAbsolute(relTarget)) continue;
      if (!fileSet.has(target)) continue;
      if (seen.has(target)) continue;
      seen.add(target);
      resolved.push(target);
    }
    edges.set(file, resolved);
  }

  return { edges, files };
}

/**
 * Compute the set of files transitively reachable from `starts`, following forward edges.
 * Used both for "from this entry point, what does it pull in?" (forward) and, against
 * `reverseGraph(...)`, "what files reach this changed file?" (backward, see `getReachableReverse`).
 *
 * Cycles are handled by the visited set — same shape as Expect's getTransitiveDependencies.
 */
export function getReachable(graph: ImportGraph, starts: string[]): Set<string> {
  const visited = new Set<string>();
  const stack = [...starts];
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (visited.has(f)) continue;
    visited.add(f);
    const out = graph.edges.get(f);
    if (out) stack.push(...out);
  }
  return visited;
}

export function reverseGraph(graph: ImportGraph): Map<string, string[]> {
  const rev = new Map<string, string[]>();
  for (const [from, tos] of graph.edges) {
    for (const to of tos) {
      const arr = rev.get(to);
      if (arr) arr.push(from);
      else rev.set(to, [from]);
    }
  }
  return rev;
}

export function getReachableReverse(
  rev: Map<string, string[]>,
  starts: string[],
): Set<string> {
  const visited = new Set<string>();
  const stack = [...starts];
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (visited.has(f)) continue;
    visited.add(f);
    const out = rev.get(f);
    if (out) stack.push(...out);
  }
  return visited;
}

function listProjectFiles(
  root: string,
  extensions: string[],
  ignore: string[],
): string[] {
  const filterByIgnore = (relPosix: string): boolean =>
    !ignore.some((pattern) => minimatch(relPosix, pattern, { dot: true }));

  try {
    const out = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      {
        cwd: root,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return out
      .split("\n")
      .filter(Boolean)
      .filter((rel) => extensions.includes(path.extname(rel)))
      .filter((rel) => filterByIgnore(toPosix(rel)))
      .map((rel) => path.resolve(root, rel));
  } catch {
    return walkDir(root, extensions, ignore);
  }
}

function walkDir(root: string, exts: string[], ignore: string[]): string[] {
  const isIgnored = (relPosix: string): boolean =>
    ignore.some((pattern) => minimatch(relPosix, pattern, { dot: true }));

  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      const rel = toPosix(path.relative(root, full));
      if (isIgnored(rel)) continue;
      if (e.isDirectory()) {
        stack.push(full);
      } else if (exts.includes(path.extname(e.name))) {
        out.push(full);
      }
    }
  }
  return out;
}

function findTsconfig(root: string): string | null {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readFileSafe(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

function extractImportSpecifiers(content: string): string[] {
  const out: string[] = [];
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const spec = m[1];
      if (spec) out.push(spec);
    }
  }
  return out;
}

function toPosix(p: string): string {
  return path.sep === "/" ? p : p.split(path.sep).join("/");
}
