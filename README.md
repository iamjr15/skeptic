# skeptic

**Agent-native, CLI-first QA for the web.** skeptic gives a coding agent the
hands and eyes it needs to actually verify a UI change: it inspects live pages,
runs deterministic TypeScript end-to-end specs with Playwright, and writes a
rich evidence bundle (screenshots, video, traces, performance, network,
console, and accessibility audits) that the agent reads back as ground truth.

skeptic brings **no model of its own**. It uses **no API keys** and makes **no
LLM calls**. The intelligence comes from the host coding agent (Claude Code,
Codex, Cursor, OpenCode, …); skeptic is the deterministic execution and
evidence layer that agent drives through a skill and a CLI.

> Web QA ships today. Native **mobile** QA (driving devices/emulators via
> `adb` and `simctl`) is on the roadmap; the agent loop and evidence model are
> designed to extend to it.

## Why it exists

A coding agent can write a UI change but cannot trust that it works until it has
observed the running app. Asking the agent to drive a raw browser is slow,
non-deterministic, and produces no durable artifacts. skeptic closes that loop:

- **Deterministic execution** — Playwright runs the same spec the same way every
  time, headless in CI or headed locally.
- **Agent-readable discovery** — `skeptic inspect` emits ARIA + cursor-interactive
  refs with stable `selectorHint:` lines, so the agent picks durable locators
  instead of guessing CSS.
- **Evidence as the source of truth** — every run writes `results.json` plus
  screenshots, WebM video, Playwright traces, and observability sidecars. The
  agent reads files, not vibes.
- **Zero secrets** — nothing is sent to any third-party service. Cookie
  extraction is strictly opt-in and stays local.

## The agent loop

skeptic is built around a four-step loop the host agent runs:

1. **Skill** — the bundled `skeptic` skill teaches the agent when and how to
   reach for skeptic (installed automatically for Claude Code, Codex, Cursor,
   and OpenCode on `npm install`).
2. **Inspect** — `skeptic inspect <url>` captures the page's interactive
   surface and stable selector hints.
3. **Author / run** — the agent writes a `*.spec.ts` (or uses `skeptic observe`
   for a one-off capture) and executes it with `skeptic run`.
4. **Read evidence** — the agent opens `results.json` and the artifact bundle to
   confirm the change works, or to debug the exact failing step.

## Quick start

```bash
# Install the CLI (published as `skeptic-cli`, exposes the `skeptic` binary)
npm install -g skeptic-cli

# Scaffold a project (tests/, config, tsconfig, example spec)
skeptic init
npm install

# Check local setup, browser installs, and daemon state
skeptic doctor

# Discover stable selectors before authoring a test
skeptic inspect https://example.com --interactive --compact

# Capture a one-off QA evidence bundle without writing a spec
skeptic observe https://example.com --full-page

# Run TypeScript specs with the full evidence bundle
skeptic run tests/homepage.spec.ts --observability --video --trace
```

A spec is an ordinary TypeScript file that imports from `skeptic-cli`:

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

## Command surface

| Command | Purpose |
|---|---|
| `skeptic init` (alias `setup`) | Scaffold a project: `tests/`, `skeptic.config.yaml`, `tsconfig.json`, example spec |
| `skeptic run [specs…]` | Run TypeScript specs headless/headed, with sharding, retries, reporters, and the observability bundle |
| `skeptic tui [specs…]` | Interactive terminal runner UI |
| `skeptic observe <url>` | One-command exploratory QA capture (screenshots, video, trace, perf/network/console/a11y) without a spec |
| `skeptic inspect <url>` | Emit ARIA + cursor-interactive refs with stable `selectorHint:` lines (CDP attach, annotated PNG, device profiles) |
| `skeptic doctor` | Diagnose setup, browser installs, optional engines, daemon state, and agent DX |
| `skeptic add github-action` | Generate a CI workflow for E2E tests |
| `skeptic add skill` | Install the skeptic skill for a coding agent (project or user scope) |
| `skeptic cookies list` | List detected browsers for opt-in cookie extraction |
| `skeptic browsers install [engines…]` | Download Playwright browser binaries |
| `skeptic daemon start\|stop\|status\|logs` | Manage the persistent BrowserServer daemon |
| `skeptic comment` | Upsert a PR comment with test results (uses the `gh` CLI) |
| `skeptic audit` | Run project lint, type-check, and quality scripts |

Run `skeptic <command> --help` for the full flag set.

## Observability

`skeptic run --observability` (or per-spec `test.use({ collectors: [...] })`)
turns on the full QA bundle: visual settle before screenshots, full-page
screenshots, Web Vitals performance metrics, network capture with issue
detection, console + page-error capture, and an accessibility audit (axe-core,
plus IBM Equal Access when the optional engine is installed). Artifacts can
include `results.json`, `report.html`, `junit.xml`, screenshots, WebM video,
Playwright trace zips, `perf-trace.md`, `network.json`, `console.json`,
`accessibility.json`, and `audit.md`. Agents should read paths out of
`results.json` rather than guessing filenames.

## Architecture

skeptic is three pieces and nothing else:

- **Skill** — the agent-facing guidance bundle that routes a coding agent
  through the inspect → author/run → read-evidence loop.
- **CLI** — TypeScript (ESM), Commander, Playwright, and Zod. Discovery,
  execution, reporting, and evidence capture.
- **Daemon** — a persistent Playwright `BrowserServer` over a Unix socket so
  repeated `run`/`inspect` calls reuse a warm browser instead of paying cold
  start every time.

There is intentionally **no MCP server, no ACP server, and no built-in AI/model
subsystem.** Those were removed; see [CHANGELOG.md](./CHANGELOG.md). The host
coding agent is the brain.

## Cookies and safety

Cookie extraction is **opt-in** (`--cookies` / `--cookies-from <browser>`) and
off by default. Extracted cookies are injected only into the local test browser
context and never leave the machine. Decryption happens locally using the OS
keychain/secret store. See [SECURITY.md](./SECURITY.md) for the disclosure
policy and the security model for agent-driven browser actions.

## Development

```bash
git clone https://github.com/iamjr15/skeptic
cd skeptic/cli
npm install
npm run build
node dist/skeptic.mjs --help
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, code style, and how to
run a single test. The CLI lives under [`cli/`](./cli); agent-authoring guidance
is in [`cli/AGENTS.md`](./cli/AGENTS.md).

## License

[MIT](./LICENSE). Third-party components redistributed inside the published
bundle are attributed in [`cli/LICENSES.md`](./cli/LICENSES.md).
