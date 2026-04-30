# skeptic

CLI-first E2E testing with YAML flows, AI assertions, and browser cookie extraction.

## Development Setup

```bash
git clone https://github.com/iamjr15/skeptic
cd skeptic/cli
npm install
npm run build
node dist/bin/skeptic.js --help
```

To use as a local command:

```bash
npm link
skeptic --help
```

## Quick Start

```bash
# Initialize a project
skeptic init

# Write a flow in tests/
# Run it
skeptic test

# Generate flows with AI
skeptic generate -m "test the login page"
```

## YAML Flow Format

Flows are YAML files with two sections separated by `---`: metadata (front-matter) and steps.

```yaml
name: Login flow
url: https://example.com
description: Verify login works
tags: [auth, smoke]
auth: cookies
timeout: 60000
viewport: { width: 1280, height: 720 }
device: iPhone-14
env:
  USER: admin
onFlowStart:
  - navigate: /setup
onFlowComplete:
  - screenshot: cleanup.png
---
- navigate: /login
- type: "#email >> user@example.com"
- click: button[type="submit"]
- assertVisible: .dashboard
- assertUrl: /dashboard
```

### Metadata Fields

| Field | Type | Description |
|---|---|---|
| `name` | string (required) | Flow name |
| `url` | string | Base URL for the flow |
| `description` | string | Human-readable description |
| `tags` | string[] | Tags for filtering |
| `timeout` | number | Default step timeout (ms) |
| `auth` | `"cookies"` \| `"none"` | Auth strategy |
| `viewport` | `{width, height}` | Browser viewport size |
| `device` | string | Device profile for emulation |
| `env` | map | Environment variables |
| `onFlowStart` | Step[] | Steps to run before the flow |
| `onFlowComplete` | Step[] | Steps to run after the flow |

### Step Commands

Every step has exactly one command key plus optional shared fields (`timeout`, `hardTimeout`, `softTimeout`, `retryIfNoChange`, `optional`, `label`, `when`).

| Command | Value Type | Description |
|---|---|---|
| `navigate` | string | Navigate to a URL |
| `click` | `Selector` | Click an element by selector ([Selector type](#selectors)) |
| `type` | string | Type into an element (`"selector >> text"`) |
| `assertVisible` | `Selector` | Assert an element is visible |
| `assertNotVisible` | `Selector` | Assert an element is not visible |
| `assertUrl` | string | Assert the current URL matches |
| `assertText` | string \| `{selector: Selector, text}` | Assert text content of an element |
| `screenshot` | string | Take a screenshot and save to path |
| `wait` | number | Wait for a duration (ms) |
| `waitForElement` | `Selector` \| `{selector, state?, timeout?}` | Wait for an element to reach a state (default `visible`) |
| `scroll` | string | Scroll to an element |
| `select` | `{selector, value}` | Select an option in a dropdown |
| `press` | string | Press a keyboard key |
| `clearInput` | string | Clear an input field |
| `assertWithAI` | string \| `{assertion, optional?}` | AI-powered visual/semantic assertion |
| `assertNoDefects` | boolean \| `{optional?}` | AI scan for visual defects |
| `extractTextWithAI` | string \| `{query, variable?}` | Extract text using AI, optionally store in variable |
| `assertScreenshot` | string \| `{path, cropOn?, threshold?}` | Pixel-diff screenshot comparison |
| `runFlow` | string \| `{file, env?, when?, commands?}` | Run another flow file |
| `repeat` | `{times?, while?, commands}` | Repeat steps N times or while condition holds |
| `setVariable` | `{name, value}` | Set a variable for interpolation |
| `randomType` | string \| `{selector, variable?, length?}` | Fill input with a faker-generated alphanumeric string (default 8 chars) |
| `randomEmail` | string \| `{selector, variable?}` | Fill input with a faker-generated email address |
| `randomNumber` | string \| `{selector, variable?, length?}` | Fill input with a numeric string (default 8 digits) |
| `randomPhone` | string \| `{selector, variable?}` | Fill input with a faker-generated phone number |

The four `random*` commands capture the generated value into a flow variable when `variable` is provided, so later steps can reference it with `${varName}` interpolation.

### Selectors

Most element-bearing commands accept a `Selector`, which is either a **bare string** (existing behavior, fed through skeptic's auto-detection chain — testid → role+name → text → label → placeholder → CSS) or a **relational object** that combines a leaf identifier with optional spatial/hierarchical constraints.

```yaml
# bare string — works as before
- click: "Submit"
- click: "testid=save-btn"
- click: "css=.btn-primary"

# relational object — leaf + constraints
- click:
    text: "Save"
    below: "Email address"           # spatial: only candidates whose center is below the ref
- click:
    role: "button"
    rightOf: "icon-search"           # spatial
- click:
    testid: "save"
    childOf: { id: "edit-form" }    # hierarchical (geometric containment)
- click:
    text: "Add"
    containsChild: { text: "Cart" } # hierarchical (this element encloses the child)
- click:
    text: "Edit"
    index: 2                        # explicit pick when multiple match (0-based)
```

**Leaf fields** (one or more required): `text` (exact match), `id`, `role` (combine with `text` for `getByRole(role, {name})`), `testid`, `css` (raw escape hatch).

**Relational fields**:
- `above`, `below`, `leftOf`, `rightOf` — strict spatial comparison via element centers (Euclidean distance breaks ties).
- `childOf`, `containsChild` — geometric bounding-box containment.
- `index` — N-th match after sort (default 0). When relational refs are present, candidates sort by Euclidean distance to the primary ref; otherwise document order (Y-then-X).

Each relational reference can itself be a string (shorthand for `{text: "..."}`) or a nested relational object.

**Strict parsing**: typo'd field names (`belwo`, `rightof`, `child`) are rejected at parse time. Pure-relational selectors without a leaf (`{below: "X"}`) are also rejected — the resolver needs at least one leaf to bound its candidate pool.

**Supported commands (v1)**: `click`, `doubleClick`, `hover`, `assertVisible`, `assertNotVisible`, `waitForElement`, `copyTextFrom`, `assertText.selector`, `scrollUntilVisible.selector`. Other selector-bearing commands (`select`, `clearInput`, `scroll`, `randomType`, etc.) currently use bare-string only.

**`waitForElement` v1 limitation**: relational selectors only support `state: "visible"` (default) and `state: "hidden"`. Use bare-string selectors for `state: "attached"` or `state: "detached"` — the relational resolver materializes bounding boxes which can't distinguish hidden-attached from detached.

**Errors are structured**. When a relational selector fails, the step error message tells you which kind of failure: no candidates matched, all candidates were detached/hidden, intersection of constraints was empty, the reference selector itself didn't resolve, the explicit index exceeded the match count, or the selector was malformed (invalid role / bad CSS). Negative assertions (`assertNotVisible`, `waitForElement state="hidden"`) treat "no candidates" / "all detached" / "intersection empty" as PASS but malformed-selector errors as FAIL — typos don't silently get a green check.

**AI generation policy**: `skeptic generate` does NOT emit relational selectors. The LLM is instructed to use bare-string selectors only — relational selectors are a power-user feature for human-authored flows.

### ARIA snapshot-ref selectors

skeptic supports the ARIA snapshot-ref pattern (inspired by [Expect](https://github.com/expectquality/expect)) for building resilient selectors that survive DOM refactors. Capture an accessibility tree once, then refer to elements by ephemeral refs (`@e1`, `@e2`, …) instead of CSS selectors that break when class names change.

```yaml
- navigate: /login
- ariaSnapshot: true        # capture the a11y tree, mint refs e1, e2, ...
- click: "@e1"              # the first interactive element (e.g. username field)
- type: "alice"
- click: "@e3"              # the third interactive element (e.g. sign-in button)
- assertVisible: "@e1"
```

Refs are minted at snapshot time in document order by Playwright's native [`Locator.ariaSnapshot({ mode: "ai" })`](https://playwright.dev/docs/aria-snapshots). They cover interactive roles (`button`, `link`, `textbox`, `combobox`, …) and named content roles (`heading`, `region`, …).

**Refs are ephemeral.** A new `ariaSnapshot` step clears the registry and re-mints. Any DOM mutation (modal opening, navigation, route change) is a hint to re-snapshot — refs do not persist across snapshots.

```yaml
- navigate: /list
- ariaSnapshot: true
- click: "@e2"          # opens a modal
- ariaSnapshot: true    # re-snapshot — modal's elements now numbered
- click: "@e1"          # the modal's first button
```

**`ariaSnapshot` step options.** Boolean shorthand `ariaSnapshot: true` captures the full body. The object form accepts:

```yaml
- ariaSnapshot:
    selector: "#main"      # scope the capture to a subtree (default: "body")
    viewport: true         # only mint refs for in-viewport elements (default: false)
    storeAs: snapshotYaml  # also store the raw YAML in a flow variable
```

**Supported handlers (v1).** Refs work in: `click`, `doubleClick`, `hover`, `assertVisible`, `assertNotVisible`, `waitForElement`, `copyTextFrom`, `assertText` (selector branch), `scrollUntilVisible`. Other selector-bearing handlers (`select`, `clearInput`, `scroll`, `randomType`, `randomEmail`, `randomNumber`, `randomPhone`, `assertScreenshot.cropOn`) currently use bespoke resolution paths and will reject `@eN` selectors — widening these is a v2 follow-up.

**Composing refs with relational selectors** (e.g., `below: "@e3"`) is not yet supported. The relational pipeline does not route `@`-prefixed strings to the ref resolver. Tracked as a small follow-up after both selector systems land.

**Privacy & limits.**
- Snapshot YAML may contain user-typed text (form values, names, account numbers). It stays in-memory on the execution context and is **never** written to logs, reporters, or step results.
- Use `storeAs` only when you intentionally want the captured YAML in a flow variable.
- Snapshots over 256 KiB are truncated with a console warning. Tune via `SKEPTIC_ARIA_SNAPSHOT_LIMIT_KB`.

**AI generation.** `skeptic generate` does **not** emit ref-based flows in v1 — the LLM doesn't see a real snapshot at generation time, so blind ref emission produces unreliable output. Refs are a power-user feature for hand-authored flows. A future release will add an interactive ref-aware generation mode that captures snapshots at runtime.

**Common errors.** Negative assertions (`assertNotVisible`, `waitForElement state="hidden"`) treat ref-resolution failures as **real failures**, not absence — a stale or missing ref is an authoring/staleness problem, not "the element isn't visible."
- `Ref "@e1" referenced before any ariaSnapshot step ran` — insert `- ariaSnapshot: true` earlier in the flow.
- `Ref "@e3" not found in the current snapshot` — the snapshot has fewer refs than expected; the page may have changed since capture, or the ref number was wrong.
- `Ref "@e2" (role: button, name: "Save") is stale` — the snapshot expected an Nth match, but the live DOM has fewer matches. Re-run `ariaSnapshot`.
- `Invalid ARIA ref "@bad". Expected "@eN"` — refs must be `@e<digits>`; double-check the syntax.

### Shared Step Fields

| Field | Type | Description |
|---|---|---|
| `timeout` | number | Override step timeout (ms). Alias of `hardTimeout` — when both are set, `hardTimeout` wins. |
| `hardTimeout` | number | Fail-on-exceed ceiling (ms). Enforced by a Node-side Promise.race, so it applies even to handlers that bypass Playwright's default timeout. |
| `softTimeout` | number | Warn-on-exceed (ms). Step keeps running; a `soft-timeout exceeded` entry is appended to the step's `warnings` array. Must be less than `hardTimeout` / `timeout`. |
| `retryIfNoChange` | boolean | Click-only. Captures URL + DOM fingerprint before the click; if both are unchanged after a short settle window, the click is re-issued once. |
| `optional` | boolean | Downgrade failure (including `hardTimeout`) to passed so the flow keeps running. |
| `label` | string | Human-readable label for reporting |
| `when` | `{visible?, notVisible?, true?}` | Conditional execution |

### Non-Fatal Warnings (`result.warnings`)

Steps can accumulate non-fatal notices on `StepResult.warnings` (an array of strings) without failing. Today, two step options emit warnings:

- `softTimeout` — emits `soft-timeout exceeded (Xms)` and logs `⚠ [softTimeout] ... (continuing)` to the console.
- `retryIfNoChange` — on a retry, emits `retried once (no change after first click)` and logs `⚠ [retryIfNoChange] ... retrying once`.

Warnings surface in:
- **console reporter** — a `⚠ <warning>` line after the step's pass line (yellow).
- **TUI** — a `⚠ N` badge next to the step row; the full list in `--verbose`.
- **JSON reporter** — serialized as `warnings: string[]` on each step result.

`retry`, `repeat`, and `runFlow` composites aggregate all child-step warnings onto their outer result, so a soft-timeout that fires inside a `retry:` block is still visible at the enclosing step's level.

## CLI Commands

### `skeptic test [flows...]`

Run E2E test flows.

| Flag | Description |
|---|---|
| `-c, --config <path>` | Path to config file |
| `--headed` | Run browser in headed mode |
| `--verbose` | Verbose output |
| `--ci` | Force CI mode (headless, no prompts) |
| `--bail` | Stop on first failure |
| `--retries <n>` | Retry failed flows N times |
| `--timeout <ms>` | Step timeout in ms |
| `--device <id>` | Device profile for viewport emulation |
| `--reporter <format...>` | Reporter format(s): `console`, `json`, `junit`, `html` |
| `--output <dir>` | Output directory for reports |
| `--dry-run` | Validate flows without running browser |
| `--screenshot-on-failure` | Capture screenshot on step failure (default: true) |
| `--grep <pattern>` | Filter flows by name regex |
| `--tags <tags...>` | Filter flows by tag |
| `--env <KEY=VALUE...>` | Set environment variables |
| `-y, --yes` | Non-interactive mode |
| `--cookies` | Enable browser cookie extraction |
| `--cookies-from <browser>` | Extract cookies from specific browser only |
| `--video` | Record video of test execution (WebM) |
| `--include-tags <tags...>` | Only run flows with at least one of these tags |
| `--exclude-tags <tags...>` | Skip flows with any of these tags |
| `-w, --watch` | Watch for file changes and re-run |
| `-u, --url <url>` | Base URL (overrides config) |
| `--analyze` | Use AI to analyze test failures |
| `--parallel <n>` | Run N flows concurrently inside one browser instance |
| `--shard-split <n>` | Split flows across N independent browser instances (each runs a disjoint subset) |
| `--shard-all <n>` | Run all flows on each of N independent browser instances (parity / flake-rate baseline) |

#### Sharding vs `--parallel`

`--parallel` runs N flows concurrently inside one Chromium process — saturated by a single browser's resources and shares state-leakage risk across flows. Sharding spawns N independent `PlaywrightEngine` instances, each its own Chromium process, giving true wall-clock speedup for CI runs and full state isolation per shard.

```bash
# CI: 4× wall-clock speedup, disjoint subset per worker
skeptic test --shard-split 4

# Flake-rate baseline: every flow runs 3× across 3 isolated processes
skeptic test --shard-all 3

# Compose with --parallel: 3 shards × 2 flows in flight per shard
skeptic test --shard-split 3 --parallel 2
```

Per-shard artifacts (videos, screenshots, traces, per-shard `results.json`/`junit.xml`/`report.html`) land in `<output>/shard-N/` subdirectories. A canonical merged report is written at the top-level output directory. Slack/webhook notifications fire **once** on the merged summary regardless of shard count. Mutually exclusive with `--watch` and the interactive TUI; `--shard-split --bail` propagates a shared abort signal across shards (`--shard-all --bail` is rejected with a warning since per-instance variance is the point of `--shard-all`). Flows can read `SKEPTIC_SHARD_INDEX` and `SKEPTIC_SHARD_COUNT` env vars at runtime to self-identify.

### `skeptic generate`

Generate test flows using AI.

| Flag | Description |
|---|---|
| `--diff [target]` | Generate from git diff (default: HEAD) |
| `-u, --url <url>` | Base URL for generated flows |
| `-m, --message <description>` | Generate from a text description |
| `-o, --output <dir>` | Output directory for generated flows |
| `--save` | Save to `.skeptic/generated/` with timestamp |
| `--model <model>` | Gemini model to use (default: `gemini-2.5-flash`) |
| `--no-coverage` | Skip the coverage analysis injected into AI prompts (`--diff` only) |
| `-c, --config <path>` | Path to config file |

#### Test coverage signal

When you run `skeptic generate --diff` in a project that contains existing flow files (matching `config.tests`), skeptic builds an import graph of your source code, walks it from each flow's `navigate:` URLs, and tells the LLM which changed files are already covered by flows and which are not:

```
## Coverage of changed files

Test coverage of changed files: 60% (3/5 files have flows)

[covered] src/components/login.tsx (tested by: flows/login.yaml, flows/auth-flows.yaml)
[covered] src/lib/auth.ts (tested by: flows/login.yaml)
[covered] src/api/users.ts (tested by: flows/profile.yaml)
[no test] src/components/profile-edit.tsx
[no test] src/lib/permissions.ts

**Prioritize generating flows for `[no test]` files. Skip files already covered unless the diff exposes new edge cases.**
```

The LLM uses this signal to focus on uncovered code instead of duplicating coverage.

Notes:

- Coverage is determined by static analysis (`oxc-resolver` + a regex import extractor). Dynamic imports such as `import(\`foo-${variant}\`)` are not detected.
- URL → source-file mapping is heuristic. skeptic builds a route index from common conventions — Next.js `app/`, `pages/`, `src/routes/` — and matches single-segment dynamic routes (`[id]`), required catch-alls (`[...slug]`), and optional catch-alls (`[[...slug]]`). App-router parent layouts contribute to coverage automatically.
- Off-origin URLs in flows (e.g. `https://accounts.google.com/login`) are ignored — they do not mark same-named local routes as covered.
- API route handlers (`*.api.ts`), config files, type-only files (`*.d.ts`), and test/spec files are excluded from analysis.
- `ai.excludePaths` from your config is honored: excluded files never enter the import graph, so they cannot appear as a coverage parent.
- Description-driven generation (`--message`) does not inject coverage — there's no diff to scope the signal against.
- Pass `--no-coverage` to skip the analysis (e.g., for debugging or performance).

### `skeptic init [dir]`

Initialize a new skeptic project with config file and example flow.

### `skeptic add github-action`

Generate a GitHub Actions workflow for E2E tests. The injected secret name matches the configured provider (e.g., `OPENAI_API_KEY` when `--provider openai`). When `--ai` is set, the generated workflow:

- Pins `node-version: 22` (matches the CLI's `engines: { node: ">=22" }` requirement).
- Grants `permissions: { contents: read, pull-requests: write }` so `skeptic comment` can post.
- Appends `--analyze` to the test step (AI failure analysis on red runs).
- Injects three env vars on the test step: the provider's API-key secret, `SKEPTIC_AI_PROVIDER=<provider>`, and `SKEPTIC_AI_API_KEY=<same secret>`. The latter two ensure the runtime CLI sees the same provider/key combination the scaffold injected, regardless of any stale `ai:` settings in `skeptic.config.yaml`.

| Flag | Description |
|---|---|
| `--dev-command <cmd>` | Dev server start command (default: `npm run dev`) |
| `--dev-url <url>` | Dev server URL (default: `http://localhost:3000`) |
| `--ai` | Enable AI features in workflow (adds provider API key + `--analyze` to test step) |
| `--provider <name>` | AI provider: `gemini`, `openai`, or `anthropic` (overrides `ai.provider` in config). Requires `--ai`. |
| `-c, --config <path>` | Path to config file |

### `skeptic comment`

Upsert a PR comment with test results. CI-agnostic — works on GitHub Actions, GitLab CI, Jenkins, or local dev. Uses the `gh` CLI (must be installed and authenticated). Falls through to a `logger.warn` and exit 0 if `gh` is missing, the auth token is invalid, no PR is detected, or `results.json` is missing/malformed — a broken PR comment never red-Xs a passing build.

```bash
# Auto-detects PR number, run URL, and reads ./skeptic-output/results.json
skeptic comment

# Explicit context (recommended in CI scaffolds)
skeptic comment --pr 123 --run-url https://github.com/owner/repo/actions/runs/456

# Preview the comment body without posting
skeptic comment --dry-run
```

| Flag | Description |
|---|---|
| `--results <path>` | Path to `results.json` (default: `./skeptic-output/results.json`) |
| `--pr <number>` | PR number (default: auto-detect via `GITHUB_REF` or `gh pr view`) |
| `--marker <string>` | HTML comment marker for upsert (default: `<!-- skeptic-qa-results -->`) |
| `--run-url <url>` | URL to the CI run page (default: derive from `GITHUB_*` env vars, omit if absent) |
| `--dry-run` | Print the comment body to stdout instead of posting |
| `-c, --config <path>` | Path to config file |

The command is idempotent: it lists the PR's comments, finds an existing one matching `--marker`, and PATCHes it; otherwise it posts a new comment. Re-running on the same PR updates the existing comment in place. **Fork PRs** receive a read-only `GITHUB_TOKEN` from GitHub Actions, so the comment step warns and skips on fork PRs — that's expected behavior.

#### Auto-detected CI environment

When the corresponding `--<flag>` is omitted, `skeptic comment` reads these GitHub Actions env vars:

| Env var | Used for | Falls back to |
|---|---|---|
| `GITHUB_REF` | `--pr` (parses `refs/pull/N/merge` or `refs/pull/N/head`) | `gh pr view --json number -q .number` |
| `GITHUB_SERVER_URL` + `GITHUB_REPOSITORY` + `GITHUB_RUN_ID` | `--run-url` (joins to `<server>/<repo>/actions/runs/<id>`) | omits the run-link line |
| `GITHUB_TOKEN` | `gh` authentication | `gh auth status` (local dev) |

If none of these resolve, the command logs a non-fatal info/warning and exits 0 — never red-Xs the build.

### `skeptic add skill`

Install skeptic skill for an AI coding agent.

| Flag | Description |
|---|---|
| `--agent <name>` | Agent name: `claude`, `codex`, `cursor` |

### `skeptic cookies list`

List detected browsers for cookie extraction.

### `skeptic mcp`

Start MCP server for AI agent integration (stdio transport).

### `skeptic acp`

Start an Agent Client Protocol (ACP) server so editors like Zed and Cursor can drive skeptic like a coding assistant whose specialty is end-to-end testing. ACP is the same protocol Zed uses for its agent integrations: the editor sends a natural-language prompt, skeptic streams back thoughts, tool invocations, and progress.

Wire it up in your editor's agent settings (Zed, Cursor with the ACP plugin, etc.):

```json
{
  "agent": {
    "command": "skeptic",
    "args": ["acp"]
  }
}
```

Once configured, prompt skeptic like a testing-focused coding assistant:

- `run flows/login.yaml`
- `run tests matching tests/**/*.yaml`
- `generate a flow that tests the cart checkout`
- `validate flows/login.yaml`
- `list flows`
- `list devices`
- `load guidance for accessibility`

ACP and MCP coexist — they're separate processes (`skeptic mcp` and `skeptic acp`) and can run in parallel from different editor extensions. They share the same underlying primitives (the YAML parser, Playwright engine, AI client, and guidance loader), so a flow that runs cleanly via the CLI also runs cleanly via either protocol.

**v1 limitations:**

- Stdio transport only (no WebSocket / HTTP).
- Heuristic prompt parsing — skeptic recognizes the patterns above; arbitrary natural language falls back to a help message.
- No `plan` updates yet; tools execute directly without a step plan first.
- One sequential conversation per session; sessions are independent so multiple editors can connect concurrently.

### Global Flags

| Flag | Description |
|---|---|
| `-v, --verbose` | Enable verbose logging |
| `-q, --quiet` | Suppress all output except errors |
| `--version` | Show version |
| `--help` | Show help |

## Configuration

skeptic uses `skeptic.config.yaml` in the project root.

```yaml
url: https://example.com
tests: "tests/**/*.yaml"

browser:
  engine: chromium        # chromium | firefox | webkit
  headless: true
  slowMo: 0
  timeout: 30000
  viewport:
    width: 1280
    height: 720
  device: iPhone-14       # optional device profile

auth:
  cookies: false
  browsers: []            # restrict to specific browsers

execution:
  retries: 0
  bail: false
  screenshotOnFailure: true
  parallel: 1
  grep: ""
  tags: []

output:
  dir: ./skeptic-output
  reporters: [console]    # console | html | json | junit
  open: false
  verbose: false

ai:
  # provider: gemini | openai | anthropic
  provider: gemini
  apiKey: $GEMINI_API_KEY
  # model: <provider-specific default used when omitted>
  model: gemini-2.5-flash
  maxRequestsPerMinute: 55
  baseBranch: main
  excludePaths: ["*.env*", "secrets/", "*.key", "*.pem"]

notifications:                    # optional — see Notifications section below
  slack:
    webhookUrl: ${SLACK_WEBHOOK_URL}
    onFailure: true
    onSuccess: false
    mention: ["<!here>"]          # optional Slack mentions (mrkdwn syntax)
  webhook:
    url: ${SKEPTIC_WEBHOOK_URL}
    onFailure: true
    onSuccess: false
    headers:
      X-Auth-Token: ${WEBHOOK_AUTH_TOKEN}

env:
  BASE_URL: https://example.com
```

## Notifications

> ⚠️ `notifications.webhook.url` and `notifications.slack.webhookUrl` accept arbitrary URLs. If your CI runs unprotected PR branches, attacker-modified configs could exfiltrate test summaries to attacker endpoints. **Pin notification config to your protected branches** or use config-validation in CI to lock down these fields.

skeptic can send run summaries to Slack and/or arbitrary HTTP webhooks at the end of each test run. Both channels are optional, off by default, and gracefully degrade — a notification HTTP failure (timeout, 5xx, network error) emits a warning by error class only and never affects the build's exit code.

### Slack

```yaml
notifications:
  slack:
    webhookUrl: ${SLACK_WEBHOOK_URL}    # required, env-interpolated
    onFailure: true                      # default: true
    onSuccess: false                     # default: false
    mention: ["<!here>", "<@U123>"]     # optional, prepended in mrkdwn format
```

The Slack message uses Block Kit: a status header (✅ or ❌), a summary section with Total / Passed / Failed / Duration fields, an optional bullet list of the first 5 failed flow names, and an optional `View run` context link.

`channel` is intentionally not configurable. Modern Slack incoming webhooks bind to a single channel at creation time and ignore overrides — to target a different channel, configure a different webhook URL.

### Webhook

```yaml
notifications:
  webhook:
    url: ${SKEPTIC_WEBHOOK_URL}            # required, env-interpolated
    onFailure: true                      # default: true
    onSuccess: false                     # default: false
    headers:                             # optional custom headers
      X-Auth-Token: ${WEBHOOK_AUTH_TOKEN}
```

The webhook receives a POST with a flat JSON body:

```json
{
  "status": "failed",
  "total": 3, "passed": 1, "failed": 2,
  "duration_ms": 5500,
  "runUrl": "https://github.com/owner/repo/actions/runs/123",
  "flows": [
    { "name": "Login Flow", "file": "tests/login.yaml", "status": "passed", "duration_ms": 1500, "error": null },
    { "name": "Dashboard", "file": "tests/dashboard.yaml", "status": "failed", "duration_ms": 2100, "error": "Element not found: #loading" }
  ]
}
```

The payload is **minimized by design**: it includes flow names, paths, durations, status, and the first error message of each failed flow. It does not include screenshots, full stack traces, env vars, or process arguments. This bounds the worst-case data leak if the webhook URL is misconfigured.

### Trigger semantics

Both channels honor two boolean flags (Maestro-style):

- `onFailure: true` (default) — fire when at least one flow failed.
- `onSuccess: false` (default) — fire when all flows passed. Set to `true` for "always notify".

Set both to `false` to disable a channel without removing it from config.

## AI Features

skeptic integrates with Gemini, OpenAI, and Anthropic for AI-powered testing:

- **`assertWithAI`** -- natural-language assertions evaluated by a vision model against a page screenshot.
- **`assertNoDefects`** -- AI scans the page for visual defects (overlapping elements, broken layouts, etc.).
- **`extractTextWithAI`** -- ask AI to extract specific information from the page and optionally store it in a variable.
- **`skeptic generate --diff`** -- generate test flows from a git diff. Analyzes changed files and produces flows covering the affected UI.
- **`skeptic test --analyze`** -- AI-powered failure analysis that explains why a step failed and suggests fixes.

Configure the provider in `skeptic.config.yaml`:

```yaml
ai:
  provider: gemini       # or: openai, anthropic
```

Then set the matching API key environment variable -- `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY` -- or put the key in `ai.apiKey`. See `skeptic generate --help` for the `--model` override.

### AI in CI

`skeptic add github-action --ai --provider <name>` produces a workflow that runs `skeptic test --ci ... --analyze`. On a failed run, the AI provider analyzes screenshots and step errors to explain why each step failed.

To insulate runtime from any stale `ai:` settings in `skeptic.config.yaml`, the scaffold injects two extra env vars on the test step in addition to the provider's API-key secret:

- `SKEPTIC_AI_PROVIDER` — overrides `ai.provider` at runtime via the loader's env-override hook.
- `SKEPTIC_AI_API_KEY` — overrides `ai.apiKey` at runtime (same pattern). Carries the same secret value as the provider-specific env var.

These env vars are also useful outside CI — e.g. `SKEPTIC_AI_PROVIDER=openai skeptic test --analyze` overrides whatever the config file says.

## Observability

skeptic captures performance metrics, network traffic, and accessibility violations during test runs. Collectors attach per-flow based on which assertion steps your flow uses.

### Step-level assertions

```yaml
- assertPerformance: { lcp: "<2.5s", cls: "<0.1", inp: "<200ms" }
- assertNoNetworkErrors: { allowStatus: [404] }
- accessibilityAudit: { standard: "WCAG2AA", impacts: ["critical", "serious"] }
```

### Capture behaviour

- **Performance** and **network** collectors run continuously when enabled — they observe the page lifecycle from attach to detach. The `assertPerformance:` and `assertNoNetworkErrors:` steps query the live snapshot.
- **Accessibility** runs on demand — only when an `accessibilityAudit:` step fires. The collector attaches at flow start (and can optionally load IBM Equal Access if installed) but doesn't audit until the step is reached.

### Force always-on capture

Attach the performance and network collectors even when no assertion step uses them — useful when you want metrics in the JSON report regardless of assertion outcomes:

```yaml
# skeptic.config.yaml
observability:
  collectors: [performance, network]
```

All metrics land in `FlowResult.metrics.{performance,network,accessibility}`. Reporters (console, HTML, JSON) surface them automatically.

### Configuration

```yaml
observability:
  collectors: []                     # always-on collectors (defaults to inferred from step list)
  networkCaptureLimit: 500           # max requests per flow (0 = unlimited)
  duplicateWindowMs: 500             # window for duplicate-request detection
  accessibilityDualEngine: false     # set true to also run IBM Equal Access (peer dep)
  accessibilityHtmlSnippetLimit: 500 # cap on HTML snippet bytes in violation nodes (0 = suppress)
```

`accessibility-checker-engine` is now declared in `optionalDependencies`, so a
plain `npm install skeptic-cli` pulls in IBM Equal Access by default. You can
still set `observability.accessibilityDualEngine: true` explicitly, but
`--observability` already flips it on as part of the richest-profile bundle.
With it, axe-core runs first; IBM Equal Access runs alongside and contributes
additional findings deduplicated by rule ID.

If the peer can't be installed (incompatible platform, install opted-out via
`--no-optional`), the collector emits one info line at attach time and degrades
to axe-only without failing the run.

> **Binary distribution caveat**: standalone skeptic binaries (downloaded from
> GitHub Releases or Homebrew) always degrade to axe-only — the
> `--observability` profile trades a11y dual-engine for portability on the slim
> binary. The Equal Access engine resolves
> `accessibility-checker-engine/ace.js` via `createRequire(import.meta.url)`,
> which inside a SEA binary points at the binary itself rather than the user's
> `node_modules/` — so the peer dependency cannot be loaded even if installed.
> If you need Equal Access, use `npm install -g skeptic-cli` (the primary
> distribution).

### Privacy

URL query parameters with token-shaped names (`token`, `apikey`, `auth`, `password`, `signature`, AWS SigV4 params like `X-Amz-Signature`, etc.) are redacted to `***` in captured network requests by default. The redaction happens at capture time, so redacted values flow through to all reporters and the snapshot. Users with sensitive endpoints should also scope flows away from them. Full opt-out via config is a planned follow-up.

## Cookie Extraction

skeptic can extract cookies from your local browsers and inject them into test sessions. This is useful for testing authenticated flows without scripting a login.

```bash
# Enable for all detected browsers
skeptic test --cookies

# Extract from a specific browser
skeptic test --cookies-from chrome

# List detected browsers
skeptic cookies list
```

Set `auth: cookies` in flow metadata to enable per-flow, or `auth.cookies: true` in config for all flows.

## Video Recording

Record test execution as WebM video:

```bash
skeptic test --video
```

Videos are saved to the output directory alongside reports.

## Parallel Execution

Run multiple flows concurrently:

```bash
# Run 4 flows at a time
skeptic test --parallel 4
```

Set `execution.parallel` in config for a persistent default.

## CI/CD

Generate a GitHub Actions workflow:

```bash
skeptic add github-action --ai
```

This creates `.github/workflows/skeptic-tests.yml` configured to run your flows on push/PR.

## License

MIT
