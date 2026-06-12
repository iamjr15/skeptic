import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { PRODUCT_NAME, CLI_NAME } from "../constants.js";
import { logger } from "../utils/logger.js";

export interface AddGitHubActionOptions {
  devCommand?: string;
  devUrl?: string;
  config?: string;
}

export async function runAddGitHubAction(opts: AddGitHubActionOptions): Promise<void> {
  const devCommand = opts.devCommand ?? "npm run dev";
  const devUrl = opts.devUrl ?? "http://localhost:3000";

  const workflowDir = path.resolve(process.cwd(), ".github/workflows");
  fs.mkdirSync(workflowDir, { recursive: true });

  const workflowPath = path.join(workflowDir, "skeptic-tests.yml");

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
        run: npx ${CLI_NAME} run --ci --reporter console --reporter junit --reporter json --output ./skeptic-output
        env:
          BASE_URL: ${devUrl}

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
description: Use Skeptic for CLI-first browser QA and TypeScript E2E tests. Use when asked to inspect pages, drive a browser interactively, write or run skeptic-cli specs, validate UI changes, or capture observability evidence. Not for unit-only logic with no browser behavior.
---

<!-- skeptic-agent-skill: managed by skeptic-cli -->

# Skeptic

Use Skeptic when you need browser evidence: interactive page-driving, page inspection, TypeScript E2E specs, one-off QA captures, or observability evidence. Do not claim a UI/browser change works until you have run a relevant Skeptic command and checked the evidence.

Skeptic is **agent-native**: it has no model of its own, makes no LLM calls, and needs no API keys. You (the coding agent) are the intelligence; Skeptic is the deterministic hands and eyes. Everything is driven from the shell — there is no MCP server.

## Choose The Surface

- **Drive a browser interactively** (click through a flow, check a fix): use the persistent session verbs — \`skeptic open <url>\`, \`skeptic snapshot -i\`, \`skeptic click @e3\`, etc. Refs persist between commands.
- **One-off discovery** (get stable selectors to write a spec): \`skeptic inspect <url> --interactive --compact --with-playwright-hints\`.
- **One-off QA / bug hunt** (full evidence bundle for one page): \`skeptic observe <url> --full-page --video --trace\`.
- **Persistent regression coverage**: inspect, write a \`tests/*.spec.ts\`, then \`skeptic run\`.
- **Changed-code verification**: run existing specs with \`skeptic run\`.

If the \`skeptic\` binary is not on PATH, try \`npx skeptic-cli\` or \`npx --yes skeptic-cli@latest\`.

Specs import the project dependency \`skeptic-cli\`. A normal \`skeptic init\` writes that dependency to \`package.json\`. If specs fail with \`Cannot find package 'skeptic-cli'\`: in an initialized project run \`npm install\`; in a project that never ran \`skeptic init\`, run \`skeptic init\` first, then \`npm install\`.

## Persistent Browser Session

A daemon holds the browser, so \`@eN\` refs from one \`skeptic snapshot\` stay valid for the next \`skeptic click @eN\` — across separate commands. The loop:

\`\`\`bash
skeptic open https://app.example.com    # opens a session (default name "default")
skeptic snapshot -i                      # mints @e1.. refs + stable selectorHints
skeptic click @e3                        # act on a ref from the last snapshot
skeptic fill @e5 "user@test.com"
skeptic snapshot -i                      # RE-SNAPSHOT after the DOM changed
skeptic console --errors                 # check for uncaught errors
skeptic screenshot --full                # returns a file path
skeptic close                            # end the session
\`\`\`

Verbs: \`open\`, \`snapshot\` (\`-i\` interactive, \`-c\` compact), \`click\`, \`fill\`, \`type\`, \`press\`, \`hover\`, \`check\`, \`uncheck\`, \`select\`, \`get <text|box|url|title> [@ref]\`, \`screenshot\` (\`--full\`, \`--annotate\`), \`console\` (\`--errors\`), \`wait\` (\`--ms\` or \`--selector\`), \`list\`, \`close\` (\`--all\`). Add \`--json\` to any verb for machine-readable output.

Rules:

- **Re-snapshot after any navigation, route change, modal open/close, or DOM mutation.** Refs are minted per snapshot and invalidated by navigation; acting on a stale ref returns a clear \`[ariaRef:stale]\` error — re-run \`skeptic snapshot\`.
- Prefer \`@eN\` refs from the latest snapshot; for selectors, use the \`selectorHint\` grammar (\`role=button:Save\`, \`text=...\`, \`css=...\`, \`testid=...\`).
- Use \`--session <name>\` for parallel isolated sessions.
- The session browser defaults to headed for local debugging; pass \`--headless\` on the first \`open\` for headless environments (CI/containers).
- Binary outputs (screenshots) come back as file paths, not inline data.

## Mobile (Android)

The same verbs drive an Android app on an emulator or attached device via \`adb\` (no installed driver, no Appium). Pass \`--platform android\`; \`open\` takes a package name or deep link instead of a URL:

\`\`\`bash
skeptic open com.example.app --platform android   # launches the app
skeptic snapshot -i                                # uiautomator tree → @eN refs
skeptic click @e5                                  # taps the node's center
skeptic fill @e3 "user@test.com"                   # ASCII input
skeptic screenshot                                 # device screencap → file path
skeptic console --errors                           # logcat (app-filtered)
skeptic close
\`\`\`

Re-snapshot after every screen change; prefer \`res=\` (resource-id) and \`desc=\` (content-description) selectorHints over \`text=\`. \`adb\` text input is ASCII-only; non-ASCII \`fill\`/\`type\` returns a \`[adbInput:unicode_unsupported]\` error — set the value via a deep link or test seam instead. WebView contents are invisible to uiautomator; drive the web surface separately for in-WebView assertions. iOS simulator support (\`--platform ios-sim\`) is planned.

## Writing Specs

Skeptic specs import from \`skeptic-cli\`.

\`\`\`ts
import { test, expect } from "skeptic-cli";

test("homepage smoke", async ({ page, snapshot, screenshot, observability }) => {
  await page.goto("https://example.com");
  await expect(page).toHaveTitle(/Example Domain/);

  const tree = await snapshot(page, { interactive: true, compact: true });
  await (await tree.byRef("e1")).click();

  await screenshot("homepage", { fullPage: true });
  await observability.expectNoConsoleErrors();
});
\`\`\`

Rules:

- Put browser side effects inside \`test(...)\`, hooks, or helper functions called from tests.
- Prefer role, label, text, and test-id locators over CSS.
- \`await snapshot(page)\` before interacting through refs; \`tree.byRef("eN")\` is async — always \`await\` it.
- Re-snapshot after navigation, route changes, modal open/close, or major DOM mutation.
- Do not paste CLI \`@eN\` refs into specs. Use \`selectorHint\` from \`inspect\`, or \`tree.byRef("eN")\` only for refs from the same in-test \`snapshot(page)\` call.
- Add \`screenshot("name")\` for states that would help debug a failure.

## Observability Checks

Use \`--observability\` for real QA evidence. In specs, assert the signals that match the risk:

\`\`\`ts
await observability.expectNoConsoleErrors();
await observability.expectNoNetworkErrors({ allow: [/analytics/] });
await observability.expectPerformance({ lcp: "<2500ms", cls: "<0.1" });
await observability.expectAccessible({ standard: "WCAG21AA" });
\`\`\`

\`skeptic run\` always writes \`results.json\` to the output dir (default \`./skeptic-output\`). Use it plus screenshots, videos, traces, \`network.json\`, \`console.json\`, \`accessibility.json\`, and \`perf-trace.md\` as the evidence source. Reference artifact paths from \`results.json\` instead of guessing filenames. If an observability artifact reports a failure, fix the product or the test and re-run the same flow immediately.

## Verification Standard

Before reporting completion for browser-facing work:

- Run the smallest Skeptic command (session verbs or a spec) that actually exercises the changed behavior.
- Test at least one adjacent or negative path when forms, routing, validation, auth, persistence, or shared components changed.
- Read the full command output. Passing navigation alone is not enough.
- If there are console errors, network failures, serious accessibility issues, poor Web Vitals, or visible regressions, fix and re-run.
- State the exact command run and the main artifact path in the final report.
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
    // Bundled dist layout: dist/add-*.mjs sits next to the shipped cli/agent-skills.
    path.resolve(here, "../agent-skills", SKILL_NAME),
    // Dev source layout: src/commands/add.ts → cli/agent-skills.
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
