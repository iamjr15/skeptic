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
    this.dispatch({ type: "run:manifest", tests: manifest.tests });
  }

  onTestStart(test: TestIdentifier): void {
    this.dispatch({ type: "test:start", testIndex: test.testIndex, test: { name: test.name, file: test.file } });
  }

  onStepStart(step: { command: string; args: unknown }, index: number, total: number, test: TestIdentifier): void {
    this.dispatch({ type: "step:start", testIndex: test.testIndex, stepIndex: index, total, command: step.command, args: step.args });
  }

  onStepComplete(step: StepResult, index: number, total: number, test: TestIdentifier): void {
    this.dispatch({ type: "step:complete", testIndex: test.testIndex, step, index, total });
  }

  onTestComplete(result: TestResult, test: TestIdentifier): void {
    this.dispatch({ type: "test:complete", testIndex: test.testIndex, result });
  }

  onRunComplete(summary: RunSummary): void {
    this.dispatch({ type: "run:complete", summary });
  }
}
