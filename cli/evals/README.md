# Skill evals

`skill-evals.mjs` runs **real host-agent sessions** against the bundled skeptic skill
(`agent-skills/skeptic/SKILL.md`) and scores whether the agent follows it. With MCP
gone, the skill is skeptic's only front door, so this is the standing quality gate for
it: given the skill, does an agent reach for the right verbs and avoid the removed
MCP/AI surface?

## How it works

Each case runs in a throwaway temp dir with:

- the skeptic skill installed at `<sandbox>/.claude/skills/skeptic` — **project-local**, so
  it never touches the real `~/.claude`; the agent loads it the same way a user would;
- a `skeptic` shim on `PATH` pointing at the built `dist/skeptic.mjs`.

The agent runs autonomously (`claude -p … --dangerously-skip-permissions`, or
`codex exec`) inside that sandbox. The harness parses the run's tool-call stream
(`--output-format stream-json`) and scores each case's rubric against the agent's
**actual** `Skill` invocations and `skeptic` commands — not its prose.

## Rubric

Shared checks every case includes:

- **triggered** — the agent invoked the skeptic skill (the `Skill` tool).
- **usedCli** — it actually ran the `skeptic` CLI.
- **noForbiddenSurface** — it never emitted removed surface (`browser_open`,
  `skeptic generate`, `--ai`/`--provider`/`--analyze`, `mcp`).

Plus a per-case behavior check (e.g. used the `inspect`/`open` discovery loop, ran a
spec via `skeptic run`, or passed `--platform android`).

## Run

```bash
npm run build                       # the shim execs dist/skeptic.mjs
node evals/skill-evals.mjs          # all cases, claude runner
node evals/skill-evals.mjs --case web-smoke
node evals/skill-evals.mjs --runner codex
node evals/skill-evals.mjs --json   # machine-readable; exit 1 if any rubric item fails
```

Each case spawns a full agent session (minutes + tokens), so this is a manual / CI
gate, not part of `npm test`. Exit code is non-zero when overall compliance < 100%,
so it can fail a CI job when a SKILL.md change regresses agent behavior.
