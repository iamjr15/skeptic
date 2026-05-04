#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "skeptic";
const MANAGED_MARKER = "skeptic-agent-skill: managed by skeptic-cli";
const RECOVERABLE_ENTRIES = new Set([".DS_Store", "Thumbs.db"]);
const SUPPORTED_AGENTS = ["claude", "codex", "cursor", "opencode"];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const sourceDir = path.join(packageRoot, "agent-skills", SKILL_NAME);

const skipRequested =
  process.env.SKEPTIC_SKIP_AGENT_SKILL_INSTALL === "1" ||
  process.env.SKEPTIC_INSTALL_AGENT_SKILLS === "0";
const ciSkip =
  process.env.CI && process.env.SKEPTIC_INSTALL_AGENT_SKILLS !== "1";

if (skipRequested || ciSkip) {
  process.exit(0);
}

try {
  if (!fs.existsSync(path.join(sourceDir, "SKILL.md"))) {
    console.warn("skeptic-cli: bundled agent skill not found; skipping skill install");
    process.exit(0);
  }

  const agents = parseAgents(process.env.SKEPTIC_AGENT_SKILLS);
  const results = agents.map((agent) => installSkill(targetDirForAgent(agent)));
  const changed = results.filter((result) => result === "installed" || result === "updated").length;

  if (changed > 0 && process.env.npm_config_loglevel !== "silent") {
    console.log(`skeptic-cli: installed agent skills for ${changed} coding agent location(s)`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`skeptic-cli: agent skill install skipped: ${message}`);
}

function parseAgents(value) {
  if (!value) return SUPPORTED_AGENTS;
  const requested = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (requested.includes("all")) return SUPPORTED_AGENTS;
  return requested.filter((entry) => SUPPORTED_AGENTS.includes(entry));
}

function targetDirForAgent(agent) {
  const home = process.env.HOME || os.homedir();
  if (agent === "codex") {
    return path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "skills", SKILL_NAME);
  }

  const baseByAgent = {
    claude: ".claude/skills",
    cursor: ".cursor/skills",
    opencode: ".opencode/skills",
  };
  return path.join(home, baseByAgent[agent], SKILL_NAME);
}

function installSkill(targetDir) {
  const targetSkillPath = path.join(targetDir, "SKILL.md");

  if (sameTree(sourceDir, targetDir)) return "already-installed";

  const existing = lstat(targetDir);
  if (existing) {
    if (existing.isSymbolicLink()) return "skipped";

    if (existing.isDirectory()) {
      if (!fs.existsSync(targetSkillPath)) {
        if (isRecoverableDirectory(targetDir)) {
          fs.rmSync(targetDir, { recursive: true, force: true });
        } else {
          return "skipped";
        }
      } else if (!isManagedSkill(targetSkillPath)) {
        return "skipped";
      } else {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
    } else if (existing.isFile()) {
      if (!isManagedSkill(targetDir)) return "skipped";
      fs.unlinkSync(targetDir);
    } else {
      return "skipped";
    }
  }

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
  return existing ? "updated" : "installed";
}

function lstat(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if (error instanceof Error && error.code === "ENOENT") return null;
    throw error;
  }
}

function isRecoverableDirectory(targetDir) {
  return fs.readdirSync(targetDir).every((entry) => RECOVERABLE_ENTRIES.has(entry));
}

function isManagedSkill(skillPath) {
  const content = fs.readFileSync(skillPath, "utf8");
  return (
    content.includes(MANAGED_MARKER) ||
    content.includes("# skeptic E2E Testing") ||
    content.includes("skeptic is a TypeScript test runner for AI agents")
  );
}

function sameTree(sourcePath, targetPath) {
  const sourceStats = lstat(sourcePath);
  const targetStats = lstat(targetPath);
  if (!sourceStats || !targetStats) return false;
  if (sourceStats.isSymbolicLink() || targetStats.isSymbolicLink()) return false;

  if (sourceStats.isDirectory() && targetStats.isDirectory()) {
    const sourceEntries = fs.readdirSync(sourcePath).sort();
    const targetEntries = fs.readdirSync(targetPath).sort();
    if (sourceEntries.length !== targetEntries.length) return false;
    return sourceEntries.every((entry, index) => {
      if (entry !== targetEntries[index]) return false;
      return sameTree(path.join(sourcePath, entry), path.join(targetPath, entry));
    });
  }

  if (sourceStats.isFile() && targetStats.isFile()) {
    return fs.readFileSync(sourcePath).equals(fs.readFileSync(targetPath));
  }

  return false;
}
