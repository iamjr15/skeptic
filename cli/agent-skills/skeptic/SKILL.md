---
name: skeptic
description: Use Skeptic for CLI-first browser QA and TypeScript E2E tests. Use when asked to inspect pages, write or run skeptic-cli specs, validate UI changes, capture observability evidence, or use Skeptic MCP tools. Not for unit-only logic with no browser behavior.
---

<!-- skeptic-agent-skill: managed by skeptic-cli -->

# Skeptic

Use Skeptic when a coding agent needs browser evidence: page inspection, TypeScript E2E specs, one-off QA captures, AI-backed checks, or MCP browser validation. Do not claim a UI/browser change works until you have run a relevant Skeptic command or MCP tool and checked the evidence.

## Choose The Surface

- One-off QA or bug hunt: run `skeptic observe <url> --full-page`.
- Persistent regression coverage: run `skeptic inspect <url> --interactive --compact --with-playwright-hints`, write a `tests/*.spec.ts`, then run `skeptic run`.
- Changed-code verification: run `skeptic run --diff` when the project has specs, or use `skeptic generate --diff` to create one.
- Agent-integrated browser work: if Skeptic MCP tools are available, use `browser_open`, `browser_snapshot`, `browser_playwright`, `browser_screenshot`, `browser_console_logs`, `browser_network_requests`, `browser_performance_metrics`, `browser_accessibility_audit`, and `browser_close`.

If the `skeptic` binary is not on PATH, try `npx skeptic-cli` or `npx --yes skeptic-cli@latest`.

## Fast Loop

```bash
skeptic doctor --quick
skeptic inspect <url> --interactive --compact --with-playwright-hints
skeptic run tests/<scenario>.spec.ts --observability --video --trace
```

For a page with no existing spec:

```bash
skeptic observe <url> --full-page --video --trace
```

Use the generated `results.json`, `report.html`, screenshots, videos, traces, `network.json`, `console.json`, `accessibility.json`, and `perf-trace.md` as the evidence source. Reference artifact paths from `results.json` instead of guessing filenames.

## Writing Specs

Skeptic specs import from `skeptic-cli`.

```ts
import { test, expect } from "skeptic-cli";

test("homepage smoke", async ({ page, snapshot, screenshot, observability }) => {
  await page.goto("https://example.com");
  await expect(page).toHaveTitle(/Example Domain/);

  const tree = await snapshot(page, { interactive: true, compact: true });
  await tree.byRole("link", { name: "More information..." }).click();

  await screenshot("homepage", { fullPage: true });
  await observability.expectNoConsoleErrors();
});
```

Rules:

- Put browser side effects inside `test(...)`, hooks, or helper functions called from tests.
- Prefer role, label, text, and test-id locators over CSS.
- Use `snapshot(page)` before interacting through refs or snapshot helpers.
- Re-snapshot after navigation, route changes, modal open/close, or major DOM mutation.
- Do not paste CLI `@eN` refs directly into specs. Use `selectorHint` from `inspect`, or use `tree.byRef("eN")` only for refs returned by the same in-test `snapshot(page)` call.
- Add `screenshot("name")` for states that would help debug a failure.

## Observability Checks

Use `--observability` for real QA evidence. In specs, assert the signals that match the risk:

```ts
await observability.expectNoConsoleErrors();
await observability.expectNoNetworkErrors({ allow: [/analytics/] });
await observability.expectPerformance({ lcp: "<2500ms", cls: "<0.1" });
await observability.expectAccessible({ standard: "WCAG21AA" });
```

If an observability artifact reports a failure, fix the product or the test and re-run the same flow immediately.

## MCP Workflow

When Skeptic is exposed through MCP:

1. `browser_open` the target URL.
2. `browser_snapshot` or `browser_screenshot` with snapshot mode to get refs.
3. Use one `browser_playwright` call for actions that share the same DOM state. Use the `ref` helper for snapshot refs and `return` structured evidence.
4. After DOM-changing actions, request a fresh snapshot.
5. Check `browser_console_logs`, `browser_network_requests`, `browser_accessibility_audit`, and `browser_performance_metrics`.
6. `browser_close` when done so video and trace artifacts flush.

Batch fills, clicks, and data collection when the DOM is stable. Do not take a new snapshot between plain text fills unless the page structure changed.

## Verification Standard

Before reporting completion for browser-facing work:

- Run the smallest Skeptic command or MCP workflow that actually exercises the changed behavior.
- Test at least one adjacent or negative path when forms, routing, validation, auth, persistence, or shared components changed.
- Read the full command/tool output. Passing navigation alone is not enough.
- If there are console errors, network failures, serious accessibility issues, poor Web Vitals, or visible regressions, fix and re-run.
- State the exact command/tool run and the main artifact path in the final report.
