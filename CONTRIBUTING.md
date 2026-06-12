# Contributing to skeptic

Thanks for your interest in improving skeptic. This guide covers local setup,
the code style we follow, and how to run and verify changes.

## Project layout

- [`cli/`](./cli) — the TypeScript CLI (the package published as `skeptic-cli`).
- [`cli/src/`](./cli/src) — source: `commands/`, `runner/`, `executor/`,
  `observability/`, `daemon/`, `cookies/`, `config/`, `api/`, `ui/`, `utils/`.
- [`cli/__tests__/`](./cli/__tests__) — Vitest test suites.
- [`cli/AGENTS.md`](./cli/AGENTS.md) — guidance for AI coding agents using skeptic.

skeptic is **agent-native**: a skill, a CLI, and a daemon. There is no MCP
server, no ACP server, and no built-in AI/model subsystem — please do not
reintroduce them or add LLM/API-key dependencies.

## Dev setup

All commands run from the `cli/` directory.

```bash
cd cli
npm install        # install dependencies (Node >= 22)
npm run build      # bundle with tsup -> dist/
npm run check      # type-check only (tsc --noEmit)
npm test           # run the Vitest suite once
```

Useful extras:

```bash
npm run dev        # tsup --watch (rebuild on change)
npm run test:watch # Vitest in watch mode
node dist/skeptic.mjs --help   # run the freshly built CLI
```

To exercise browser-backed paths locally, install Playwright's Chromium once:

```bash
node dist/skeptic.mjs browsers install chromium
```

## Running a single test

Vitest takes a file path and/or a name filter:

```bash
# A single test file
npx vitest run __tests__/cookies/crypto.test.ts

# Filter by test name (substring or regex)
npx vitest run -t "strips the M127 host_key prefix"

# Both together
npx vitest run __tests__/cookies/crypto.test.ts -t "decrypt"
```

Add a regression test under `cli/__tests__/` for every bug fix, matching the
style of the nearest existing suite.

## Code style

These conventions are enforced by review (see [`CLAUDE.md`](./CLAUDE.md)):

- **Arrow functions** are preferred.
- **`interface` over `type`** where an interface works.
- **kebab-case filenames** (e.g. `network-collector.ts`).
- **Descriptive variable names**; avoid abbreviations that need a mental decode.
- **No comments unless they explain a non-obvious "why."** Don't narrate what
  the code already says.
- **ESM only** (`"type": "module"`); strict TypeScript, ES2022 target.
- Step handlers and collectors stay close to pure functions with explicit
  inputs and outputs.

## Before you open a PR

1. `npm run check` passes with zero new type errors.
2. `npm test` passes (add/adjust tests for your change).
3. `npm run build` succeeds.
4. Update [`CHANGELOG.md`](./CHANGELOG.md) under `[Unreleased]` for any
   user-facing change.
5. Keep the change minimal and focused — touch only what the change requires.

## Reporting bugs and security issues

- Functional bugs: open a GitHub issue with the command you ran, the relevant
  `results.json`, and the first failing step.
- Security vulnerabilities: **do not** open a public issue — follow
  [SECURITY.md](./SECURITY.md).
