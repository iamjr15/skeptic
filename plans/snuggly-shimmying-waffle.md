# Plan: Interactive TUI (Ink/React for Terminal)

## Context

skeptic's CLI currently uses a basic `ConsoleReporter` that writes plain text with chalk colors — step-by-step progress, PASS/FAIL badges, and a summary line. No spinners, no animations, no interactivity. This plan adds a full interactive TUI using Ink 7 (React for the terminal), inspired by Expect's architecture but tailored to skeptic's test-runner UX.

**Why now:** The core engine is stable (92 tests, 64 source files, ~6K LOC). The reporter interface is well-defined. Adding a premium interactive experience now — before publishing — differentiates skeptic from every other YAML-based testing tool.

**What we're building:** A dual-mode rendering system:
1. **Interactive TUI** (Ink) — full-screen, animated, keyboard-navigable test execution UI for local dev
2. **Plain CI mode** — the current console reporter, refined for non-TTY environments

**Breaking change:** Node.js engine requirement bumps from `>=18` to `>=22` (required by Ink 7 + React 19).

---

## Research Summary

### What Expect Does (github.com/millionco/expect)
- **React + Ink v6** with alternate screen buffer, Zustand navigation, Effect Atoms for state
- **Stateless renderer pattern** — CLI renders supervisor state, owns zero business logic
- **Per-character TextShimmer** animation (each char is its own `<Text>` with interpolated color at 20fps)
- **Dual mode** — Ink TUI for interactive, `ci-reporter.ts` with picocolors for headless
- **Screen system** — TaggedEnum screens (Main, Testing, Results, etc.) with typed payloads
- **React Compiler** — no manual `useCallback`/`useMemo`/`React.memo`
- **Key deps:** ink, ink-spinner, ink-link, figures, cli-truncate, string-width, pretty-ms, ora, zustand, @tanstack/react-query

### Technology Decision: Ink 7.0.0

**Why Ink 7 over alternatives:**
| Option | Verdict |
|--------|---------|
| **Ink 7.0** | Winner. Node 22+, 2.9M weekly DL, React DX, incremental rendering, concurrent mode, `useAnimation` hook. Battle-tested by Gatsby, Prisma, Jest. |
| **OpenTUI** | Bun-only (no Node.js support yet). Not viable. |
| **Silvery** | Requires Node 23.6+. APIs still changing. Has Ink compat layer — migration path if needed later. |
| **Plain ANSI** (Vitest/Playwright pattern) | Simpler but no layout system, no component model, manual cursor math. Wrong choice for interactive features. |
| **@clack/prompts** | Perfect for prompts/wizards, not full TUIs. Will use for `skeptic init` separately. |

**Key Ink 7 features we'll use:**
- `incrementalRendering: true` — line-level diffing, only redraws changed lines (eliminates flickering)
- `alternateScreen: true` — Ink manages alternate screen buffer natively (no manual escape codes)
- `patchConsole` — redirects `console.*` calls through Ink so they don't corrupt the TUI
- `concurrent: true` — React 19 Suspense for async data
- `useAnimation({ interval })` — built-in animation hook with configurable interval in ms
- `useWindowSize` — responsive layouts that adapt to terminal width
- `<Static>` — completed test results render once and leave the reconciliation tree

### Why Not Plain ANSI (Vitest Pattern)?
Vitest and Playwright use raw `process.stdout.write()` with ANSI cursor movement. This works great for sequential test output but breaks down for:
- Flexbox layouts (parallel flow progress side-by-side)
- Component-based reuse (spinner, progress bar, shimmer as React components)
- Keyboard input handling (useInput hook vs raw stdin parsing)
- Responsive terminal width adaptation
- Watch mode with persistent UI

skeptic needs interactivity (re-run on keypress, expand/collapse flows, toggle verbose), not just pretty printing.

---

## Visual Design

### During Execution (Interactive TUI)
```
  ◆ skeptic                                           v0.1.0

  ❯ login-flow.yaml                                   1.2s
    ✓ navigate https://example.com                  (245ms)
    ✓ click "Sign In"                               (189ms)
    ⠋ type "user@••••••••••••"                             ← shimmer + spinner
    ○ assertVisible "Welcome"
    ○ screenshot

  ○ checkout-flow.yaml
  ○ profile-flow.yaml

  ━━━━━━━━━░░░░░░░░░░░░░░░░░░░░  1/3 flows  33%  •  4.2s

  v verbose  enter expand  ctrl+c abort
```

### After Completion (Results Screen)
```
  ◆ skeptic Results

  ✓ login-flow.yaml                          PASS    2.4s
  ✗ checkout-flow.yaml                       FAIL    5.1s
  │ Step 4: assertVisible "Cart Total"
  │ → Element not found: "Cart Total"
  ✓ profile-flow.yaml                        PASS    1.8s

  ────────────────────────────────────────────────────────
   Tests:  2 passed │ 1 failed │ 3 total
   Time:   9.3s

  r re-run  f re-run failed  q quit
```

### Parallel Execution (Multiple Flows Active)
```
  ◆ skeptic                                    --parallel 3

  ❯ login-flow.yaml                              3/5  1.2s
    ✓ navigate  ✓ click  ⠋ type  ○ assert  ○ screenshot

  ❯ checkout-flow.yaml                            2/4  0.8s
    ✓ navigate  ⠋ click  ○ fill  ○ assert

  ❯ profile-flow.yaml                             1/3  0.3s
    ⠋ navigate  ○ click  ○ assert

  ○ settings-flow.yaml                          (queued)
  ○ signup-flow.yaml                            (queued)

  ━━━━━━━━━━━━━░░░░░░░░░░░░░░░░  0/5 flows   0%  •  1.2s

  v verbose  enter expand  ctrl+c abort
```

### Watch Mode
```
  ◆ skeptic Watch

  ✓ login-flow.yaml                          PASS    2.4s
  ✗ checkout-flow.yaml                       FAIL    5.1s
  ✓ profile-flow.yaml                        PASS    1.8s

  ────────────────────────────────────────────────────────
   Tests:  2 passed │ 1 failed │ 3 total
   Time:   9.3s

   Watching for changes...  ⠋

  r re-run  f re-run failed  q quit
```

---

## Architecture

### Core Principle: Stateless Renderer

Following Expect's proven pattern, the TUI is a **stateless renderer of execution state**. All business logic stays in the executor. The TUI just renders whatever state is emitted through the reporter interface.

```
┌─────────────────────────────────────────────────────┐
│                   test.ts command                    │
│                                                     │
│  ┌──────────┐     ┌──────────────┐                  │
│  │ Executor │────▶│ InkReporter  │──┐               │
│  │ (engine) │     │ (bridge)     │  │               │
│  └──────────┘     └──────────────┘  │               │
│                                     ▼               │
│                          ┌──────────────────┐       │
│                          │  Sync Store       │       │
│                          │  (state channel)  │       │
│                          └────────┬─────────┘       │
│                                   │                  │
│                    ┌──────────────┼──────────────┐   │
│                    ▼              ▼              ▼   │
│              ┌─────────┐  ┌───────────┐  ┌────────┐ │
│              │ RunScreen│  │ResultsScr │  │WatchScr│ │
│              │ (Ink)    │  │ (Ink)     │  │ (Ink)  │ │
│              └─────────┘  └───────────┘  └────────┘ │
│                    │              │              │   │
│                    └──────────────┼──────────────┘   │
│                                   ▼                  │
│                          ┌──────────────────┐       │
│                          │ Ink render()      │       │
│                          │ (alt screen)      │       │
│                          └──────────────────┘       │
└─────────────────────────────────────────────────────┘
```

### Live Step Progress (Critical Architecture Change)

**Problem:** The current `Reporter` interface only fires `onStepComplete` AFTER `engine.runFlow()` finishes the entire flow (see `test.ts:174-178`). The TUI needs real-time step-by-step progress during execution.

**Solution:** Add a `StepProgressCallback` to `PlaywrightEngine.runFlow()` that fires events DURING execution:

```typescript
// New callback type for live step progress
export type StepProgressCallback = (event: StepProgressEvent) => void;

export type StepProgressEvent =
  | { type: "step:start"; index: number; total: number; command: string; args: unknown }
  | { type: "step:complete"; index: number; total: number; result: StepResult };
```

**File: `cli/src/executor/playwright-engine.ts`** — Modify `runFlow()` signature:
```typescript
async runFlow(input: FlowInput, onProgress?: StepProgressCallback): Promise<FlowResult> {
  // ... existing setup ...

  for (let i = 0; i < input.steps.length; i++) {
    const step = input.steps[i]!;

    // NEW: emit step:start BEFORE execution
    onProgress?.({ type: "step:start", index: i, total: input.steps.length, command: step.command, args: step.args });

    // ... existing handler execution ...
    const result = await handler(page, ctx, step.args);

    // NEW: emit step:complete AFTER execution
    onProgress?.({ type: "step:complete", index: i, total: input.steps.length, result });

    steps.push(result);
    // ... existing break-on-failure logic ...
  }
}
```

This is backward-compatible — `onProgress` is optional. Existing callers pass nothing and behavior is unchanged.

### Extended Reporter Interface

**File: `cli/src/reporter/types.ts`** — Updated interface with `FlowIdentifier` carried through all callbacks:

```typescript
export interface FlowIdentifier {
  name: string;
  file: string;
  flowIndex: number;  // stable unique integer from filtered array position
}

export interface Reporter {
  onRunStart?(manifest: { flows: Array<{ name: string; file: string; stepCount: number }>; totalFlows: number }): void;
  onStepStart?(step: { command: string; args: unknown }, index: number, total: number, flow: FlowIdentifier): void;
  onFlowStart(flow: FlowIdentifier): void;
  onStepComplete(step: StepResult, index: number, total: number, flow: FlowIdentifier): void;
  onFlowComplete(result: FlowResult, flow: FlowIdentifier): void;
  onRunComplete(summary: RunSummary): void;
}
```

`onRunStart`/`onStepStart` are optional. All flow-identifying callbacks carry `FlowIdentifier` for parallel-safe identification. Existing reporters need minor signature updates.

### State Flow (keyed by flowIndex, not name)

```typescript
// Events emitted by InkReporter
export type TUIEvent =
  | { type: "run:manifest"; flows: Array<{ name: string; file: string; stepCount: number }> }
  | { type: "flow:start"; flowIndex: number; flow: { name: string; file: string } }
  | { type: "step:start"; flowIndex: number; stepIndex: number; total: number; command: string; args: unknown }
  | { type: "step:complete"; flowIndex: number; step: StepResult; index: number; total: number }
  | { type: "flow:complete"; flowIndex: number; result: FlowResult }
  | { type: "run:complete"; summary: RunSummary };

// React state — flows keyed by flowIndex (unique integer), NOT flow name
interface TUIState {
  phase: "running" | "complete";
  flows: FlowState[];  // ordered by flowIndex
  startTime: number;
  summary: RunSummary | null;
  expandedFlowIndex: number | null;
  verbose: boolean;
}

interface FlowState {
  flowIndex: number;
  name: string;
  file: string;
  phase: "queued" | "running" | "passed" | "failed" | "error";
  steps: StepState[];
  activeStepIndex: number;
  stepCount: number;
  startTime: number;
  duration_ms: number;
}

interface StepState {
  command: string;
  args: unknown;
  phase: "pending" | "running" | "passed" | "failed" | "error" | "skipped";
  duration_ms: number;
  error?: string;
  screenshot?: string;
}
```

### Mode Detection (reusing existing `detectCI()`)

```typescript
// In test.ts — uses existing detectCI() from cli/src/utils/ci-detect.ts
import { detectCI } from "../utils/ci-detect.js";

const ciInfo = detectCI(); // already called at line 53
const useInteractiveTUI = ciInfo.isInteractive && !opts.noTui && !hasExplicitReporter;
```

`detectCI()` already checks 15 CI providers, 5 agent environments, AND `process.stdin.isTTY`. No need for raw `process.env.CI` checks or the `is-in-ci` package.

---

## File Structure

```
cli/src/
  ui/                              # NEW — Ink TUI layer
    render.tsx                     # Ink render() entry, uses built-in alternateScreen
    app.tsx                        # Root component with screen router
    theme.ts                       # Color tokens, figures, semantic styling
    types.ts                       # TUIEvent, TUIState, FlowState, StepState

    screens/
      run-screen.tsx               # Live test execution (main screen)
      results-screen.tsx           # Post-run summary with actions
      watch-screen.tsx             # Watch mode: results + "watching..." indicator

    components/
      header.tsx                   # ◆ skeptic branding + version + flags
      flow-list.tsx                # Scrollable list of all flows
      flow-progress.tsx            # Single flow with inline step status
      step-line.tsx                # One step: icon + command + args + duration
      step-line-compact.tsx        # Compact step view for parallel mode
      summary-bar.tsx              # Bottom: progress bar + counts + elapsed
      hint-bar.tsx                 # Keyboard shortcut hints
      spinner.tsx                  # Themed ink-spinner wrapper
      text-shimmer.tsx             # Per-character color sweep animation
      progress-bar.tsx             # ━━━━━━░░░░░░ block-char progress bar
      error-panel.tsx              # Expanded error message + screenshot path

    hooks/
      use-test-events.ts           # Subscribe to InkReporter useSyncExternalStore → React state
      use-elapsed.ts               # 1s interval elapsed time counter
      use-scrollable.ts            # Viewport window over long lists

  executor/
    playwright-engine.ts           # MODIFIED — add StepProgressCallback param
    types.ts                       # MODIFIED — add StepProgressCallback, StepProgressEvent

  reporter/
    ink-reporter.ts                # NEW — Reporter → useSyncExternalStore bridge
    console-reporter.ts            # EXISTING — unchanged
    json-reporter.ts               # EXISTING — unchanged
    junit-reporter.ts              # EXISTING — unchanged
    html-reporter.ts               # EXISTING — unchanged
    types.ts                       # MODIFIED — add onRunStart?, onStepStart? to Reporter

  commands/
    test.ts                        # MODIFIED — mode detection, InkReporter wiring, executeFlows()
  index.ts                         # MODIFIED — --no-tui flag
```

---

## Implementation Plan

### Phase 1: Engine + Reporter Foundation

#### 1.1 Dependencies

**File: `cli/package.json`** — Add to dependencies:
```json
{
  "ink": "^7.0.0",
  "react": "^19.2.0",
  "ink-spinner": "^5.0.0",
  "figures": "^6.1.0",
  "cli-truncate": "^5.0.0",
  "string-width": "^8.0.0",
  "pretty-ms": "^9.0.0"
}
```

Add to devDependencies:
```json
{
  "@types/react": "^19.2.0",
  "ink-testing-library": "^4.0.0"
}
```

Bump engine: `"engines": { "node": ">=22" }`

Note: `chalk` already a dependency (v5.4.1). `is-in-ci` NOT needed — reuse existing `detectCI()` from `cli/src/utils/ci-detect.ts`.

#### 1.2 TSConfig Updates

**File: `cli/tsconfig.json`** — Two changes:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react"
  },
  "include": ["bin/**/*.ts", "src/**/*.ts", "src/**/*.tsx"]
}
```

Both `jsx` for JSX transform AND `.tsx` in include (current include only has `*.ts`).

#### 1.3 StepProgressCallback (Engine Modification)

**File: `cli/src/executor/types.ts`** — Add:
```typescript
export type StepProgressEvent =
  | { type: "step:start"; index: number; total: number; command: string; args: unknown }
  | { type: "step:complete"; index: number; total: number; result: StepResult };

export type StepProgressCallback = (event: StepProgressEvent) => void;
```

**File: `cli/src/executor/playwright-engine.ts`** — Modify `runFlow()`:

The callback must handle ALL terminal paths correctly. The engine has 4 distinct step outcomes:
1. **Skipped** (when condition = false, line 132) — no handler called
2. **Error** (unknown command, line 148) — no handler called
3. **Optional failure** (optional flag, line 174) — handler called, result downgraded
4. **Normal** (pass or fail, line 166) — handler called, may attach screenshot

```typescript
async runFlow(input: FlowInput, onProgress?: StepProgressCallback): Promise<FlowResult> {
  // ... existing setup ...

  for (let i = 0; i < input.steps.length; i++) {
    const step = input.steps[i]!;
    const { options } = step;

    // Check when condition — skip WITHOUT emitting step:start
    if (options?.when) {
      const shouldRun = await evaluateCondition(options.when, page, ctx);
      if (!shouldRun) {
        const skipped: StepResult = { command: step.command, args: step.args, status: "skipped", duration_ms: 0 };
        onProgress?.({ type: "step:complete", index: i, total: input.steps.length, result: skipped });
        steps.push(skipped);
        continue;
      }
    }

    const handler = stepHandlers[step.command];
    if (!handler) {
      const errorResult: StepResult = { command: step.command, args: step.args, status: "error", duration_ms: 0, error: `Unknown command: "${step.command}"` };
      onProgress?.({ type: "step:complete", index: i, total: input.steps.length, result: errorResult });
      steps.push(errorResult);
      flowStatus = "error";
      break;
    }

    // Emit step:start ONLY when we're about to call handler()
    onProgress?.({ type: "step:start", index: i, total: input.steps.length, command: step.command, args: step.args });

    // ... existing timeout setup ...
    const result = await handler(page, ctx, step.args);
    // ... existing timeout restore ...

    // Handle optional flag (downgrade failure)
    if (options?.optional && (result.status === "failed" || result.status === "error")) {
      result.status = "passed";
      result.error = `[optional] ${result.error ?? "step failed"}`;
    }

    // Attach screenshot on failure (BEFORE emitting step:complete)
    if ((result.status === "failed" || result.status === "error") && this.options.screenshotOnFailure) {
      // ... existing screenshot capture logic ...
    }

    // Emit step:complete with FINAL post-processed result
    onProgress?.({ type: "step:complete", index: i, total: input.steps.length, result });
    steps.push(result);

    if (result.status === "failed" || result.status === "error") {
      flowStatus = result.status;
      break;
    }
  }
}
```

Key: `step:start` fires ONLY when handler will execute. `step:complete` fires for EVERY terminal path (skip, error, optional, normal) with the FINAL result including screenshot paths and optional downgrades. Backward-compatible: `onProgress` is optional, existing callers unaffected.

#### 1.4 Extended Reporter Interface

See Phase 1.4 in Implementation Plan below for the full updated `Reporter` interface with `FlowIdentifier` type.

#### 1.5 Test Command Refactor

**File: `cli/src/commands/test.ts`** — Three changes:

1. **Extract `executeFlows()`** — move the execution loop into a reusable function. Each reporter callback carries a `FlowIdentifier` with `flowIndex` from the filtered array position:
```typescript
async function executeFlows(
  engine: PlaywrightEngine,
  flows: ResolvedFlow[],
  reporters: Reporter[],
  opts: { concurrency: number; maxRetries: number; shouldBail: boolean; baseUrl?: string; env: Record<string, string> },
): Promise<FlowResult[]> {
  // Emit run manifest
  const manifest = flows.map((f, i) => ({ name: f.metadata.name, file: f.filePath, stepCount: f.steps.length }));
  for (const r of reporters) r.onRunStart?.({ flows: manifest, totalFlows: flows.length });

  // ... existing sequential/parallel execution loop ...
  // flowId carries flowIndex for parallel-safe identification:
  const flowId: FlowIdentifier = { name: input.name, file: input.file, flowIndex: fi };

  // Passes onProgress callback to engine.runFlow():
  const onProgress: StepProgressCallback = (event) => {
    if (event.type === "step:start") {
      for (const r of reporters) r.onStepStart?.({ command: event.command, args: event.args }, event.index, event.total, flowId);
    }
    // step:complete also dispatches via onStepComplete with flowId
  };
  let result = await engine.runFlow(input, onProgress);

  // Pass flowId to onFlowComplete for parallel correctness
  for (const r of reporters) r.onFlowComplete(result, flowId);
}
```

2. **Mode detection** using existing `detectCI()` and the RESOLVED reporter list (not just CLI flags):
```typescript
// Resolve reporters FIRST from CLI flags OR config (same as existing line 115)
const reporterFormats = opts.reporter ?? config.output.reporters;
const hasExplicitNonConsoleReporter = reporterFormats.some(r => r !== "console");
const useInteractiveTUI = ciInfo.isInteractive && !opts.noTui && !hasExplicitNonConsoleReporter;
```

This ensures a project configured for `reporters: [json]` in `skeptic.config.yaml` doesn't unexpectedly enter TUI mode.

3. **TUI wiring** when interactive:
```typescript
if (useInteractiveTUI) {
  const { InkReporter } = await import("../reporter/ink-reporter.js");
  const { renderTUI } = await import("../ui/render.js");
  const inkReporter = new InkReporter();
  reporters.push(inkReporter);

  // Render TUI (uses Ink's built-in alternateScreen)
  const tui = await renderTUI(inkReporter, {
    watch: !!opts.watch,
    onRerun: () => executeFlows(engine, filtered, reporters, execOpts),
    onRerunFailed: () => executeFlows(engine, failedFlows, reporters, execOpts),
    onAbort: async () => { await engine.close(); tui.unmount(); process.exit(130); },
    onQuit: async () => { if (watcher) await watcher.close(); await engine.close(); tui.unmount(); process.exit(process.exitCode ?? 0); },
  });

  // ... execution ...
  await tui.waitUntilExit();
} else {
  reporters.push(new ConsoleReporter({ verbose: opts.verbose, concurrency }));
}
```

Lazy-imports `ink-reporter.ts` and `render.tsx` only when TUI is active — avoids loading React/Ink in CI.

#### 1.6 CLI Flag

**File: `cli/src/index.ts`** — Add:
```typescript
.option("--no-tui", "disable interactive TUI, use plain text output")
```

---

### Phase 2: Theme + Types + InkReporter

#### 2.1 Theme System

**File: `cli/src/ui/theme.ts`**

```typescript
import figures from "figures";

export const colors = {
  brand:       "#ffd700",  // skeptic gold
  pass:        "#4caf50",  // Green
  fail:        "#f44336",  // Red
  warn:        "#ff9800",  // Orange
  active:      "#2196f3",  // Blue
  dim:         "#666666",  // Gray
  shimmerBase: "#555555",
  shimmerHigh: "#ffffff",
  text:        "#e0e0e0",  // Light gray
} as const;

export const icons = {
  pass:    figures.tick,
  fail:    figures.cross,
  running: figures.pointer,
  pending: figures.circle,
  queued:  figures.ellipsis,
  brand:   figures.lozenge,
} as const;
```

Respects `NO_COLOR` via Ink's built-in support (Ink disables colors when `NO_COLOR` is set).

#### 2.2 TUI State Types

**File: `cli/src/ui/types.ts`** — As specified in Architecture section above. Key detail: flows keyed by `flowIndex` (integer), not name.

#### 2.3 InkReporter (Synchronous Store, Not Raw EventEmitter)

**File: `cli/src/reporter/ink-reporter.ts`**

**Critical**: Uses a synchronous external store pattern (NOT raw EventEmitter + useEffect) to avoid race conditions. Events can fire before React subscribes — if `executeFlows()` starts immediately after `renderTUI()`, `onRunStart`/`onFlowStart` could fire before `useEffect` attaches the listener.

```typescript
import type { Reporter } from "./types.js";
import type { TUIState, TUIEvent } from "../ui/types.js";

export class InkReporter implements Reporter {
  private state: TUIState = initialState;
  private listeners = new Set<() => void>();

  // Synchronous state update — no event loss possible
  private dispatch(event: TUIEvent): void {
    this.state = tuiReducer(this.state, event);
    for (const listener of this.listeners) listener();
  }

  // useSyncExternalStore interface
  getSnapshot = (): TUIState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  // Reporter interface — flowIndex comes FROM the caller (test.ts), not from internal counter
  onRunStart(manifest) { this.dispatch({ type: "run:manifest", flows: manifest.flows }); }
  onFlowStart(flow) { this.dispatch({ type: "flow:start", flowIndex: flow.flowIndex, flow }); }
  onStepStart(step, index, total, flow) { this.dispatch({ type: "step:start", flowIndex: flow.flowIndex, stepIndex: index, total, command: step.command, args: step.args }); }
  onStepComplete(step, index, total, flow) { this.dispatch({ type: "step:complete", flowIndex: flow.flowIndex, step, index, total }); }
  onFlowComplete(result, flow) { this.dispatch({ type: "flow:complete", flowIndex: flow.flowIndex, result }); }
  onRunComplete(summary) { this.dispatch({ type: "run:complete", summary }); }
}
```

#### 2.4 useTestEvents Hook

**File: `cli/src/ui/hooks/use-test-events.ts`** — Uses `useSyncExternalStore` (React 18+) instead of `useReducer + useEffect`. No race condition — state is always current:

```typescript
import { useSyncExternalStore } from "react";
import type { InkReporter } from "../../reporter/ink-reporter.js";

export const useTestEvents = (reporter: InkReporter): TUIState => {
  return useSyncExternalStore(reporter.subscribe, reporter.getSnapshot);
};
```

Reducer state transitions (inside `InkReporter.dispatch`):
- `run:manifest` → populate `flows[]` with `phase: "queued"`
- `flow:start` → set flow `phase: "running"`, record `startTime`
- `step:start` → update `flow.steps[index].phase = "running"`, set `activeStepIndex`
- `step:complete` → update `flow.steps[index]` with final result
- `flow:complete` → set flow `phase` from result status, set `duration_ms`
- `run:complete` → set `phase: "complete"`, store summary

---

### Phase 3: Core Components

#### 3.1 Ink Entry Point

**File: `cli/src/ui/render.tsx`** — Uses Ink's built-in render options (no manual escape codes, no standalone function imports):
```tsx
import { render } from "ink";

export const renderTUI = async (reporter: InkReporter, opts) => {
  const instance = render(<App reporter={reporter} {...opts} />, {
    exitOnCtrlC: false,          // we handle Ctrl+C ourselves via useInput (raw mode captures it as keyboard input)
    alternateScreen: true,       // Ink manages alt screen buffer natively
    patchConsole: true,          // redirect console.* through Ink (render option, NOT a standalone function)
    incrementalRendering: true,  // only redraws changed lines
  });

  return { waitUntilExit: () => instance.waitUntilExit(), unmount: () => instance.unmount() };
};
```

Note: `patchConsole` is a render option in Ink 7, NOT a standalone exported function. This means `logger.info()` calls from file reporters (json, junit, html — they each log "Report written to X" after writing) will render above the Ink UI via Ink's console patching. This is acceptable — it's informational output the user expects to see.

#### 3.2 StepLine

**File: `cli/src/ui/components/step-line.tsx`**

Renders one step based on `StepState.phase`:
- `"running"` → `<Spinner />` + `<TextShimmer text={command + " " + maskedArgs} />`
- `"passed"` → green `✓` + command + truncated args + dim `(245ms)`
- `"failed"` → red `✗` + command + error on next line
- `"pending"` → dim `○` + dim command
- `"skipped"` → dim `→` + dim command + `[skipped]`

**Security masking:** When `command === "type"` and args suggest a password field (selector contains `password`, `secret`, `token`), mask the value as `••••••••` in both normal and verbose mode.

#### 3.3 FlowProgress

**File: `cli/src/ui/components/flow-progress.tsx`** — Two display modes:
- **Expanded**: show all steps vertically (default for sequential or focused flow)
- **Compact**: show step icons inline `✓ ✓ ⠋ ○ ○` (for parallel mode with many flows)

#### 3.4 TextShimmer

**File: `cli/src/ui/components/text-shimmer.tsx`**

Per-character color sweep animation using Ink 7's `useAnimation`:
```tsx
const TextShimmer = ({ text, speed = 1 }) => {
  const { frame } = useAnimation({ interval: 50 }); // 20fps via interval in ms
  const position = (frame * speed) % (text.length + GRADIENT_WIDTH * 2) - GRADIENT_WIDTH;
  // ... per-character color interpolation ...
};
```

Note: `useAnimation` uses `interval` (milliseconds), not `fps`.

#### 3.5 Other Components
- **header.tsx** — `◆ skeptic` + version + flags indicator
- **spinner.tsx** — Themed `ink-spinner` wrapper
- **progress-bar.tsx** — `━━━━━━░░░░░░` block-character progress
- **summary-bar.tsx** — Progress bar + counts + elapsed (running) or totals (complete)
- **hint-bar.tsx** — Keyboard shortcut hints, context-dependent
- **error-panel.tsx** — Red-bordered error details with screenshot path
- **flow-list.tsx** — Scrollable list container using `useScrollable` hook

---

### Phase 4: Screens

#### 4.1 RunScreen

**File: `cli/src/ui/screens/run-screen.tsx`**

Layout uses `<Static>` for completed flows (critical perf optimization — rendered once, removed from React tree):

```tsx
<Box flexDirection="column">
  <Header />
  <Box flexDirection="column" flexGrow={1} paddingX={2}>
    <Static items={completedFlows}>
      {flow => <FlowProgress key={flow.flowIndex} flow={flow} compact={isParallel} />}
    </Static>
    {activeAndPendingFlows.map(flow =>
      <FlowProgress key={flow.flowIndex} flow={flow} compact={isParallel} />
    )}
  </Box>
  <SummaryBar phase="running" ... />
  <HintBar context="running" />
</Box>
```

Keyboard handlers (via `useInput`):
- `v` → toggle verbose mode
- `Enter` → expand/collapse focused flow
- `↑`/`↓` → navigate flow list
- `Ctrl+C` → handled via `useInput` hook (see abort handling below)

**No `q` on running screen.** `useApp().exit()` only unmounts the React tree — it doesn't cancel the Playwright run. Without AbortController (deferred to Phase 2), `q` during execution would leave Playwright running in the background with no UI.

**Ctrl+C handling:** When Ink puts stdin in raw mode, `Ctrl+C` is NOT delivered as SIGINT — it's captured as keyboard input. `process.on("SIGINT")` will NOT fire. Therefore we disable `exitOnCtrlC` and handle Ctrl+C ourselves:

1. **`test.ts`** passes an `onAbort` callback to the TUI:
```typescript
const tui = await renderTUI(inkReporter, {
  onAbort: async () => {
    await engine.close();   // close Playwright browser
    tui.unmount();          // unmount Ink, restore terminal
    process.exit(130);      // standard SIGINT exit code
  },
  // ...
});
```

2. **`render.tsx`** disables `exitOnCtrlC`:
```typescript
const instance = render(<App {...opts} />, {
  exitOnCtrlC: false,       // we handle Ctrl+C ourselves
  alternateScreen: true,
  patchConsole: true,
  incrementalRendering: true,
});
```

3. **`app.tsx`** handles Ctrl+C via `useInput`:
```tsx
useInput((input, key) => {
  if (key.ctrl && input === "c") {
    opts.onAbort();  // calls engine.close() + unmount + process.exit(130)
  }
});
```

This ensures Ctrl+C during execution: (1) closes the browser, (2) restores the terminal from alt screen, (3) exits with code 130. Works correctly in raw mode because we handle the keyboard event directly, not via SIGINT.

#### 4.2 ResultsScreen

**File: `cli/src/ui/screens/results-screen.tsx`** — All flows with final status, auto-expands failures.

Keyboard handlers:
- `r` → invoke `onRerun` callback (re-runs `executeFlows()`)
- `f` → invoke `onRerunFailed` callback
- `q` → invoke `onQuit` callback (see quit handling below)

**Quit handling (`q`):** Both ResultsScreen and WatchScreen receive an `onQuit` callback from `test.ts`:

```typescript
// In test.ts:
const tui = await renderTUI(inkReporter, {
  onQuit: async () => {
    if (watcher) await watcher.close();  // tear down chokidar (watch mode)
    await engine.close();                 // close Playwright browser
    tui.unmount();                        // unmount Ink, restore terminal
    process.exit(process.exitCode ?? 0);  // exit with test result code
  },
  onAbort: async () => { /* ... Ctrl+C handler ... */ },
  onRerun: () => executeFlows(engine, filtered, reporters, execOpts),
  onRerunFailed: () => executeFlows(engine, failedFlows, reporters, execOpts),
});
```

This ensures `q` on results/watch screens: (1) closes chokidar if watching, (2) closes browser, (3) restores terminal, (4) exits with the correct code. Without this, the chokidar watcher keeps the process alive indefinitely (current watch mode parks at `await new Promise(() => {})`).

#### 4.3 WatchScreen

**File: `cli/src/ui/screens/watch-screen.tsx`** — Extends ResultsScreen with "Watching for changes... ⠋" spinner. On chokidar file change, resets state and re-executes.

#### 4.4 App (Screen Router)

**File: `cli/src/ui/app.tsx`**

```tsx
const App = ({ reporter, watch, onRerun, onRerunFailed, onQuit, onAbort }) => {
  const state = useTestEvents(reporter);

  // Ctrl+C abort during execution (raw mode, handled via useInput)
  useInput((input, key) => {
    if (key.ctrl && input === "c") onAbort();
  });

  if (state.phase === "running") {
    return <RunScreen state={state} />;
  }
  if (watch) {
    return <WatchScreen state={state} onRerun={onRerun} onRerunFailed={onRerunFailed} onQuit={onQuit} />;
  }
  return <ResultsScreen state={state} onRerun={onRerun} onRerunFailed={onRerunFailed} onQuit={onQuit} />;
};
```

---

### Phase 5: Polish & Performance

#### 5.1 Performance
1. **Incremental rendering** via `incrementalRendering: true` (Ink 7 built-in)
2. **`<Static>`** for completed flows — renders once, exits React tree
3. **Batch state updates**: `React.startTransition` for non-urgent updates from rapid step events
4. **Lazy imports**: `import("../ui/render.js")` only when TUI is active — CI never loads React/Ink
5. **TextShimmer only on active step** — not rendered for pending/completed steps

#### 5.2 Output Channel Discipline
- **TUI mode**: All progress → Ink rendering. `patchConsole: true` (render option) redirects stray `console.*` through Ink, rendering them above the TUI.
- **Logger calls in test.ts**: `logger.info/warn` calls (e.g., "skeptic v0.1.0 — N flows", "Bail: stopping...") go through `patchConsole` and render above the TUI. Acceptable for informational messages.
- **File reporters**: `JsonReporter`, `JUnitReporter`, `HtmlReporter` write to files AND call `logger.info("Report written to X")`. The `logger.info` calls go through `patchConsole` and render above TUI. This is correct behavior — users should see where reports were saved.
- **Non-TUI mode**: All output goes through existing `ConsoleReporter` + `logger` as before. No change.

#### 5.3 Edge Cases
1. **Piped output** (`!isTTY`): Skip TUI, use ConsoleReporter
2. **Narrow terminal** (<60 cols): Auto-compact mode via `useWindowSize`, no args display
3. **Many flows** (> terminal height): Viewport scrolling with `useScrollable` hook
4. **Long flow names**: Truncate with `cli-truncate` to fit available width
5. **No Unicode**: `figures` auto-falls back to ASCII (`✓` → `√`)
6. **`NO_COLOR`**: Ink handles this natively
7. **Explicit `--reporter json/junit/html`**: Disable TUI, use ConsoleReporter
8. **TUI render crash**: Catch, unmount, fall back to ConsoleReporter

#### 5.4 Security: Arg Masking in Verbose Mode
The `type` step handler args may contain passwords. In `step-line.tsx`, mask values when:
- Selector matches patterns: `password`, `secret`, `token`, `api-key`, `type="password"`
- Always mask in verbose mode too — "verbose" means "show step commands", not "dump secrets"

---

## New Dependencies

| Package | Version | Size | Purpose | Location |
|---------|---------|------|---------|----------|
| `ink` | ^7.0.0 | ~150KB | React renderer for terminal | dependencies |
| `react` | ^19.2.0 | ~140KB | Component model, hooks | dependencies |
| `ink-spinner` | ^5.0.0 | ~2KB | Animated loading spinners | dependencies |
| `figures` | ^6.1.0 | ~3KB | Unicode symbols with ASCII fallback | dependencies |
| `cli-truncate` | ^5.0.0 | ~2KB | Smart string truncation | dependencies |
| `string-width` | ^8.0.0 | ~3KB | Visual string width (CJK/emoji) | dependencies |
| `pretty-ms` | ^9.0.0 | ~2KB | Human-readable durations | dependencies |
| `@types/react` | ^19.2.0 | — | TypeScript types | devDependencies |
| `ink-testing-library` | ^4.0.0 | — | Component testing | devDependencies |

Total: ~300KB runtime (mostly React + Ink). No `is-in-ci` — reuse existing `detectCI()`.

---

## Files Summary

### Modified (Existing) — 10 files

| File | Change |
|------|--------|
| `cli/package.json` | Add deps, bump engine to `>=22` |
| `cli/tsconfig.json` | Add `jsx`, `jsxImportSource`, `.tsx` in include |
| `cli/src/index.ts` | Add `--no-tui` flag |
| `cli/src/commands/test.ts` | Mode detection via `detectCI()`, `executeFlows()` extraction, InkReporter wiring, lazy imports, pass `FlowIdentifier` to all reporter calls |
| `cli/src/executor/playwright-engine.ts` | Add optional `StepProgressCallback` param to `runFlow()`, correct event placement for all terminal paths |
| `cli/src/reporter/types.ts` | Add `FlowIdentifier` type, add `onRunStart?`/`onStepStart?`, update `onFlowStart`/`onStepComplete`/`onFlowComplete` signatures |
| `cli/src/reporter/console-reporter.ts` | Update to accept `FlowIdentifier` on `onFlowStart`/`onStepComplete`/`onFlowComplete` (ignores `flowIndex`) |
| `cli/src/reporter/json-reporter.ts` | Update to accept `FlowIdentifier` on `onFlowComplete` |
| `cli/src/reporter/junit-reporter.ts` | Update to accept `FlowIdentifier` on `onFlowComplete` |
| `cli/src/reporter/html-reporter.ts` | Update to accept `FlowIdentifier` on `onFlowComplete` |

### Created (New) — 22 files

| File | Purpose |
|------|---------|
| `cli/src/ui/render.tsx` | Ink entry, `alternateScreen`, `patchConsole`, `incrementalRendering` |
| `cli/src/ui/app.tsx` | Root component, screen router |
| `cli/src/ui/theme.ts` | Colors, icons, styling constants |
| `cli/src/ui/types.ts` | TUIEvent, TUIState, FlowState, StepState |
| `cli/src/ui/screens/run-screen.tsx` | Live execution view with `<Static>` |
| `cli/src/ui/screens/results-screen.tsx` | Post-run results with keyboard actions |
| `cli/src/ui/screens/watch-screen.tsx` | Watch mode UI |
| `cli/src/ui/components/header.tsx` | Top bar |
| `cli/src/ui/components/flow-list.tsx` | Scrollable flow list |
| `cli/src/ui/components/flow-progress.tsx` | Single flow with steps (expanded + compact) |
| `cli/src/ui/components/step-line.tsx` | Step status line with arg masking |
| `cli/src/ui/components/step-line-compact.tsx` | Compact step view |
| `cli/src/ui/components/summary-bar.tsx` | Progress + counts |
| `cli/src/ui/components/hint-bar.tsx` | Keyboard hints |
| `cli/src/ui/components/spinner.tsx` | Themed spinner |
| `cli/src/ui/components/text-shimmer.tsx` | Shimmer animation |
| `cli/src/ui/components/progress-bar.tsx` | Block-char progress |
| `cli/src/ui/components/error-panel.tsx` | Error details |
| `cli/src/ui/hooks/use-test-events.ts` | useSyncExternalStore → React state |
| `cli/src/ui/hooks/use-elapsed.ts` | Timer hook |
| `cli/src/ui/hooks/use-scrollable.ts` | Viewport scrolling |
| `cli/src/reporter/ink-reporter.ts` | Reporter → synchronous external store bridge |

**Total: 22 new files, 10 modified files**

---

## Implementation Order

| # | Phase | Key Files | Depends On |
|---|-------|-----------|------------|
| 1 | Engine + Reporter foundation | package.json, tsconfig, playwright-engine.ts, reporter/types.ts, test.ts (`executeFlows` extraction) | — |
| 2 | Theme + Types + InkReporter | theme.ts, types.ts, ink-reporter.ts, use-test-events.ts | Phase 1 |
| 3 | Core components | header, spinner, step-line, flow-progress, progress-bar, summary-bar, hint-bar, error-panel, text-shimmer | Phase 2 |
| 4 | Screens + App | run-screen, results-screen, watch-screen, app.tsx, render.tsx | Phase 3 |
| 5 | Integration + wiring | test.ts TUI mode, index.ts --no-tui flag, lazy imports | Phase 4 |
| 6 | Polish | compact mode, scrollable, truncation, arg masking, edge cases, graceful degradation | Phase 5 |
| 7 | Tests | ink-testing-library component tests, integration tests for --no-tui / CI / piped | Phase 6 |

---

## Verification

1. **Build**: `cd cli && npm run build` — zero TypeScript errors with JSX
2. **Type check**: `npm run check` — all .tsx files included and type-safe
3. **Unit tests**: `npm test` — all existing 92 tests still pass + new TUI component tests via ink-testing-library
4. **Backward compat**: `engine.runFlow(input)` without callback — existing behavior unchanged
5. **Interactive smoke test**:
   - `node dist/bin/skeptic.js test examples/*.yaml` — TUI renders with live step progress, shimmer on active step, results screen
   - Press `v` during execution — verbose mode toggles step args
   - Press `q` on results — exits cleanly, terminal restored (no escape code artifacts)
6. **Parallel smoke test**: `skeptic test --parallel 3 examples/*.yaml` — compact mode, multiple active flows
7. **Watch mode**: `skeptic test --watch examples/*.yaml` — TUI persists, re-runs on file change
8. **CI mode**: `CI=true skeptic test examples/*.yaml` — plain ConsoleReporter output, no TUI, no React loaded
9. **Piped output**: `skeptic test examples/*.yaml | cat` — plain output, no ANSI codes
10. **`--no-tui` flag**: `skeptic test --no-tui examples/*.yaml` — plain output even in TTY
11. **NO_COLOR**: `NO_COLOR=1 skeptic test examples/*.yaml` — no colors
12. **Re-run from results**: Press `r` → execution restarts in same Ink instance
13. **Arg masking**: `type` step on `input[type=password]` — value shown as `••••••••`

## Future Enhancements (Out of v1 Scope)

- **AbortController** for mid-execution cancel (Ctrl+C graceful abort with partial results)
- **Full state machine controller** (`idle`/`running`/`aborting`/`rerunning` states)
- **Run-scoped output directories** to prevent artifact overwrite on reruns
- **AI failure analysis** integration in results screen
- **Terminal image rendering** for failure screenshots (Kitty/Sixel protocol)
- **Hyperlinks** for file paths and screenshot paths (OSC 8)
