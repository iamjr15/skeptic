import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ENV_KEY_BY_PROVIDER } from "../../../src/ai/ai-client.js";

let tmpDir: string;

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => {
    throw new Error("not found");
  }),
}));

const workflowPath = () => path.join(tmpDir, ".github/workflows/skeptic-tests.yml");
const workflowsDir = () => path.join(tmpDir, ".github/workflows");

describe("add command", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-add-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    process.exitCode = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("runAddGitHubAction baseline workflow", () => {
    it("creates .github/workflows/skeptic-tests.yml", async () => {
      const { runAddGitHubAction } = await import("../../../src/commands/add.js");
      await runAddGitHubAction({});

      expect(fs.existsSync(workflowPath())).toBe(true);
      const content = fs.readFileSync(workflowPath(), "utf-8");
      expect(content).toContain("name: skeptic E2E Tests");
      expect(content).toContain("npx playwright install");
      expect(content).toContain("npx skeptic run");
      // Phase 2: scaffolded workflow now uses standalone `skeptic comment`, not inline JS
      expect(content).toContain("npx skeptic comment");
      expect(content).not.toContain("actions/github-script@v7");
      // Phase 2.3a: node bumped to 22 (matches package.json engines: >=22)
      expect(content).toContain("node-version: 22");
      // Phase 2.3b: explicit permissions for `gh pr comment`
      expect(content).toContain("pull-requests: write");
      // Phase 2.3c: explicit --pr and --run-url from GHA context (no detached-HEAD edge case)
      expect(content).toContain("--pr ${{ github.event.pull_request.number }}");
      expect(content).toContain(
        "--run-url ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
      );
    });

    it("uses custom dev command and URL", async () => {
      const { runAddGitHubAction } = await import("../../../src/commands/add.js");
      await runAddGitHubAction({
        devCommand: "yarn dev",
        devUrl: "http://localhost:4000",
      });

      const content = fs.readFileSync(workflowPath(), "utf-8");
      expect(content).toContain("yarn dev");
      expect(content).toContain("http://localhost:4000");
    });
  });

  describe("runAddGitHubAction AI env block", () => {
    it("has no provider env block when --ai is omitted", async () => {
      const { runAddGitHubAction } = await import("../../../src/commands/add.js");
      await runAddGitHubAction({});
      const content = fs.readFileSync(workflowPath(), "utf-8");
      for (const key of Object.values(ENV_KEY_BY_PROVIDER)) {
        expect(content).not.toContain(key);
      }
    });

    for (const provider of ["gemini", "openai", "anthropic"] as const) {
      it(`injects ${ENV_KEY_BY_PROVIDER[provider]} when --ai --provider=${provider}`, async () => {
        const { runAddGitHubAction } = await import("../../../src/commands/add.js");
        await runAddGitHubAction({ ai: true, provider });
        const content = fs.readFileSync(workflowPath(), "utf-8");
        const expected = ENV_KEY_BY_PROVIDER[provider];
        expect(content).toContain(`${expected}: \${{ secrets.${expected} }}`);
        for (const key of Object.values(ENV_KEY_BY_PROVIDER)) {
          if (key !== expected) expect(content).not.toContain(key);
        }
      });
    }
  });

  describe("runAddGitHubAction AI runtime drift fixes (Phase 5)", () => {
    // Helper: extract the YAML chunk for the step containing `npx skeptic run`
    // so assertions are scoped to that step's `env:` block, not job-level / other steps.
    function extractTestStep(yaml: string): string {
      const stepHeaders = yaml.split(/\n\s+- name: /);
      const testStep = stepHeaders.find((s) => s.includes("npx skeptic run"));
      if (!testStep) throw new Error("Could not find skeptic run step in YAML");
      return testStep;
    }

    for (const provider of ["gemini", "openai", "anthropic"] as const) {
      it(`emits SKEPTIC_AI_PROVIDER=${provider} in test step env when --ai --provider=${provider}`, async () => {
        const { runAddGitHubAction } = await import("../../../src/commands/add.js");
        await runAddGitHubAction({ ai: true, provider });
        const yaml = fs.readFileSync(workflowPath(), "utf-8");
        const testStep = extractTestStep(yaml);
        expect(testStep).toContain(`SKEPTIC_AI_PROVIDER: ${provider}`);
      });

      it(`emits SKEPTIC_AI_API_KEY referencing the same secret as the API key env (${provider})`, async () => {
        const { runAddGitHubAction } = await import("../../../src/commands/add.js");
        await runAddGitHubAction({ ai: true, provider });
        const yaml = fs.readFileSync(workflowPath(), "utf-8");
        const testStep = extractTestStep(yaml);
        const envKey = ENV_KEY_BY_PROVIDER[provider];
        expect(testStep).toContain(`SKEPTIC_AI_API_KEY: \${{ secrets.${envKey} }}`);
      });

      it(`appends --analyze to the test command for --ai --provider=${provider}`, async () => {
        const { runAddGitHubAction } = await import("../../../src/commands/add.js");
        await runAddGitHubAction({ ai: true, provider });
        const yaml = fs.readFileSync(workflowPath(), "utf-8");
        expect(yaml).toMatch(/npx skeptic run .* --analyze/);
      });
    }

    it("does NOT emit SKEPTIC_AI_PROVIDER, SKEPTIC_AI_API_KEY, or --analyze when --ai is omitted", async () => {
      const { runAddGitHubAction } = await import("../../../src/commands/add.js");
      await runAddGitHubAction({});
      const yaml = fs.readFileSync(workflowPath(), "utf-8");
      expect(yaml).not.toContain("SKEPTIC_AI_PROVIDER");
      expect(yaml).not.toContain("SKEPTIC_AI_API_KEY");
      expect(yaml).not.toContain("--analyze");
    });

    it("stale ai.apiKey: $GEMINI_API_KEY in config doesn't break --ai --provider openai workflow", async () => {
      // The Codex round-6 scenario: user has the README example apiKey in their config but
      // scaffolds with --provider openai. The workflow must surface the OpenAI key through
      // SKEPTIC_AI_API_KEY so runtime apiKey is non-empty regardless of stale config.
      fs.writeFileSync(
        path.join(tmpDir, "skeptic.config.yaml"),
        "ai:\n  provider: gemini\n  apiKey: $GEMINI_API_KEY\n",
        "utf-8",
      );
      const { runAddGitHubAction } = await import("../../../src/commands/add.js");
      await runAddGitHubAction({ ai: true, provider: "openai" });
      const yaml = fs.readFileSync(workflowPath(), "utf-8");

      // All three injections present, all referencing OpenAI's secret
      expect(yaml).toContain("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
      expect(yaml).toContain("SKEPTIC_AI_PROVIDER: openai");
      expect(yaml).toContain("SKEPTIC_AI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");

      // Step-scoped: all three live in the test step's env: block (not somewhere else)
      const testStep = extractTestStep(yaml);
      expect(testStep).toContain("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
      expect(testStep).toContain("SKEPTIC_AI_PROVIDER: openai");
      expect(testStep).toContain("SKEPTIC_AI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");

      // Negative: nothing references GEMINI_API_KEY anywhere
      expect(yaml).not.toContain("GEMINI_API_KEY");
    });
  });

  describe("runAddGitHubAction config-driven provider", () => {
    it("reads provider from skeptic.config.yaml when --provider is omitted", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "skeptic.config.yaml"),
        `ai:\n  provider: anthropic\n`,
        "utf-8",
      );
      const { runAddGitHubAction } = await import("../../../src/commands/add.js");
      await runAddGitHubAction({ ai: true });
      const content = fs.readFileSync(workflowPath(), "utf-8");
      expect(content).toContain("ANTHROPIC_API_KEY");
      expect(content).not.toContain("GEMINI_API_KEY");
      expect(content).not.toContain("OPENAI_API_KEY");
    });

    it("defaults to gemini when no config exists", async () => {
      const { runAddGitHubAction } = await import("../../../src/commands/add.js");
      await runAddGitHubAction({ ai: true });
      const content = fs.readFileSync(workflowPath(), "utf-8");
      expect(content).toContain("GEMINI_API_KEY");
    });

    it("CLI --provider overrides config", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "skeptic.config.yaml"),
        `ai:\n  provider: gemini\n`,
        "utf-8",
      );
      const { runAddGitHubAction } = await import("../../../src/commands/add.js");
      await runAddGitHubAction({ ai: true, provider: "openai" });
      const content = fs.readFileSync(workflowPath(), "utf-8");
      expect(content).toContain("OPENAI_API_KEY");
      expect(content).not.toContain("GEMINI_API_KEY");
    });
  });

  describe("runAddGitHubAction console guidance", () => {
    it("prints provider-aware guidance mentioning the correct env var (anthropic)", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const { runAddGitHubAction } = await import("../../../src/commands/add.js");
      await runAddGitHubAction({ ai: true, provider: "anthropic" });
      const printed = logSpy.mock.calls.flat().join("\n");
      expect(printed).toContain("ANTHROPIC_API_KEY");
      expect(printed).toContain("anthropic");
      expect(printed).not.toContain("GEMINI_API_KEY");
      logSpy.mockRestore();
    });

    it("prints gemini guidance when --ai without --provider and no config", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const { runAddGitHubAction } = await import("../../../src/commands/add.js");
      await runAddGitHubAction({ ai: true });
      const printed = logSpy.mock.calls.flat().join("\n");
      expect(printed).toContain("GEMINI_API_KEY");
      logSpy.mockRestore();
    });

    it("prints no API-key guidance when --ai is omitted", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const { runAddGitHubAction } = await import("../../../src/commands/add.js");
      await runAddGitHubAction({});
      const printed = logSpy.mock.calls.flat().join("\n");
      for (const key of Object.values(ENV_KEY_BY_PROVIDER)) {
        expect(printed).not.toContain(key);
      }
      logSpy.mockRestore();
    });
  });

  describe("runAddGitHubAction error paths", () => {
    it("errors when --provider is passed without --ai", async () => {
      const { runAddGitHubAction } = await import("../../../src/commands/add.js");
      await runAddGitHubAction({ provider: "openai" });
      expect(process.exitCode).toBe(1);
      expect(fs.existsSync(workflowPath())).toBe(false);
      expect(fs.existsSync(workflowsDir())).toBe(false);
    });

    it("errors on invalid --provider value (zod enum rejection)", async () => {
      const { runAddGitHubAction } = await import("../../../src/commands/add.js");
      await runAddGitHubAction({ ai: true, provider: "claude" });
      expect(process.exitCode).toBe(1);
      expect(fs.existsSync(workflowPath())).toBe(false);
      expect(fs.existsSync(workflowsDir())).toBe(false);
    });

    it("errors cleanly when --config points to a missing file", async () => {
      const { runAddGitHubAction } = await import("../../../src/commands/add.js");
      await runAddGitHubAction({
        ai: true,
        config: path.join(tmpDir, "nonexistent.yaml"),
      });
      expect(process.exitCode).toBe(1);
      expect(fs.existsSync(workflowPath())).toBe(false);
      expect(fs.existsSync(workflowsDir())).toBe(false);
    });

    it("errors cleanly on malformed config YAML", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "skeptic.config.yaml"),
        `ai:\n  provider: "unterminated`,
        "utf-8",
      );
      const { runAddGitHubAction } = await import("../../../src/commands/add.js");
      await runAddGitHubAction({ ai: true });
      expect(process.exitCode).toBe(1);
      expect(fs.existsSync(workflowPath())).toBe(false);
      expect(fs.existsSync(workflowsDir())).toBe(false);
    });
  });

  describe("runAddSkill", () => {
    it("creates .claude/skills/skeptic/SKILL.md for claude agent", async () => {
      const { runAddSkill } = await import("../../../src/commands/add.js");
      await runAddSkill({ agent: "claude" });

      const skillPath = path.join(tmpDir, ".claude/skills/skeptic/SKILL.md");
      expect(fs.existsSync(skillPath)).toBe(true);

      const content = fs.readFileSync(skillPath, "utf-8");
      expect(content).toContain("name: skeptic");
      expect(content).toContain("skeptic run");
      expect(content).toContain("skeptic-agent-skill: managed by skeptic-cli");
    });

    it("creates .agents/skills/skeptic/SKILL.md for codex agent", async () => {
      const { runAddSkill } = await import("../../../src/commands/add.js");
      await runAddSkill({ agent: "codex" });

      const skillPath = path.join(tmpDir, ".agents/skills/skeptic/SKILL.md");
      expect(fs.existsSync(skillPath)).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, ".agents/skills/skeptic/agents/openai.yaml"))).toBe(
        true,
      );
    });

    it("creates .cursor/skills/skeptic/SKILL.md for cursor agent", async () => {
      const { runAddSkill } = await import("../../../src/commands/add.js");
      await runAddSkill({ agent: "cursor" });

      const skillPath = path.join(tmpDir, ".cursor/skills/skeptic/SKILL.md");
      expect(fs.existsSync(skillPath)).toBe(true);
    });

    it("creates project skill directories for all supported agents", async () => {
      const { runAddSkill } = await import("../../../src/commands/add.js");
      await runAddSkill({ agent: "all" });

      expect(fs.existsSync(path.join(tmpDir, ".claude/skills/skeptic/SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, ".agents/skills/skeptic/SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, ".cursor/skills/skeptic/SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, ".opencode/skills/skeptic/SKILL.md"))).toBe(true);
    });

    it("creates user skill directories for claude and codex", async () => {
      const homeDir = path.join(tmpDir, "home");
      const codexHome = path.join(tmpDir, "codex-home");
      vi.stubEnv("HOME", homeDir);
      vi.stubEnv("CODEX_HOME", codexHome);

      const { runAddSkill } = await import("../../../src/commands/add.js");
      await runAddSkill({ agent: "all", scope: "user" });

      expect(fs.existsSync(path.join(homeDir, ".claude/skills/skeptic/SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(codexHome, "skills/skeptic/SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(homeDir, ".cursor/skills/skeptic/SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(homeDir, ".opencode/skills/skeptic/SKILL.md"))).toBe(true);
    });

    it("does not overwrite an existing non-skeptic skill", async () => {
      const skillDir = path.join(tmpDir, ".claude/skills/skeptic");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: skeptic\n---\ncustom", "utf-8");

      const { runAddSkill } = await import("../../../src/commands/add.js");
      await runAddSkill({ agent: "claude" });

      expect(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8")).toBe(
        "---\nname: skeptic\n---\ncustom",
      );
      expect(process.exitCode).toBe(1);
    });

    it("updates an existing skeptic-managed skill", async () => {
      const skillDir = path.join(tmpDir, ".agents/skills/skeptic");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "<!-- skeptic-agent-skill: managed by skeptic-cli -->\nold",
        "utf-8",
      );

      const { runAddSkill } = await import("../../../src/commands/add.js");
      await runAddSkill({ agent: "codex" });

      const content = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8");
      expect(content).toContain("name: skeptic");
      expect(content).not.toContain("\nold");
    });

    it("sets exitCode for unknown agent", async () => {
      const { runAddSkill } = await import("../../../src/commands/add.js");
      await runAddSkill({ agent: "unknown-agent" });
      expect(process.exitCode).toBe(1);
    });

    it("sets exitCode for unknown scope", async () => {
      const { runAddSkill } = await import("../../../src/commands/add.js");
      await runAddSkill({ agent: "claude", scope: "workspace" });
      expect(process.exitCode).toBe(1);
    });
  });
});
