# Plan: Remaining Features (No Publishing)

## Context

The skeptic CLI v0.1.0 core is built and tested (92 tests, 64 source files, ~6K LOC). All features work. This plan covers the remaining items to make the codebase production-ready WITHOUT publishing to npm or deploying anything. Just code + tests.

Items: `--parallel` execution, README, Dockerfile, package.json metadata, test coverage gaps, cleanup + git commit.

**Implementation order matters:** `--parallel` first (changes CLI surface), then tests, then Docker/metadata, then README (after surface is final), then cleanup + commit.

---

## Item 1: `--parallel` Execution

### 1a. CLI + config wiring

**File: `cli/src/commands/test.ts`**
- Add `parallel?: number` to `TestCommandOptions`
- Wire it: `const concurrency = opts.parallel ?? config.execution.parallel ?? 1`
- Add to `buildOverrides()`: if `opts.parallel`, set `execution.parallel`
- Parse as positive integer with validation

**File: `cli/src/index.ts`**
- Add `.option("--parallel <n>", "run N flows concurrently", parsePositiveInt)` to test command
- Define custom parser:
```typescript
function parsePositiveInt(value: string): number {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 1) {
    throw new Error(`--parallel must be a positive integer, got "${value}"`);
  }
  return n;
}
```

### 1b. Per-flow artifact isolation

**File: `cli/src/executor/playwright-engine.ts`**

Currently screenshots go to flat `outputDir/failure-step-N.png` and videos to `outputDir/videos/FlowName.webm`. Under parallel execution, flows with same step numbers would collide.

Fix: create per-flow subdirectory using sanitized flow name + index (handles duplicate flow names):
```typescript
const safeName = input.name.replace(/[^a-zA-Z0-9_-]/g, "_");
const flowDir = join(outputDir, `${safeName}-${flowIndex}`);
await mkdir(flowDir, { recursive: true });
// Screenshots go to: outputDir/FlowName-0/failure-step-1.png
// Videos go to: outputDir/FlowName-0/FlowName.webm
// Named screenshots go to: outputDir/FlowName-0/screenshot-label.png
```

The `flowIndex` is the position of the flow in the filtered array (0-based), passed to `engine.runFlow()` as part of FlowInput or as a separate parameter. This guarantees uniqueness even with duplicate flow names.

This also affects the `screenshot` step handler — it currently writes to `outputDir/label.png`. Need to pass `flowDir` via ExecutionContext so handlers use it.

**File: `cli/src/executor/context.ts`**
- Add `flowDir: string` property (set when ExecutionContext is created)
- Screenshot handler reads `ctx.flowDir` instead of `ctx.outputDir`

### 1c. Reporter API update for parallel

**File: `cli/src/reporter/types.ts`**
- Add flow identity to step events:
```typescript
onStepComplete(step: StepResult, index: number, total: number, flow: { name: string; file: string }): void;
```

**File: `cli/src/reporter/console-reporter.ts`**
- When `parallel > 1`: buffer all output per flow, print everything when `onFlowComplete` fires
- When `parallel === 1`: current behavior (print step-by-step in real time)

**File: other reporters** (junit, json, html) — already batch output in `onRunComplete`, no changes needed.

### 1d. Parallel execution loop

**File: `cli/src/commands/test.ts`**

Replace sequential for-loop with a fixed-size worker loop (simpler than p-limit, no new dependency):

```typescript
if (concurrency <= 1) {
  // Current sequential loop (unchanged)
} else {
  // Parallel: fixed worker pool
  const queue = [...filtered];
  const results: FlowResult[] = [];
  let bailTriggered = false;

  const worker = async () => {
    while (queue.length > 0 && !bailTriggered) {
      const flow = queue.shift()!;
      const input = flowToInput(flow, baseUrl, envOverrides);
      for (const r of reporters) r.onFlowStart({ name: input.name, file: input.file });
      let result = await engine.runFlow(input);
      // retry logic...
      for (const r of reporters) r.onFlowComplete(result);
      results.push(result);
      if (shouldBail && result.status !== "passed") {
        bailTriggered = true;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}
```

`--bail` with parallel: stop dequeuing new flows after first failure, let in-flight flows finish, then exit non-zero. No AbortController needed — just a boolean flag.

**No new dependencies.** No p-limit needed.

### 1e. Cookie safety under parallel

**File: `cli/src/cookies/chromium.ts` + `cli/src/cookies/firefox.ts`**
- Currently temp DB copies use `Date.now()` which can collide at millisecond precision
- Change to `crypto.randomUUID()` or `Date.now() + '-' + Math.random().toString(36).slice(2)` for unique temp paths

---

## Item 2: Test Coverage

### 2a. Parallel execution tests
**File: `cli/__tests__/unit/commands/parallel.test.ts`**
- Test: `--parallel 1` runs sequentially (same as default)
- Test: `--parallel 3` with 6 flows — all complete, results correct
- Test: `--bail` with parallel — stops dequeuing after failure, in-flight finishes
- Test: artifact isolation — no file collisions with duplicate flow names
- Test: invalid `--parallel 0` or `--parallel -1` — error

### 2b. Command tests
**File: `cli/__tests__/unit/commands/init.test.ts`**
- Test: creates tests/ dir, config file, example flow
- Test: skips existing files without overwriting

**File: `cli/__tests__/unit/commands/add.test.ts`**
- Test: `add github-action` generates .github/workflows/skeptic-tests.yml
- Test: `add skill --agent claude` creates .claude/skills/skeptic.md
- Test: `add skill --agent codex` creates .agents/skills/skeptic/SKILL.md

**File: `cli/__tests__/unit/commands/generate.test.ts`**
- Test: `--message` mode generates valid YAML (mock Gemini)
- Test: `--diff` mode runs git diff and sends to Gemini (mock both)

### 2c. AI module tests
**File: `cli/__tests__/unit/ai/gemini-client.test.ts`**
- Test: rate limiter throttles at configured RPM
- Test: markdown fence stripping

**File: `cli/__tests__/unit/ai/assertion-evaluator.test.ts`**
- Test: `evaluateAssertion()` with valid JSON response → pass/fail
- Test: `evaluateAssertion()` with markdown-wrapped JSON → parsed correctly
- Test: `evaluateAssertion()` with garbage response → graceful fallback
- Test: `analyzeFailure()` returns analysis string

**File: `cli/__tests__/unit/ai/security.test.ts`**
- Test: `checkAIEnabled()` throws without API key
- Test: `checkAIEnabled()` succeeds with API key
- Test: `firstUseWarning()` creates consent file
- Test: `filterDiffPaths()` excludes .env, secrets/, *.key patterns

### 2d. Cookie tests
**File: `cli/__tests__/unit/cookies/extractor.test.ts`**
- Test: `detectBrowsers()` returns profiles (mock fs paths)
- Test: domain filtering
- Test: first-use notice creates consent file
- Test: Playwright cookie format conversion

### 2e. Reporter tests
**File: `cli/__tests__/unit/reporter/html-reporter.test.ts`**
- Test: generates self-contained HTML
- Test: includes flow names, step counts
- Test: includes video link when videoPath present
- Test: escapes flow names/errors (XSS prevention)

### 2f. MCP tests
**File: `cli/__tests__/unit/commands/mcp.test.ts`**
- Test: MCP server exposes expected tool names (run_flow, run_test, generate_flow, validate_flow, list_flows, list_devices)

---

## Item 3: Dockerfile (Multi-stage)

**File: `cli/Dockerfile`**

```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY bin/ ./bin/
COPY src/ ./src/
COPY templates/ ./templates/
RUN npm run build

# Stage 2: Runtime (Playwright + Node)
FROM mcr.microsoft.com/playwright:v1.52.0-noble
WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/templates/ ./templates/
ENTRYPOINT ["node", "dist/bin/skeptic.js"]
```

**File: `cli/.dockerignore`**
```
node_modules
__tests__
live-tests
live-output
.skeptic
skeptic-output
*.md
.git
```

---

## Item 4: Package.json Metadata

**File: `cli/package.json`** — Add descriptive fields only (defer main/types/exports until publish time):

```json
{
  "files": [
    "dist",
    "templates",
    "README.md"
  ],
  "repository": {
    "type": "git",
    "url": "https://github.com/iamjr15/skeptic"
  },
  "homepage": "https://github.com/iamjr15/skeptic",
  "author": "iamjr15",
  "license": "MIT"
}
```

No `main`/`types`/`exports` until we actually publish for programmatic import.

---

## Item 5: README.md

**File: `cli/README.md`**

Developer-focused, ~200 lines. Written AFTER parallel is implemented so CLI surface is final.

Key corrections from Codex review:
- **21 step commands** (not 22 — count from COMMAND_KEYS)
- **`--diff` is on `skeptic generate`** not `skeptic test`
- **Install section**: local dev setup (`npm run build`, `node dist/bin/skeptic.js`), not `npm install -g skeptic-cli`

Structure:
```
# skeptic
One-line description

## Development Setup
git clone, npm install, npm run build, node dist/bin/skeptic.js --help

## Quick Start
skeptic init, write a flow, skeptic test

## YAML Flow Format
--- delimiter, metadata fields, 21 step commands table

## CLI Commands
skeptic test, generate, init, add, cookies, mcp — with key flags

## Configuration
skeptic.config.yaml structure

## AI Features
assertWithAI, assertNoDefects, extractTextWithAI, skeptic generate --diff

## Cookie Extraction
--cookies, supported browsers

## Video Recording
--video flag

## CI/CD
skeptic add github-action

## License
MIT
```

---

## Item 6: Cleanup + Git Commit

### 6a. Cleanup before commit

- Add `cli/live-output/` and `cli/live-tests/` to root `.gitignore`
- Delete `cli/live-output/` directory (test artifacts, not source)
- Delete `cli/live-tests/` directory (ad-hoc test files, not part of the project)
- Verify no secrets, .env files, or large binaries in staging area

### 6b. .gitignore updates

**File: `/Users/iamjr15/Desktop/skeptic/.gitignore`** — Add:
```
# CLI test artifacts
cli/live-output/
cli/live-tests/
```

### 6c. Git commit

```bash
cd /Users/iamjr15/Desktop/skeptic
git add cli/ CLAUDE.md .gitignore
git status  # review — verify no secrets/artifacts/plans
git commit -m "feat: skeptic CLI v0.1.0 — YAML flows, Playwright engine, AI assertions, cookie extraction, video recording, parallel execution"
```

Verification: `git diff --cached --stat` shows only source files, no screenshots/videos/artifacts.

---

## Implementation Order (Sequential)

| # | Item | Files | Depends on |
|---|------|-------|------------|
| 1 | `--parallel` execution | 7 modified | — |
| 2 | Test coverage (all) | 10 new test files | Item 1 (parallel tests need parallel code) |
| 3 | Dockerfile + .dockerignore | 2 new files | — |
| 4 | Package.json metadata | 1 modified | — |
| 5 | README.md | 1 new file | Items 1-4 (needs final CLI surface) |
| 6 | Cleanup + git commit | 1 modified (.gitignore) | Items 1-5 (everything ready) |

---

## Verification

1. `npx tsc --noEmit` — zero errors
2. `npm run build` — clean
3. `npx vitest run` — all tests pass (92 existing + ~50 new = ~140 total)
4. Parallel verification: start fixture server (`npx serve __tests__/fixtures/app -l 9877`), then create 3 temp flows with `url: http://localhost:9877` and run `skeptic test --parallel 3 /tmp/skeptic-parallel-test/*.yaml` — all complete, per-flow dirs created in output
5. Bail verification: create 3 temp flows (2 pass, 1 fail with `assertVisible: "NONEXISTENT"`), run `skeptic test --parallel 2 --bail /tmp/skeptic-bail-test/*.yaml` — stops after failure, exit code 1
6. `docker build -t skeptic-cli .` — builds successfully from clean tree
7. `npm pack --dry-run` — shows dist/, templates/, README.md only
8. `cat README.md` — accurate command list, 21 commands, local dev setup
9. `git diff --cached --stat` — no artifacts, secrets, or generated files
10. Per-flow artifact dirs: `ls skeptic-output/FlowName-0/` shows screenshots + video isolated per flow
