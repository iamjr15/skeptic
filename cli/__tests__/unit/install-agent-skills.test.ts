import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let tmpDir: string;
let homeDir: string;
let codexHome: string;

const scriptPath = path.resolve("scripts/install-agent-skills.mjs");

describe("install-agent-skills postinstall script", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-agent-skills-"));
    homeDir = path.join(tmpDir, "home");
    codexHome = path.join(tmpDir, "codex-home");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("installs the bundled skill into all supported user locations", () => {
    runPostinstall();

    expect(fs.existsSync(path.join(homeDir, ".claude/skills/skeptic/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(codexHome, "skills/skeptic/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(homeDir, ".cursor/skills/skeptic/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(homeDir, ".opencode/skills/skeptic/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(codexHome, "skills/skeptic/agents/openai.yaml"))).toBe(true);
  });

  it("honors SKEPTIC_AGENT_SKILLS subsets", () => {
    runPostinstall({ SKEPTIC_AGENT_SKILLS: "claude,codex" });

    expect(fs.existsSync(path.join(homeDir, ".claude/skills/skeptic/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(codexHome, "skills/skeptic/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(homeDir, ".cursor/skills/skeptic/SKILL.md"))).toBe(false);
    expect(fs.existsSync(path.join(homeDir, ".opencode/skills/skeptic/SKILL.md"))).toBe(false);
  });

  it("does not overwrite an existing unmanaged skill", () => {
    const skillDir = path.join(homeDir, ".claude/skills/skeptic");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: skeptic\n---\ncustom", "utf-8");

    runPostinstall({ SKEPTIC_AGENT_SKILLS: "claude" });

    expect(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8")).toBe(
      "---\nname: skeptic\n---\ncustom",
    );
  });

  it("updates an existing skeptic-managed skill", () => {
    const skillDir = path.join(codexHome, "skills/skeptic");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "<!-- skeptic-agent-skill: managed by skeptic-cli -->\nold",
      "utf-8",
    );

    runPostinstall({ SKEPTIC_AGENT_SKILLS: "codex" });

    const content = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8");
    expect(content).toContain("name: skeptic");
    expect(content).not.toContain("\nold");
  });
});

function runPostinstall(extraEnv: NodeJS.ProcessEnv = {}): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    CODEX_HOME: codexHome,
    SKEPTIC_INSTALL_AGENT_SKILLS: "1",
    npm_config_loglevel: "silent",
    ...extraEnv,
  };
  delete env.SKEPTIC_SKIP_AGENT_SKILL_INSTALL;

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: path.resolve("."),
    env,
    encoding: "utf-8",
  });

  expect(result.status, result.stderr || result.stdout).toBe(0);
}
