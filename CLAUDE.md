# CLAUDE.md — skeptic

## Project Overview

skeptic is an **agent-native, CLI-first QA tool**. A host coding agent (Claude
Code, Codex, Cursor, OpenCode, …) drives it through a bundled skill and a CLI to
inspect live pages, run deterministic TypeScript end-to-end specs with
Playwright, and read back a rich evidence bundle (screenshots, video, traces,
performance, network, console, accessibility).

skeptic brings **no model of its own**. It uses **no API keys** and makes **no
LLM calls**. The intelligence comes from the host agent; skeptic is the
deterministic execution and evidence layer. There is no MCP server, no ACP
server, and no built-in AI/model subsystem — do not reintroduce them, import
from `src/ai`/`src/mcp`/`src/acp` (they no longer exist), or add LLM calls.

Web QA ships today (Playwright). Native **mobile** QA (driving devices and
emulators via `adb` and `simctl`) is on the roadmap; the agent loop and evidence
model are designed to extend to it.

## Architecture

skeptic is three pieces — **skill + CLI + daemon**:

- **Skill:** `cli/agent-skills/skeptic/` — agent-facing guidance that routes a
  coding agent through the inspect → author/run → read-evidence loop. Installed
  into agent skill directories by `scripts/install-agent-skills.mjs` on
  `npm install` (skipped in CI unless opted in).
- **CLI package:** `cli/` — TypeScript (ESM), Commander, Playwright, Zod.
  - `src/index.ts` — command surface: `init`, `run`, `tui`, `observe`,
    `inspect`, `doctor`, `add` (`github-action`, `skill`), `cookies`,
    `browsers`, `daemon`, `comment`, `audit`.
  - `src/runner/` — spec discovery and worker-thread execution
    (`discover.ts`, `execute.ts`, `worker.ts`, `ipc.ts`, `watch.ts`).
  - `src/executor/` — Playwright engine, ARIA/cursor snapshot capture, ref
    resolution, cursor/annotation overlays, visual settle, sharding.
  - `src/observability/` — performance, network, console/page-error, and
    accessibility collectors plus sidecar writers.
  - `src/daemon/` — persistent Playwright `BrowserServer` over a Unix socket so
    repeated `run`/`inspect` calls reuse a warm browser.
  - `src/cookies/`, `src/config/`, `src/api/` (public `test`/`expect` and
    fixtures), `src/reporter/`, `src/ui/` (Ink TUI), `src/safety/`, `src/utils/`.
- **Daemon:** the `BrowserServer` lifecycle/control plane (`~/.skeptic/`),
  managed via `skeptic daemon start|stop|status|logs` and auto-spawned when a
  browser-using command needs it.

## Key Technical Decisions

- TypeScript + Node.js, ESM (`"type": "module"`), `engines.node >= 22`.
- `tsconfig.json`: strict, Node16 module resolution, ES2022 target.
- **tsup** bundles to `dist/` (entry points `skeptic`, `index`, `worker`);
  `bin/launcher.mjs` is the published bin and loads `dist/skeptic.mjs`.
- Playwright for browser automation (not Puppeteer).
- TypeScript `*.spec.ts` specs that `import { test, expect } from "skeptic-cli"`
  — no bespoke YAML flow format.
- Zod for all schema validation; Commander for the CLI framework.
- Config precedence: CLI flags > env vars > config file > defaults.
- Cookie extraction is opt-in (`--cookies` flag, default off) and stays local;
  Chromium decryption strips the M127+ `host_key` hash prefix.
- A persistent daemon reuses a warm `BrowserServer` across invocations.
- **No API keys, no outbound LLM calls.** Execution is fully deterministic.

## Runtime notes

- Specs run in **worker threads** (`src/runner/worker.ts`); the parent
  coordinates discovery, sharding, and reporting over `src/runner/ipc.ts`.
- A **hard per-test timeout** ceiling is enforced by the runner independent of
  Playwright's soft action timeout (`--hard-timeout`); see `src/runner/` and
  `src/executor/context.ts`.
- `skeptic inspect --connect <url>` attaches to an existing browser over CDP
  (auto-discovery). This is page inspection only and is unrelated to the
  removed AI flow.

## Code Style

- Arrow functions preferred.
- No comments unless explaining a non-obvious "why".
- Descriptive variable names.
- `interface` over `type` where possible.
- kebab-case filenames.

## Build & Test

```bash
cd cli
npm run build      # bundle with tsup
npm run check      # type-check only (tsc --noEmit)
npm test           # run vitest
npm run dev        # tsup watch-mode build

# Run a single test file or name filter
npx vitest run __tests__/<suite>.test.ts
npx vitest run -t "test name substring"
```
