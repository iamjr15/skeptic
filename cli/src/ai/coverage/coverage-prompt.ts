import * as path from "node:path";
import type { CoverageReport } from "./coverage-builder.js";

/**
 * Extract the absolute paths of files mentioned in a unified-diff string.
 * The "b/" path (target side, post-diff) is the canonical file location; resolve relative
 * to projectRoot so the result lines up with absolute paths from the import graph.
 */
export function extractDiffPaths(diff: string, projectRoot: string): string[] {
  const lines = diff.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m && m[2]) out.push(path.resolve(projectRoot, m[2]));
  }
  return out;
}

/**
 * Filter changed files to UI-rendering ones.
 *
 * Heuristic — matches `.tsx|jsx|ts|js` extensions but excludes API handlers, config,
 * type declarations, tests, and specs (files the LLM can't generate browser flows against).
 */
export function isUIFile(absPath: string): boolean {
  const base = path.basename(absPath);
  if (/\.(api|config|d|test|spec)\.[tj]sx?$/.test(base)) return false;
  return /\.(tsx|jsx|ts|js)$/.test(absPath);
}

/**
 * Render the coverage section that's appended to the diff in the AI prompt.
 *
 * Emits a percentage header, one `[covered]`/`[no test]` line per changed file, and a closing
 * directive telling the LLM to prioritize uncovered files. Paths are relativized against `cwd`
 * for readability — flow file paths have a leading `./` stripped so the LLM sees clean paths.
 */
export function formatCoverageSection(
  report: CoverageReport,
  changedFiles: string[],
  cwd: string = process.cwd(),
): string {
  const lines: string[] = [];
  let coveredCount = 0;
  for (const file of changedFiles) {
    const flows = report.coveredBy.get(file);
    const rel = path.relative(cwd, file);
    if (flows && flows.length > 0) {
      coveredCount++;
      const flowRels = flows.map((f) => path.relative(cwd, f));
      lines.push(`[covered] ${rel} (tested by: ${flowRels.join(", ")})`);
    } else {
      lines.push(`[no test] ${rel}`);
    }
  }
  const total = changedFiles.length;
  const pct = total > 0 ? Math.round((coveredCount / total) * 100) : 0;
  const header = `## Coverage of changed files\n\nTest coverage of changed files: ${pct}% (${coveredCount}/${total} files have flows)\n`;
  const directive =
    "\n**Prioritize generating flows for `[no test]` files. Skip files already covered unless the diff exposes new edge cases.**";
  return `${header}\n${lines.join("\n")}${directive}`;
}
