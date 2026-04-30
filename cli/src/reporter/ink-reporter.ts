import type { Reporter, TestIdentifier, RunSummary } from "./types.js";
import type { StepResult, TestResult } from "../executor/types.js";
import type { TUIState, TUIEvent } from "../ui/types.js";
import { tuiReducer, initialState } from "../ui/types.js";

export class InkReporter implements Reporter {
  private state: TUIState = { ...initialState, startTime: Date.now() };
  private listeners = new Set<() => void>();

  private dispatch(event: TUIEvent): void {
    this.state = tuiReducer(this.state, event);
    for (const listener of this.listeners) listener();
  }

  getSnapshot = (): TUIState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  onRunStart(manifest: { tests: Array<{ name: string; file: string; stepCount: number }>; totalTests: number }): void {
    // The TUI's internal dispatch keeps `flows` as the in-progress test-state array name;
    // it's a UI rendering concept, not the RunSummary key. Renaming the dispatch action's
    // payload key would touch the TUI reducer; out of B0.5 scope.
    this.dispatch({ type: "run:manifest", flows: manifest.tests });
  }

  onTestStart(flow: TestIdentifier): void {
    this.dispatch({ type: "flow:start", flowIndex: flow.testIndex, flow: { name: flow.name, file: flow.file } });
  }

  onStepStart(step: { command: string; args: unknown }, index: number, total: number, flow: TestIdentifier): void {
    this.dispatch({ type: "step:start", flowIndex: flow.testIndex, stepIndex: index, total, command: step.command, args: step.args });
  }

  onStepComplete(step: StepResult, index: number, total: number, flow: TestIdentifier): void {
    this.dispatch({ type: "step:complete", flowIndex: flow.testIndex, step, index, total });
  }

  onTestComplete(result: TestResult, flow: TestIdentifier): void {
    this.dispatch({ type: "flow:complete", flowIndex: flow.testIndex, result });
  }

  onRunComplete(summary: RunSummary): void {
    this.dispatch({ type: "run:complete", summary });
  }
}
