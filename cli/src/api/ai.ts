import type { Locator, Page } from "playwright";
import type { ExecutionContext } from "../executor/context.js";
import type { AIClient } from "../ai/ai-client.js";
import {
  evaluateAssertion,
  evaluateDefects,
  extractText,
} from "../ai/assertion-evaluator.js";
import { takeRedactedScreenshot } from "../ai/security.js";

export interface AiAssertOpts {
  target?: Locator;
}

export interface AiDefectsOpts extends AiAssertOpts {
  /** Future hook for severity filtering — wired in B5 along with the AI rewrite. */
  minSeverity?: "low" | "medium" | "high" | "critical";
}

export interface AiExtractOpts<T> extends AiAssertOpts {
  /** Optional Zod-or-similar schema. We accept any object exposing `.parse(value)`. */
  schema?: { parse: (value: unknown) => T };
}

export interface AiFixture {
  assert(claim: string, opts?: AiAssertOpts): Promise<void>;
  assertNoDefects(opts?: AiDefectsOpts): Promise<void>;
  extract<T = string>(query: string, opts?: AiExtractOpts<T>): Promise<T>;
}

export interface AiFixtureInput {
  runAction: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  page: Page;
  ctx: ExecutionContext;
}

const requireClient = (ctx: ExecutionContext, action: string): AIClient => {
  if (!ctx.aiClient) {
    throw new Error(
      `[skeptic] ai.${action}() needs an AI client. Set GEMINI_API_KEY (or your provider equivalent) ` +
        `and configure the ai block in skeptic.config.yaml, or run with --ai-provider <name>.`,
    );
  }
  return ctx.aiClient;
};

const screenshotForAi = async (
  page: Page,
  target: Locator | undefined,
): Promise<Buffer> => {
  if (target) {
    return target.screenshot();
  }
  return takeRedactedScreenshot(page);
};

export const buildAiFixture = (input: AiFixtureInput): AiFixture => {
  const { runAction, page, ctx } = input;

  return {
    assert: (claim, opts) =>
      runAction("ai.assert", async () => {
        const client = requireClient(ctx, "assert");
        const buffer = await screenshotForAi(page, opts?.target);
        const result = await evaluateAssertion(client, buffer, claim);
        if (!result.passed) {
          const issues =
            result.issues.length > 0
              ? `\nIssues:\n  - ${result.issues
                  .map((i) => `${i.type} (${i.severity}): ${i.description}`)
                  .join("\n  - ")}`
              : "";
          throw new Error(
            `[skeptic] ai.assert failed: ${claim}\n${result.summary || "AI marked the claim as not passing"}${issues}`,
          );
        }
      }),

    assertNoDefects: (opts) =>
      runAction("ai.assertNoDefects", async () => {
        const client = requireClient(ctx, "assertNoDefects");
        const buffer = await screenshotForAi(page, opts?.target);
        const result = await evaluateDefects(client, buffer);
        if (!result.passed) {
          const issues =
            result.issues.length > 0
              ? `\nDefects:\n  - ${result.issues
                  .map((i) => `${i.type} (${i.severity}): ${i.description}`)
                  .join("\n  - ")}`
              : "";
          throw new Error(`[skeptic] ai.assertNoDefects failed${issues}\n${result.summary}`);
        }
      }),

    extract: <T = string>(query: string, opts?: AiExtractOpts<T>): Promise<T> =>
      runAction("ai.extract", async () => {
        const client = requireClient(ctx, "extract");
        const buffer = await screenshotForAi(page, opts?.target);
        const result = await extractText(client, buffer, query);
        if (opts?.schema) {
          return opts.schema.parse(result.text);
        }
        return result.text as unknown as T;
      }),
  };
};
