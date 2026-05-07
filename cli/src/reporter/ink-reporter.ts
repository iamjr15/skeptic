import type { Reporter, RunSummary, TestIdentifier } from "./types.js";
import type { StepResult, TestResult } from "../executor/types.js";
import { RunTuiStore, type RunTuiSnapshot } from "../ui/model.js";

export class InkReporter implements Reporter {
  private readonly store = new RunTuiStore();

  getSnapshot = (): RunTuiSnapshot => this.store.getSnapshot();

  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  onRunStart(manifest: {
    tests: Array<{ name: string; file: string; stepCount: number; testIndex?: number }>;
    totalTests: number;
  }): void {
    this.store.runStart(manifest.tests);
  }

  onTestStart(test: TestIdentifier): void {
    this.store.testStart(test);
  }

  onStepStart(
    step: { command: string; args: unknown },
    index: number,
    total: number,
    test: TestIdentifier,
  ): void {
    this.store.stepStart(test, step, index, total);
  }

  onStepComplete(
    step: StepResult,
    index: number,
    total: number,
    test: TestIdentifier,
  ): void {
    this.store.stepComplete(test, step, index, total);
  }

  onTestComplete(result: TestResult, test: TestIdentifier): void {
    this.store.testComplete(result, test);
  }

  onRunComplete(summary: RunSummary): void {
    this.store.runComplete(summary);
  }
}
