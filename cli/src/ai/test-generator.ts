/**
 * AI-driven *.spec.ts generator. The generator writes the LLM output to a
 * temp `.spec.ts` file, typechecks it via `typecheckSpecs`, and sanity-checks
 * that at least one `test(...)` call is registered.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { AIClient } from "./ai-client.js";
import {
  GENERATE_FROM_DESCRIPTION_PROMPT,
  GENERATE_FROM_DIFF_PROMPT,
} from "./prompts.js";
import {
  beginRegistration,
  endRegistration,
  type FileRegistry,
} from "../api/test.js";
import { typecheckSpecs } from "../commands/spec-validation.js";

/** Caller-tunable knobs for coverage-aware diff generation. */
export interface CoverageGenerationOptions {
  projectRoot: string;
  testGlob: string | string[];
  configDir?: string;
}

export interface GenerateFromDiffOptions {
  coverage?: CoverageGenerationOptions;
  baseUrl?: string;
}

/**
 * The validated artefact produced by the generator. The caller decides
 * whether to write it to disk; the generator owns the temp-file dance and
 * surfaces only the final source + filename + diagnostics.
 */
export interface GeneratedTest {
  source: string;
  filename: string;
  diagnostics: string[];
  testCount: number;
}

const stripCodeFences = (raw: string): string => {
  const trimmed = raw.trim();
  // ```ts ... ``` or ``` ... ```
  const fence = /^```(?:ts|tsx|typescript|javascript|js)?\n([\s\S]*?)```$/i;
  const m = trimmed.match(fence);
  if (m && m[1]) return m[1].trim();
  // Tolerate a stray opening fence without closing fence.
  if (/^```(?:ts|tsx|typescript|javascript|js)?\n/i.test(trimmed)) {
    return trimmed.replace(/^```[a-z]*\n?/i, "").replace(/```$/m, "").trim();
  }
  return trimmed;
};

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "generated";

interface ValidateOptions {
  /**
   * If true, attempt a dynamic `import(tempFile)` to count registered
   * `test(...)` calls. Disabled by tests that mock the LLM and don't want
   * to spin up the runner registry.
   */
  importForTestCount?: boolean;
}

export interface ValidationResult {
  ok: boolean;
  diagnostics: string[];
  testCount: number;
}

/**
 * Write `source` to a unique temp `.spec.ts` file, then run `tsc --noEmit`
 * on it (via `typecheckSpecs`). Returns the diagnostics list and, when
 * requested, dynamically imports the file to count `test(...)` registrations.
 *
 * The caller MUST clean up the temp file when finished; we return the path
 * so the generator can either delete it or hand it back as the final
 * filename if the user passes `--output`.
 */
export const validateGeneratedSource = async (
  source: string,
  cwd: string,
  options: ValidateOptions = {},
): Promise<{ tempPath: string; result: ValidationResult }> => {
  // Write under <cwd>/.skeptic/.gen-* so the project's tsconfig (which
  // commonly pins `rootDir: "."`) doesn't reject the temp file as
  // out-of-root, AND so module resolution to `skeptic-cli` finds the
  // package via the project's own node_modules.
  const tempDir = path.join(cwd, ".skeptic", `.gen-${crypto.randomBytes(6).toString("hex")}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, "generated.spec.ts");
  fs.writeFileSync(tempPath, source, "utf-8");

  const diagnostics: string[] = [];
  let ok = true;
  let testCount = 0;

  // Layer 1: tsc --noEmit via the shared spec-validation helper.
  const tsResults = await typecheckSpecs([tempPath], cwd);
  for (const fileResult of tsResults) {
    if (fileResult.status === "error") ok = false;
    for (const diag of fileResult.diagnostics) {
      if (diag.category === "error") ok = false;
      const loc =
        diag.line !== undefined ? `:${diag.line}:${diag.column ?? 0}` : "";
      diagnostics.push(`[${diag.category}] ${path.basename(fileResult.file)}${loc} — ${diag.message}`);
    }
  }

  // Layer 2: dynamic-import sanity. The runner's registry is module-scoped
  // via globalThis (api/test.ts), so calling `beginRegistration` before the
  // import gives us a counter even though the spec uses `import { test } from
  // "skeptic-cli"`. Skipped when typecheck already failed (broken module
  // would re-surface the same error).
  if (ok && options.importForTestCount !== false) {
    const registry = beginRegistration(tempPath);
    try {
      const url = pathToFileURL(tempPath).href;
      // tsx is registered globally by `cli/bin/launcher.mjs` for prod runs.
      // In tests, vitest handles TS imports natively. The dynamic import here
      // therefore works without a per-call loader configuration.
      await import(/* @vite-ignore */ url);
      testCount = registry.tests.length;
      if (testCount === 0) {
        ok = false;
        diagnostics.push(
          "[error] generated source registered 0 test() calls — at least one is required",
        );
      }
    } catch (err) {
      ok = false;
      const msg = err instanceof Error ? err.message : String(err);
      diagnostics.push(`[import] ${msg}`);
    } finally {
      const finished: FileRegistry | null = endRegistration();
      if (finished && testCount === 0) testCount = finished.tests.length;
    }
  }

  return { tempPath, result: { ok, diagnostics, testCount } };
};

const buildAndValidate = async (
  client: AIClient,
  prompt: string,
  description: string,
  cwd: string,
): Promise<GeneratedTest> => {
  const ai = await client.generateText(prompt);
  const source = stripCodeFences(ai.text);
  const filename = `${slugify(description)}.spec.ts`;

  const { tempPath, result } = await validateGeneratedSource(source, cwd);
  // Best-effort cleanup — leaving a stray file in /tmp isn't fatal but we tidy.
  try {
    fs.rmSync(path.dirname(tempPath), { recursive: true, force: true });
  } catch {
    // ignored — temp cleanup is non-fatal.
  }

  if (!result.ok) {
    const reason = result.diagnostics.length > 0 ? result.diagnostics.join("\n  ") : "no diagnostics";
    throw new Error(
      `[skeptic] generated spec failed validation:\n  ${reason}\n\nSource:\n${source}`,
    );
  }

  return {
    source,
    filename,
    diagnostics: result.diagnostics,
    testCount: result.testCount,
  };
};

export const generateFromDescription = async (
  client: AIClient,
  description: string,
  baseUrl?: string,
  cwd: string = process.cwd(),
): Promise<GeneratedTest[]> => {
  const url = baseUrl ?? "https://example.com";
  const prompt = GENERATE_FROM_DESCRIPTION_PROMPT.replace(
    /\{baseUrl\}/g,
    url,
  ).replace(/\{description\}/g, description);
  const result = await buildAndValidate(client, prompt, description, cwd);
  return [result];
};

export const generateFromDiff = async (
  client: AIClient,
  diff: string,
  options: GenerateFromDiffOptions = {},
  cwd: string = process.cwd(),
): Promise<GeneratedTest[]> => {
  const url = options.baseUrl ?? "https://example.com";
  const prompt = GENERATE_FROM_DIFF_PROMPT.replace(/\{baseUrl\}/g, url).replace(
    /\{diff\}/g,
    diff,
  );
  const result = await buildAndValidate(client, prompt, "diff-driven", cwd);
  return [result];
};
