# AGENTS.md

Instructions for AI coding agents authoring and running tests with
`skeptic-cli`.

Skeptic is a TypeScript-first Playwright runner. Author `*.spec.ts` files,
discover selectors with `skeptic inspect`, run them with `skeptic run`, and use
the generated artifacts as the source of truth when debugging.

## Fast Loop

```bash
skeptic doctor --quick
skeptic inspect <url> --interactive --compact
skeptic run tests/<scenario>.spec.ts --observability --video --trace
```

Specs import from the project dependency `skeptic-cli`. A normal `skeptic init`
writes that dependency to `package.json`; run `npm install` before
`skeptic run`, or re-run it if specs fail with `Cannot find package
'skeptic-cli'`.

Use `skeptic observe <url>` when you need a one-off QA capture without writing a
spec.

## Skill Installation

The npm package installs a managed `skeptic` skill for Claude Code, Codex,
Cursor, and OpenCode into user-level skill directories when `npm install` runs.
Use that skill when an agent needs browser QA, spec authoring, or interactive
browser-session driving.

Manual install commands:

```bash
skeptic add skill --agent all --scope project
skeptic add skill --agent all --scope user
```

Project scope writes `.claude/skills/skeptic`, `.agents/skills/skeptic`,
`.cursor/skills/skeptic`, and `.opencode/skills/skeptic`. User scope writes the
matching home-directory locations. Skeptic only replaces skills marked as
managed by `skeptic-cli`; custom skills are not overwritten.

## Test Shape

```ts
import { test, expect } from "skeptic-cli";

test("homepage smoke", async ({ page, snapshot, screenshot, observability }) => {
  await page.goto("https://example.com");
  await expect(page).toHaveTitle(/Example Domain/);

  const tree = await snapshot(page);
  await tree.byRole("link", { name: "More information..." }).click();

  await screenshot("homepage", { fullPage: true });
  await observability.expectNoConsoleErrors();
});
```

Rules for generated or hand-written specs:

- Import only from `skeptic-cli` unless the scenario truly needs another local helper.
- Keep browser actions inside `test(...)`, `test.beforeEach(...)`, or `test.afterEach(...)`.
- Do not put browser side effects at module top level; discovery imports the spec before execution.
- Prefer role, label, text, and test-id locators over CSS.
- Use `snapshot(page)` before interacting with elements discovered through Skeptic refs.
- Save visual checkpoints with `screenshot("name")` when they help debug failures.

## Fixture API

| Member | Use |
|---|---|
| `page` | Playwright `Page` |
| `expect` | Re-exported Playwright Test expect |
| `snapshot(target?, opts?)` | ARIA + cursor-interactive discovery |
| `screenshot(name, opts?)` | PNG capture with optional ref annotations |
| `settle()` | Best-effort network-idle settle |
| `observability` | Performance, network, console, and accessibility assertions |
| `ctx` | Per-test execution context |

### Snapshot Helpers

```ts
const tree = await snapshot(page, { interactive: true, compact: true });
await tree.byRole("button", { name: "Submit" }).click();
await tree.byText(/Welcome/).isVisible();
await tree.byTestId("save").click();
await (await tree.byRef("e3")).click();
```

`tree.byRef("eN")` is only valid for refs minted by that exact
`snapshot(...)` call. After navigation, modal opens, route changes, or major DOM
mutation, capture a new snapshot.

Snapshot options:

| Option | Default | Use |
|---|---:|---|
| `interactive` | `false` | Keep ref-bearing entries only |
| `compact` | `false` | Keep ref-bearing entries plus minimal ancestors |
| `selector` | `"body"` | Scope capture to a subtree |
| `viewportAware` | `true` | Include viewport-hidden markers |
| `includeCursorInteractive` | `true` | Detect click handlers without ARIA roles |

## Inspect Workflow

```bash
skeptic inspect https://example.com
skeptic inspect https://example.com --interactive --compact
skeptic inspect https://example.com --json
skeptic inspect https://example.com --annotated --annotate-output inspect.png
```

The output includes `selectorHint:` lines. Copy those into test code as durable
selectors. Do not copy raw `@eN` refs into a spec unless the same spec first
calls `snapshot(page)` and uses the matching `tree.byRef(...)`.

Common flags:

| Flag | Use |
|---|---|
| `--interactive` | Show ref-bearing entries |
| `--compact` | Reduce snapshot size |
| `--selector <css>` | Scope to part of the page |
| `--json` | Machine-readable refs and stats |
| `--device <id>` | Discover at a device profile |
| `--connect <url>` | Attach to an existing browser over CDP |
| `--with-playwright-hints` | Print Playwright locator snippets |
| `--wait <ms>` | Wait before capture |

If an element cannot be found during execution, re-run `inspect` against the
failure state and update the selector from observed output.

## Running Specs

```bash
skeptic run
skeptic run tests/login.spec.ts
skeptic run tests/**/*.spec.ts --tag smoke
skeptic run --parallel 4
skeptic run --shard-split 4 --shard-index 1
skeptic run --list
```

`--parallel` runs multiple spec-file workers at once. Tests inside one file run
in declaration order.

Use `--bail` for sequential fail-fast behavior. Use `--retries <n>` for flaky
retries. Use `--hard-timeout <ms>` to enforce a per-test ceiling.

## Observability

Attach collectors with `--observability` or per file:

```ts
test.use({ collectors: ["performance", "network", "console", "accessibility"] });
```

Assertions:

```ts
await observability.expectPerformance({ lcp: "<2500ms", cls: "<0.1" });
await observability.expectNoNetworkErrors({ allow: [/analytics/] });
await observability.expectNoConsoleErrors();
await observability.expectAccessible({ standard: "WCAG21AA" });
const metrics = await observability.snapshot();
```

`--observability` enables performance, network, console, accessibility,
full-page screenshot defaults, visual settle, automatic accessibility audit, and
artifact sidecars. Use `--observability-write-sidecars` to force sidecar files.

## Screenshots

```ts
await screenshot("before-submit");
await screenshot("after-submit", { fullPage: true });
await screenshot("annotated", { annotate: true, annotateScope: "main" });
```

Annotated screenshots add numbered labels over interactive refs and return an
annotation map without accessible names, so structured metadata does not repeat
potentially sensitive page text.

## Browser Session Verbs

Skeptic is agent-native — you drive a persistent browser from the shell, no MCP
server and no built-in AI/keys. A daemon holds the session so `@eN` refs persist
between commands:

```bash
skeptic open https://app.example.com    # opens a session
skeptic snapshot -i                      # mints @e1.. refs + selectorHints
skeptic click @e3
skeptic fill @e5 "user@test.com"
skeptic snapshot -i                      # re-snapshot after the DOM changed
skeptic console --errors
skeptic screenshot --full                # returns a file path
skeptic close
```

Verbs: `open`, `snapshot` (`-i`/`-c`), `click`, `fill`, `type`, `press`, `hover`,
`check`, `uncheck`, `select`, `get`, `screenshot`, `console`, `wait`, `list`,
`close`. Add `--json` to any verb; `--session <name>` for isolated sessions;
`--headless` on `open` for CI. Re-snapshot after navigation — refs invalidate on
DOM change and acting on a stale ref returns a clear `[ariaRef:stale]` error.

## Evidence

With the relevant flags, Skeptic writes:

- `results.json`
- `report.html`
- `junit.xml`
- screenshots
- annotated screenshots
- WebM video
- Playwright trace zip
- `perf-trace.md`
- `network.json`
- `console.json`
- `accessibility.json`
- `audit.md`

Use paths from `results.json` rather than guessing artifact filenames.

## Config Defaults

```yaml
url: http://localhost:3000
tests: "tests/**/*.spec.ts"

browser:
  engine: chromium
  headless: true
  timeout: 30000

execution:
  retries: 0
  bail: false
  parallel: 1

output:
  dir: ./skeptic-output
  reporters: [console]
```

## CI

```bash
skeptic add github-action
skeptic add github-action --dev-command "npm run dev" --dev-url http://localhost:3000
skeptic comment --results ./skeptic-output/results.json
```

The generated workflow runs `skeptic run --ci` and uploads `skeptic-output/`.

## Troubleshooting

```bash
skeptic doctor --json --quick
skeptic browsers install chromium
skeptic daemon status
skeptic daemon stop
```

When reporting a failure, include:

- command run
- `results.json`
- failing test name
- first failing step error
- screenshot/video/trace paths from the result
