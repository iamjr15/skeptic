# Competitive Analysis: Maestro & Expect vs skeptic CLI

**Date:** April 2026
**Sources:** GitHub repos, official docs, Exa research, codebase analysis

---

## Executive Summary

skeptic CLI has already borrowed heavily from both Maestro and Expect. After thorough analysis, there are **~25 features and design principles** across both tools that skeptic does NOT yet have. They are categorized below by impact tier.

---

## What skeptic Already Has (from these tools)

| Feature | Source Inspiration | skeptic Status |
|---|---|---|
| YAML flow syntax | Maestro | `flow-schema.ts` |
| assertWithAI / assertNoDefects / extractTextWithAI | Maestro | Step handlers built |
| assertScreenshot (visual regression) | Maestro | Built with threshold + cropOn |
| runFlow (nested flows) | Maestro | Built with env passing |
| repeat / setVariable | Maestro | Built |
| Conditions (when/visible/notVisible/true) | Maestro | Built |
| Tags + filtering (--include-tags, --exclude-tags) | Maestro | Built |
| --watch mode | Maestro (`--continuous`) | Built via chokidar |
| --bail | Maestro (`continueOnFailure: false`) | Built |
| --retries (flow-level) | Both | Built |
| --parallel | Maestro Cloud concept | Built/planned |
| Cookie extraction (Chrome, Firefox, Safari) | Expect | Built |
| --ci mode + CI auto-detection | Expect | Built |
| --headed / headless | Both | Built |
| --video | Maestro (startRecording) | Built |
| --analyze | Maestro (--analyze) | Built |
| `generate` command (AI flow generation) | Expect (diff→plan) | Built |
| `init` command | Both | Built |
| `add github-action` | Expect | Built |
| `add skill` | Expect | Built |
| `mcp` command | Maestro (`maestro mcp`) | Built |
| Multiple reporters (console, json, junit, html) | Maestro | Built |
| TUI (Ink-based) | Expect | Built |
| Device profiles | Maestro | Built |
| Dry-run mode | N/A | Built |
| --grep (name filter) | Maestro | Built |
| --url (base URL override) | Expect (EXPECT_BASE_URL) | Built |
| Environment variable overrides | Maestro | Built |

---

## Tier 1: High-Impact Features to Borrow

### 1. Flow Hooks (`onFlowStart` / `onFlowComplete`)
**Source:** Maestro
**What:** Config-level setup/teardown that runs before/after every flow automatically.
**Why it matters:** Eliminates boilerplate. Login, reset state, cleanup — defined once, applies everywhere. Maestro's hook model is elegant:
```yaml
# skeptic.config.yaml (proposed)
hooks:
  onFlowStart:
    - runFlow: subflows/login.yaml
  onFlowComplete:
    - runFlow: subflows/cleanup.yaml
```
**Design detail:** If `onFlowStart` fails → flow skipped, `onFlowComplete` still runs. Same as JUnit `@Before`/`@After` semantics.

### 2. Step-Level `retry` Block
**Source:** Maestro
**What:** Retry a block of steps N times within a flow (different from `--retries` which retries the entire flow).
```yaml
- retry:
    maxRetries: 3
    commands:
      - click: "#flaky-button"
      - assertVisible: "Success"
```
**Why it matters:** Handles flaky UI interactions without retrying the entire flow. skeptic currently only has flow-level retries. This is critical for real-world web apps with animations, lazy loading, etc.

### 3. JavaScript Integration (`runScript` / `evalScript`)
**Source:** Maestro
**What:** Execute JavaScript within flows for dynamic data, complex assertions, API calls.
```yaml
- runScript: seed-data.js
- navigate: "/dashboard"
- assertVisible: ${output.dashboardTitle}
```
Maestro uses a sandboxed GraalJS engine with a global `output` object that persists across steps. Includes built-in `http` client and `faker` library.

**Why it matters:** YAML is great for simple flows but falls apart for:
- Dynamic test data generation (unique emails, timestamps)
- API-driven setup/teardown (seed DB before test, verify backend after)
- Complex assertions that need calculation
- Reading environment-specific config

**Implementation approach for skeptic:**
- Use Node.js `vm` module (sandboxed) or direct `eval` with scope isolation
- Expose `output` object, `http` client (fetch-based), and `env` object
- `evalScript` for inline expressions, `runScript` for external `.js` files
- Faker via `@faker-js/faker` as built-in

### 4. Built-in HTTP Client for Flows
**Source:** Maestro
**What:** Make HTTP requests from within test flows to interact with backend APIs.
```yaml
- runScript: |
    const res = http.post('https://api.example.com/users', {
      body: JSON.stringify({ email: faker.internet.email() })
    });
    output.userId = json(res.body).id;
- navigate: "/users/${output.userId}"
- assertVisible: "User Profile"
```
**Why it matters:** E2E tests often need backend setup/verification. Without this, users must use external scripts or fixtures. This is one of Maestro's most powerful features for real-world testing.

### 5. Diff-Aware Test Generation (`--target`)
**Source:** Expect
**What:** Read git diff and generate targeted tests based on what actually changed.
```bash
skeptic generate --target branch    # Test all branch changes vs main
skeptic generate --target unstaged  # Test only uncommitted changes
skeptic generate --target changes   # Staged + unstaged (default)
```
**Why it matters:** This is Expect's killer feature. Instead of generating generic tests, the AI sees exactly which files/lines changed and generates adversarial tests targeting those specific UI surfaces. If you modified a form validation, it will try empty inputs, boundary values, XSS strings, double-submission.

**skeptic already has `generate --diff`** but should enhance it to support the three target modes and make the AI prompt explicitly adversarial (not just confirmatory).

### 6. Adversarial Test Generation Prompts
**Source:** Expect
**What:** The AI agent is explicitly instructed to generate adversarial tests, not confirmation tests.
**Key insight from Expect's docs:**
> "Write adversarial instructions rather than confirmation checks. Instead of 'check that the login form renders', use 'submit the login form empty, with an invalid email, with a wrong password, and with valid credentials — verify error states and console errors.'"

**Why it matters:** Default AI-generated tests are weak — they just confirm happy paths. Adversarial prompts find real bugs. skeptic's `generate` command should adopt this philosophy in its prompts.

### 7. Interactive TUI Plan Review for AI-Generated Tests
**Source:** Expect
**What:** Before executing AI-generated tests, show the test plan in an interactive TUI where users can:
- Read each step
- Edit or remove individual steps
- Adjust the instruction and regenerate
- Press `y` to approve and begin execution

**Why it matters:** Gives users confidence and control over AI-generated tests before they touch the browser. skeptic has an Ink-based TUI already — this is a natural extension for the `generate` command.

### 8. `scrollUntilVisible` Smart Scroll
**Source:** Maestro
**What:** Automatically scroll until a target element becomes visible, instead of fixed scroll amounts.
```yaml
- scrollUntilVisible: "Add to Cart"
```
Maestro describes this as mimicking "human visual search." It scrolls in increments until the element is found or a max scroll count is hit.

**Why it matters:** skeptic's `scroll` step is a dumb fixed-direction scroll. For long pages, users must guess how many scrolls to do. `scrollUntilVisible` is far more reliable and readable.

### 9. Synthetic Data Generation (Faker)
**Source:** Maestro
**What:** Built-in `faker` object for generating realistic test data.
```yaml
- evalScript: "output.email = faker.internet.email()"
- type:
    selector: "#email"
    text: ${output.email}
```
**Why it matters:** Avoids hardcoded test data that causes collisions in parallel runs, shared environments, or repeated executions. Every test run gets unique data.

### 10. Saved/Reusable AI-Generated Flows (`-f` / `--flow`)
**Source:** Expect
**What:** After AI generates a test plan, save it by slug. Reuse it later without regenerating.
```bash
skeptic generate -m "test login flow"        # Generates and saves as "test-login-flow"
skeptic test -f test-login-flow              # Reuse saved flow
```
Expect stores these in a `.expect` directory.

**Why it matters:** AI generation costs time and tokens. Being able to save and replay successful test plans is practical for regression testing. Flows evolve from AI-generated → human-curated.

### 11. Visual Regression Diff Image Output
**Source:** Maestro (v2.2.0, March 2026)
**What:** When `assertScreenshot` fails, generate a visual diff image highlighting exactly what changed.
**Why it matters:** skeptic has `assertScreenshot` with threshold, but when it fails, users have to manually compare images. A diff image (red overlay on changed pixels) makes debugging instant.

### 12. `back` Step (Browser Back Navigation)
**Source:** Maestro
```yaml
- back  # Press browser back button
```
Simple but missing from skeptic. Currently users would need to use `press` or navigate to a specific URL.

### 13. `doubleClick` Step
**Source:** Maestro (`doubleTapOn`)
```yaml
- doubleClick: "#text-to-select"
```
Common interaction pattern for text selection, item activation, etc.

### 14. `copyTextFrom` / `extractText` Step
**Source:** Maestro (`copyTextFrom`)
**What:** Copy text content from a UI element into a variable for later use.
```yaml
- copyTextFrom:
    selector: ".order-number"
    variable: orderNum
- navigate: "/orders/${orderNum}"
```
**Why it matters:** Enables data flow between steps without JavaScript. Essential for testing multi-page flows where data from one page is needed on another.

### 15. `eraseText` Step
**Source:** Maestro
```yaml
- eraseText:
    selector: "#search"
    characters: 10  # or "all"
```
skeptic has `clearInput` but `eraseText` with character count is more granular — useful for testing partial deletion, backspace behavior.

---

## Tier 2: Valuable Features to Consider

### 16. `executionOrder` Config
**Source:** Maestro
**What:** Configure specific flow execution order in config.yaml.
```yaml
executionOrder:
  continueOnFailure: false
  flowsOrder:
    - signup
    - verify-email
    - complete-profile
```
**Why:** Some test suites have logical dependencies. skeptic should support this alongside its default parallel/unordered execution.

### 17. `continueOnFailure` (Per-Suite)
**Source:** Maestro
**What:** Distinct from `--bail`. This is a config-level setting that controls whether the suite continues after a flow fails. `--bail` is a CLI override; `continueOnFailure` is the default behavior.

### 18. Browser Permissions (`setPermissions`)
**Source:** Maestro
```yaml
- setPermissions:
    notifications: allow
    geolocation: allow
    camera: deny
```
**Why:** Web apps increasingly use browser APIs (notifications, camera, mic, clipboard). Playwright supports `context.grantPermissions()` — skeptic should expose this.

### 19. Geolocation Mocking (`setLocation`)
**Source:** Maestro
```yaml
- setLocation:
    latitude: 40.7128
    longitude: -74.0060
```
**Why:** Essential for location-based features (store locators, delivery apps, maps).

### 20. Clock Manipulation (`travel`)
**Source:** Maestro
```yaml
- travel:
    offset: "+2h"  # or specific datetime
```
**Why:** Time-sensitive UIs (countdown timers, expiry dates, scheduled events). Playwright supports `page.clock` API.

### 21. Clipboard Operations (`setClipboard`)
**Source:** Maestro
```yaml
- setClipboard: "test-coupon-code"
- click: "#coupon-field"
- pasteText
```

### 22. Session Replay with Hosted Viewer
**Source:** Expect
**What:** rrweb recording with a URL to a replay viewer that can be shared.
**Why:** skeptic records with rrweb, but the replay experience could be enhanced with a hosted viewer URL. Expect prints a clickable replay URL after each run.

### 23. `audit` Command
**Source:** Expect
```bash
skeptic audit  # Runs all lint, type-check, format checks
```
**Why:** Nice DX for monorepo projects. Scans package.json scripts and runs relevant checks.

### 24. Multi-Agent AI Provider Support
**Source:** Expect
**What:** Support Claude, Codex, Gemini, Copilot as AI providers for test generation (not just Gemini).
**Why:** Users already have API keys for different providers. skeptic is currently Gemini-only.

---

## Tier 3: Long-Term / Large Scope

### 25. Visual Element Inspector (Maestro Studio)
**Source:** Maestro
**What:** Browser-based IDE that mirrors the app, lets you click elements to get selectors, and generates YAML commands in real-time.
**Scope:** Very large, but extremely high DX value. Could be a skeptic v2 feature.

### 26. `record` Command — ✅ Shipped (Bundle 5)
**Source:** Maestro (attribution); actual reference is Playwright codegen — Maestro has no interaction recorder.
```bash
skeptic record [output]                       # Record user interactions → YAML
skeptic record out.yaml --url https://app.io  # Override start URL
skeptic record --cookies                      # Inject browser cookies before recording
skeptic record --include-sensitive            # Capture password fields verbatim (default: redacted)
```
**What:** Custom DOM-injection recorder (Option A from `plans/scribbly-mimicking-mockingbird.md`) writes a runnable skeptic YAML flow. Uses skeptic's selector vocabulary (testid → id → role+name → text → label → placeholder → CSS path) so generated flows replay through `skeptic test` cleanly. Password fields redacted by default; binding payload validated at the trust boundary; action cap of 5000 / value cap of 4096 chars.

### 27. Agent Client Protocol (ACP) Support ✅ Shipped (Bundle 5)
**Source:** Expect
**What:** Standardized protocol for AI agent integration, so any ACP-aware editor (Zed, Cursor, Claude Code) can drive skeptic like a coding assistant whose specialty is E2E testing.
**Status:** Implemented — `skeptic acp` exposes skeptic as an ACP **agent server** over stdio. Editor sends a natural-language prompt; skeptic streams `agent_thought_chunk`, `tool_call`, `tool_call_update`, `agent_message_chunk` notifications and ends with a `stopReason`. Heuristic regex dispatcher routes prompts to the existing primitives (run_flow, run_test, generate_flow, validate_file, list_flows, list_devices, load_guidance) — no MCP refactor; ACP and MCP coexist as separate processes.
**Plan:** `plans/chatty-relaying-raven.md` (Bundle 5 item 5/5).

### 28. Performance Metrics as First-Class Testing
**Source:** Expect
**What:** Collect Core Web Vitals (FCP, LCP, CLS, INP), Long Animation Frames with script attribution, and resource analysis during every test run — not as a separate tool, but integrated into the testing flow.
```yaml
# Proposed: performance assertion step
- assertPerformance:
    lcp: "< 2.5s"
    cls: "< 0.1"
    inp: "< 200ms"
```
**Why it matters:** Performance regressions are invisible to functional tests. Expect surfaces them automatically. skeptic should add performance metric collection to every run and optionally assert on them.

### 29. Network Request Monitoring & Issue Detection
**Source:** Expect
**What:** Capture all HTTP traffic during test execution. Auto-detect issues: 4xx/5xx responses, duplicate requests, mixed content, CORS errors.
```yaml
# Could surface as a step or automatic report section
- assertNoNetworkErrors
```
**Why it matters:** Many bugs manifest as failing API calls, duplicate requests, or security issues (mixed content). This catches them without explicit assertions.

### 30. Accessibility Audit (axe-core + IBM Equal Access)
**Source:** Expect
**What:** Built-in WCAG accessibility audit using dual engines (axe-core AND IBM Equal Access with deduplication) for broader coverage.
```yaml
- accessibilityAudit:
    standard: "WCAG2AA"
    optional: false
```
**Why it matters:** Accessibility testing is increasingly required by law. Expect runs it as part of every test. skeptic should add this as a step type.

### 31. ARIA Snapshot-Ref Pattern for Element Interaction
**Source:** Expect
**Status:** ✅ Shipped (Bundle 5) — `ariaSnapshot:` step + `@eN` selectors in 9 handlers
**What:** Instead of fragile CSS selectors, use ARIA accessibility snapshots that assign ref identifiers to interactive elements. A `ref()` function resolves refs to Playwright locators.
**Why it matters:** CSS selectors break when class names change, IDs are removed, or DOM structure shifts. ARIA-based refs are inherently more stable because they reflect semantic meaning, not implementation details.
**Implementation:** `cli/src/executor/aria-snapshot-capture.ts` calls Playwright's native `Locator.ariaSnapshot({ mode: "ai" })` and parses the `[ref=eN]` annotations into `ctx.ariaRefs`. `cli/src/executor/aria-ref-resolver.ts` reconstructs locators via `getByRole(role, { name, exact: true }).nth(nth)`, with structured `AriaRefError` (kinds: `invalid_format`, `not_found`, `stale`) so negative assertions don't silently pass on stale refs. v1 ships in 9 handlers (click, doubleClick, hover, assertVisible, assertNotVisible, waitForElement, copyTextFrom, assertText.selector, scrollUntilVisible). AI generation is deferred to a follow-up plan that needs an interactive ref-aware loop. Privacy: snapshot YAML may include typed-in PII and is in-memory only — never logged. Size cap at 256 KiB (tunable via `SKEPTIC_ARIA_SNAPSHOT_LIMIT_KB`).

### 32. Test Coverage Tracking via Import Graph — ✅ Shipped (Bundle 5)
**Source:** Expect
**What:** Uses `oxc-resolver` to build a full import graph, identifies which source files have test coverage, and marks files as `[covered]` or `[no test]` in the AI prompt. Instructs the AI to prioritize testing uncovered files.
**Why it matters:** Makes AI-generated tests smarter. Instead of generating tests for well-covered code, the AI focuses on gaps. skeptic's `generate` command should incorporate this.
**skeptic implementation:** `skeptic generate --diff` builds an import graph (`cli/src/ai/coverage/import-graph.ts`), maps each flow's `navigate:` URLs to route handlers via a route index that understands Next.js `app/`/`pages/`/`src/routes/` conventions plus `[id]`/`[...slug]`/`[[...slug]]` and app-router parent layouts (`cli/src/ai/coverage/route-resolver.ts`), then injects a `## Coverage of changed files` section into the AI prompt with `[covered]`/`[no test]` annotations and a percentage (`cli/src/ai/coverage/coverage-prompt.ts`). Description-driven (`--message`) generation skips coverage; pass `--no-coverage` to skip even on `--diff`. `ai.excludePaths` is honored at both the diff and graph layers via a shared `matchExcludePath` helper.

### 33. Domain-Specific Guidance Loading (On-Demand)
**Source:** Expect
**What:** An MCP tool (`load_guidance`) provides on-demand domain knowledge for 8 domains: animation, accessibility, performance, design, security, SEO, responsive, React. Content loads only when the agent encounters domain-specific failures.
**Why it matters:** Saves tokens by not including all guidance upfront. When the AI hits a performance issue, it loads the performance guidance. skeptic's MCP server could expose similar domain-specific knowledge.

### 34. Watch Mode with LLM Triage
**Source:** Expect
**What:** Enhanced watch mode that uses an LLM to classify whether file changes warrant re-testing. Has deterministic fast-path skipping for obviously irrelevant files (.md, config, lock files) and falls back to LLM assessment for ambiguous changes. Includes backoff after 2 assessment failures.
**Why it matters:** skeptic has `--watch` but it re-runs on every change. Smart triage avoids unnecessary test runs when editing docs, config, or non-UI code.

### 35. PR Comment Integration
**Source:** Expect
**Status:** ✅ Shipped (Bundle 4) — `skeptic comment` command
**What:** Auto-upsert PR comments with test results using `gh` CLI. Marker-based idempotency (finds existing comment, updates it instead of posting duplicates). Includes pass/fail badge and fenced code block.
**Why it matters:** Native PR integration closes the feedback loop. Developers see test results directly in their PR without checking CI logs.
**Implementation:** `cli/src/commands/comment.ts`. CI-agnostic (works wherever `gh auth status` succeeds — GitHub Actions, GitLab CI, Jenkins, local). Uses `gh api repos/{owner}/{repo}/issues/{pr}/comments?per_page=100` with Node-side JSON parse + `body.includes(marker)` filter for idempotency. Top-level try/catch wraps the entire posting flow — never red-Xs a passing build. The generated GitHub Actions workflow now invokes `npx skeptic comment --pr ${{ github.event.pull_request.number }} --run-url ...` instead of the previous inline `actions/github-script@v7` block.

### 36. TypeScript SDK for Programmatic Usage
**Source:** Expect (`expect-sdk`)
**What:** Programmatic API where tests are plain English strings:
```ts
import { Expect } from "expect-sdk";
const run = await Expect.test({
  url: "http://localhost:3000",
  tests: ["verify login works", "test checkout flow"]
});
```
The TestRun object is both a Promise and AsyncIterable for streaming.
**Why it matters:** Enables integration into custom toolchains, CI scripts, and other tools without going through the CLI.

### 37. Composable Relational Selectors (Spatial + Hierarchical) — ✅ Shipped (Bundle 5)
**Source:** Maestro
**What:** Find elements using spatial and hierarchical relationships, not just CSS selectors:
```yaml
- click:
    text: "Save"
    below: "Username"               # element below the "Username" label
- click:
    role: "button"
    rightOf: "icon-search"          # element right of the search icon
- click:
    testid: "save"
    childOf: { id: "edit-form" }   # within a specific parent
- click:
    text: "Add"
    containsChild: { text: "Cart" } # parent that contains this child
```
Maestro implements these as composable filter functions: `ElementFilter = (List<TreeNode>) -> List<TreeNode>`. Filters compose via `compose()` (chain) and `intersect()` (AND).

**Why it matters:** CSS selectors are fragile. Spatial selectors describe element relationships as a human would ("the button below the email field"). Much more readable and resilient to DOM changes.

**skeptic implementation:** `cli/src/executor/relational-resolver.ts` — Maestro's synchronous tree-walking filter API translated to async batched-bounds materialization. `findCandidates` builds the candidate pool from leaf fields (`text`/`id`/`role`/`testid`/`css`), `Promise.all(boundingBox)` collects geometries into a `ShadowNode[]`, then pure-synchronous spatial (center-based) and hierarchical (geometric containment) filters intersect; closest-by-Euclidean-distance breaks ties. v1 ships in 9 handlers (click, doubleClick, hover, assertVisible, assertNotVisible, waitForElement, copyTextFrom, assertText.selector, scrollUntilVisible). Schema is `.strict()` so typos like `belwo` or `rightof` fail at parse time; pure-relational selectors without a leaf are also rejected. Structured `RelationalResolutionError` with 6 kinds — `invalid_selector` is distinct from `no_leaf_match` so negative assertions (`assertNotVisible`, `waitForElement state="hidden"`) don't silently pass on malformed input. `skeptic generate` is instructed to emit bare-string selectors only — relational form is reserved for human-authored flows.

### 38. Random Input Commands as First-Class Steps
**Source:** Maestro
**What:** Built-in commands for random data, not just faker through JS:
```yaml
- inputRandomEmail         # generates unique email
- inputRandomPersonName    # realistic name
- inputRandomNumber        # random number
```
Maestro has 7 dedicated random input commands (email, person name, text, number, city, country, color).

**Why it matters:** Zero-friction random data without learning faker API or writing JS. Each test run uses unique data automatically.

### 39. Test Sharding (`--shard-split` / `--shard-all`) — ✅ Shipped
**Source:** Maestro
```bash
skeptic test --shard-split 3    # Distribute tests across 3 browser instances
skeptic test --shard-all 3      # Run ALL tests on each of 3 instances
```
**Why it matters:** `--parallel` runs flows concurrently in one browser. Sharding runs them across multiple browser instances, which is faster and avoids state leakage. `--shard-all` is useful for cross-browser testing.

**skeptic implementation:** Pure modulo round-robin partition lives in `cli/src/executor/shard.ts` (matching Maestro's `groupBy { it.index % effectiveShards }` at `TestCommand.kt:646-660`). Orchestration lives inline in `cli/src/commands/test.ts` (`runShardedSession` + `runFlowsForShard`); each shard owns its own `PlaywrightEngine`, runs its slice via `Promise.allSettled` (so a worker throw never strands sibling workers before engine close), and writes per-shard `results.json`/`junit.xml`/`report.html` under `outputDir/shard-N/`. A merge step then writes the canonical top-level reports with deterministic `(originalFlowIndex, shardId)` ordering. Manifest-gated cleanup (`outputDir/.skeptic-shard-manifest.json`) deletes only previously-written shard subdirs — user-owned `shard-N/` dirs in `--output .` paths are left alone. `--shard-split --bail` propagates a shared `AbortController`; `--shard-all --bail` is rejected with a warning since per-instance variance is the point of `--shard-all`. Flows read `SKEPTIC_SHARD_INDEX` / `SKEPTIC_SHARD_COUNT` env vars at runtime to self-identify. Mutually exclusive with `--watch` and the interactive TUI; both gates fire only when `effectiveShards > 1` so `--shard-split 1` (or any clamped-to-1 invocation) is indistinguishable from a non-sharded run. Slack/Webhook fire exactly once on the merged summary regardless of shard count. JUnit/HTML/Slack/Webhook reporter output disambiguates `--shard-all` duplicate runs via a `formatFlowDisplayName` suffix (`"Login Flow [shard 2]"`).

### 40. Workspace Notifications (Slack / Email / Webhook)
**Source:** Maestro
**Status:** ✅ Shipped (Bundle 4) — Slack + Webhook reporters; email deferred
**What:** Built-in notifications on test run completion.
```yaml
# skeptic.config.yaml — actual shipped shape
notifications:
  slack:
    webhookUrl: ${SLACK_WEBHOOK_URL}    # required
    onSuccess: false                     # default
    onFailure: true                      # default
    mention: ["<!here>"]                 # optional, mrkdwn-format mentions
  webhook:
    url: ${SKEPTIC_WEBHOOK_URL}            # required
    onSuccess: false
    onFailure: true
    headers:
      X-Auth-Token: ${WEBHOOK_AUTH_TOKEN}
  # email: deferred — no SMTP infra in scope for v1
```
**Why it matters:** Built-in notification system without CI config. Teams get alerted on test failures directly.
**Implementation:** Implemented as new reporters (`cli/src/reporter/slack-reporter.ts`, `cli/src/reporter/webhook-reporter.ts`) that share the same `Reporter` interface as `console`/`json`/`junit`/`html` — config-driven, not exposed via `--reporter` CLI flag. The `Reporter.onRunComplete` method was widened to `void | Promise<void>` so notifications can `await fetch(...)`; `test.ts` now uses `await Promise.all(reporters.map((r) => Promise.resolve(r.onRunComplete(summary))))` at all four dispatch sites. **Strong log hygiene:** reporters log only `err.name` (TimeoutError/TypeError/AbortError) plus HTTP status — never `err.message`, which can carry the request URL on Node fetch errors. **Slack design:** mentions go in a `mrkdwn` section block (header blocks are `plain_text` and don't notify); `channel:` is intentionally unsupported because modern incoming webhooks bind to a single channel. **Differs from Maestro:** Maestro's CLI is server-driven (passes a flag to its cloud backend); skeptic delivers in-process via reporters with no external dependencies.

### 40b. AI Failure Analysis in CI
**Source:** skeptic-internal (Bundle 4 follow-up to provider-aware CI scaffold)
**Status:** ✅ Shipped (Bundle 4)
**What:** `skeptic add github-action --ai --provider <name>` now appends `--analyze` to the generated workflow's test step, and injects two extra env vars (`SKEPTIC_AI_PROVIDER` and `SKEPTIC_AI_API_KEY`) so runtime AI provider/key resolution matches the scaffold-time provider — regardless of any stale `ai:` settings in `skeptic.config.yaml`. Defense-in-depth: `client-factory.ts` was updated from `??` to `||` so an empty-string `apiKey` (e.g. interpolated from an unset env var) falls through to the provider env var instead of triggering the early-return guard.
**Implementation:** `cli/src/config/loader.ts` `applyEnvOverrides` (env vars), `cli/src/ai/client-factory.ts` (one-char fix), `cli/src/commands/add.ts` (workflow scaffold).

### 41. `retryTapIfNoChange` Anti-Flakiness Pattern
**Source:** Maestro
**What:** After clicking, compare the view/DOM state before and after. If nothing changed (the click didn't register), automatically retry. Uses screenshot diff at 0.5% threshold as fallback.
**Why it matters:** Clever anti-flakiness pattern. Click actions sometimes fail silently (element overlapped, animation in progress). This detects and recovers automatically. skeptic should adopt this as default behavior for `click` steps.

### 42. YAML Syntax Validation Command
**Source:** Maestro (`check-syntax`)
```bash
skeptic check-syntax flows/      # Validate without running browser
```
**Why it matters:** skeptic has `--dry-run` which validates AND sets up the engine. A dedicated `check-syntax` command is faster (no Playwright, no browser) and useful in CI pre-checks and git hooks. Related: Maestro uses Levenshtein distance to suggest corrections ("Did you mean: assertVisible?" when you type "assrtVisible").

### 43. Dual Timeout Strategy (Required vs Optional)
**Source:** Maestro
**What:** Two different default timeouts: 17s for required elements, 7s for optional ones. Timeouts also dynamically reduce based on elapsed time since last interaction.
**Why it matters:** Optional elements shouldn't block for the full timeout. And dynamic timeout reduction prevents artificially long waits at the end of flows when something has clearly gone wrong.

### 44. Future Concepts Worth Watching (from Expect's Roadmap)
**Source:** Expect `.specs/workflow-integration-brainstorm.md`
- `expect proxy` — Reverse proxy that records manual QA sessions and converts them to test flows
- `expect fuzz` — Chaos monkey for UI (random clicks, inputs, navigations)
- `expect sabotage` — Mutation testing (introduce bugs, verify tests catch them)
- `expect dream` — Exploratory crawling (AI autonomously explores the app looking for issues)
- Static AST analysis via `oxc-parser` for deterministic impact analysis without LLM

---

## Design Principles to Adopt

### From Maestro:

1. **"Embrace Instability"** — Maestro auto-waits for screens to settle before proceeding. Every command has built-in tolerance for network delays and UI flakiness. skeptic should make auto-waiting the default behavior, not something users opt into.

2. **"Idiomatic Commands"** — Commands like `scrollUntilVisible` encode human behavior patterns. Instead of requiring users to script "scroll + check + scroll + check", the command does what a human would do. skeptic should prioritize human-behavior-matching commands.

3. **"Black Box Testing"** — Maestro never touches app source code. It tests through the UI layer only. skeptic should maintain this principle — test what users see, not implementation details.

4. **"Declarative Over Imperative"** — Keep YAML for the 90% case, JavaScript for the 10%. Maestro's JS integration is explicitly positioned as an escape hatch, not the primary interface. 

5. **"Modular Subflows"** — Maestro's `subflows/` directory pattern and `runFlow` with env passing encourages DRY test design. skeptic should document and encourage this pattern.

6. **AI as Managed Service** — Maestro recently moved from BYOK (bring your own key) to managed AI. All AI features route through Maestro Cloud. skeptic should consider this model long-term — it simplifies user setup and lets you control model quality.

### From Expect:

1. **"Adversarial by Default"** — Expect's entire philosophy is that tests should try to break things, not confirm they work. The agent skill explicitly instructs: test like a user trying to break things. skeptic's AI prompts should adopt this posture.

2. **"Diff-Aware, Not Generic"** — Tests should be targeted at what changed. Generic test suites waste time. Expect reads the git diff and generates tests for exactly the changed surfaces. This is the single most impactful design principle to adopt.

3. **"Agent-Native"** — Expect is designed to be invoked BY coding agents (Claude Code, Codex, Cursor), not just by humans. The skill/tool paradigm means AI agents can run E2E tests as part of their code-change workflow. skeptic's MCP server is a step in this direction.

4. **"Zero Config Auth"** — Expect extracts cookies from the user's real browser sessions. No manual auth setup, no fixture files, no storageState JSON. This dramatically lowers the barrier to testing authenticated flows. skeptic already has this — keep it.

5. **"Scan → Plan → Execute → Report"** — Expect's four-stage pipeline with human review at the plan stage is excellent. The user sees what will be tested before anything runs. skeptic should adopt this for AI-generated tests.

---

## Priority Implementation Roadmap

| Priority | Feature | Effort | Impact |
|---|---|---|---|
| P0 | Hooks (onFlowStart/onFlowComplete) — workspace-level | Medium | High |
| P0 | Step-level retry blocks | Small | High |
| P0 | Diff-aware generate (--target modes) | Medium | Very High |
| P0 | Adversarial AI prompts | Small | High |
| P0 | Performance metrics collection (CWV) | Medium | Very High |
| P0 | Network request monitoring + issue detection | Medium | High |
| P1 | JavaScript integration (runScript/evalScript) | Large | Very High |
| P1 | Built-in HTTP client | Medium | High |
| P1 | scrollUntilVisible | Small | High |
| P1 | Accessibility audit step (axe-core) | Medium | High |
| P1 | Interactive TUI plan review | Medium | High |
| P1 | back / doubleClick / copyTextFrom / eraseText steps | Small | Medium |
| P1 | Visual regression diff images | Medium | High |
| ✅ Shipped | Test coverage tracking in AI prompts (Bundle 5) | Medium | High |
| P1 | PR comment integration | Small | Medium |
| P2 | Faker integration | Small | Medium |
| P2 | Saved flows (-f flag) | Small | Medium |
| P2 | executionOrder config | Small | Medium |
| P2 | Browser permissions | Small | Medium |
| P2 | Geolocation mocking | Small | Medium |
| P2 | Clock manipulation | Small | Medium |
| P2 | Watch mode with LLM triage | Medium | Medium |
| P2 | Domain-specific guidance loading | Medium | Medium |
| P2 | TypeScript SDK | Large | Medium |
| P3 | Multi-agent AI providers | Large | Medium |
| P3 | audit command | Small | Low |
| P3 | Session replay viewer | Medium | Medium |
| P3 | Visual element inspector | Very Large | Very High |
| ✅ Shipped | record command (Bundle 5) | Large | High |
| P3 | Exploratory crawling ("dream" mode) | Large | High |
| P3 | Mutation testing ("sabotage" mode) | Large | High |
| ✅ Shipped | Composable relational selectors (Bundle 5) | Medium | High |
| P1 | retryTapIfNoChange (auto-retry clicks) | Small | High |
| P2 | Random input commands (first-class) | Small | Medium |
| P2 | Test sharding (--shard-split/--shard-all) | Medium | Medium |
| P2 | Workspace notifications (Slack/email/webhook) | Medium | Medium |
| P2 | check-syntax command + typo suggestions | Small | Medium |
| P2 | Dual timeout strategy (required vs optional) | Small | Medium |
