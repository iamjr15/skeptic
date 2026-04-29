/**
 * Shared spec-validation helpers for the MCP `validate_tests` and ACP
 * `validate` dispatch paths. The validation has two layers:
 *
 *   1. tsx-import sanity — surfaces module-level crashes (syntax errors, top-
 *      level throws, missing imports). Run via the runner's `discover()` pass.
 *   2. TypeScript compiler API typecheck — surfaces type errors that don't
 *      block imports. Uses the project's `tsconfig.json` when present, otherwise
 *      a permissive default mirroring `cli/templates/tsconfig.json`.
 *
 * Both MCP and ACP call into these helpers so users see the same error set
 * regardless of which transport they're driving the server through.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface SpecValidateDiagnostic {
  file: string;
  line?: number;
  column?: number;
  code?: number | string;
  category: "error" | "warning" | "import";
  message: string;
}

export interface SpecValidateFileResult {
  file: string;
  status: "ok" | "error";
  diagnostics: SpecValidateDiagnostic[];
}

/**
 * Typecheck a set of spec files using the TypeScript compiler API. Returns
 * per-file diagnostics. The `import` category covers cases where the compiler
 * couldn't read a file (missing path / non-spec).
 *
 * Diagnostics from upstream lib files (when skipLibCheck slips) get attached
 * to the most-likely owner — the first user spec — so callers still see the
 * failure even if the diagnostic's file pointer is something like `lib.dom.d.ts`.
 */
export const typecheckSpecs = async (
  files: string[],
  cwd: string,
): Promise<SpecValidateFileResult[]> => {
  const ts = await import("typescript");
  const resolved = files.map((f) => path.resolve(cwd, f));

  const tsconfigPath = path.resolve(cwd, "tsconfig.json");
  let compilerOptions: import("typescript").CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    noEmit: true,
    allowJs: false,
    types: [],
  };
  if (fs.existsSync(tsconfigPath)) {
    const parsed = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (!parsed.error && parsed.config) {
      const conv = ts.parseJsonConfigFileContent(
        parsed.config as Record<string, unknown>,
        ts.sys,
        cwd,
      );
      if (conv.options) {
        compilerOptions = { ...conv.options, noEmit: true };
      }
    }
  }

  const program = ts.createProgram({
    rootNames: resolved,
    options: compilerOptions,
  });

  const allDiagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
    ...program.getOptionsDiagnostics(),
  ];

  const fileResults = new Map<string, SpecValidateFileResult>();
  for (const f of resolved) {
    fileResults.set(f, { file: f, status: "ok", diagnostics: [] });
  }

  for (const diag of allDiagnostics) {
    const targetFile = diag.file?.fileName ? path.resolve(diag.file.fileName) : undefined;
    const owner =
      targetFile && fileResults.has(targetFile)
        ? targetFile
        : (resolved[0] ?? targetFile ?? "<unknown>");
    let entry = fileResults.get(owner);
    if (!entry) {
      entry = { file: owner, status: "ok", diagnostics: [] };
      fileResults.set(owner, entry);
    }
    const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
    let line: number | undefined;
    let column: number | undefined;
    if (diag.file && typeof diag.start === "number") {
      const { line: l, character } = diag.file.getLineAndCharacterOfPosition(diag.start);
      line = l + 1;
      column = character + 1;
    }
    const category =
      diag.category === ts.DiagnosticCategory.Error
        ? "error"
        : diag.category === ts.DiagnosticCategory.Warning
          ? "warning"
          : "warning";
    entry.diagnostics.push({
      file: owner,
      ...(line !== undefined ? { line } : {}),
      ...(column !== undefined ? { column } : {}),
      ...(diag.code !== undefined ? { code: diag.code } : {}),
      category,
      message,
    });
    if (category === "error") entry.status = "error";
  }

  return [...fileResults.values()];
};

/**
 * Fold a per-file map of import errors (from `discover()`) into a typecheck
 * result set. Returns the merged list with `status: "error"` and an `import`-
 * category diagnostic on every file that crashed at module load time.
 */
export const mergeImportErrors = (
  tsResults: SpecValidateFileResult[],
  importErrors: Map<string, string>,
  targets: string[],
): SpecValidateFileResult[] => {
  const merged = [...tsResults];
  for (const entry of merged) {
    const importErr = importErrors.get(entry.file);
    if (importErr) {
      entry.status = "error";
      entry.diagnostics.push({
        file: entry.file,
        category: "import",
        message: importErr,
      });
    }
  }
  for (const target of targets) {
    if (!merged.find((e) => e.file === target)) {
      const importErr = importErrors.get(target);
      merged.push({
        file: target,
        status: importErr ? "error" : "ok",
        diagnostics: importErr ? [{ file: target, category: "import", message: importErr }] : [],
      });
    }
  }
  return merged;
};
