/**
 * Stubbed in B1 (TS-pivot). The original implementation generated YAML flows
 * via flow-generator + coverage analysis. B5.5 rewrites this to emit
 * `*.spec.ts` files validated by `tsc --noEmit` and a literal-AST coverage
 * extractor. The exports stay so cli/src/index.ts compiles.
 */
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

export const runGenerate = async (_opts: GenerateCommandOptions): Promise<void> => {
  throw new Error(
    "[skeptic] generate is being rewritten in Bundle 5.5 (TS spec output + AST coverage). " +
      "See plan §B5.5.",
  );
};
