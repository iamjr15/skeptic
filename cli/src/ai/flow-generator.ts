/**
 * Stubbed in B1 (TS-pivot). The original implementation generated YAML flows.
 * B5.5 rewrites this end-to-end against the new TS spec API; the symbols are
 * preserved here so `generate.ts` keeps compiling.
 */
import type { AIClient } from "./ai-client.js";

export interface CoverageGenerationOptions {
  projectRoot: string;
  flowGlob: string | string[];
  configDir?: string;
}

export interface GenerateFromDiffOptions {
  coverage?: CoverageGenerationOptions;
}

const PIVOT_MESSAGE =
  "[skeptic] flow-generator is being rewritten in Bundle 5.5 — see plan §B5.5 (`generate` rewrite + AST coverage + TS spec validation).";

export const generateFromDiff = async (
  _client: AIClient,
  _diff: string,
  _options: GenerateFromDiffOptions = {},
): Promise<string[]> => {
  throw new Error(PIVOT_MESSAGE);
};

export const generateFromDescription = async (
  _client: AIClient,
  _description: string,
  _baseUrl?: string,
): Promise<string[]> => {
  throw new Error(PIVOT_MESSAGE);
};
