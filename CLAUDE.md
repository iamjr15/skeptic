# CLAUDE.md — skeptic CLI

## Project Overview

skeptic is a CLI-first E2E testing tool combining Maestro-style declarative YAML flows with Expect-style AI-powered diff-aware test generation. Users write YAML test flows that Playwright executes deterministically, with optional AI assertions via Gemini.

## Architecture

- **CLI package:** `cli/` — TypeScript, Commander, Playwright, Zod
- **Plan:** `plans/eager-crunching-popcorn.md` — Full implementation plan

## Key Technical Decisions

- TypeScript + Node.js (ESM, `"type": "module"`)
- `tsconfig.json`: strict, Node16 module resolution, ES2022 target
- Playwright for browser automation (not Puppeteer)
- YAML with front-matter (`---` delimiter) for flow files
- Zod for all schema validation
- Commander for CLI framework
- Config precedence: CLI flags > env vars > flow-level > config file > defaults
- Cookie extraction is opt-in (`--cookies` flag, default off)
- rrweb recording on by default, replays are local HTML files
- AI features require explicit `GEMINI_API_KEY` config

### Executor invariants (Bundle 1 — runtime reliability)

- **`hardTimeout` is enforced by Promise.race, not just Playwright's `setDefaultTimeout`.** Several handlers hard-code their own timeouts or ignore the default (`assert-visible.ts`, `wait.ts`, etc.), so `ctx.activeTimeout` alone is not a reliable ceiling. `raceWithHardTimeout` in `nested-executor.ts` wraps every step-body Promise against a Node-side `setTimeout`; whichever resolves first wins.
- **Hard-timeout sets `ctx.abortReason`.** Every composite handler (`retry`, `repeat`, `run-flow`) and the top-level flow-body loop must check this flag before any dispatch or `when`/`while` condition evaluation. The order is always `abortReason → when → handler`.
- **`ctx.inTeardown` bypasses the abort check.** It's a ctx-level boolean flipped only inside the `onFlowComplete` try/finally in `playwright-engine.ts`. Because it lives on the shared context object, composite teardown hooks (e.g. `retry:` inside `onFlowComplete`) inherit it through their own `executeNestedSteps` calls without any per-call plumbing. The per-call `continueOnError` option is a separate, orthogonal knob for ignoring step errors within a list.
- **`ctx.abortReason` is cleared on non-fatal paths.** Both the `optional: true` downgrade branches (nested-executor + playwright-engine) and the `onFlowStart` hook-failure warning branch must set `ctx.abortReason = null` so a hardTimeout inside those contexts doesn't halt the rest of the flow.
- **Any body passed to `raceWithHardTimeout` must re-check `ctx.abortReason` between awaits.** Promise.race cannot cancel the body; if the timer wins, the body keeps running in the background. Every side-effecting `await` (especially destructive ones like a retry click) must be preceded by `if (ctx.abortReason !== null) return result;`. See `buildStepBody` in `nested-executor.ts` for the canonical shape.

## Code Style

- Arrow functions preferred
- No comments unless explaining non-obvious "why"
- Descriptive variable names
- `interface` over `type` where possible
- kebab-case filenames
- Each step handler is a pure function: `(page, ctx, args) => Promise<StepResult>`

## Build & Test

```bash
cd cli
npm run build      # TypeScript compile
npm run check      # Type check only
npm test           # Run vitest
npm run dev        # Watch mode compile
```

## Extracted Code References (from old platform, saved at /tmp/skeptic-extract/)

- `device_profiles.py` → port to `cli/src/config/device-profiles.ts`
- `vision_activities.py` lines 15-44 → visual assertion prompt for `cli/src/ai/prompts.ts`
- `gemini_adapter.py` → API call pattern for `cli/src/ai/gemini-client.ts`
- `post_results.py` lines 98-136 → PR comment format
- `extension-content.ts` lines 10-45 → selector priority logic for element-resolver
