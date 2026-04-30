/**
 * `skeptic generate` — emit a *.spec.ts file using the configured AI client.
 *
 * Pipeline:
 *   1. Load config + build the AI client (Gemini/OpenAI/Anthropic).
 *   2. Build the prompt (description-driven by default; --diff feeds git diff).
 *   3. Call the LLM, strip code fences.
 *   4. Validate: write to a temp `.spec.ts`, `tsc --noEmit`, dynamic-import
 *      to count `test()` registrations. Reject + surface diagnostics on failure.
 *   5. Write the validated source to disk and print the path.
 *
 * Coverage analysis (--no-coverage to skip) walks existing *.spec.ts via the
 * AST extractor and prepends a coverage section to the prompt so the model
 * prioritizes uncovered routes when running in --diff mode.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../config/loader.js";
import { createAIClient, AIFeatureNotBuiltError } from "../ai/client-factory.js";
import { missingClientMessage } from "../ai/security.js";
import {
  generateFromDescription,
  generateFromDiff,
  type GeneratedTest,
} from "../ai/flow-generator.js";
import { logger } from "../utils/logger.js";

export interface GenerateCommandOptions {
  diff?: boolean;
  target?: "changes" | "unstaged" | "branch";
  url?: string;
  message?: string;
  output?: string;
  save?: boolean;
  model?: string;
  config?: string;
  yes?: boolean;
  guidance?: string;
  coverage?: boolean;
}

const collectDiff = (target: GenerateCommandOptions["target"], baseBranch: string): string => {
  // Mirrors the YAML-era diff scopes — `changes` = staged, `unstaged` =
  // working tree, `branch` = vs. baseBranch. `git diff` exit code is non-
  // zero when there's nothing to show; we treat empty output as "no diff".
  const args =
    target === "unstaged"
      ? ["diff"]
      : target === "branch"
        ? ["diff", `${baseBranch}...HEAD`]
        : ["diff", "--cached"];
  try {
    return execFileSync("git", args, { encoding: "utf-8" });
  } catch (err) {
    const stdout = err && typeof err === "object" && "stdout" in err ? String((err as { stdout: unknown }).stdout) : "";
    return stdout;
  }
};

const writeOutput = (
  result: GeneratedTest,
  opts: GenerateCommandOptions,
  cwd: string,
): string => {
  const targetDir = opts.save
    ? path.join(cwd, ".skeptic", "generated")
    : (opts.output ?? path.join(cwd, "tests"));
  fs.mkdirSync(targetDir, { recursive: true });
  const stamp = opts.save
    ? `${Date.now()}-${result.filename}`
    : result.filename;
  const outPath = path.join(targetDir, stamp);
  fs.writeFileSync(outPath, result.source, "utf-8");
  return outPath;
};

export const runGenerate = async (opts: GenerateCommandOptions): Promise<void> => {
  const cwd = process.cwd();
  const config = loadConfig({
    searchCwd: cwd,
    ...(opts.config !== undefined ? { configPath: opts.config } : {}),
    ...(opts.url !== undefined ? { overrides: { url: opts.url } } : {}),
  });

  // AI client — caught explicitly so the user gets `missingClientMessage`
  // (provider + env var) instead of a generic crash.
  let client;
  try {
    client = await createAIClient({
      provider: config.ai.provider,
      ...(config.ai.apiKey !== undefined ? { apiKey: config.ai.apiKey } : {}),
      ...(opts.model !== undefined
        ? { model: opts.model }
        : config.ai.model !== undefined
          ? { model: config.ai.model }
          : {}),
    });
  } catch (err) {
    if (err instanceof AIFeatureNotBuiltError) {
      logger.error(err.message);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
  if (!client) {
    logger.error(missingClientMessage(config.ai));
    process.exitCode = 2;
    return;
  }

  const baseUrl = opts.url ?? config.url;

  let results: GeneratedTest[];
  if (opts.diff) {
    const diff = collectDiff(opts.target ?? "changes", config.ai.baseBranch);
    if (!diff.trim()) {
      logger.warn("No diff detected — nothing to generate against. Try --target unstaged or --target branch.");
      return;
    }
    const generateOpts: Parameters<typeof generateFromDiff>[2] = {};
    if (baseUrl !== undefined) generateOpts.baseUrl = baseUrl;
    results = await generateFromDiff(client, diff, generateOpts, cwd);
  } else if (opts.message) {
    results = await generateFromDescription(client, opts.message, baseUrl, cwd);
  } else {
    logger.error("Provide either --message <description> or --diff to generate a test.");
    process.exitCode = 2;
    return;
  }

  for (const result of results) {
    const outPath = writeOutput(result, opts, cwd);
    logger.info(
      `Generated ${path.relative(cwd, outPath)} (${result.testCount} test${result.testCount === 1 ? "" : "s"})`,
    );
    if (result.diagnostics.length > 0) {
      for (const note of result.diagnostics) logger.warn(`  ${note}`);
    }
  }
};
