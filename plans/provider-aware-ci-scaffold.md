# Plan: Provider-Aware GitHub Action Scaffold

## Context

`skeptic add github-action --ai` is the CI scaffold that writes `.github/workflows/skeptic-tests.yml`. It was explicitly left out of scope during the multi-provider rollout (`plans/wiggly-floating-whistle.md`). Three problems remain:

1. **Env var hardcoded to Gemini** — `cli/src/commands/add.ts:25` injects `GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}` regardless of the user's `config.ai.provider`. A user with `provider: "openai"` generates a workflow that silently fails to authenticate in CI because `OPENAI_API_KEY` is never surfaced.
2. **User guidance hardcoded to Gemini** — `add.ts:135` tells every user to "Add GEMINI_API_KEY to your repository secrets," including OpenAI/Anthropic users.
3. **Scaffold is disconnected from config** — `add.ts` never calls `loadConfig()`. The config already has `ai.provider` (defaults to `"gemini"`), but the scaffold ignores it.

A secondary cleanup opportunity: `ENV_KEY_BY_PROVIDER` is duplicated privately in `cli/src/ai/security.ts:11-15` and `cli/src/ai/client-factory.ts:11-15`. The new scaffold makes a third consumer, which is the right moment to extract a single exported mapping.

**Goal:** `skeptic add github-action --ai` produces a workflow whose env block and user guidance match the project's configured AI provider. Users can override via a new `--provider` flag that mirrors the precedence pattern already established by `skeptic generate --model`.

**Out of scope:** adding actual AI-using steps to the generated workflow (e.g., `--analyze` in the test command). That would also require handling the model choice at scaffold time and pinning a per-provider cost/latency strategy — different feature.

---

## Phase 1 — Extract shared provider → env var mapping

### 1.1 Export `ENV_KEY_BY_PROVIDER` from `ai-client.ts`

**File:** `cli/src/ai/ai-client.ts`

Currently 8 lines. Add the mapping as the canonical source, co-located with the `AIProvider` type:

```ts
export type AIProvider = "gemini" | "openai" | "anthropic";

export const ENV_KEY_BY_PROVIDER: Record<AIProvider, string> = {
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

export interface AIClient {
  readonly provider: AIProvider;
  analyzeImage(imageBuffer: Buffer, prompt: string, temperature?: number): Promise<string>;
  generateText(prompt: string, system?: string, temperature?: number): Promise<string>;
}
```

### 1.2 Update call sites to import from there

Remove the duplicate private constant from:

- **`cli/src/ai/security.ts:11-15`** — replace the private const with `import { ENV_KEY_BY_PROVIDER } from "./ai-client.js"` (alongside the existing `AIProvider` import).
- **`cli/src/ai/client-factory.ts:11-15`** — same fix; import from `./ai-client.js`.

No behavior changes — this is a lossless refactor. Existing tests for `missingClientMessage` and `createAIClient` continue to pass unchanged.

---

## Phase 2 — Make the scaffold provider-aware

### 2.1 Extend the CLI signature

**File:** `cli/src/index.ts:101-109`

Add both `--provider` AND `-c, --config` options on the `github-action` subcommand. The `--config` option matches the pattern used by `generate` (`index.ts:91`) and `test` so users can target a non-default config file:

```ts
addCmd
  .command("github-action")
  .description("Generate a GitHub Actions workflow for E2E tests")
  .option("--dev-command <cmd>", "dev server start command", "npm run dev")
  .option("--dev-url <url>", "dev server URL", "http://localhost:3000")
  .option("--ai", "enable AI features in workflow")
  .option(
    "--provider <name>",
    "AI provider: gemini, openai, or anthropic (overrides ai.provider in config)",
  )
  .option("-c, --config <path>", "path to config file")
  .action(async (cmdOpts: AddGitHubActionOptions) => {
    await runAddGitHubAction(cmdOpts);
  });
```

### 2.2 Thread provider through the scaffold (via `loadConfig` overrides)

**File:** `cli/src/commands/add.ts`

Use `loadConfig`'s existing `overrides` channel (`loader.ts:46-47`) to merge `--provider` into the config before it's validated. This means zod does the enum validation (`schema.ts:61`), no manual `VALID_PROVIDERS` list, no cast-heavy helper. It also reuses the config path resolution and error shape already in place.

1. Extend `AddGitHubActionOptions` (current line 8-12):
   ```ts
   export interface AddGitHubActionOptions {
     devCommand?: string;
     devUrl?: string;
     ai?: boolean;
     provider?: string;   // validated by zod via skepticConfigSchema
     config?: string;     // config path override
   }
   ```

2. Add imports at the top:
   ```ts
   import { loadConfig } from "../config/loader.js";
   import { ENV_KEY_BY_PROVIDER, type AIProvider } from "../ai/ai-client.js";
   ```

3. Replace the Gemini-specific logic with provider-aware resolution at the top of `runAddGitHubAction`. **Crucially, move the existing `mkdirSync(workflowDir)` call (currently line 19-20) below this validation block** so a failed `--provider` / `--config` run doesn't leave an empty `.github/workflows/` directory behind:
   ```ts
   const devCommand = opts.devCommand ?? "npm run dev";
   const devUrl = opts.devUrl ?? "http://localhost:3000";
   const useAI = opts.ai ?? false;

   // Guard: --provider only makes sense with --ai.
   if (opts.provider && !useAI) {
     logger.error("--provider requires --ai. Pass both, or omit --provider to use the default.");
     process.exitCode = 1;
     return;
   }

   let provider: AIProvider = "gemini"; // only consulted when useAI is true
   if (useAI) {
     try {
       const config = loadConfig({
         configPath: opts.config,
         overrides: opts.provider ? { ai: { provider: opts.provider } } : undefined,
       });
       provider = config.ai.provider;
     } catch (err) {
       // Surfaces: invalid provider value (zod enum error), unreadable --config path,
       // malformed YAML. All cases abort cleanly without writing the workflow OR creating
       // the workflows directory — because mkdirSync now runs AFTER this block.
       logger.error(err instanceof Error ? err.message : String(err));
       process.exitCode = 1;
       return;
     }
   }

   // All validation passed — safe to create the output directory now.
   const workflowDir = path.resolve(process.cwd(), ".github/workflows");
   fs.mkdirSync(workflowDir, { recursive: true });
   const workflowPath = path.join(workflowDir, "skeptic-tests.yml");

   const envKey = ENV_KEY_BY_PROVIDER[provider];
   const aiEnvBlock = useAI
     ? `\n          ${envKey}: \${{ secrets.${envKey} }}`
     : "";
   ```

   **Ordering note:** the current `add.ts:19-20` creates the workflows dir before any arg handling. After this change, validation always runs first, and the dir is only created once we know we're going to write to it. This makes the error-path tests (3.6) assert cleanly that the file AND its parent directory are both absent on failure — not just the file.

4. **Delete** `const aiFlag = "";` at line 28 (dead code) AND the `${aiFlag}` interpolation on line 66. One-line cleanup unrelated to the main change but visible once you're editing this function.

5. Replace the Gemini-specific guidance block (lines 132-141) with a provider-aware equivalent:
   ```ts
   if (useAI) {
     console.log();
     console.log(
       chalk.yellow(`  Add ${envKey} to your repository secrets (provider: ${provider}):`),
     );
     console.log(
       chalk.dim("  Settings → Secrets and variables → Actions → New repository secret"),
     );
     console.log();
   }
   ```

**Security note** — the workflow always derives the secret name from the fixed `ENV_KEY_BY_PROVIDER` map after zod validation. Raw `opts.provider` is never interpolated into the `${{ secrets.* }}` string, so a user passing `--provider "foo; rm -rf /"` would just be rejected by zod's enum check.

---

## Phase 3 — Update and expand tests

### 3.1 Test-setup improvements

**File:** `cli/__tests__/unit/commands/add.test.ts`

Add one thing to the existing `beforeEach` (line 16-19). `process.exitCode` persists across tests in the same process, so a test that sets it to 1 bleeds into the next test's assertions. Reset it:

```ts
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-add-"));
  vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  process.exitCode = 0;   // new — avoid leakage across tests
});
```

### 3.2 Rewrite the existing `--ai` test into per-provider coverage

Replace the current single-provider test at `:53-60` with a loop covering all three providers + the no-AI baseline:

```ts
import { ENV_KEY_BY_PROVIDER } from "../../../src/ai/ai-client.js";

const workflowPath = () => path.join(tmpDir, ".github/workflows/skeptic-tests.yml");

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
```

### 3.3 Config-driven tests (no explicit `--provider`)

Write tests that place an `skeptic.config.yaml` in the tmp dir before invoking the scaffold. The existing `process.cwd()` mock ensures `loadConfig`'s walk-up search finds it (`loader.ts:104-114`):

```ts
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
```

### 3.4 Console guidance assertions

Locks in the provider-aware guidance — a stated goal that the YAML assertions can't cover. Spy on `console.log`:

```ts
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
```

### 3.5 CLI-surface test (lock in `index.ts` flag registration)

The Phase 3 tests above call `runAddGitHubAction()` directly, which bypasses Commander. If someone edits the type in `add.ts` but forgets the matching `.option()` call in `index.ts`, every other test still passes. Guard against that drift with a single help-text assertion.

**File:** new test file `cli/__tests__/integration/commands/add-cli-surface.test.ts`

Use the existing built-dist pattern (same idiom as `cli/__tests__/integration/commands/test-command.test.ts`, which spawns `node dist/bin/skeptic.js`):

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

// ESM: package.json has `"type": "module"`, so use `import.meta.dirname` (Node 20+),
// mirroring cli/__tests__/integration/commands/test-command.test.ts:10.
const skepticBin = path.resolve(import.meta.dirname, "../../../dist/bin/skeptic.js");

describe("skeptic add github-action CLI surface", () => {
  beforeAll(() => {
    if (!fs.existsSync(skepticBin)) {
      throw new Error(`Build required: ${skepticBin} not found. Run 'npm run build' first.`);
    }
  });

  it("advertises --provider, -c/--config, --ai, --dev-command, --dev-url in --help", () => {
    const help = execFileSync("node", [skepticBin, "add", "github-action", "--help"], {
      encoding: "utf-8",
    });
    expect(help).toContain("--ai");
    expect(help).toContain("--dev-command");
    expect(help).toContain("--dev-url");
    expect(help).toContain("--provider");
    expect(help).toContain("-c, --config");
  });
});
```

This test is deliberately placed under `integration/` since it requires a built CLI. The existing integration harness already expects `npm run build` to have been run; the suite's verification step (`npm run build && npm test`) covers this ordering.

### 3.6 Error-path tests

All error paths assert the workflow file AND its parent directory are absent, proving the mkdirSync reordering from 2.2 took effect.

```ts
const workflowsDir = () => path.join(tmpDir, ".github/workflows");

it("errors when --provider is passed without --ai", async () => {
  const { runAddGitHubAction } = await import("../../../src/commands/add.js");
  await runAddGitHubAction({ provider: "openai" });
  expect(process.exitCode).toBe(1);
  expect(fs.existsSync(workflowPath())).toBe(false);
  expect(fs.existsSync(workflowsDir())).toBe(false);
});

it("errors on invalid --provider value (zod enum rejection)", async () => {
  const { runAddGitHubAction } = await import("../../../src/commands/add.js");
  await runAddGitHubAction({ ai: true, provider: "claude" }); // not a valid AIProvider
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
    `ai:\n  provider: \"unterminated`,
    "utf-8",
  );
  const { runAddGitHubAction } = await import("../../../src/commands/add.js");
  await runAddGitHubAction({ ai: true });
  expect(process.exitCode).toBe(1);
  expect(fs.existsSync(workflowPath())).toBe(false);
  expect(fs.existsSync(workflowsDir())).toBe(false);
});
```

---

## Phase 4 — Documentation

### 4.1 Update `cli/README.md` (two places)

**4.1a — Flag table (lines 168-176).** Expand to cover the new surface:

```markdown
### `skeptic add github-action`

Generate a GitHub Actions workflow for E2E tests.

| Flag | Description |
|---|---|
| `--dev-command <cmd>` | Dev server start command (default: `npm run dev`) |
| `--dev-url <url>` | Dev server URL (default: `http://localhost:3000`) |
| `--ai` | Enable AI features in workflow (adds provider API key to env block) |
| `--provider <name>` | AI provider: `gemini`, `openai`, or `anthropic` (overrides `ai.provider` in config). Requires `--ai`. |
| `-c, --config <path>` | Path to config file |
```

Also add a one-line note pointing out that the injected secret name matches the provider (e.g., `OPENAI_API_KEY` for `--provider openai`).

**4.1b — CI/CD section (line 309).** The current text says the scaffold creates `.github/workflows/skeptic.yml`, but the actual filename written by `add.ts:22` is `skeptic-tests.yml`. This predates the current work, but since Phase 4 is already editing README, fix it in the same pass:

```markdown
This creates `.github/workflows/skeptic-tests.yml` configured to run your flows on push/PR.
```

**4.1c — AI Features section (lines 251-261).** Multi-provider support landed in `wiggly-floating-whistle.md` but this section still says "skeptic integrates with Gemini" and instructs users to set `GEMINI_API_KEY` exclusively. After the CI scaffold change, OpenAI/Anthropic users following the README would get contradictory guidance. Rewrite:

```markdown
## AI Features

skeptic integrates with Gemini, OpenAI, and Anthropic for AI-powered testing:

- **`assertWithAI`** -- natural-language assertions evaluated by a vision model against a page screenshot.
- **`assertNoDefects`** -- AI scans the page for visual defects (overlapping elements, broken layouts, etc.).
- **`extractTextWithAI`** -- ask AI to extract specific information from the page and optionally store it in a variable.
- **`skeptic generate --diff`** -- generate test flows from a git diff. Analyzes changed files and produces flows covering the affected UI.
- **`skeptic test --analyze`** -- AI-powered failure analysis that explains why a step failed and suggests fixes.

Configure the provider in `skeptic.config.yaml`:

\`\`\`yaml
ai:
  provider: gemini       # or: openai, anthropic
\`\`\`

Then set the matching API key environment variable — `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY` — or put the key in `ai.apiKey`. See `skeptic generate --help` for the `--model` override.
```

**4.1d — Config-example section (lines 239-245).** The example config shows `provider: gemini` with `apiKey: $GEMINI_API_KEY` hard-interpolated. That's fine as a working example, but add a one-line comment above pointing readers at the other valid provider values, so the example isn't the only authoritative source for what's supported:

```yaml
ai:
  # provider: gemini | openai | anthropic
  provider: gemini
  apiKey: $GEMINI_API_KEY
  # model: <provider-specific default used when omitted>
```

---

## Critical Files to Modify

| File | Phase | Change |
|------|-------|--------|
| `cli/src/ai/ai-client.ts` | 1.1 | Export `ENV_KEY_BY_PROVIDER` |
| `cli/src/ai/security.ts` | 1.2 | Import from ai-client; delete duplicate const |
| `cli/src/ai/client-factory.ts` | 1.2 | Import from ai-client; delete duplicate const |
| `cli/src/commands/add.ts` | 2.2 | Provider-aware env block + guidance via `loadConfig` overrides; `--provider` guard; remove dead `aiFlag` |
| `cli/src/index.ts` | 2.1 | Add `--provider` and `-c, --config` options to `github-action` subcommand |
| `cli/__tests__/unit/commands/add.test.ts` | 3.1-3.4, 3.6 | Reset `process.exitCode`; per-provider + config-driven + console + error tests |
| `cli/__tests__/integration/commands/add-cli-surface.test.ts` (new) | 3.5 | Help-text assertion locks in `index.ts` flag registration |
| `cli/README.md` | 4.1a-d | Flag table; fix `skeptic.yml`→`skeptic-tests.yml` at line 309; AI-Features multi-provider rewrite (lines 251-261); config-example provider comment (lines 239-245) |

Plus 1 new test file (`add-cli-surface.test.ts`). No new dependencies.

---

## Reused Utilities

- `loadConfig()` (with `overrides` channel) — `cli/src/config/loader.ts:46-47` (same mechanism used throughout the codebase for CLI overrides)
- `skepticConfigSchema` validation — `cli/src/config/schema.ts:61` provides the canonical provider enum; we rely on it instead of duplicating a list
- `AIProvider`, `ENV_KEY_BY_PROVIDER` — `cli/src/ai/ai-client.ts` (after 1.1)
- Idiom for `process.cwd()` mocking + tmp dir fixtures — `cli/__tests__/unit/commands/add.test.ts:17-18` (already in place)
- Pattern precedent — `skeptic generate --model` merges flag into config: `cli/src/commands/generate.ts:30`

---

## Verification

After implementation:

```bash
cd cli
npm run check        # strict TS compile
npm run build        # full build
npm test             # all existing + new tests pass
```

**Manual smoke test:**

```bash
# no config, no --ai → no AI block
skeptic add github-action
grep -E "(GEMINI|OPENAI|ANTHROPIC)_API_KEY" .github/workflows/skeptic-tests.yml
# expect: no match

# --ai with no config → defaults to Gemini
skeptic add github-action --ai
grep GEMINI_API_KEY .github/workflows/skeptic-tests.yml
# expect: one match in env block; stdout names GEMINI_API_KEY

# --ai --provider openai → uses OPENAI_API_KEY
skeptic add github-action --ai --provider openai
grep OPENAI_API_KEY .github/workflows/skeptic-tests.yml
# expect: one match; no GEMINI / ANTHROPIC keys present

# Config with anthropic + no flag → uses ANTHROPIC_API_KEY
printf 'ai:\n  provider: anthropic\n' > skeptic.config.yaml
skeptic add github-action --ai
grep ANTHROPIC_API_KEY .github/workflows/skeptic-tests.yml

# Error paths
skeptic add github-action --provider openai       # exit 1 — "requires --ai"
skeptic add github-action --ai --provider foo     # exit 1 — zod enum error
skeptic add github-action --ai -c missing.yaml    # exit 1 — file read error
```

Confirm terminal guidance names the matching env key (e.g., "Add OPENAI_API_KEY to your repository secrets (provider: openai):").
