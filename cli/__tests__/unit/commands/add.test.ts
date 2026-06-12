import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

    it("emits no AI provider env, secrets, or --analyze flag", async () => {
      const { runAddGitHubAction } = await import("../../../src/commands/add.js");
      await runAddGitHubAction({});
      const yaml = fs.readFileSync(workflowPath(), "utf-8");
      expect(yaml).not.toContain("SKEPTIC_AI_PROVIDER");
      expect(yaml).not.toContain("SKEPTIC_AI_API_KEY");
      expect(yaml).not.toContain("--analyze");
      expect(yaml).not.toContain("GEMINI_API_KEY");
      expect(yaml).not.toContain("OPENAI_API_KEY");
      expect(yaml).not.toContain("ANTHROPIC_API_KEY");
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
