/**
 * AST-based route extraction for skeptic *.spec.ts files.
 *
 * The pre-pivot implementation walked YAML `Step[]` arrays for `navigate:`
 * URLs. B5.5 rewires the same logic against the public TS test API so coverage
 * analysis works on TypeScript specs:
 *
 *   - `await page.goto(<literal>)`            → covered URL
 *   - `await expect(page).toHaveURL(<literal>)` → covered URL (assertion)
 *   - `await ai.assert(..., { url: <literal> })` → covered URL (assertion)
 *
 * Conservative on purpose: only `ts.isStringLiteral` arguments contribute.
 * Template literals, variables, and computed paths are SKIPPED — they would
 * require evaluating arbitrary JS, which the coverage layer must not do.
 *
 * Documented limitation: dynamic URLs require an explicit
 * `test.use({ urls: ["..."] })` declaration to participate in coverage. That
 * test.use shape is reserved for a future bundle; this file only handles the
 * literal-extraction pass.
 *
 * Public types from the YAML era (`RouteIndexEntry`, `RouteCandidate`,
 * `CatchAllKind`) stay so other modules keep compiling, but the index/file
 * machinery is no longer used by the AST path.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type CatchAllKind = false | "required" | "optional";

export interface RouteIndexEntry {
  segments: string[];
  catchAll: CatchAllKind;
  file: string;
  layoutFiles?: string[];
}

export interface RouteCandidate {
  url: string;
  files: string[];
}

/**
 * Extract literal URL arguments from a *.spec.ts source string.
 *
 * Recognised call shapes (both bare and inside `await`):
 *   page.goto("/foo")
 *   <anyExpr>.goto("/foo")             — `tree.goto`, `ctx.page.goto`, etc.
 *   expect(<anyExpr>).toHaveURL("/foo")
 *   ai.assert(<anything>, { url: "/foo" })
 *
 * Returns the raw literal strings in source order, deduplicated. Non-string
 * arguments (template literals, identifiers, member expressions) are skipped
 * silently — that's the documented "dynamic URL" path.
 */
export const extractRouteUrlsFromSource = async (
  source: string,
  fileName = "spec.ts",
): Promise<string[]> => {
  const ts = await import("typescript");
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );

  const out: string[] = [];
  const seen = new Set<string>();

  const pushLiteral = (node: import("typescript").Node | undefined): void => {
    if (!node || !ts.isStringLiteral(node)) return;
    const v = node.text;
    if (v.length === 0) return;
    if (seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };

  const visit = (node: import("typescript").Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;

      // <expr>.goto(<literal>)
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.name) &&
        callee.name.text === "goto"
      ) {
        pushLiteral(node.arguments[0]);
      }

      // expect(<expr>).toHaveURL(<literal>)
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.name) &&
        callee.name.text === "toHaveURL" &&
        ts.isCallExpression(callee.expression)
      ) {
        const inner = callee.expression;
        if (
          ts.isIdentifier(inner.expression) &&
          inner.expression.text === "expect"
        ) {
          pushLiteral(node.arguments[0]);
        }
      }

      // ai.assert(<anything>, { url: <literal>, ... })
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "ai" &&
        ts.isIdentifier(callee.name) &&
        callee.name.text === "assert"
      ) {
        const optsArg = node.arguments[1];
        if (optsArg && ts.isObjectLiteralExpression(optsArg)) {
          for (const prop of optsArg.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              ((ts.isIdentifier(prop.name) && prop.name.text === "url") ||
                (ts.isStringLiteral(prop.name) && prop.name.text === "url"))
            ) {
              pushLiteral(prop.initializer);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return out;
};

/**
 * Read a *.spec.ts off disk and extract its literal URL arguments. Returns
 * an empty array if the file can't be read.
 */
export const extractRouteUrlsFromFile = async (
  absPath: string,
): Promise<string[]> => {
  let source: string;
  try {
    source = fs.readFileSync(absPath, "utf-8");
  } catch {
    return [];
  }
  return extractRouteUrlsFromSource(source, path.basename(absPath));
};

/**
 * Pre-pivot helper kept as a stub. The B5.5 coverage builder no longer uses
 * a route-segment index — the AST extractor returns URLs directly. Throws
 * to surface accidental callers of the old API.
 */
export const buildRouteIndex = (
  _files: string[],
): Map<string, RouteIndexEntry[]> => {
  throw new Error(
    "[skeptic] buildRouteIndex is removed in the TS-pivot — coverage walks *.spec.ts AST via extractRouteUrlsFromFile.",
  );
};

/**
 * Pre-pivot helper kept as a stub for the same reason as `buildRouteIndex`.
 */
export const collectNavigateUrls = (_steps: unknown[]): string[] => {
  throw new Error(
    "[skeptic] collectNavigateUrls is removed in the TS-pivot — coverage walks *.spec.ts AST via extractRouteUrlsFromFile.",
  );
};

export const resolveRoutesForFlow = (
  _flow: unknown,
  _index: Map<string, RouteIndexEntry[]>,
): RouteCandidate[] => {
  throw new Error(
    "[skeptic] resolveRoutesForFlow is removed in the TS-pivot — coverage walks *.spec.ts AST via extractRouteUrlsFromFile.",
  );
};
