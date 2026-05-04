# Plan: Bundle 4 — CI Delivery Channels

## Context

Bundle 3 (`plans/provider-aware-ci-scaffold.md`) shipped a provider-aware CI scaffold. Three follow-ups remain in the competitive backlog (`docs/competitive-analysis-maestro-expect.md`):

1. **#35 PR comment integration** (Expect) — today the upsert logic lives as inline JavaScript inside the workflow YAML emitted by `skeptic add github-action` (`cli/src/commands/add.ts:106-155`). It uses `actions/github-script@v7` and Octokit, which only works on GitHub Actions runners. Extracting to a standalone `skeptic comment` command makes the same feature reusable from GitLab CI, Jenkins, local dev, and any future CI scaffold — and removes ~40 lines of embedded JS from the YAML template.
2. **#40 Workspace notifications** (Maestro) — skeptic has no Slack/webhook surface today. Maestro's CLI defines the `notifications:` config block but defers actual delivery to its cloud backend; we'll keep the same config shape but implement delivery in-process via reporters (the existing `Reporter` interface at `cli/src/reporter/types.ts:17` is the right seam — same as `console`/`json`/`junit`/`html`). Email is deferred (no SMTP infra in scope).
3. **AI-in-CI** (skeptic-internal) — `plans/provider-aware-ci-scaffold.md:15` left appending `--analyze` to the generated workflow's test step out of scope. The provider-aware env block now exists, so wiring `--analyze` is a one-line addition.

**Outcome:** A user with `notifications.slack.webhookUrl` configured gets Slack alerts on every failed run. A user running `skeptic add github-action --ai` gets a workflow that uses `npx skeptic comment` (idempotent PR upserts via `gh`) and runs `skeptic test --ci ... --analyze` (AI failure analysis on red runs).

**Out of scope:** email channel, per-flow notifications, Slack interactivity (buttons/threading), webhook signing/HMAC, multi-shard comment aggregation. All can ship later without breaking changes — `notifications.slack` and `notifications.webhook` are independent optional blocks.

---

## Design notes

### Why `gh` CLI for `skeptic comment`, not Octokit

Expect uses `gh` CLI with marker-based upsert (`/Users/iamjr15/Desktop/skeptic-refs/expect/packages/supervisor/src/github.ts:172-185`). It's the simpler path:

- `gh` ships pre-installed on GitHub-hosted runners.
- Auth flows through `GITHUB_TOKEN` automatically — zero auth code in our CLI.
- Works on local dev too (`gh auth login`).
- Self-hosted runners need to install `gh`; we surface a clear warning if absent.
- **No new npm dependencies** (Octokit would add ~3 MB to the install).

### Marker stays the same

Keep `<!-- skeptic-qa-results -->` (already used by the inline JS at `add.ts:117`). Anyone with comments from a prior CI run will see them updated in place rather than getting a duplicate.

### Reporter interface change is minimal

Today `Reporter.onRunComplete(summary): void`. Slack and webhook reporters need to fire HTTP — that's `await fetch(...)`. We have two choices:

1. Make `onRunComplete` return `void | Promise<void>` and `await` at call sites (`test.ts:346, 355, 368, 439`).
2. Fire-and-forget `void this.flush()` inside the reporter and risk dropping the build before HTTP completes.

**Choose #1.** Existing reporters' `void` returns are still valid (TypeScript widens). Only the four `for (const r of reporters) r.onRunComplete(summary);` lines change to `await Promise.all(reporters.map(r => r.onRunComplete(summary)));`. Step-level callbacks are unchanged — the per-step hot loop stays synchronous.

### Notifications are NOT exposed via `--reporter` flag

`OutputConfigSchema.reporters` (`cli/src/config/schema.ts:46-48`) is the user-facing format list (`console|json|junit|html`). Slack/webhook are config-driven only — they read `config.notifications.{slack,webhook}` and self-instantiate. A new `createNotificationReporters(config.notifications)` function lives next to `createReporters()` in `test.ts`; both push into the same `reporters[]` array.

### Fire-condition gating

Both new reporters honor `onSuccess` / `onFailure` flags (Maestro's pattern at `WorkspaceConfig.kt:29,36`). Default: `onFailure: true`, `onSuccess: false` — matches Maestro's defaults. The reporter checks `summary.failed > 0` against its config and short-circuits with no HTTP call when not configured to fire.

### Secrets via env-var interpolation, not env-var lookup

`cli/src/utils/env.ts` already provides `${VAR}` and `${VAR:-default}` syntax via `interpolateEnvDeep` (called in `loader.ts:53`). Users write:

```yaml
notifications:
  slack:
    webhookUrl: ${SLACK_WEBHOOK_URL}
  webhook:
    url: ${SKEPTIC_WEBHOOK_URL}
```

This is the same pattern `ai.apiKey: $GEMINI_API_KEY` already uses. **No new env-resolution code.** We do not extend `applyEnvOverrides` in `loader.ts:90`; that function is for `SKEPTIC_*` shortcut overrides and notifications don't need shortcuts.

### Native `fetch`, no new deps

`cli/package.json` declares `"engines": {"node": ">=22"}`. Node 22 has global `fetch`. No `node-fetch` / `axios` / Octokit needed.

---

## Phase 1 — Schema + Reporter interface foundation

**Goal:** Add the `notifications` config block and let `onRunComplete` be async. No behavior change yet.

### 1.1 Extend `cli/src/config/schema.ts`

Add three new schemas above `skepticConfigSchema`:

```ts
const NotificationTriggerBase = {
  onSuccess: z.boolean().default(false),
  onFailure: z.boolean().default(true),
};

const SlackNotificationSchema = z.object({
  webhookUrl: z.string().min(1, "notifications.slack.webhookUrl is required"),
  // Note: `channel` intentionally omitted — modern Slack incoming webhooks bind to a single
  // channel at creation time and ignore overrides. To target a different channel, configure
  // a different webhook URL.
  mention: z.array(z.string()).default([]),  // e.g. ["<!here>", "<@U123>"]
  ...NotificationTriggerBase,
});

const WebhookNotificationSchema = z.object({
  url: z.string().url("notifications.webhook.url must be a valid URL"),
  headers: z.record(z.string()).default({}),
  ...NotificationTriggerBase,
});

const NotificationsSchema = z.object({
  slack: SlackNotificationSchema.optional(),
  webhook: WebhookNotificationSchema.optional(),
});
```

Add to `skepticConfigSchema` (`schema.ts:87-98`):

```ts
notifications: NotificationsSchema.optional(),
```

Export the inferred types (`SlackNotificationConfig`, `WebhookNotificationConfig`, `NotificationsConfig`) alongside the existing exports at `schema.ts:101-107`.

### 1.2 Update `cli/src/reporter/types.ts:23`

Change one line:

```ts
onRunComplete(summary: RunSummary): void | Promise<void>;
```

### 1.3 Update `cli/src/commands/test.ts` to await

Four sites use `for (const r of reporters) r.onRunComplete(summary);` — lines 346, 355, 368, 439. Change each to:

```ts
await Promise.all(reporters.map((r) => Promise.resolve(r.onRunComplete(summary))));
```

`Promise.resolve` lifts existing `void`-returning reporters into the same shape — no breaking change for `console`/`json`/`junit`/`html`/`InkReporter`.

### 1.4 Tests

- **`cli/__tests__/unit/config/notifications-schema.test.ts`** (new). Cover: valid slack-only, valid webhook-only, both, invalid (missing webhookUrl), invalid (non-URL webhook url), defaults applied (`onFailure: true`, `onSuccess: false`).
- **No reporter test changes** — interface widening is non-breaking; existing tests still pass without `await`.

---

## Phase 2 — `skeptic comment` command

**Goal:** Standalone `skeptic comment` command that reads `results.json` and upserts a PR comment via `gh`. CI-agnostic (works wherever `gh auth status` succeeds).

### 2.1 New file `cli/src/commands/comment.ts`

Public surface:

```ts
export interface CommentCommandOptions {
  results?: string;       // default: ./skeptic-output/results.json
  pr?: string;            // PR number; default: auto-detect via `gh pr view --json number`
  marker?: string;        // default: <!-- skeptic-qa-results -->
  runUrl?: string;        // default: derived from GITHUB_SERVER_URL + REPOSITORY + RUN_ID, or omitted
  dryRun?: boolean;       // print body to stdout, don't post
  config?: string;
}

export async function runComment(opts: CommentCommandOptions): Promise<void>;
```

Internal helpers (all exported for testing):

```ts
export const DEFAULT_MARKER = "<!-- skeptic-qa-results -->";
export interface ResultsShape { /* RunSummary subset */ }
export function buildCommentBody(results: ResultsShape, runUrl: string | null, marker?: string): string;
export function detectPrNumber(): string | null;   // shells out to `gh pr view --json number -q .number`
export function findExistingComment(prNumber: string, marker: string): string | null; // returns comment ID
```

**Body builder (`buildCommentBody`)** mirrors lines 119-133 of `add.ts` exactly — same markdown table, same failed-flow bullet format, same "Download full report" link. We're moving the logic, not redesigning the format.

**Posting flow:**
1. Read `results.json` — if missing, log warning and exit 0 (mirrors line 113 of inline JS).
2. Validate the parsed JSON has the expected `RunSummary` shape (zod-lite guard: check `total`, `passed`, `failed`, `duration_ms`, `flows[]` are present and well-typed). On mismatch, warn and exit 0.
3. Detect PR number (precedence: CLI `--pr` flag → `GITHUB_REF` parsing for `refs/pull/N/merge` → `gh pr view --json number -q .number`). If none resolved, log info ("No PR detected; skipping") and exit 0.
4. List existing comments via:
   ```ts
   execFileSync("gh", ["api", `repos/{owner}/{repo}/issues/${prNumber}/comments?per_page=100`])
   ```
   `gh api` auto-expands ONLY the `{owner}`, `{repo}`, and `{branch}` placeholders (per `gh api --help`) — `{pr}` is NOT one of them. We use a TypeScript template literal to interpolate `${prNumber}` at runtime; the resulting argv is e.g. `["gh", "api", "repos/{owner}/{repo}/issues/123/comments?per_page=100"]`, which `gh` then expands `{owner}` and `{repo}` from the current repo's git remote.

   **Why no `-F per_page=100`:** `gh api` defaults to GET unless any `-F/--field` argument is supplied, in which case it switches to POST — silently turning the list-comments request into a malformed POST. Embedding `per_page` in the URL query string avoids the method switch entirely and is one fewer flag.

   **Why no `--paginate`:** `gh api --paginate` emits each page as a separate JSON document concatenated to stdout (`[{...}][{...}]`), which is not parseable by a single `JSON.parse`. Older `gh` versions don't support `--slurp` either. A single `per_page=100` request is the simplest robust choice — 100 PR comments is well above any realistic E2E test PR. If a PR ever has >100 comments without our marker on the first page, we'll create a duplicate instead of updating; the new comment still carries the marker, so the *next* run finds it.

   **Parse the JSON in Node** (no `--jq` interpolation), filter with `body.includes(marker)`, take first match's `id`.
5. Write body to a tempfile (avoid command-line length limits + shell quoting), then (using TS template literals to interpolate the runtime values, with `gh` only auto-expanding `{owner}`/`{repo}`):
   - If existing → `execFileSync("gh", ["api", \`repos/{owner}/{repo}/issues/comments/${commentId}\`, "-X", "PATCH", "-F", \`body=@${tempfile}\`])`
   - Else → `execFileSync("gh", ["pr", "comment", String(prNumber), "--body-file", tempfile])`
6. On success, log `Comment posted to PR #{pr}`.

**Graceful degradation** (mirrors Expect's `Effect.catchTag` pattern at `github.ts:322-327`):
- The entire non-dry-run posting flow is wrapped in a top-level `try { … } catch (err) { logger.warn(…); }`. Exit code stays 0 regardless. This protects against cases the inline-JS version doesn't even consider: malformed JSON, schema-shape drift, tempfile write failure, PATH oddities.
- Specific cases the catch handles cleanly (each emits a tailored warning before the catch-all):
  - `gh` not on PATH (`spawn` ENOENT) → `logger.warn("skeptic comment: 'gh' CLI not found — skipping PR comment. Install: https://cli.github.com")`.
  - `gh auth status` fails / 401 / 403 → `logger.warn("skeptic comment: gh CLI not authenticated — set GITHUB_TOKEN or run 'gh auth login'")`.
  - Network/timeout → `logger.warn("skeptic comment: GitHub API timeout/network error")`.
- **Never `process.exitCode = 1`.** A broken PR comment must not red-X a passing build. The `catch` block is the last-resort guarantee of this invariant.

**Run URL derivation:** if `--run-url` not passed, build from env: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`. If any of those are missing, omit the link line (don't crash).

**Implementation detail — shelling out:** Use `node:child_process` `execFileSync` with `{ encoding: "utf-8", timeout: 15_000 }` (matches Expect's `GITHUB_TIMEOUT_MS` at `constants.ts:6`). Wrap each `gh` invocation in try/catch and convert non-zero exits to warnings.

### 2.2 Register in `cli/src/index.ts`

After the existing `addCmd` registration (after line 139):

```ts
program
  .command("comment")
  .description("Upsert a PR comment with test results (uses `gh` CLI)")
  .option("--results <path>", "path to results.json", "./skeptic-output/results.json")
  .option("--pr <number>", "PR number (default: auto-detect)")
  .option("--marker <string>", "HTML comment marker", "<!-- skeptic-qa-results -->")
  .option("--run-url <url>", "URL to CI run page")
  .option("--dry-run", "print body to stdout instead of posting")
  .option("-c, --config <path>", "path to config file")
  .action(async (cmdOpts: CommentCommandOptions) => {
    const { runComment } = await import("./commands/comment.js");
    await runComment(cmdOpts);
  });
```

### 2.3 Replace inline JS in `cli/src/commands/add.ts:106-154` and harden the workflow

Three workflow-level changes go together because they're tested together (`add.test.ts` baseline assertion):

**(a)** Bump `node-version` from `20` to `22` at `add.ts:76`. The CLI's `package.json` declares `"engines": {"node": ">=22"}`, and the new code paths (`fetch`, `AbortSignal.timeout`) require it. Today's emitted workflow is inconsistent.

**(b)** Add a job-level `permissions:` block. Modern repos default `GITHUB_TOKEN` to read-only, so `gh pr comment` and `gh api ... -X PATCH` will 403 without explicit `pull-requests: write`. Insert under `e2e-tests:` (`add.ts:67-69`):

```yaml
jobs:
  e2e-tests:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
      pull-requests: write
```

(Fork PRs receive a read-only token regardless — `skeptic comment` will warn-and-skip, which is the documented behavior.)

**(c)** Replace the entire `actions/github-script@v7` step (lines 106-154) with an explicit `skeptic comment` invocation that passes PR number and run URL from GitHub Actions context — **never relying on `gh pr view` autodetection**, which is unreliable on detached merge refs:

```yaml
      - name: Comment on PR
        if: github.event_name == 'pull_request' && always()
        run: |
          npx ${CLI_NAME} comment \
            --results ./skeptic-output/results.json \
            --pr \${{ github.event.pull_request.number }} \
            --run-url \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
```

`runComment` still falls back to `gh pr view` when `--pr` is omitted (for local dev / non-GHA CIs), but the GHA scaffold passes it explicitly so we never trip the detached-HEAD edge case.

Net effect: **~40 lines of embedded JS deleted from `add.ts`**, replaced with 7 lines of YAML + a 3-line permissions block.

### 2.4 Tests

- **`cli/__tests__/unit/commands/comment.test.ts`** (new):
  - `buildCommentBody` — passing summary, failing summary with one failure, failing with multiple, `runUrl: null` omits link, marker is first line, escapes `|` in flow names (matches Expect's pattern at `github.ts:268`).
  - `runComment --dry-run` — prints body to stdout, never invokes `gh`, exit code 0.
  - `runComment` with `gh` ENOENT — mock `child_process.execFileSync` to throw `Error & { code: "ENOENT" }`, assert warn logged, exit 0, no throw.
  - `runComment` with no PR detected — mock `gh pr view` to return `""`, assert info logged, exit 0.
  - `runComment` with `--results <missing>` — assert warn, exit 0.
  - **`gh api` invocation shape** (covers Codex rounds 3, 4, 5): drive PR resolution via the real input path — call `runComment({ pr: "123", results: <fixture path>, ... })` so `runComment` uses the explicit `--pr` value and never invokes `detectPrNumber`. (We don't `vi.spyOn(detectPrNumber)`: ESM exports are immutable bindings, so spying on a same-module helper doesn't replace the lexical reference `runComment` uses internally — only `vi.mock` of the whole module would, and that's heavier than necessary.) Mock only `child_process.execFileSync` to return a JSON-array string for the list call and an empty string for the PATCH call. Then assert the `execFileSync` mock was called with args **exactly** equal to `["gh", "api", "repos/{owner}/{repo}/issues/123/comments?per_page=100"]`. Three things this locks in: (a) the `${prNumber}` template literal is interpolated to the concrete PR number — `gh api` only auto-expands `{owner}`/`{repo}`/`{branch}`, so a literal `{pr}` would 404; (b) `per_page` is in the URL query string, not passed via `-F` (which would silently switch the method to POST); (c) the explicit `--pr` flag bypasses autodetect cleanly. A second test seeds the list response to contain a comment with the marker, asserts the PATCH path's argv is exactly `["gh", "api", "repos/{owner}/{repo}/issues/comments/<id>", "-X", "PATCH", "-F", "body=@<tempfile>"]` with concrete (mocked-fixed) `<id>` and `<tempfile>`. A third test for autodetect: pass NO `--pr`, mock `execFileSync` so the first call (`gh pr view --json number -q .number`) returns `"123\n"`, then assert the subsequent list call uses `123`.
- **Update `cli/__tests__/unit/commands/add.test.ts`**: existing baseline test (line 31-40) should also assert `npx skeptic comment --results` is in the YAML and that `actions/github-script` is **NOT**. Add a small assertion to the existing test rather than a new test.
- **`cli/__tests__/integration/commands/comment-cli-surface.test.ts`** (new, mirrors `add-cli-surface.test.ts`): assert help text advertises `--results`, `--pr`, `--marker`, `--run-url`, `--dry-run`, `-c, --config`.

---

## Phase 3 — Slack reporter

**Goal:** New reporter that posts to a Slack incoming webhook on `onRunComplete`. Config-driven, gracefully degrades.

### 3.1 New file `cli/src/reporter/slack-reporter.ts`

```ts
import type { Reporter, RunSummary, FlowResult, StepResult, FlowIdentifier } from "./types.js";
import type { SlackNotificationConfig } from "../config/schema.js";
import { logger } from "../utils/logger.js";

export class SlackReporter implements Reporter {
  constructor(private readonly config: SlackNotificationConfig, private readonly runUrl?: string) {}

  onFlowStart(_flow: FlowIdentifier): void {}
  onStepComplete(_s: StepResult, _i: number, _t: number, _f: FlowIdentifier): void {}
  onFlowComplete(_r: FlowResult, _f: FlowIdentifier): void {}

  async onRunComplete(summary: RunSummary): Promise<void> {
    const failed = summary.failed > 0;
    if (failed && !this.config.onFailure) return;
    if (!failed && !this.config.onSuccess) return;

    const payload = buildSlackPayload(summary, this.config, this.runUrl);
    try {
      const res = await fetch(this.config.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // Status code is safe — it never contains the URL or headers.
        logger.warn(`Slack notification failed: HTTP ${res.status}`);
      }
    } catch (err) {
      // CRITICAL: never log err.message or String(err) — Node's fetch error messages
      // can include the request URL ("fetch failed for https://hooks.slack.com/...").
      // err.name is a fixed class identifier ("TimeoutError", "TypeError", "AbortError")
      // that never carries user data.
      const errClass = err instanceof Error ? err.name : "UnknownError";
      logger.warn(`Slack notification failed: ${errClass}`);
    }
  }
}

export function buildSlackPayload(summary: RunSummary, config: SlackNotificationConfig, runUrl?: string): object;
```

**Block Kit payload** (cleaner than plain text, modern Slack standard):

- Top-level `text` (notification fallback) — combines status + mentions so push notifications fire even on clients that don't render blocks. Slack uses `text` as the notification preview.
- Optional **mrkdwn section block** at the top with `mention.join(" ")` if mentions are configured. **Mentions must live in mrkdwn-formatted blocks**, not the header — `header` blocks are `plain_text`-only and `<!here>` / `<@U…>` syntax does not notify there.
- Header block (plain text): `✅ skeptic tests passed` or `❌ skeptic tests failed: N flows`.
- Section block with summary fields: Total / Passed / Failed / Duration.
- Section block listing first 5 failed flow names (truncated, with bullet); if >5, append `_…and N more_`.
- Optional context block with `<runUrl|View run>` link.

### 3.2 Wire in `cli/src/commands/test.ts`

After `loadConfig()` (line 69-72), add:

```ts
const ciRunUrl = buildCIRunUrl();  // helper that reads GITHUB_* env, returns string|undefined
```

In the reporter assembly block (after line 167 / 172), append:

```ts
const notificationReporters = createNotificationReporters(config.notifications, ciRunUrl);
reporters.push(...notificationReporters);
```

Where `createNotificationReporters` is a new local function:

```ts
function createNotificationReporters(
  cfg: NotificationsConfig | undefined,
  runUrl: string | undefined,
): Reporter[] {
  if (!cfg) return [];
  const out: Reporter[] = [];
  if (cfg.slack) out.push(new SlackReporter(cfg.slack, runUrl));
  if (cfg.webhook) out.push(new WebhookReporter(cfg.webhook, runUrl));
  return out;
}

function buildCIRunUrl(): string | undefined {
  const server = process.env["GITHUB_SERVER_URL"];
  const repo = process.env["GITHUB_REPOSITORY"];
  const runId = process.env["GITHUB_RUN_ID"];
  if (server && repo && runId) return `${server}/${repo}/actions/runs/${runId}`;
  return undefined;
}
```

### 3.3 Tests `cli/__tests__/unit/reporter/slack-reporter.test.ts`

Mock `globalThis.fetch` with `vi.spyOn`. Cover:
- Posts on failure when `onFailure: true` (default).
- Skips on success when `onSuccess: false` (default) — assert `fetch` never called.
- Posts on success when `onSuccess: true`.
- Skips on failure when `onFailure: false`.
- Payload includes top-level `text`, header (plain_text), summary fields, run URL.
- **Mentions land in a mrkdwn section block** (not in the header) — explicit assertion: header `type: "header"` block has no mention strings; the mrkdwn section above it does.
- Top-level `text` includes mentions (so notifications fire on minimal Slack clients).
- HTTP 500 → logs warning, doesn't throw.
- `fetch` rejection (network error) → logs warning, doesn't throw.
- Status emoji differs by outcome (✅ vs ❌).
- Truncates failed-flow list at 5; appends `_…and N more_` for the overflow.
- **Log hygiene — strong form.** The test mocks `fetch` to reject with `new TypeError("fetch failed for https://hooks.slack.com/services/T123/B456/SECRET-TOKEN-XYZ")` (i.e. the *error message itself contains the secret URL*, mimicking Node's actual fetch behavior). Then asserts: `logger.warn` mock call args contain neither the literal substring `"hooks.slack.com"` nor `"SECRET-TOKEN-XYZ"`. This proves the reporter logs `err.name` only, never `err.message`. Repeat with `AbortError` for the timeout path.

---

## Phase 4 — Webhook reporter

**Goal:** Generic JSON webhook reporter. Mirrors Slack reporter, simpler payload.

### 4.1 New file `cli/src/reporter/webhook-reporter.ts`

```ts
export class WebhookReporter implements Reporter {
  constructor(private readonly config: WebhookNotificationConfig, private readonly runUrl?: string) {}

  /* ...same skeleton as SlackReporter... */

  async onRunComplete(summary: RunSummary): Promise<void> {
    /* same gating as Slack */
    const payload = {
      status: summary.failed > 0 ? "failed" : "passed",
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      duration_ms: summary.duration_ms,
      runUrl: this.runUrl ?? null,
      flows: summary.flows.map((f) => ({
        name: f.name,
        file: f.file,
        status: f.status,
        duration_ms: f.duration_ms,
        error: f.steps.find((s) => s.status !== "passed")?.error ?? null,
      })),
    };
    try {
      const res = await fetch(this.config.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.config.headers },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) logger.warn(`Webhook notification failed: HTTP ${res.status}`);
    } catch (err) {
      // Same hygiene rule as SlackReporter — never log err.message (may carry URL).
      const errClass = err instanceof Error ? err.name : "UnknownError";
      logger.warn(`Webhook notification failed: ${errClass}`);
    }
  }
}

export function buildWebhookPayload(summary: RunSummary, runUrl?: string): object;
```

### 4.2 Tests `cli/__tests__/unit/reporter/webhook-reporter.test.ts`

Mirror Slack tests:
- Posts on failure / success per gating.
- Payload shape matches contract.
- Custom headers included in request, but **never logged** (log-hygiene assertion).
- HTTP 500 / network error logs warning, doesn't throw.
- **Strong log hygiene:** mock `fetch` to reject with `new TypeError("fetch failed for https://hooks.example.com/SECRET")`; assert `logger.warn` args contain neither `hooks.example.com` nor `SECRET` nor any header value. Mirrors Slack reporter's hygiene test.

---

## Phase 4.5 — End-to-end wiring test for notifications

**Goal:** A reporter unit test asserts a class works in isolation. It does not catch `runTest` forgetting to call `createNotificationReporters`, forgetting to `await Promise.all`, or accidentally letting a Slack 500 set `process.exitCode = 1`. Add one focused integration-style test that exercises the wired-up path.

### 4.5.1 New test `cli/__tests__/integration/notifications-wiring.test.ts`

Run an in-process `runTest` against a minimal flow with notifications configured, mocking `globalThis.fetch`. Use the existing fixture pattern from `cli/__tests__/integration/commands/test-command.test.ts` (which writes a temp config + flow), but call `runTest` directly (no spawn) so we can `vi.spyOn(globalThis, "fetch")`.

Cover:
- A passing flow with `notifications.slack.onFailure: true, onSuccess: false` configured → `fetch` is **not** called (default gating, no failure).
- A failing flow with the same config → `fetch` **is** called exactly once with the configured URL, after `onRunComplete` fires.
- A passing flow with `notifications.webhook.onSuccess: true` → `fetch` called once with the webhook URL.
- Slack returns HTTP 500 on a failing flow → `fetch` was called, `process.exitCode === 1` (set by failed flow, not by Slack), test does not throw.
- Both `slack` and `webhook` configured on a failing flow → `fetch` called twice, once per URL, in any order.

This is the test that would catch a regression where someone removes `await` from `Promise.all(...)` or forgets to push notification reporters into the array.

---

## Security considerations for notifications

`notifications.webhook.url`, `notifications.webhook.headers`, and `notifications.slack.webhookUrl` are read from `skeptic.config.yaml` (with `${ENV}` interpolation). On a CI that runs unprotected PR branches, an attacker could open a PR that mutates `skeptic.config.yaml` to redirect the run summary (file paths, error strings, durations) to an attacker-controlled endpoint. This is the same trust model Maestro adopted (`WorkspaceConfig.kt:22-38`) — it is fundamental to any config-driven notification system.

**Mitigations adopted by this plan:**

1. **Log hygiene — strong form.** Neither `slack-reporter.ts` nor `webhook-reporter.ts` logs `err.message` or `String(err)` — Node's `fetch` errors routinely include the request URL in `err.message` (e.g. `"fetch failed for https://hooks.slack.com/..."`). Reporters log only `err.name` (a fixed class identifier like `"TimeoutError"`, `"TypeError"`, `"AbortError"`) plus, on HTTP failure, the status code. Tests in 3.3 and 4.2 prove this end-to-end by mocking `fetch` to reject with errors whose messages explicitly contain a fake secret URL — the assertions then check that `logger.warn` mock args contain neither the URL nor the secret token.
2. **Documentation warning** — `cli/README.md` Notifications section opens with: *"⚠️ `notifications.webhook.url` and `notifications.slack.webhookUrl` accept arbitrary URLs. If your CI runs unprotected PR branches, attacker-modified configs could exfiltrate test summaries to attacker endpoints. Pin notification config to your protected branches."*
3. **Payload minimization** — webhook payload (Phase 4.1) includes flow names, file paths, status, durations, and the first error message of each failed flow. It does **not** include screenshots, full error stack traces, environment variables, or process arguments. This bounds the worst-case data leak.

**Mitigations explicitly NOT adopted** (and why):

- Requiring an env-var-only opt-in for webhooks (e.g. `SKEPTIC_WEBHOOK_ENABLED=1`). Rejected: would break the config-driven model that Maestro pioneered and the spec doc (`docs/competitive-analysis-maestro-expect.md:414-428`) calls for. Users on protected branches would have to remember a CI env var that's redundant for their threat model.
- HMAC signing of webhook bodies. Out of scope for v1 — adds a shared secret to manage; users who need it can run a sidecar.

---

## Phase 5 — AI-in-CI

**Goal:** Generated workflow's test step appends `--analyze` when `--ai` is set, AND the provider chosen at scaffold time actually flows through to the runtime `skeptic test --analyze` call.

### 5.1 Two latent drift bugs (must fix together with `--analyze`)

`skeptic add github-action --ai --provider openai` injects `OPENAI_API_KEY` into the workflow env block (Bundle 3 behavior). At runtime, `skeptic test --analyze` reads its AI config via `loadConfig()` and instantiates the client via `createAIClient` (`cli/src/ai/client-factory.ts:17-22`). Two latent drifts mean Phase 5 can't ship with a one-line `--analyze` append:

**(a) Provider drift.** Runtime `config.ai.provider` defaults to `gemini` (`schema.ts:76`). If the user's `skeptic.config.yaml` says `provider: gemini` (or omits the `ai:` block), `createAIClient` looks for `GEMINI_API_KEY` — which the OpenAI workflow never injected. Result: `--analyze` silently degrades.

**(b) API-key drift.** Even with provider matched, `client-factory.ts:20` reads `apiKey = config?.apiKey ?? process.env[envKey]`. The README example sets `ai.apiKey: $GEMINI_API_KEY`. After `interpolateEnvDeep`, an unset `GEMINI_API_KEY` becomes the **empty string** `""`. Empty string is **not** nullish, so `??` does not fall through — `apiKey = ""`, `!apiKey` is true at line 22, `createAIClient` returns `undefined`, and `--analyze` silently degrades again.

### 5.2 Three coordinated fixes

**(a) `cli/src/config/loader.ts:90`** — add two env overrides inside `applyEnvOverrides`. Mirrors the existing `SKEPTIC_URL`/`SKEPTIC_TIMEOUT` pattern:

```ts
const providerOverride = process.env["SKEPTIC_AI_PROVIDER"];
if (providerOverride) {
  const ai = (result["ai"] ?? {}) as Record<string, unknown>;
  result["ai"] = { ...ai, provider: providerOverride };
}

const apiKeyOverride = process.env["SKEPTIC_AI_API_KEY"];
if (apiKeyOverride) {
  const ai = (result["ai"] ?? {}) as Record<string, unknown>;
  result["ai"] = { ...ai, apiKey: apiKeyOverride };
}
```

`provider` is validated by the zod enum at `schema.ts:76`. `apiKey` is just a string. No new validation code.

**(b) `cli/src/ai/client-factory.ts:20`** — defense-in-depth one-character change:

```ts
// Before:
const apiKey = config?.apiKey ?? process.env[envKey];
// After:
const apiKey = config?.apiKey || process.env[envKey];
```

Logical OR (`||`) treats empty-string `apiKey` as falsy and falls through to the env var. This handles the case where a config-file `ai.apiKey` was interpolated from an unset env var to `""`. Without this, fix (a) is the only line of defense; with both, the system is robust to config drift even if a user runs in an environment where neither override is set.

**(c) `cli/src/commands/add.ts`** — workflow now injects all three env vars when `--ai`:

```ts
const aiEnvBlock = useAI
  ? `\n          ${envKey}: \${{ secrets.${envKey} }}\n          SKEPTIC_AI_PROVIDER: ${provider}\n          SKEPTIC_AI_API_KEY: \${{ secrets.${envKey} }}`
  : "";

// In the YAML body:
run: npx ${CLI_NAME} test --ci --reporter console --reporter junit --reporter json --output ./skeptic-output${useAI ? " --analyze" : ""}
```

The workflow simultaneously injects: (i) the provider-specific secret (Bundle 3 behavior, e.g. `OPENAI_API_KEY`); (ii) `SKEPTIC_AI_PROVIDER` so runtime `provider` matches; (iii) `SKEPTIC_AI_API_KEY` (same secret value, surfaced through the new override) so runtime `apiKey` is non-empty regardless of any stale `ai.apiKey: $GEMINI_API_KEY` in the user's config. **No config-file edit needed.**

### 5.3 Tests in `cli/__tests__/unit/commands/add.test.ts`

Inside the existing `runAddGitHubAction AI env block` describe (which already loops over all three providers):
- `--analyze` is present in YAML when `--ai` is set (any provider); NOT present when omitted.
- `SKEPTIC_AI_PROVIDER: <provider>` is present and matches the secret's provider when `--ai --provider=<provider>` is set; NOT present when `--ai` is omitted.
- `SKEPTIC_AI_API_KEY: ${{ secrets.<envKey> }}` is present and references the same secret as the API-key env line; NOT present when `--ai` is omitted.
- **Step-scoped assertions** (Codex round-8 strengthening): the three AI env vars (`<envKey>`, `SKEPTIC_AI_PROVIDER`, `SKEPTIC_AI_API_KEY`) all live in the `env:` block of the **`skeptic test ... --analyze` step**, not merely "somewhere in the YAML". Implementation: split the YAML on the `- name:` step delimiters, find the test step (the one whose `run:` contains `skeptic test`), assert all three env vars appear inside that step's `env:` block. Prevents false positives where an env var lands under the wrong step or at job level.

### 5.4 Tests in `cli/__tests__/unit/config/loader.test.ts` (new if absent, otherwise extend)

- `SKEPTIC_AI_PROVIDER=openai` overrides config `ai.provider`; zod validates the value (invalid value rejected with same error shape as `--provider`).
- `SKEPTIC_AI_API_KEY=secret123` overrides config `ai.apiKey` even when the YAML had `ai.apiKey: $GEMINI_API_KEY` (interpolated to empty in this context).
- Both env vars unset → no overrides applied; config values preserved.

### 5.5 Tests in `cli/__tests__/unit/ai/client-factory.test.ts` (new if absent)

The defense-in-depth `??` → `||` change deserves a regression test:
- `config.ai.apiKey = ""` and `process.env.OPENAI_API_KEY = "abc"` → `createAIClient` returns an OpenAI client (uses env var). Without the fix, this returns `undefined`.
- `config.ai.apiKey = "literal"` and env var unset → uses literal (existing behavior preserved).
- Both empty/unset → returns `undefined` (existing behavior preserved).

### 5.6 End-to-end stale-config test (covers Codex round-6 scenario directly)

In `cli/__tests__/unit/commands/add.test.ts`, add a single integration-flavored test that proves the full chain works:

```ts
it("stale ai.apiKey in config doesn't break --ai --provider openai workflow", async () => {
  fs.writeFileSync(path.join(tmpDir, "skeptic.config.yaml"),
    `ai:\n  provider: gemini\n  apiKey: $GEMINI_API_KEY\n`, "utf-8");
  const { runAddGitHubAction } = await import("../../../src/commands/add.js");
  await runAddGitHubAction({ ai: true, provider: "openai" });
  const yaml = fs.readFileSync(workflowPath(), "utf-8");
  // All three env injections present; the OpenAI key is the source of truth at runtime
  expect(yaml).toContain("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
  expect(yaml).toContain("SKEPTIC_AI_PROVIDER: openai");
  expect(yaml).toContain("SKEPTIC_AI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
  // Step-scoped: the three AI env vars must be attached to the test step's env: block,
  // not merely "somewhere in the YAML" (Codex round-8 strengthening).
  const testStep = extractStep(yaml, "skeptic test");  // helper: returns the YAML chunk
  expect(testStep).toContain("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
  expect(testStep).toContain("SKEPTIC_AI_PROVIDER: openai");
  expect(testStep).toContain("SKEPTIC_AI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
  // Negative: nothing should reference GEMINI_API_KEY anywhere
  expect(yaml).not.toContain("GEMINI_API_KEY");
});
```

---

## Phase 6 — Documentation

### 6.1 Update `docs/competitive-analysis-maestro-expect.md`

Mark items #35, #40 as "Shipped (Bundle 4)". Add a new entry for AI-in-CI follow-up under Bundle 4.

### 6.2 Update `cli/README.md`

Three new sections:
1. **`skeptic comment`** — flag table (`--results`, `--pr`, `--marker`, `--run-url`, `--dry-run`, `-c`); example usage; requirement note that `gh` must be installed and authenticated; note that fork PRs receive read-only tokens (warn-and-skip behavior); table of CI envs the command auto-detects.
2. **Notifications** — opens with the security callout (verbatim from the Security Considerations section above). `notifications:` config example with both `slack` and `webhook` blocks. Uses `${SLACK_WEBHOOK_URL}` and `${SKEPTIC_WEBHOOK_URL}` interpolation. Documents `onSuccess` / `onFailure` defaults (false / true). Notes that Slack `channel` is intentionally not configurable — tied to the webhook URL.
3. **AI in CI** — note that `skeptic add github-action --ai` now appends `--analyze` to the test step. Also calls out that the generated workflow now uses Node 22 (matches the CLI's engines requirement) and grants `pull-requests: write` for PR comments.

---

## Critical files

| File | Phase | Change |
|---|---|---|
| `cli/src/config/schema.ts` | 1.1 | Add `NotificationsSchema`, `SlackNotificationSchema`, `WebhookNotificationSchema`; export inferred types |
| `cli/src/reporter/types.ts` | 1.2 | `onRunComplete: void \| Promise<void>` |
| `cli/src/commands/test.ts` | 1.3, 3.2 | `await Promise.all` on 4 onRunComplete sites; add `createNotificationReporters` + `buildCIRunUrl` |
| `cli/src/commands/comment.ts` (new) | 2.1 | `runComment` + helpers (`buildCommentBody`, `detectPrNumber`, `findExistingComment`) |
| `cli/src/index.ts` | 2.2 | Register `comment` command |
| `cli/src/commands/add.ts` | 2.3, 5.2c | Replace inline JS with `npx skeptic comment` step (with explicit `--pr`/`--run-url`); add `permissions:` block; bump node-version to 22; emit `SKEPTIC_AI_PROVIDER` + `SKEPTIC_AI_API_KEY` and append `--analyze` when `--ai` |
| `cli/src/config/loader.ts` | 5.2a | Add `SKEPTIC_AI_PROVIDER` AND `SKEPTIC_AI_API_KEY` env overrides in `applyEnvOverrides` |
| `cli/src/ai/client-factory.ts` | 5.2b | One-char defense-in-depth: `??` → `\|\|` so empty-string `apiKey` falls through to env var |
| `cli/__tests__/unit/config/loader.test.ts` | 5.4 | Cover both new env overrides + zod validation |
| `cli/__tests__/unit/ai/client-factory.test.ts` | 5.5 | Empty-string apiKey falls through to env var (regression-locks `??`→`\|\|`) |
| `cli/src/reporter/slack-reporter.ts` (new) | 3.1 | `SlackReporter` + `buildSlackPayload` |
| `cli/src/reporter/webhook-reporter.ts` (new) | 4.1 | `WebhookReporter` + `buildWebhookPayload` |
| `cli/__tests__/unit/config/notifications-schema.test.ts` (new) | 1.4 | Schema validation tests |
| `cli/__tests__/unit/commands/comment.test.ts` (new) | 2.4 | Body builder + degradation paths |
| `cli/__tests__/integration/commands/comment-cli-surface.test.ts` (new) | 2.4 | Help-text lock |
| `cli/__tests__/unit/commands/add.test.ts` | 2.4, 5.2 | Assert YAML uses `npx skeptic comment`; assert `--analyze` toggle |
| `cli/__tests__/unit/reporter/slack-reporter.test.ts` (new) | 3.3 | Posting + gating + degradation + log hygiene |
| `cli/__tests__/unit/reporter/webhook-reporter.test.ts` (new) | 4.2 | Posting + gating + payload shape + log hygiene |
| `cli/__tests__/integration/notifications-wiring.test.ts` (new) | 4.5.1 | End-to-end: `runTest` actually invokes notification reporters |
| `cli/README.md` | 6.2 | New sections: comment, notifications (with security warning), AI-in-CI |
| `docs/competitive-analysis-maestro-expect.md` | 6.1 | Mark #35, #40 shipped |

**Net delta:** 5 new source files, 6 new test files, ~40 lines deleted from `add.ts` plus a node-version bump and permissions block, no new npm dependencies.

---

## Reused utilities

- `Reporter` interface — `cli/src/reporter/types.ts:17` (interface widening only)
- `RunSummary` — `cli/src/reporter/types.ts:3-9` (sole input to all reporters; nothing recomputed)
- `loadConfig` + `interpolateEnvDeep` — `cli/src/config/loader.ts:78` (handles `${SLACK_WEBHOOK_URL}` resolution automatically)
- `ENV_KEY_BY_PROVIDER` pattern — `cli/src/ai/ai-client.ts:3-7` (mirror for documentation in README, not as code)
- `logger.warn` graceful-degradation idiom — used throughout existing reporters (`cli/src/reporter/json-reporter.ts:40`)
- `chalk` for CLI output — already a dep
- Native `fetch` — Node 22+ (`package.json:engines`)
- Test idioms — `mkdtempSync` + spy patterns from `cli/__tests__/unit/reporter/json-reporter.test.ts` and `cli/__tests__/unit/commands/add.test.ts`
- Integration help-text lock pattern — `cli/__tests__/integration/commands/add-cli-surface.test.ts`
- Marker upsert pattern — Expect `/Users/iamjr15/Desktop/skeptic-refs/expect/packages/supervisor/src/github.ts:172-185` (referenced verbatim in 2.1)
- Notifications config shape — Maestro `/Users/iamjr15/Desktop/skeptic-refs/maestro/maestro-orchestra-models/src/main/java/maestro/orchestra/WorkspaceConfig.kt:22-38` (referenced verbatim in 1.1)

---

## Verification

After each phase: `cd cli && npm run check && npm test` — green.

After Phase 2 (manual smoke):
```bash
# In a repo with results.json present and on a PR branch with gh logged in:
npx skeptic comment --dry-run
# expect: markdown body printed to stdout

# Without gh installed (rename gh on PATH):
npx skeptic comment
# expect: warning logged, exit 0
```

After Phase 3 (manual smoke):
```bash
SLACK_WEBHOOK_URL='https://hooks.slack.com/...' \
  npx skeptic test tests/intentionally-failing.yaml
# expect: Slack message in channel; build exit code reflects test status, not Slack status
```

After Phase 5 (manual smoke):
```bash
skeptic add github-action --ai --provider openai
grep -E "test --ci .* --analyze" .github/workflows/skeptic-tests.yml
# expect: one match
```

Final acceptance:
```bash
cd cli
npm run build
npm run check
npm test            # all 280+ existing tests + ~25 new tests pass
```

The 280-test count climbs as we land each phase. Each phase keeps tests green — no "fix at the end" sequence.
