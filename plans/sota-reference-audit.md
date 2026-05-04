# SOTA Reference Audit: Borrowing From agent-browser and Expect

Date: 2026-05-03

## Scope

This audit reviews the local reference code under:

- `/Users/iamjr15/Desktop/aurum-refs/agent-browser`
- `/Users/iamjr15/Desktop/aurum-refs/expect`
- `/Users/iamjr15/Desktop/skeptic`

The goal is not to copy either product wholesale. `agent-browser` is a general browser-control CLI for agents. Expect is a compact browser MCP/runtime plus an agent-supervised testing layer. Skeptic should remain a testing product: fast TS specs, high-quality reports, agent-friendly discovery, observability, and CI behavior. The right move is to borrow the primitives that improve test authoring, diagnosis, safety, and agent loops without turning Skeptic into a generic browser swiss-army knife.

## Executive Verdict

Skeptic is already ahead of Expect for repeatable test-runner workflows: TS specs, reporters, sharding, retries, daemon-backed execution, video/trace output, observability sidecars, CI comments, and generated tests. After the recent work, Skeptic also has the DX basics Expect had around local state directories: `skeptic init` creates `.skeptic/.gitignore` and updates root `.gitignore` for `.skeptic/` and `skeptic-output/`.

Expect is still ahead in one important area: live browser MCP ergonomics. Its `open` -> `screenshot(mode="snapshot")` -> `playwright(snapshotAfter=true)` loop is excellent for coding agents because it keeps refs fresh, exposes `ref("eN")` directly, writes large results to temp files, and offers quick console/network/perf/a11y tools in one session.

agent-browser is ahead in operating-model completeness: `doctor`, durable session/state management, encrypted state files, policy/domain restrictions, network route/HAR tooling, tab/window handles, dialog status, diffing, skills served by the installed CLI, and agent-behavior evals/benchmarks.

The SOTA path for Skeptic is therefore:

1. Keep Skeptic test-runner-first.
2. Add a first-class live browser MCP/agent loop alongside the existing test-runner MCP.
3. Add `doctor`, state/session, policy, and config-schema quality-of-life features.
4. Build evals and benchmarks that continuously compare Skeptic against Expect and agent-browser on agent success rate, output quality, latency, and artifact usefulness.

## What Skeptic Already Has And Should Preserve

These are not gaps; they are strengths to keep intact:

- `skeptic inspect`: ARIA and cursor-interactive snapshots, selector hints, stats, compact/interactive modes, annotated PNG output, CDP attach, daemon path, and clear warning that refs are volatile.
- Test-runner depth: TypeScript spec API, `test.use`, per-file workers, retries, sharding, bail, hard timeouts, screenshots on failure, video, Playwright trace, and artifact directories.
- Observability: performance, network, console, axe-core plus optional IBM Equal Access, auto a11y audit under `--observability`, `perf-trace.md`, `network.json`, `console.json`, and `audit.md`.
- Reports and CI: console/html/json/junit reporters, PR comment upsert, Slack/webhook notifications, GitHub Action scaffold.
- Daemon: persistent BrowserServer with owner-only `~/.skeptic`, idle timeout, sidecar files, version/engine handshake, and a `--no-daemon` escape hatch.
- Init DX: `tests/`, `skeptic.config.yaml`, `tsconfig.json`, `.skeptic/.gitignore`, and root `.gitignore` entries.
- Cookie extraction: Chromium/Firefox/Safari support, first-use local notice, and Playwright context injection.

## Borrow From Expect

### P0: Add Live Browser MCP Tools

Expect's browser MCP is small but very effective:

- `open`
- `playwright`
- `screenshot` with `snapshot`, `screenshot`, and `annotated` modes
- `console_logs`
- `network_requests`
- `performance_metrics`
- `accessibility_audit`
- `close`

Skeptic's current MCP is test-runner-oriented: `list_tests`, `validate_tests`, `generate_test`, and `run_test`. That is useful, but it does not give agents a fast interactive browser loop. Add one of these shapes:

- Preferred: keep existing tools and add browser tools with names such as `browser_open`, `browser_playwright`, `browser_screenshot`, `browser_console_logs`, `browser_network_requests`, `browser_performance_metrics`, `browser_accessibility_audit`, `browser_close`.
- Alternative: add a separate `skeptic browser-mcp` command with Expect-compatible tool names.

Important implementation details to borrow:

- Maintain a session object with `browser`, `context`, `page`, `trackedPages`, `consoleMessages`, `networkRequests`, `lastSnapshot`, and screenshot/video paths.
- `playwright` should expose globals: `page`, `context`, `browser`, and `ref(id)`.
- `snapshotAfter` should capture a fresh snapshot after DOM-changing code and update `lastSnapshot`.
- `screenshot(mode="snapshot")` should return `{ tree, refs, stats }`, not only a text block.
- Annotated screenshots should return the image plus an annotation list mapping labels to refs.

Why this matters: it lets agents inspect and act without guessing selectors, and it makes Skeptic competitive with Expect in interactive agent workflows.

### P0: Safe Result Serialization And Result Files

Expect's `safeJsonStringify` handles circular data, BigInt, functions, symbols, Buffers, RegExp, Errors, Map, Set, and non-serializable Playwright constructors. It also truncates long strings and writes returned Playwright results to `/tmp/expect-artifacts/playwright-results/result-*.json`.

Skeptic should add a shared `safeJsonStringify` utility and use it in MCP/ACP/browser tools. For large returned objects, return:

```json
{
  "result": "...small preview or structured value...",
  "resultFile": "/tmp/skeptic-artifacts/playwright-results/result-xxxx.json"
}
```

This is a direct DX improvement: agents can return structured evidence without breaking MCP frames or flooding context.

### P0: Viewport-Aware Scroll-Container Snapshots

Expect's runtime hides off-viewport children inside scroll containers, inserts accessible `note` markers like "N items hidden above/below", then restores the DOM. Skeptic currently supports viewport filtering, but it does not emit the hidden-above/below markers that tell an agent why expected items are missing.

Borrow the behavior, not necessarily the exact implementation:

- Detect scrollable containers with enough children.
- Temporarily mark fully hidden children `aria-hidden`.
- Insert zero-size `role="note"` markers for hidden counts.
- Restore all DOM mutations after the snapshot.
- Add stats fields such as `totalNodes` and `visibleNodes` when viewport-aware mode is active.

This materially improves list/table/menu exploration and prevents false conclusions from partial snapshots.

### P1: Action Error Taxonomy

Expect classifies Playwright failures into ref-specific errors:

- ambiguous ref
- blocked pointer event
- not visible/outside viewport/stale
- timeout
- unknown

Skeptic already has structured resolver errors in places, but action failures can still surface as raw Playwright messages. Add a shared `toActionError(error, target)` mapper and use it in:

- snapshot ref resolution
- page proxy actions
- MCP `ref()` actions
- selector-hint actions

The goal is not to hide Playwright's detail. The goal is to add a stable user-facing classification and next step: re-snapshot, scroll into view, disambiguate with selector hint, or fix the UI.

### P1: Headed Overlay For MCP And Inspect

Expect's `OverlayController` moves a cursor/label to refs or Playwright locators parsed from code and logs actions in the page overlay. Skeptic already has cursor overlays for videos and page proxies. Extend that to browser MCP/headed inspect:

- Show current tool/action label.
- Move cursor to `ref("eN")` or obvious locators in `playwright` code.
- Highlight refs used by a code block.
- Hide overlay during screenshots.
- Log action history in a small overlay panel.

This gives agents and humans a better debugging surface during headed sessions.

### P1: Cookie Extraction Via Profile Copy + CDP Fallback

Expect's `@expect/cookies` supports a stronger Chromium profile path:

- copy profile to temp
- remove singleton locks
- launch headless Chromium with that copied profile
- call `Network.getAllCookies`
- fall back to SQLite if needed

Skeptic currently reads Chromium cookies from SQLite and decrypts values directly. Keep that path, but add the CDP profile-copy strategy for Chromium so macOS Keychain/DPAPI friction drops and profile-specific extraction improves.

### P1: Project Detection And Dev Server Hints

Expect's supervisor detects frameworks and default/custom ports from `package.json`, dev scripts, and Vite config. Skeptic's GitHub Action scaffold asks for `--dev-command` and `--dev-url`, but it can infer a good default.

Add a `detectProject()` helper:

- Detect Next, Vite, Remix, Astro, Nuxt, SvelteKit, Gatsby, CRA, Angular.
- Infer dev command from `scripts.dev`.
- Infer port from `--port`, `-p`, or common config files.
- Use it in `skeptic init`, `add github-action`, and generated instructions.

### P1: MCP Testing Guide Resource

Expect ships a strong MCP prompt guide with rules around snapshot workflow, responsive testing, data seeding, stability, recovery, console/network checks, and status markers.

Skeptic should expose a similar resource/prompt from its MCP server:

- test-runner workflow
- browser MCP workflow
- ref freshness rules
- artifact interpretation
- responsive/a11y/perf pass expectations
- failure taxonomy and when to stop

This is especially important because MCP clients vary in how they display tool descriptions.

### P2: Saved Flow Memory

Expect has saved flow files with structured frontmatter and replay guidance. Skeptic's TS specs are stronger for durable tests, but saved exploratory flows are useful for agents.

Add optional `.skeptic/flows/*.md` memory:

- original user prompt
- target URL
- tested steps
- selectors/snapshot hints
- artifacts
- known blockers

Use it only as guidance for future generation or exploratory runs. Do not replace TS specs.

## Borrow From agent-browser

### P0: `skeptic doctor --json`

agent-browser's `doctor` is one of the best DX features in either repo. Skeptic should add an equivalent.

Recommended checks:

- CLI version, Node version, OS/arch.
- Home directory and `~/.skeptic` permissions.
- Output directory writability.
- Playwright installed and browser executable availability for chromium/firefox/webkit.
- Daemon sidecars, stale PID/socket cleanup, version mismatch, active daemon status.
- Config discovery and schema validation for `skeptic.config.yaml`.
- Optional dependency status: `accessibility-checker-engine`, `better-sqlite3`.
- Cookie extraction support and platform-specific warnings.
- AI provider env/config health without printing secrets.
- Notification config safety: Slack/webhook URLs present, but redact values.
- GitHub Action scaffold prerequisites where applicable.
- Live launch smoke test unless `--quick`.

Output should support text and JSON. `--fix` should be conservative:

- remove stale daemon sidecars
- create `~/.skeptic`
- fix permissions where safe
- optionally run `skeptic browsers install chromium`
- never delete user artifacts without a specific flag

This belongs in P0 because every hard-to-debug install issue becomes easier for users and agents.

### P0: Config Schema And Layering

agent-browser ships `agent-browser.schema.json` and layers user config, project config, env, and CLI flags.

Skeptic has a strong Zod schema but no exported JSON/YAML schema artifact. Add:

- `skeptic schema` command to print JSON Schema for editor integration.
- Packaged `skeptic.config.schema.json`.
- Schema URL comment in generated `skeptic.config.yaml`.
- Optional user config at `~/.skeptic/config.yaml` for defaults such as browser engine, output policy, and artifact preferences.
- Merge order: CLI flags > env vars > project config > user config > defaults.

Keep project config as source of truth for CI. User config should be convenience only.

### P0: Security Policy For Agent-Driven Runs

agent-browser has action policy and domain filtering. Skeptic needs this when agents drive browser MCP or AI-generated tests.

Add config:

```yaml
safety:
  allowedDomains: ["localhost", "127.0.0.1", "*.example.com"]
  actionPolicy: ".skeptic/action-policy.json"
  confirmActions: ["submit", "download", "navigation-external"]
  maxOutputChars: 120000
  contentBoundaries: true
```

Borrow these mechanics:

- Exact and wildcard domain allowlist.
- Block navigation and subresources outside allowed domains.
- Patch WebSocket, EventSource, and `sendBeacon`.
- Add Fetch interception where supported.
- Deny/allow/confirm policy with deny taking precedence.
- In non-interactive environments, confirmations fail closed.

This should apply first to browser MCP and AI generation/exploration. For ordinary deterministic test specs, default should remain permissive unless configured.

### P1: State Management Commands

agent-browser has a complete state surface:

- `state save`
- `state load`
- `state list`
- `state show`
- `state rename`
- `state clear`
- `state clean --older-than`
- optional encryption

Skeptic has cookie extraction and per-test isolation, but no user-facing auth state workflow. Add:

- `skeptic state save <url> [path]`
- `skeptic state load <path> --run ...` or config `auth.state`
- `skeptic state list/show/clear/clean`
- save cookies plus localStorage/sessionStorage per origin
- encrypt with `SKEPTIC_STATE_ENCRYPTION_KEY`
- write state files under `.skeptic/state/` by default and ensure ignored

This closes a major DX gap for authenticated app testing.

### P1: Network Route, Mock, HAR, And Request Detail

Skeptic's network collector is good for passive evidence: failed requests, failures, duplicates, mixed content, and CORS. agent-browser adds active network control:

- route URL patterns
- abort by resource type
- mock response body/status/headers
- list/filter tracked requests
- inspect full request/response detail
- start/stop HAR

Skeptic should expose this through fixtures and MCP:

```ts
await network.route("**/analytics/**").abort();
await network.mock("**/api/user", { status: 200, body: { name: "Ada" } });
await network.har.start();
```

This improves deterministic tests and lets agents isolate third-party noise.

### P1: Snapshot And Screenshot Diff Commands

agent-browser's `diff snapshot`, `diff screenshot`, and `diff url` are useful primitives. Skeptic already has `assertScreenshot` and visual-diff reporting in tests, but lacks an inspection-time CLI diff.

Add:

- `skeptic diff snapshot <urlA> <urlB> [--selector] [--compact]`
- `skeptic diff screenshot <baseline> <url|image> [--threshold]`
- `skeptic diff url <urlA> <urlB> --screenshot`

This helps users evaluate UI changes without writing a full test first.

### P1: Tabs, Frames, Dialogs, Downloads

agent-browser handles stable tab IDs, frame switching, dialog status/accept/dismiss, and downloads. Skeptic should selectively borrow:

- Test fixture helpers for dialogs and downloads.
- MCP tools for tabs/pages with stable IDs.
- Warning when a dialog is pending.
- Auto-dismiss policy for alert/beforeunload only, configurable.
- Frame helper that snapshots a specific frame and preserves ref scope.

This is not urgent for core tests, but it matters for parity with browser automation tools.

### P1: Bundled Skills Served By The CLI

Skeptic has `skeptic add skill`, but the generated skill is static at install time. agent-browser serves skills from the installed CLI with `skills list/get/path`, so agent instructions always match the binary version.

Add:

- `skeptic skills list`
- `skeptic skills get core`
- `skeptic skills get browser-mcp`
- `skeptic skills get ci`
- `skeptic skills path`

Then make `skeptic add skill` install a thin stub that tells agents to run `skeptic skills get core`. This prevents stale instructions as Skeptic evolves.

### P1: Evals For Agent Behavior

agent-browser has evals that check whether agents load the right skill and produce correct commands. Skeptic needs equivalent evals, because the product is explicitly agent-facing.

Suggested eval categories:

- skill loading: agent uses `skeptic skills get`.
- inspect loop: agent runs `skeptic inspect`, copies selector hints, writes a spec.
- browser MCP loop: agent snapshots, uses refs, refreshes refs after DOM changes.
- test authoring: generated TS spec compiles and avoids top-level browser side effects.
- debugging: agent reads artifacts and fixes a failing test.
- safety: agent respects allowed domains and does not leak secrets in output.

Run against at least Codex and Claude CLIs, with optional LLM judge scoring.

### P1: Benchmarks For Latency And Output Quality

agent-browser benchmarks daemon latency and memory. Skeptic should benchmark what matters for tests:

- cold `skeptic inspect`
- warm daemon `skeptic inspect`
- `snapshot` full/interactive/compact token count and latency
- one-test run cold/warm
- video + observability overhead
- a11y audit latency with axe-only vs dual-engine
- MCP `playwright(snapshotAfter=true)` latency
- output quality compared to Expect and agent-browser on a fixed website set

Store results under `benchmark-artifacts/` with a machine-readable summary.

### P2: React And Hydration Introspection

agent-browser has React tree/inspect/renders/suspense and vitals with hydration phases. Skeptic already collects web vitals and LoAF. Add React-specific collectors later:

- component tree snapshot
- render count/profile around interactions
- Suspense boundary classification
- hydration timing when profiling data exists

Keep this optional and framework-aware. Do not make React a core dependency for non-React apps.

### P2: Dashboard/Live Session UI

agent-browser's dashboard is useful, but Skeptic already has CLI/TUI/report surfaces. Treat live dashboard as later-stage:

- show running sessions/tests
- active page preview
- console/network panels
- artifact timeline
- action feed

This is nice, but not necessary before MCP, doctor, policy, and state management.

## Skeptic-Specific DX Gaps Found During Audit

### Documentation Drift

`cli/README.md` still contains a large legacy "YAML Flow Format" and `skeptic test` section even though the current CLI emphasizes `skeptic run` and TS specs. This hurts developer experience because users and agents may learn the wrong primary workflow.

Recommended fix:

- Make TS specs the only primary path in the README.
- Move legacy YAML details to `docs/legacy-yaml.md` if still supported.
- Replace `skeptic test` references with `skeptic run` or explicitly mark them as historical.
- Add a concise "agent workflow" section: `inspect` -> write TS spec -> `run --observability`.

### MCP Split Brain

Skeptic's MCP name sounds like a full browser automation MCP, but today it only handles tests. Expect's browser MCP is what agents expect when they ask to "open a page and inspect it." Add browser tools or split commands so this is explicit.

### Cookie Extraction Robustness

Skeptic's Chromium profile detection only checks `Default/Cookies` for each browser. Expect detects profiles more broadly and can extract via copied Chromium profiles and CDP. Add profile listing and profile selection for better real-world auth reuse.

### State And Auth Story

Cookie extraction helps, but many apps rely on localStorage/sessionStorage. Skeptic needs a durable storage-state workflow so login setup is not repeated or fragile.

### Safety Controls

Skeptic has redaction and local cookie consent, but no domain/action policy for AI-driven browser work. This is a blocker for high-trust agent automation.

## Prioritized Roadmap

### P0: Quality Foundation

1. `skeptic doctor --json`
   - Text and JSON output.
   - Checks install, daemon, config, browsers, optional deps, cookie support, AI config, artifact dirs.
   - Conservative `--fix`.

2. Browser MCP tools
   - Session lifecycle, `open`, `playwright`, `screenshot`, `console_logs`, `network_requests`, `performance_metrics`, `accessibility_audit`, `close`.
   - `ref(id)` from last snapshot.
   - `snapshotAfter`.
   - Safe serializer and result files.

3. Safety envelope for browser MCP and agent-driven runs
   - Allowed domains.
   - Action policy.
   - Max output and optional content boundaries.

4. Docs cleanup
   - README reflects current TS-spec runner.
   - Legacy YAML moved or clearly labeled.
   - MCP setup examples for Codex, Claude, Cursor, VS Code, Copilot, Gemini.

### P1: Daily Workflow Excellence

1. State management
   - Save/load/list/show/rename/clear/clean.
   - Cookies plus localStorage/sessionStorage.
   - Optional encryption.

2. Better cookie extraction
   - Profile detection.
   - Chromium copied-profile CDP extraction.
   - SQLite fallback.

3. Viewport-aware snapshot markers
   - Hidden above/below notes for scroll containers.
   - Stats for visible versus total nodes.

4. Network controls
   - Route, abort, mock, request detail, HAR.

5. Skills served by CLI
   - Version-matched `skeptic skills get core`.
   - Static stubs point to the CLI-served content.

6. Agent behavior evals
   - Inspect loop, MCP loop, spec authoring, debugging, safety.

### P2: SOTA Differentiators

1. React/hydration collectors.
2. Snapshot/screenshot/url diff CLI.
3. Live dashboard/session viewer.
4. Saved exploratory flow memory.
5. Cross-browser parity suites for Chromium, Firefox, WebKit.

## Test Strategy

Each borrowed feature needs tests at three levels:

- Unit tests for parsers, policies, serializers, domain matching, schema generation, and error classification.
- Integration tests with local fixtures for MCP browser tools, snapshots, state save/load, network mocking, and doctor.
- Real-site benchmarks for output quality and latency. Keep Apple.com as one case, but add:
  - a docs site with deep nav
  - an ecommerce page with menus
  - a dashboard/table fixture
  - a form-heavy page
  - a page with scroll containers

Recommended quality metrics:

- Snapshot latency.
- Snapshot size in chars/tokens.
- Ref count and rendered high-signal refs.
- Agent task success rate.
- Number of selector guesses versus ref/selectorHint usage.
- Artifact completeness: screenshot, console, network, perf, a11y.
- Error actionability: whether a failure message tells the user what to do next.

## What Not To Borrow

- Do not turn Skeptic into a generic CLI replacement for agent-browser. Browser commands should serve test authoring, debugging, and validation.
- Do not expose arbitrary page evaluation without the policy/max-output/safe-serialization layer.
- Do not default to persistent authenticated state in CI. State reuse should be explicit.
- Do not make React introspection part of the core path. It should be optional.
- Do not let generated tests depend on volatile refs from `inspect`; generated specs should use selector hints or capture snapshots in-run.
- Do not copy Expect's entire agent-supervisor model unless there is a clear product need. Skeptic's TS specs are a stronger durable artifact.

## Implementation Notes

- Prefer building browser MCP tools on top of Skeptic's existing Playwright and daemon layers rather than adding a second browser lifecycle.
- Reuse existing collectors for `console_logs`, `network_requests`, `performance_metrics`, and `accessibility_audit` where possible so MCP and test-runner output stay consistent.
- Use `.skeptic/` for project-local artifacts and `~/.skeptic/` for user/global state. Keep generated sensitive files ignored by default.
- Keep Expect-compatible response shapes where they are already good: `{ tree, refs, stats }`, `snapshotAfter`, and `resultFile`.
- Keep agent-browser-compatible snapshot text rendering for humans and CLI workflows.
- Add JSON schema generation from the existing Zod config schema rather than maintaining schema by hand.

## Suggested First Milestone

The best first milestone is:

1. Add `skeptic doctor --json`.
2. Add browser MCP tools with `snapshotAfter`, `ref(id)`, and safe result files.
3. Add a minimal safety config for allowed domains and max output.
4. Update README/MCP docs to teach the current flow.
5. Add an Apple.com plus local-fixture benchmark comparing Skeptic browser MCP, Expect MCP, and agent-browser on snapshot/action/evidence quality.

This would close the biggest parity gap with Expect while establishing the safety and diagnostic base needed for the larger agent-browser-inspired roadmap.
