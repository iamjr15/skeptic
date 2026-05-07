import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
  // unreadable config paths, and reports malformed config files in one try/catch.
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
  scope?: string;
}

type SkillAgent = "claude" | "codex" | "cursor" | "opencode";
type SkillScope = "project" | "user";
type SkillInstallStatus = "installed" | "updated" | "already-installed" | "skipped";

interface SkillInstallResult {
  agent: SkillAgent;
  scope: SkillScope;
  targetDir: string;
  status: SkillInstallStatus;
  reason?: string;
}

const SKILL_NAME = "skeptic";
const MANAGED_SKILL_MARKER = "skeptic-agent-skill: managed by skeptic-cli";
const SUPPORTED_SKILL_AGENTS = ["claude", "codex", "cursor", "opencode"] as const;
const RECOVERABLE_SKILL_DIR_ENTRIES = new Set([".DS_Store", "Thumbs.db"]);

const EMBEDDED_SKILL_MD = `---
name: skeptic
description: Use Skeptic for CLI-first browser QA and TypeScript E2E tests. Use when asked to inspect pages, write or run skeptic-cli specs, validate UI changes, capture observability evidence, or use Skeptic MCP tools. Not for unit-only logic with no browser behavior.
---

<!-- skeptic-agent-skill: managed by skeptic-cli -->

# Skeptic

Use Skeptic when a coding agent needs browser evidence: page inspection, TypeScript E2E specs, one-off QA captures, AI-backed checks, or MCP browser validation. Do not claim a UI/browser change works until you have run a relevant Skeptic command or MCP tool and checked the evidence.

## Choose The Surface

- Human interactive test run: run \`skeptic tui\`.
- One-off QA or bug hunt: run \`skeptic observe <url> --full-page\`.
- Persistent regression coverage: run \`skeptic inspect <url> --interactive --compact --with-playwright-hints\`, write a \`tests/*.spec.ts\`, then run \`skeptic run\`.
- Changed-code verification: run existing specs with \`skeptic run\`, or use \`skeptic generate --diff\` to create one first.
- Agent-integrated browser work: if Skeptic MCP tools are available, use \`browser_open\`, \`browser_snapshot\`, \`browser_playwright\`, \`browser_screenshot\`, \`browser_console_logs\`, \`browser_network_requests\`, \`browser_performance_metrics\`, \`browser_accessibility_audit\`, and \`browser_close\`.

If the \`skeptic\` binary is not on PATH, try \`npx skeptic-cli\` or \`npx --yes skeptic-cli@latest\`.

Specs import from the project dependency \`skeptic-cli\`. A normal \`skeptic init\`
writes that dependency to \`package.json\`. If specs fail with \`Cannot find
package 'skeptic-cli'\`, run \`npm install\` in the project before re-running
Skeptic.

## Fast Loop

\`\`\`bash
skeptic doctor --quick
skeptic inspect <url> --interactive --compact --with-playwright-hints
skeptic run tests/<scenario>.spec.ts --observability --video --trace
\`\`\`

For a page with no existing spec:

\`\`\`bash
skeptic observe <url> --full-page --video --trace
\`\`\`

Use the generated \`results.json\`, \`report.html\`, screenshots, videos, traces, \`network.json\`, \`console.json\`, \`accessibility.json\`, and \`perf-trace.md\` as the evidence source. Reference artifact paths from \`results.json\` instead of guessing filenames.

## Writing Specs

Skeptic specs import from \`skeptic-cli\`.

\`\`\`ts
import { test, expect } from "skeptic-cli";

test("homepage smoke", async ({ page, snapshot, screenshot, observability }) => {
  await page.goto("https://example.com");
  await expect(page).toHaveTitle(/Example Domain/);

  const tree = await snapshot(page, { interactive: true, compact: true });
  await expect(tree.byRole("heading", { name: "Example Domain" })).toBeVisible();

  await screenshot("homepage", { fullPage: true });
  await observability.expectNoConsoleErrors();
});
\`\`\`

Rules:

- Put browser side effects inside \`test(...)\`, hooks, or helper functions called from tests.
- Prefer role, label, text, and test-id locators over CSS.
- Use \`snapshot(page)\` before interacting through refs or snapshot helpers.
- Re-snapshot after navigation, route changes, modal open/close, or major DOM mutation.
- Do not paste CLI \`@eN\` refs directly into specs. Use \`selectorHint\` from \`inspect\`, or use \`tree.byRef("eN")\` only for refs returned by the same in-test \`snapshot(page)\` call.
- Add \`screenshot("name")\` for states that would help debug a failure.

## Observability Checks

Use \`--observability\` for real QA evidence. In specs, assert the signals that match the risk:

\`\`\`ts
await observability.expectNoConsoleErrors();
await observability.expectNoNetworkErrors({ allow: [/analytics/] });
await observability.expectPerformance({ lcp: "<2500ms", cls: "<0.1" });
await observability.expectAccessible({ standard: "WCAG21AA" });
\`\`\`

If an observability artifact reports a failure, fix the product or the test and re-run the same flow immediately.

## MCP Workflow

When Skeptic is exposed through MCP:

1. \`browser_open\` the target URL.
2. \`browser_snapshot\` or \`browser_screenshot\` with snapshot mode to get refs.
3. Use one \`browser_playwright\` call for actions that share the same DOM state. Use the \`ref\` helper for snapshot refs and \`return\` structured evidence.
4. After DOM-changing actions, request a fresh snapshot.
5. Check \`browser_console_logs\`, \`browser_network_requests\`, \`browser_accessibility_audit\`, and \`browser_performance_metrics\`.
6. \`browser_close\` when done so video and trace artifacts flush.

Batch fills, clicks, and data collection when the DOM is stable. Do not take a new snapshot between plain text fills unless the page structure changed.

## Verification Standard

Before reporting completion for browser-facing work:

- Run the smallest Skeptic command or MCP workflow that actually exercises the changed behavior.
- Test at least one adjacent or negative path when forms, routing, validation, auth, persistence, or shared components changed.
- Read the full command/tool output. Passing navigation alone is not enough.
- If there are console errors, network failures, serious accessibility issues, poor Web Vitals, or visible regressions, fix and re-run.
- State the exact command/tool run and the main artifact path in the final report.
`;

const EMBEDDED_OPENAI_YAML = `interface:
  display_name: "Skeptic"
  short_description: "Use Skeptic to inspect pages, write TypeScript E2E tests, run browser QA, and collect observability evidence."
  default_prompt: "Use Skeptic to verify this UI or browser behavior with real evidence and report the relevant artifacts."
`;

export async function runAddSkill(opts: AddSkillOptions): Promise<void> {
  const scope = normalizeSkillScope(opts.scope);
  if (!scope) {
    logger.error("Unknown skill scope. Use --scope project or --scope user.");
    process.exitCode = 1;
    return;
  }

  const agents = resolveSkillAgents(opts.agent);
  if (agents.length === 0) {
    logger.error(
      "No AI agent detected. Specify one with --agent (claude, codex, cursor, opencode, all)",
    );
    process.exitCode = 1;
    return;
  }

  const results = agents.map((agent) => installSkillForAgent(agent, scope));
  for (const result of results) {
    const label = `${result.agent} ${result.scope}`;
    if (result.status === "skipped") {
      logger.warn(`${label}: skipped ${chalk.dim(result.targetDir)} (${result.reason ?? "unknown reason"})`);
      continue;
    }
    const verb =
      result.status === "already-installed"
        ? "already installed"
        : result.status === "updated"
          ? "updated"
          : "installed";
    logger.success(`${PRODUCT_NAME} skill ${verb} for ${chalk.cyan(label)} at ${chalk.dim(result.targetDir)}`);
  }

  if (results.every((result) => result.status === "skipped")) {
    process.exitCode = 1;
  }
}

function normalizeSkillScope(scope: string | undefined): SkillScope | null {
  if (scope === undefined || scope === "project") return "project";
  if (scope === "user") return "user";
  return null;
}

function resolveSkillAgents(agent: string | undefined): SkillAgent[] {
  if (agent === "all") return [...SUPPORTED_SKILL_AGENTS];
  if (agent !== undefined) {
    return isSkillAgent(agent) ? [agent] : [];
  }
  const detected = detectAgent();
  return detected ? [detected] : [];
}

function isSkillAgent(agent: string): agent is SkillAgent {
  return SUPPORTED_SKILL_AGENTS.includes(agent as SkillAgent);
}

function detectAgent(): SkillAgent | null {
  for (const agent of SUPPORTED_SKILL_AGENTS) {
    try {
      execSync(`which ${agent}`, { stdio: "ignore" });
      return agent;
    } catch {
      // not found
    }
  }
  return null;
}

function installSkillForAgent(agent: SkillAgent, scope: SkillScope): SkillInstallResult {
  const targetDir = getSkillTargetDir(agent, scope);
  return installSkillDirectory(targetDir, agent, scope);
}

function getSkillTargetDir(agent: SkillAgent, scope: SkillScope): string {
  if (scope === "project") {
    const baseByAgent: Record<SkillAgent, string> = {
      claude: ".claude/skills",
      codex: ".agents/skills",
      cursor: ".cursor/skills",
      opencode: ".opencode/skills",
    };
    return path.resolve(process.cwd(), baseByAgent[agent], SKILL_NAME);
  }

  const home = process.env.HOME || os.homedir();
  if (agent === "codex") {
    return path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "skills", SKILL_NAME);
  }

  const baseByAgent: Record<Exclude<SkillAgent, "codex">, string> = {
    claude: ".claude/skills",
    cursor: ".cursor/skills",
    opencode: ".opencode/skills",
  };
  return path.join(home, baseByAgent[agent], SKILL_NAME);
}

function installSkillDirectory(
  targetDir: string,
  agent: SkillAgent,
  scope: SkillScope,
): SkillInstallResult {
  const existing = getPathStats(targetDir);
  const sourceDir = findBundledSkillDir();
  const targetSkillPath = path.join(targetDir, "SKILL.md");
  const sourceMatchesTarget = sourceDir
    ? pathMatchesContents(sourceDir, targetDir)
    : fs.existsSync(targetSkillPath) && fs.readFileSync(targetSkillPath, "utf-8") === EMBEDDED_SKILL_MD;

  if (sourceMatchesTarget) {
    return { agent, scope, targetDir, status: "already-installed" };
  }

  if (existing) {
    if (existing.isSymbolicLink()) {
      return { agent, scope, targetDir, status: "skipped", reason: "target is a symlink" };
    }

    if (existing.isDirectory()) {
      if (!fs.existsSync(targetSkillPath)) {
        if (isRecoverableSkillDirectory(targetDir)) {
          fs.rmSync(targetDir, { recursive: true, force: true });
        } else {
          return {
            agent,
            scope,
            targetDir,
            status: "skipped",
            reason: "existing directory is not a Skeptic skill",
          };
        }
      } else if (!isSkepticManagedSkill(targetSkillPath)) {
        return {
          agent,
          scope,
          targetDir,
          status: "skipped",
          reason: "existing skill was not created by skeptic-cli",
        };
      } else {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
    } else if (existing.isFile()) {
      if (!isSkepticManagedSkill(targetDir)) {
        return {
          agent,
          scope,
          targetDir,
          status: "skipped",
          reason: "existing file was not created by skeptic-cli",
        };
      }
      fs.unlinkSync(targetDir);
    } else {
      return { agent, scope, targetDir, status: "skipped", reason: "unsupported existing path" };
    }
  }

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  if (sourceDir) {
    fs.cpSync(sourceDir, targetDir, { recursive: true });
  } else {
    writeEmbeddedSkill(targetDir);
  }

  return { agent, scope, targetDir, status: existing ? "updated" : "installed" };
}

function findBundledSkillDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../agent-skills", SKILL_NAME),
    path.resolve(here, "../../../agent-skills", SKILL_NAME),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "SKILL.md"))) ?? null;
}

function writeEmbeddedSkill(targetDir: string): void {
  fs.mkdirSync(path.join(targetDir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(targetDir, "SKILL.md"), EMBEDDED_SKILL_MD, "utf-8");
  fs.writeFileSync(path.join(targetDir, "agents", "openai.yaml"), EMBEDDED_OPENAI_YAML, "utf-8");
}

function getPathStats(targetPath: string): fs.Stats | null {
  try {
    return fs.lstatSync(targetPath);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

function isRecoverableSkillDirectory(targetDir: string): boolean {
  return fs.readdirSync(targetDir).every((entry) => RECOVERABLE_SKILL_DIR_ENTRIES.has(entry));
}

function isSkepticManagedSkill(skillPath: string): boolean {
  const content = fs.readFileSync(skillPath, "utf-8");
  return (
    content.includes(MANAGED_SKILL_MARKER) ||
    content.includes(`# ${PRODUCT_NAME} E2E Testing`) ||
    content.includes(`${PRODUCT_NAME} is a TypeScript test runner for AI agents`)
  );
}

function pathMatchesContents(sourcePath: string, targetPath: string): boolean {
  const sourceStats = getPathStats(sourcePath);
  const targetStats = getPathStats(targetPath);
  if (!sourceStats || !targetStats) return false;
  if (sourceStats.isSymbolicLink() || targetStats.isSymbolicLink()) return false;

  if (sourceStats.isDirectory() && targetStats.isDirectory()) {
    const sourceEntries = fs.readdirSync(sourcePath).sort();
    const targetEntries = fs.readdirSync(targetPath).sort();
    if (sourceEntries.length !== targetEntries.length) return false;
    return sourceEntries.every((entry, index) => {
      if (entry !== targetEntries[index]) return false;
      return pathMatchesContents(path.join(sourcePath, entry), path.join(targetPath, entry));
    });
  }

  if (sourceStats.isFile() && targetStats.isFile()) {
    return fs.readFileSync(sourcePath).equals(fs.readFileSync(targetPath));
  }

  return false;
}
