import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import chalk from "chalk";
import { PRODUCT_NAME, CLI_NAME } from "../constants.js";
import { loadConfig } from "../config/loader.js";
import { ENV_KEY_BY_PROVIDER, type AIProvider } from "../ai/ai-client.js";
import { logger } from "../utils/logger.js";

export interface AddGitHubActionOptions {
  devCommand?: string;
  devUrl?: string;
  ai?: boolean;
  provider?: string;
  config?: string;
}

export async function runAddGitHubAction(opts: AddGitHubActionOptions): Promise<void> {
  const devCommand = opts.devCommand ?? "npm run dev";
  const devUrl = opts.devUrl ?? "http://localhost:3000";
  const useAI = opts.ai ?? false;

  // --provider only makes sense with --ai.
  if (opts.provider && !useAI) {
    logger.error("--provider requires --ai. Pass both, or omit --provider to use the default.");
    process.exitCode = 1;
    return;
  }

  // Resolve provider via loadConfig overrides so zod validates the enum, catches
  // unreadable config paths, and reports malformed YAML — all in one try/catch.
  let provider: AIProvider = "gemini";
  if (useAI) {
    try {
      const config = loadConfig({
        configPath: opts.config,
        overrides: opts.provider ? { ai: { provider: opts.provider } } : undefined,
      });
      provider = config.ai.provider;
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  }

  // All validation passed — now safe to create the output directory.
  const workflowDir = path.resolve(process.cwd(), ".github/workflows");
  fs.mkdirSync(workflowDir, { recursive: true });

  const workflowPath = path.join(workflowDir, "skeptic-tests.yml");

  const envKey = ENV_KEY_BY_PROVIDER[provider];
  const aiEnvBlock = useAI
    ? `\n          ${envKey}: \${{ secrets.${envKey} }}\n          SKEPTIC_AI_PROVIDER: ${provider}\n          SKEPTIC_AI_API_KEY: \${{ secrets.${envKey} }}`
    : "";
  const analyzeFlag = useAI ? " --analyze" : "";

  const yaml = `name: ${PRODUCT_NAME} E2E Tests

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  e2e-tests:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
      pull-requests: write

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium

      - name: Start dev server
        run: ${devCommand} &
        env:
          PORT: 3000

      - name: Wait for server
        run: npx wait-on ${devUrl} --timeout 30000

      - name: Run ${PRODUCT_NAME} tests
        run: npx ${CLI_NAME} run --ci --reporter console --reporter junit --reporter json --output ./skeptic-output${analyzeFlag}
        env:
          BASE_URL: ${devUrl}${aiEnvBlock}

      - name: Upload test artifacts
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: skeptic-test-results
          path: skeptic-output/
          retention-days: 14

      - name: Comment on PR
        if: github.event_name == 'pull_request' && always()
        run: |
          npx ${CLI_NAME} comment \\
            --results ./skeptic-output/results.json \\
            --pr \${{ github.event.pull_request.number }} \\
            --run-url \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;

  fs.writeFileSync(workflowPath, yaml, "utf-8");
  logger.success(`Created ${chalk.cyan(workflowPath)}`);

  if (useAI) {
    console.log();
    console.log(
      chalk.yellow(`  Add ${envKey} to your repository secrets (provider: ${provider}):`),
    );
    console.log(
      chalk.dim("  Settings → Secrets and variables → Actions → New repository secret"),
    );
    console.log();
  }
}

export interface AddSkillOptions {
  agent?: string;
}

export async function runAddSkill(opts: AddSkillOptions): Promise<void> {
  const agent = opts.agent ?? detectAgent();

  if (!agent) {
    logger.error(
      "No AI agent detected. Specify one with --agent (claude, codex, cursor)",
    );
    process.exitCode = 1;
    return;
  }

  const skillContent = `# ${PRODUCT_NAME} E2E Testing

${PRODUCT_NAME} is a TypeScript test runner for AI agents — built on Playwright with AI assertions, observability, and snapshot-based discovery.

## Quick Commands

- \`${CLI_NAME} run\` — run all tests in tests/**/*.spec.ts
- \`${CLI_NAME} run tests/login.spec.ts\` — run a specific test file
- \`${CLI_NAME} run --observability\` — full observability bundle (perf+net+a11y+console)
- \`${CLI_NAME} inspect <url>\` — discover ARIA refs + selectorHints for a page
- \`${CLI_NAME} generate --diff\` — generate tests from code changes
- \`${CLI_NAME} generate --message "test the login form"\` — generate from description

## After Code Changes

\`\`\`bash
${CLI_NAME} run --diff
\`\`\`

If tests fail, examine the output (stderr + results.json) and fix the code or update the test.

## Test Format

Tests are TypeScript files in \`tests/\` using the skeptic API:

\`\`\`ts
import { test, expect } from "skeptic-cli";

test("login", async ({ page, snapshot, ai, screenshot }) => {
  await page.goto("/login");
  await page.fill("[data-testid=email]", "user@test.com");
  await page.click("button:has-text('Sign In')");
  await expect(page).toHaveURL(/dashboard/);
  await ai.assert("the dashboard greets the user by name");
  await screenshot("dashboard");
});
\`\`\`

Fixture members: page, snapshot, screenshot, settle, observability, ai, ctx.
`;

  let skillPath: string;

  switch (agent) {
    case "claude": {
      const dir = path.resolve(process.cwd(), ".claude/skills");
      fs.mkdirSync(dir, { recursive: true });
      skillPath = path.join(dir, "skeptic.md");
      break;
    }
    case "codex": {
      const dir = path.resolve(process.cwd(), ".agents/skills/skeptic");
      fs.mkdirSync(dir, { recursive: true });
      skillPath = path.join(dir, "SKILL.md");
      break;
    }
    case "cursor": {
      const dir = path.resolve(process.cwd(), ".cursor/skills");
      fs.mkdirSync(dir, { recursive: true });
      skillPath = path.join(dir, "skeptic.md");
      break;
    }
    default: {
      logger.error(`Unknown agent: ${agent}`);
      process.exitCode = 1;
      return;
    }
  }

  fs.writeFileSync(skillPath, skillContent, "utf-8");
  logger.success(`Installed ${PRODUCT_NAME} skill for ${chalk.cyan(agent)} at ${chalk.dim(skillPath)}`);
}

function detectAgent(): string | null {
  const agents = ["claude", "codex", "cursor"];
  for (const agent of agents) {
    try {
      execSync(`which ${agent}`, { stdio: "ignore" });
      return agent;
    } catch {
      // not found
    }
  }
  return null;
}
