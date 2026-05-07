# skeptic

CLI-first end-to-end testing for TypeScript specs. Skeptic runs Playwright tests,
adds agent-friendly page discovery, and captures QA evidence that is useful in
local debugging, CI, and coding-agent workflows.

> Agent authors should also read [AGENTS.md](./AGENTS.md) for the recommended
> inspect → author → run loop and the full fixture API.

## Install For Development

```bash
git clone https://github.com/iamjr15/skeptic
cd skeptic/cli
npm install
npm run build
node dist/skeptic.mjs --help
```

To use the local checkout as a command:

```bash
npm link
skeptic --help
```

## Quick Start

```bash
# Install the CLI
npm install -g skeptic-cli

# Initialize a project
skeptic init
npm install

# Discover stable selectors before authoring a test
skeptic inspect https://example.com

# Capture an ad hoc QA evidence bundle without writing a spec
skeptic observe https://example.com

# Run TypeScript specs with full QA evidence
skeptic run tests/homepage.spec.ts --observability --video --trace

# Generate a validated TypeScript spec with AI
skeptic generate -m "test the login page"

# Check local setup
skeptic doctor
```

`skeptic init` creates:

- `package.json` when missing, or adds a `test:e2e` script and `skeptic-cli` dev dependency when present
- `tests/`
- `tests/package.json` with `type: "module"` so specs can use ESM without changing your app package mode
- `tests/example.spec.ts`
- `skeptic.config.yaml`
- `tsconfig.json`
- `.skeptic/.gitignore`
- root `.gitignore` entries for `.skeptic/` and `skeptic-output/`

## Agent Skills

The npm package includes a `skeptic` skill for Claude Code, Codex, Cursor, and
OpenCode. During `npm install`, Skeptic installs that skill into user-level agent
skill directories when possible:

| Agent | User skill directory |
|---|---|
| Claude Code | `~/.claude/skills/skeptic` |
| Codex | `${CODEX_HOME:-~/.codex}/skills/skeptic` |
| Cursor | `~/.cursor/skills/skeptic` |
| OpenCode | `~/.opencode/skills/skeptic` |

The installer only replaces skills previously managed by `skeptic-cli`; existing
custom skills are left untouched. To skip automatic installation, set
`SKEPTIC_SKIP_AGENT_SKILL_INSTALL=1` or `SKEPTIC_INSTALL_AGENT_SKILLS=0`.
Automatic installation is skipped in CI unless `SKEPTIC_INSTALL_AGENT_SKILLS=1`
is set. To install only selected agents, set
`SKEPTIC_AGENT_SKILLS=claude,codex`.

For a repository-scoped skill that should be committed with a project, run:

```bash
skeptic add skill --agent all --scope project
```

For an explicit user-level reinstall, run:

```bash
skeptic add skill --agent all --scope user
```

## Test Format

Skeptic specs are ordinary TypeScript files that import from `skeptic-cli`.

```ts
import { test, expect } from "skeptic-cli";

test("homepage smoke", async ({ page, snapshot, screenshot, observability }) => {
  await page.goto("https://example.com");
  await expect(page).toHaveTitle(/Example Domain/);

  const tree = await snapshot(page);
  await expect(tree.byRole("heading", { name: "Example Domain" })).toBeVisible();

  await screenshot("homepage", { fullPage: true });
  await observability.expectNoConsoleErrors();
});
```

The fixture exposes:

| Member | Purpose |
|---|---|
| `page` | Playwright `Page`, wrapped for cursor/action markers when video is enabled |
| `snapshot` | ARIA + cursor-interactive discovery with refs and locator helpers |
| `screenshot` | PNG screenshots, including annotated numbered-ref captures |
| `settle` | Network-idle settle helper |
| `observability` | Performance, network, console, and accessibility assertions |
| `ai` | Vision-backed assertions, defect checks, and text extraction |
| `ctx` | Per-test execution context and artifact paths |

`expect` is re-exported from Playwright Test, so matchers like
`toHaveURL`, `toBeVisible`, and `toHaveText` are available without a second
import.

## Discovery

`skeptic inspect <url>` opens the page, captures an ARIA/cursor snapshot, and
prints stable `selectorHint:` lines.

```bash
skeptic inspect https://example.com --interactive --compact
skeptic inspect https://example.com --json
skeptic inspect https://example.com --annotated --annotate-output inspect.png
```

Useful flags:

| Flag | Purpose |
|---|---|
| `--interactive` | Show only ref-bearing entries |
| `--compact` | Show interactive entries with minimal ancestors |
| `--selector <css>` | Scope discovery to part of the page |
| `--json` | Emit machine-readable refs, hints, and stats |
| `--device <id>` | Inspect under a configured device profile |
| `--connect <url>` | Attach to an existing browser over CDP |
| `--with-playwright-hints` | Emit equivalent Playwright locator snippets |
| `--annotated` | Save a numbered-ref screenshot |

Refs like `e3` are runtime handles. Copy `selectorHint` strings into durable
tests, or use `tree.byRef("e3")` only after a matching `snapshot(page)` call in
the same test.

## Running Tests

```bash
skeptic tui
skeptic tui tests/login.spec.ts
skeptic run
skeptic run tests/login.spec.ts
skeptic run tests/**/*.spec.ts --tag smoke
skeptic run --parallel 4
skeptic run --shard-split 4 --shard-index 1
skeptic run --watch
```

`skeptic tui` is the discoverable interactive entrypoint, matching Expect's
explicit `expect tui` model. `skeptic run` is the plain spec runner for scripts,
CI, and agent-invoked regression checks.

Specs import from `skeptic-cli`, so project dependencies must be installed. A
normal `skeptic init` writes the dependency into `package.json`; run
`npm install` once before `skeptic run`.

Important flags:

| Flag | Purpose |
|---|---|
| `--headed` | Show the browser |
| `--ci` | Force headless CI behavior |
| `--bail` | Stop after the first failing test |
| `--retries <n>` | Retry failed tests |
| `--timeout <ms>` | Playwright default action timeout |
| `--hard-timeout <ms>` | Per-test ceiling enforced by the runner |
| `--parallel <n>` | Run up to N spec-file workers concurrently |
| `--shard-split <n>` | Split tests across N independent shard runs |
| `--shard-all <n>` | Run all tests on each shard for variance checks |
| `--reporter <format...>` | `console`, `json`, `junit`, `html` |
| `--output <dir>` | Report and artifact directory |
| `--list` | Discover tests without launching a browser |

`--parallel` runs different spec files concurrently. Tests inside one file stay
ordered so hooks, module state, and duplicate names remain predictable.

## Observability

`--observability` enables the full QA bundle:

- visual settle before screenshots
- full-page screenshots by default
- performance metrics
- network capture and issue detection
- console capture
- accessibility audit with automatic per-test `audit.md`
- sidecar artifacts when report defaults allow them

Use `--observability-write-sidecars` to force sidecars even when the reporter
profile would not otherwise write them.

```ts
test("checkout stays healthy", async ({ page, observability }) => {
  await page.goto("/checkout");
  await observability.expectPerformance({ lcp: "<2500ms", cls: "<0.1" });
  await observability.expectNoNetworkErrors();
  await observability.expectNoConsoleErrors();
  await observability.expectAccessible({ standard: "WCAG21AA" });
});
```

Artifacts can include:

- `results.json`
- `report.html`
- `junit.xml`
- screenshots
- WebM videos
- Playwright trace zips
- `perf-trace.md`
- `network.json`
- `console.json`
- `accessibility.json`
- `audit.md`

## Observe

`skeptic observe <url>` is the one-command evidence path for exploratory QA.

```bash
skeptic observe https://example.com --full-page
skeptic observe https://example.com --no-video --no-trace
```

It writes an output directory containing an HTML report, JSON report,
screenshots, annotated screenshots, snapshot text/JSON, console/network data,
performance summary, accessibility JSON, and an accessibility markdown audit.

## AI Features

Skeptic supports Gemini, OpenAI, and Anthropic.

```yaml
ai:
  provider: openai
  model: gpt-4o
```

Set the matching provider key with `GEMINI_API_KEY`, `OPENAI_API_KEY`, or
`ANTHROPIC_API_KEY`. You can also use `SKEPTIC_AI_PROVIDER` and
`SKEPTIC_AI_API_KEY` to override config in CI.

Available AI paths:

- `ai.assert("the dashboard greets the user")`
- `ai.assertNoDefects()`
- `ai.extract("the invoice total")`
- `skeptic generate --message "test checkout"`
- `skeptic generate --diff`
- `skeptic run --analyze`

Generated specs are typechecked and imported before being written.

## MCP And ACP

`skeptic mcp` exposes testing and browser QA tools over stdio:

| Tool | Purpose |
|---|---|
| `list_tests` | Discover specs |
| `validate_tests` | Typecheck and import-check specs |
| `generate_test` | Generate a validated TypeScript spec |
| `run_test` | Run specs and stream progress |
| `browser_open` | Open a page with config-driven browser/auth/safety |
| `browser_snapshot` | Capture ARIA/cursor refs |
| `browser_playwright` | Run focused Playwright code |
| `browser_screenshot` | Capture PNG, annotated PNG, or snapshot-only output |
| `browser_console_logs` | Read console messages |
| `browser_network_requests` | Read requests and computed issues |
| `browser_performance_metrics` | Capture Web Vitals, LoAF, resources, and `perf-trace.md` |
| `browser_accessibility_audit` | Run axe-core plus IBM Equal Access when available |
| `browser_close` | Close the browser session |

`skeptic acp` exposes a testing-focused agent server for editors that support
Agent Client Protocol.

## Configuration

`skeptic.config.yaml` lives in the project root.

```yaml
url: http://localhost:3000
tests: "tests/**/*.spec.ts"

browser:
  engine: chromium
  headless: true
  timeout: 30000
  viewport:
    width: 1280
    height: 720

execution:
  retries: 0
  bail: false
  parallel: 1

output:
  dir: ./skeptic-output
  reporters: [console]

observability:
  collectors: []
  defaultsForReports: passive
  networkCaptureLimit: 500
  duplicateWindowMs: 500
  accessibilityDualEngine: false
  autoAccessibilityAudit: false

safety:
  allowedDomains: []
  confirmActions: []
  maxOutputChars: 120000

env:
  BASE_URL: http://localhost:3000
```

## Cookie Injection

```bash
skeptic cookies list
skeptic run --cookies
skeptic run --cookies-from chrome
```

Cookie extraction is opt-in. Cookies are injected into local test browser
contexts and are not sent to Skeptic services.

## CI

```bash
skeptic add github-action
skeptic add github-action --ai --provider openai
```

The generated workflow installs dependencies, installs Chromium, starts your dev
server, runs Skeptic, uploads artifacts, and posts a PR comment with
`skeptic comment`.

## Notifications

Optional Slack and webhook notifications are configured under `notifications`.
Notification failures warn but do not fail the test run.

```yaml
notifications:
  slack:
    webhookUrl: ${SLACK_WEBHOOK_URL}
    onFailure: true
    onSuccess: false

  webhook:
    url: ${SKEPTIC_WEBHOOK_URL}
    onFailure: true
    onSuccess: false
```

Webhook payloads use a `tests` array with name, file, status, duration, error,
and optional shard metadata.

## Diagnostics

```bash
skeptic doctor
skeptic doctor --json --quick
skeptic browsers install chromium
skeptic daemon status
skeptic daemon stop
```

`skeptic doctor` checks config, output directories, browser installs, optional
accessibility/cookie engines, daemon state, cookie profiles, and AI provider
setup.

## License

MIT
