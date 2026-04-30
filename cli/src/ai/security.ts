import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { minimatch } from "minimatch";
import type { Page } from "playwright";
import { ENV_KEY_BY_PROVIDER, type AIClient, type AIProvider } from "./ai-client.js";
import { PRODUCT_NAME } from "../constants.js";

const CONSENT_DIR = ".skeptic";

const HOST_BY_PROVIDER: Record<AIProvider, string> = {
  gemini: "generativelanguage.googleapis.com",
  openai: "api.openai.com",
  anthropic: "api.anthropic.com",
};

/**
 * Provider-aware message for the "no API key configured" case.
 * Shared by generate.ts, mcp.ts, test.ts --analyze, and step handlers so users see
 * the same guidance regardless of where the failure surfaced.
 */
export function missingClientMessage(ai?: { provider?: AIProvider }): string {
  const provider: AIProvider = ai?.provider ?? "gemini";
  const envKey = ENV_KEY_BY_PROVIDER[provider];
  return (
    `No API key configured for provider "${provider}". ` +
    `Set ${envKey} in your environment, or ai.apiKey in skeptic.config.yaml. ` +
    `To switch providers, set ai.provider (gemini | openai | anthropic) in config.`
  );
}

/**
 * Throws if no AI client is configured. Step handlers and command paths that
 * require AI should call this before dereferencing `ctx.aiClient`.
 */
export function checkAIEnabled(client: AIClient | undefined): void {
  if (!client) {
    throw new Error(missingClientMessage());
  }
}

/**
 * Print a one-time consent warning per provider, then remember the user acknowledged.
 * Per-provider consent file prevents silent switching between providers without re-asking.
 */
export function firstUseWarning(provider: AIProvider): boolean {
  const consentPath = path.resolve(process.cwd(), CONSENT_DIR, `.ai-consent-${provider}`);

  if (fs.existsSync(consentPath)) {
    return true;
  }

  const host = HOST_BY_PROVIDER[provider];
  console.log();
  console.log(
    chalk.yellow(
      `  ${PRODUCT_NAME} AI features will send screenshots and prompts to ${provider} (${host}).`,
    ),
  );
  console.log(chalk.yellow(`  Data may leave your machine.`));
  console.log();

  const dir = path.dirname(consentPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(consentPath, new Date().toISOString(), "utf-8");

  return true;
}

/**
 * Take a screenshot with sensitive inputs (passwords, [data-skeptic-redact]) masked.
 */
export async function takeRedactedScreenshot(page: Page): Promise<Buffer> {
  return page.screenshot({
    type: "png",
    mask: [
      page.locator('input[type="password"]'),
      page.locator("[data-skeptic-redact]"),
    ],
    maskColor: "#000000",
  });
}

/**
 * Match a project-relative path against the user's exclude patterns.
 *
 * Single source of truth for `ai.excludePaths` semantics — used by the diff filter
 * AND the coverage import-graph builder so the user's "secrets/" config drops the
 * same files everywhere. matchBase lets bare patterns match on basename; dot lets
 * `*.env*` hit `.env.local`. Trailing-`/` patterns become `pattern + "**"` so a
 * directory prefix matches every descendant.
 */
export function matchExcludePath(filePath: string, excludePatterns: string[]): boolean {
  if (excludePatterns.length === 0) return false;
  for (const raw of excludePatterns) {
    const pattern = raw.endsWith("/") ? `${raw}**` : raw;
    if (minimatch(filePath, pattern, { matchBase: true, dot: true })) return true;
  }
  return false;
}

/**
 * Filter a unified git diff, removing files that match any exclude pattern.
 * Delegates to matchExcludePath so coverage analysis sees identical exclusions.
 */
export function filterDiffPaths(diff: string, excludePatterns: string[]): string {
  if (excludePatterns.length === 0) return diff;

  const lines = diff.split("\n");
  const result: string[] = [];
  let skip = false;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/diff --git a\/(.+) b\/(.+)/);
      const filePath = match?.[2] ?? "";
      skip = matchExcludePath(filePath, excludePatterns);
    }
    if (!skip) {
      result.push(line);
    }
  }

  return result.join("\n");
}
