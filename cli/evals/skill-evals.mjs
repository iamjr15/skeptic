#!/usr/bin/env node
// Skill-evals harness — runs REAL host-agent sessions (claude -p / codex exec) against
// the bundled skeptic skill and scores SKILL.md compliance from the agent's actual tool
// calls. The skill is skeptic's only front door (no MCP), so this is the standing quality
// gate: does an agent, given the skill, reach for the right verbs and avoid removed surface?
//
//   node evals/skill-evals.mjs                 # all cases, claude runner
//   node evals/skill-evals.mjs --runner codex  # use `codex exec` instead
//   node evals/skill-evals.mjs --case web-smoke # one case
//   node evals/skill-evals.mjs --json          # machine-readable report
//
// Isolation: each case runs in a throwaway temp dir with the skeptic skill installed at
// <sandbox>/.claude/skills/skeptic (project-local — never touches the real ~/.claude) and
// a `skeptic` shim on PATH pointing at the built dist. The agent runs autonomously
// (--dangerously-skip-permissions) inside that sandbox.

import { mkdtempSync, cpSync, writeFileSync, mkdirSync, chmodSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_SRC = join(ROOT, "agent-skills", "skeptic");
const DIST_SKEPTIC = join(ROOT, "dist", "skeptic.mjs");

// ── Rubric helpers ──────────────────────────────────────────────────────────
const some = (arr, re) => arr.some((s) => re.test(s));
// Surface that was DELETED with the MCP/AI subsystem — an agent must never emit it.
const FORBIDDEN = /\bbrowser_(open|click|snapshot|playwright|close)\b|\bskeptic\s+generate\b|--ai\b|--provider\b|--analyze\b|\bmcp\b/i;

const RUBRIC = {
  triggered: {
    label: "invoked the skeptic skill",
    check: ({ skills }) => some(skills, /skeptic/i),
  },
  usedCli: {
    label: "ran the skeptic CLI",
    // `\b` matches both `skeptic …` and codex's `/bin/zsh -lc 'skeptic …'` wrapper.
    check: ({ commands }) => some(commands, /\bskeptic\s/),
  },
  noForbiddenSurface: {
    label: "avoided removed MCP/AI surface",
    check: ({ commands, skills }) => !some(commands, FORBIDDEN) && !some(skills, FORBIDDEN),
  },
};

// ── Eval cases ──────────────────────────────────────────────────────────────
const verbUsed = (commands, re) => some(commands, re);
const CASES = [
  {
    name: "web-smoke",
    prompt:
      "Using the skeptic QA tool, verify that the homepage at https://example.com loads and shows the title \"Example Domain\". Inspect the page and confirm the heading is present. You have the `skeptic` CLI available.",
    rubric: ["triggered", "usedCli", "noForbiddenSurface", {
      label: "used the inspect/open discovery loop",
      check: ({ commands }) => verbUsed(commands, /skeptic\s+(inspect|open|snapshot)\b/),
    }],
  },
  {
    name: "web-regression",
    prompt:
      "Using the skeptic QA tool, write a persistent regression spec that checks the page at https://example.com has a working link, then run it. The `skeptic` CLI is available.",
    rubric: ["triggered", "usedCli", "noForbiddenSurface", {
      label: "ran a *.spec.ts via `skeptic run`",
      check: ({ commands }) => verbUsed(commands, /skeptic\s+run\b/),
    }],
  },
  {
    name: "android-platform",
    prompt:
      "Using the skeptic QA tool, open the Android Settings app (package com.android.settings) on the connected emulator, snapshot its first screen, and tell me the first few items you see. The `skeptic` CLI is available and an emulator is running.",
    rubric: ["triggered", "usedCli", "noForbiddenSurface", {
      label: "used --platform android",
      check: ({ commands }) => verbUsed(commands, /--platform\s+android\b/),
    }],
  },
];

// ── Sandbox + runners ───────────────────────────────────────────────────────
const setupSandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), "skeptic-eval-"));
  // claude: loads project-local skills from .claude/skills (isolated from ~/.claude).
  cpSync(SKILL_SRC, join(dir, ".claude", "skills", "skeptic"), { recursive: true });
  // codex: has no Skill mechanism — it reads ambient AGENTS.md, so inject the skill there.
  cpSync(join(SKILL_SRC, "SKILL.md"), join(dir, "AGENTS.md"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const shim = join(binDir, "skeptic");
  writeFileSync(shim, `#!/bin/sh\nexec node "${DIST_SKEPTIC}" "$@"\n`);
  chmodSync(shim, 0o755);
  return { dir, binDir };
};

const parseClaudeEvents = (jsonl) => {
  const skills = [];
  const commands = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "assistant") {
      for (const c of ev.message?.content ?? []) {
        if (c?.type !== "tool_use") continue;
        if (c.name === "Skill") skills.push(String(c.input?.skill ?? c.input?.command ?? ""));
        if (c.name === "Bash") commands.push(String(c.input?.command ?? ""));
      }
    }
  }
  return { skills, commands };
};

const runClaude = (prompt, sandbox) => {
  const r = spawnSync(
    "claude",
    ["-p", prompt, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions",
      "--allowedTools", "Bash Read Write Edit Skill", "--add-dir", sandbox.dir],
    {
      cwd: sandbox.dir,
      env: { ...process.env, PATH: `${sandbox.binDir}:${process.env.PATH}` },
      input: "",
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 128 * 1024 * 1024,
    },
  );
  return { ...parseClaudeEvents(r.stdout ?? ""), stderr: r.stderr ?? "", status: r.status };
};

const parseCodexEvents = (out) => {
  // codex exec --json emits JSONL `{type:"item.completed", item:{type:"command_execution",
  // command:"/bin/zsh -lc '…'"}}`. codex has no Skill tool — the skeptic skill is ambient
  // via AGENTS.md (always in context), so we mark it "triggered" by construction.
  const commands = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const item = ev?.item;
    if (item?.type === "command_execution" && item.command) commands.push(String(item.command));
  }
  return { skills: ["skeptic (AGENTS.md)"], commands };
};

const runCodex = (prompt, sandbox) => {
  const r = spawnSync(
    "codex",
    ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--cd", sandbox.dir, prompt],
    {
      cwd: sandbox.dir,
      env: { ...process.env, PATH: `${sandbox.binDir}:${process.env.PATH}` },
      input: "",
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 128 * 1024 * 1024,
    },
  );
  return { ...parseCodexEvents(r.stdout ?? ""), stderr: r.stderr ?? "", status: r.status };
};

// ── Scoring + report ────────────────────────────────────────────────────────
const scoreCase = (testCase, transcript) => {
  const items = testCase.rubric.map((r) => {
    const def = typeof r === "string" ? RUBRIC[r] : r;
    return { label: def.label, passed: Boolean(def.check(transcript)) };
  });
  const passed = items.filter((i) => i.passed).length;
  return { name: testCase.name, items, score: passed / items.length, commands: transcript.commands, skills: transcript.skills };
};

const main = () => {
  const args = process.argv.slice(2);
  const runner = args.includes("--runner") ? args[args.indexOf("--runner") + 1] : "claude";
  const only = args.includes("--case") ? args[args.indexOf("--case") + 1] : null;
  const asJson = args.includes("--json");

  if (!existsSync(DIST_SKEPTIC)) {
    console.error(`dist not built — run \`npm run build\` first (${DIST_SKEPTIC} missing)`);
    process.exit(2);
  }
  const run = runner === "codex" ? runCodex : runClaude;
  const cases = only ? CASES.filter((c) => c.name === only) : CASES;
  if (cases.length === 0) {
    console.error(`no case named "${only}" (have: ${CASES.map((c) => c.name).join(", ")})`);
    process.exit(2);
  }

  const results = [];
  for (const testCase of cases) {
    if (!asJson) process.stderr.write(`▶ ${runner}: ${testCase.name} … `);
    const sandbox = setupSandbox();
    try {
      const transcript = run(testCase.prompt, sandbox);
      const result = scoreCase(testCase, transcript);
      results.push(result);
      if (!asJson) process.stderr.write(`${Math.round(result.score * 100)}% (${result.commands.length} cmds)\n`);
    } finally {
      rmSync(sandbox.dir, { recursive: true, force: true });
    }
  }

  const overall = results.reduce((s, r) => s + r.score, 0) / (results.length || 1);
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ runner, overall, results }, null, 2)}\n`);
  } else {
    console.log(`\n── Skill-eval report (${runner}) ──`);
    for (const r of results) {
      console.log(`\n${r.score === 1 ? "✓" : "✗"} ${r.name}  ${Math.round(r.score * 100)}%`);
      for (const i of r.items) console.log(`    ${i.passed ? "✓" : "✗"} ${i.label}`);
      if (r.score < 1) console.log(`    skeptic cmds: ${r.commands.filter((c) => /skeptic/.test(c)).slice(0, 4).map((c) => JSON.stringify(c.slice(0, 60))).join(", ") || "(none)"}`);
    }
    console.log(`\nOverall compliance: ${Math.round(overall * 100)}%  (${results.length} case(s))`);
  }
  // Non-zero exit when any rubric item failed — usable as a CI gate.
  process.exit(overall === 1 ? 0 : 1);
};

main();
