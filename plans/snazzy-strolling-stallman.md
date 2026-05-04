# Deferred: Playwright Tracing + Interactive Generate Review

## Context

The 18-feature port from Maestro/Expect into the skeptic CLI landed with zero type errors and 155/155 tests passing, but two items were deferred to this plan:

1. **F18 — Playwright Tracing**: The `--trace` flag and `EngineOptions.trace` field are already wired end-to-end (CLI → Commander → `TestCommandOptions`), but the engine never actually starts or stops a Playwright trace. So `skeptic test --trace flow.yaml` is a no-op today.
2. **F7 — Interactive plan review for `generate`**: The `-y/--yes` flag and `detectCI()` import already exist in `generate.ts`, but the actual Ink TUI that lets a user review AI-generated YAML flows before they are saved does not exist yet. `skeptic generate -m "..."` currently writes everything blind.

Goal: close both gaps without touching any of the already-completed feature work.

## Task 1 — Playwright Tracing

### Files

- `cli/src/executor/playwright-engine.ts` — add tracing start/stop around the existing flow-execution lifecycle
- `cli/src/commands/test.ts` — pass `opts.trace` into `EngineOptions`

### Pattern to follow

Mirror the existing video-recording logic (`videoEnabled`, `videoDir`, `safeName`, `flowDir`). Trace is simpler because it is a single `.zip` written at the context level — we do not need a separate subdirectory and do not need to close the page first.

### Engine edits (`cli/src/executor/playwright-engine.ts`)

1. Near line 49 (right below `const videoEnabled = this.options.video ?? false;`):
   ```ts
   const traceEnabled = this.options.trace ?? false;
   let traceStarted = false;
   ```
   `traceStarted` guards the finally block so we never call `tracing.stop` on a context where `tracing.start` threw or never ran.

2. Immediately after `context = await this.browser.newContext(contextOptions);` at line 85:
   ```ts
   if (traceEnabled) {
     await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
     traceStarted = true;
   }
   ```

3. In the `finally` block (currently lines 269–277), before the existing `page.close()` / `context.close()` calls:
   ```ts
   if (traceStarted && context) {
     try {
       const tracePath = join(flowDir, `${safeName}.trace.zip`);
       await context.tracing.stop({ path: tracePath });
       logger.info(`Trace saved. View with: npx playwright show-trace ${tracePath}`);
     } catch (err) {
       logger.warn(`Trace save failed: ${err instanceof Error ? err.message : String(err)}`);
     }
   }
   ```
   Ordering note: the video-save block at lines 245–259 closes the page but leaves the context open, so trace-stop still has a live context when finally runs.

### CLI edits (`cli/src/commands/test.ts`)

1. In the `engineOpts` object (lines 183–205), add after `video: videoEnabled,`:
   ```ts
   trace: opts.trace,
   ```
   `EngineOptions.trace?: boolean` already exists at `cli/src/executor/types.ts:62`; no type changes needed.

2. Directly after the existing video warning at line 178–181, add a parallel security warning for trace:
   ```ts
   const traceEnabled = opts.trace ?? false;
   if (traceEnabled) {
     logger.warn("Trace captures DOM snapshots, screenshots, and network requests — may include credentials. Review before sharing.");
   }
   ```
   Traces contain the same class of sensitive data as video (and more — full DOM + network), so parity with the video warning is a must.

### Known limitation (shared with video)

Trace artifacts are overwritten across retries — the path is fixed at `${safeName}.trace.zip`, just like `${safeName}.webm` at `playwright-engine.ts:249`. This matches the user-specified pattern ("check existing video recording code for the pattern") and keeps video/trace behavior consistent. If per-attempt artifacts become desirable later, both video and trace should be extended together.

## Task 2 — Interactive Generate Review TUI

### Files to create

- `cli/src/ui/screens/generate-review-screen.tsx` — Ink component
- `cli/src/ui/screens/generate-review-render.tsx` — promise-based entry point

### File to modify

- `cli/src/commands/generate.ts` — gate the TUI behind CI / TTY / `-y` checks after generation, before save

### Component: `generate-review-screen.tsx`

Shape:
```tsx
interface GenerateReviewScreenProps {
  flows: string[];
  onApprove: (indices: number[]) => void;
  onSkip: () => void;
}
```

Per-flow parsing helper (runs once inside `useMemo`):
- Call `parseFlowString(yaml, "<generated-${i}>")` from `../../parser/flow-parser.js`.
- On success: extract `metadata.name`, `metadata.tags`, `steps.length`.
- On failure: fall back to `/^name:\s*(.+)$/m` regex (same approach already used in `generate.ts:87`); set `stepCount = 0`, `tags = []`, `parseError = err.message`.
- **Parse-error flows remain selectable** (and are included in the default-selected `Set`). The TUI just warns with a `⚠ parse error` marker. This preserves today's behavior where `generate.ts:83` writes raw YAML unconditionally — malformed flows can still be saved so the user can inspect / fix them by hand.

State:
- `focusedIndex: number` (starts at 0)
- `selected: Set<number>` (starts as `new Set(parsed.map((_, i) => i))` — all flows selected, including parse errors)

Keyboard handling via `useInput`:
- `k` / up-arrow → `focusedIndex - 1` (clamped)
- `j` / down-arrow → `focusedIndex + 1` (clamped)
- `space` / `return` → toggle `selected` membership for `focusedIndex` (always allowed, even for parse-error flows)
- `a` → `onApprove(parsed.map((_, i) => i))` (approve all, including parse errors)
- `s` → `onApprove([...selected].sort((a,b) => a - b))`
- `q` → `onSkip()`
- `ctrl+c` → `onSkip()` (graceful abort)

Rendering: match existing `watch-screen.tsx` structure, with a preview pane below the list so users can actually see the YAML they're reviewing. The preview pane is **sized to available terminal height** so a tall terminal shows the full flow; small terminals still get a useful window.

```tsx
const { stdout } = useStdout();
const rows = stdout?.rows ?? 24;
const overhead = 10; // header + instructional line + dividers + hint bar
const listRows = parsed.length + 2;
const previewMaxLines = Math.max(6, rows - listRows - overhead);
const focusedYaml = flows[focusedIndex] ?? "";
const previewLines = focusedYaml.split("\n");
const previewText = previewLines.slice(0, previewMaxLines).join("\n");
const truncated = previewLines.length > previewMaxLines;
```

```
<Box flexDirection="column">
  <Header label="Review generated flows" />
  <Box paddingX={2}>{count} flow(s) generated. Select which to save.</Box>
  <Box flexDirection="column" paddingX={2}>
    {each flow as a line with: focus pointer ▸, checkbox [x]/[ ], name, (N steps, tags: …), ⚠ parse error?}
  </Box>
  <Box paddingX={2}><Text color={colors.dim}>{"─".repeat(56)}</Text></Box>
  <Box flexDirection="column" paddingX={2}>
    <Text color={colors.dim}>Preview — {focused.name}</Text>
    <Text>{previewText}</Text>
    {truncated ? <Text color={colors.dim}>… +{previewLines.length - previewMaxLines} more lines (resize terminal to see more)</Text> : null}
  </Box>
  <Box paddingX={2}><Text color={colors.dim}>{"─".repeat(56)}</Text></Box>
  <Box paddingX={2} gap={2}>{hint bar: j/k navigate, space toggle, a approve all, s save selected, q skip}</Box>
</Box>
```

The preview updates automatically as `focusedIndex` changes — no extra keybinding needed, so the user's spec for keys is preserved. `useStdout` is already how `cli/src/ui/components/header.tsx` and `flow-list.tsx` size themselves. The existing `useScrollable` hook at `cli/src/ui/hooks/use-scrollable.ts:12` is an option for future iteration if dedicated preview scrolling becomes worth the keybinding cost.

Use `colors` and `icons` from `../theme.js` (brand/pass/fail/active/dim already defined). Inline the hint bar rather than extending `hint-bar.tsx` to avoid modifying shared shipped code.

### Entry point: `generate-review-render.tsx`

Exports `renderGenerateReview(flows: string[]): Promise<{ approved: string[] }>`.

Pattern (follows `cli/src/ui/render.tsx`):
```tsx
export const renderGenerateReview = (flows: string[]): Promise<{ approved: string[] }> =>
  new Promise((resolve) => {
    let resolved = false;
    let instance: ReturnType<typeof render> | null = null;

    const finish = (approved: string[]) => {
      if (resolved) return;
      resolved = true;
      instance?.unmount();
      resolve({ approved });
    };

    const onApprove = (indices: number[]) =>
      finish(indices.map((i) => flows[i]).filter((y): y is string => typeof y === "string"));
    const onSkip = () => finish([]);

    instance = render(
      <GenerateReviewScreen flows={flows} onApprove={onApprove} onSkip={onSkip} />,
      { exitOnCtrlC: false, alternateScreen: true, patchConsole: true, incrementalRendering: true },
    );
  });
```
`resolved` guard prevents double-resolve if any input race fires both callbacks.

### Command edits (`cli/src/commands/generate.ts`)

After `logger.success(\`Generated ${yamlOutputs.length} flow(s)\`)` (line 66), before `if (opts.save)` (line 69):
```ts
if (!detectCI().isCI && process.stdout.isTTY && process.stdin.isTTY && !opts.yes) {
  const { renderGenerateReview } = await import("../ui/screens/generate-review-render.js");
  const result = await renderGenerateReview(yamlOutputs);
  yamlOutputs = result.approved;
  if (yamlOutputs.length === 0) {
    logger.info("No flows approved, nothing saved.");
    return;
  }
}
```
- `yamlOutputs` is declared with `let` (line 37) — reassignable.
- `detectCI` already imported at line 9.
- Dynamic import keeps Ink/React out of the import graph when the TUI is skipped (CI, non-TTY, `-y`).
- The guard reuses `process.stdout.isTTY` rather than `ciInfo.isInteractive` because the latter also excludes agent environments, which can still be running inside a pty. The user's spec called out `stdout.isTTY`; we defensively add `process.stdin.isTTY` as well so that pipelines like `cat prompts.txt | skeptic generate -m "..."` fall through to non-interactive mode instead of hanging on Ink's `useInput`.

## Reused utilities

- `parseFlowString` — `cli/src/parser/flow-parser.ts:18` (validates + extracts `metadata.name`, `metadata.tags`, `steps`)
- `detectCI` — `cli/src/utils/ci-detect.ts:43` (already imported in `generate.ts`)
- `logger` — `cli/src/utils/logger.ts` (info/warn)
- `colors`, `icons` — `cli/src/ui/theme.ts`
- `Header` — `cli/src/ui/components/header.tsx`
- Ink `render()` options — copy from `cli/src/ui/render.tsx:15-20`

## Tests to add

The repo already has `cli/__tests__/unit/commands/generate.test.ts` and `cli/__tests__/integration/commands/test-command.test.ts`. Two targeted tests that *actually* pin the new behavior (not just re-assert trivial assignments):

1. **`cli/__tests__/unit/commands/generate.test.ts`** — extend with a case that genuinely proves the `-y` bypass. Because the guard also short-circuits on TTY, a naive test passes even if `opts.yes` is ignored. The test must:
   - Stub `process.stdout.isTTY = true` and `process.stdin.isTTY = true` (restore in `afterEach`).
   - `vi.mock("../../../src/utils/ci-detect.js")` so `detectCI()` returns `{ isCI: false, ciProvider: null, isAgentEnv: false, agentName: null, isInteractive: true }`.
   - `vi.mock("../../../src/ui/screens/generate-review-render.js", () => ({ renderGenerateReview: vi.fn().mockResolvedValue({ approved: [] }) }))`.
   - Assert: `runGenerate({ message: "x", yes: true, config: "/dev/null" })` → `renderGenerateReview` is **not** called.
   - Companion assert: `runGenerate({ message: "x", yes: false, config: "/dev/null" })` → `renderGenerateReview` **is** called with the generated YAML array.

2. **`cli/__tests__/unit/commands/test-command-trace.test.ts`** (new file) — pin `trace: opts.trace` end-to-end from CLI options to engine construction:
   - `vi.mock("../../../src/executor/playwright-engine.js")` with a factory that replaces `PlaywrightEngine` with a `vi.fn()` that returns `{ launch: vi.fn(), runFlow: vi.fn().mockResolvedValue({ name: "x", file: "x", status: "passed", duration_ms: 0, steps: [] }), close: vi.fn() }`.
   - Mock `resolveFlows` to return a single minimal `ResolvedFlow`.
   - Call `runTest([...], { trace: true, config: "/dev/null", ... })`.
   - Assert: the `PlaywrightEngine` constructor was called with an object containing `trace: true`. Repeat with `trace: false` / undefined to assert the flag is passed through faithfully.
   - Bonus optional: a second test that passes `aiClient`-style config and asserts trace flag and video flag coexist in the same `EngineOptions`.

Neither test requires rendering Ink or launching a browser. Expected post-change suite count: **157** tests (155 prior + 2 new assertions packed into 2–3 test cases).

## Out of scope

- No changes to `FlowResult` (trace path is logged, not returned).
- No changes to `hint-bar.tsx` (hints inlined on the review screen).
- No changes to any of the 11 new step handlers, 3 AI clients, or config schema from the main feature ship.
- No step-level edit / regenerate flow for the review TUI — the user's spec is a simple approve/select, not the full Expect-style edit UX described at `docs/competitive-analysis-maestro-expect.md:133-141`. That can ship later as its own feature.

## Verification

1. **Type check**: `cd cli && npx tsc --noEmit` — expect zero errors.
2. **Unit tests**: `cd cli && npm test` — expect 157/157 passing (155 existing + 2 new suites for the `-y` bypass and the `--trace → EngineOptions` wiring).
3. **Trace smoke**: `cd cli && npm run build && node dist/bin/skeptic.js test --trace <some flow>.yaml`
   - Expect a file at `skeptic-output/<safe-name>-0/<safe-name>.trace.zip`
   - Expect a log line: `Trace saved. View with: npx playwright show-trace …`
   - Expect `npx playwright show-trace <path>` to open the inspector.
4. **TUI smoke** (needs `GEMINI_API_KEY` exported, run in a real terminal):
   - `node dist/bin/skeptic.js generate -m "smoke test the homepage"` — expect the review screen to appear, navigation/toggle keys to work, `s` to save only selected flows.
   - `node dist/bin/skeptic.js generate -m "..." -y` — expect no TUI; goes straight to save/print behavior.
   - `CI=true node dist/bin/skeptic.js generate -m "..."` — expect no TUI (CI guard).
   - `node dist/bin/skeptic.js generate -m "..." | cat` — expect no TUI (non-TTY guard).
