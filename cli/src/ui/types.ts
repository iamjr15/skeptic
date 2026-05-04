import type { StepResult, TestResult } from "../executor/types.js";
import type { RunSummary } from "../reporter/types.js";

export type TUIEvent =
  | { type: "run:manifest"; tests: Array<{ name: string; file: string; stepCount: number }> }
  | { type: "test:start"; testIndex: number; test: { name: string; file: string } }
  | { type: "step:start"; testIndex: number; stepIndex: number; total: number; command: string; args: unknown }
  | { type: "step:complete"; testIndex: number; step: StepResult; index: number; total: number }
  | { type: "test:complete"; testIndex: number; result: TestResult }
  | { type: "run:complete"; summary: RunSummary };

export interface StepState {
  command: string;
  args: unknown;
  phase: "pending" | "running" | "passed" | "failed" | "error" | "skipped";
  duration_ms: number;
  error?: string;
  screenshot?: string;
  warnings?: string[];
}

export interface TestState {
  testIndex: number;
  name: string;
  file: string;
  phase: "queued" | "running" | "passed" | "failed" | "error";
  steps: StepState[];
  activeStepIndex: number;
  stepCount: number;
  startTime: number;
  duration_ms: number;
}

export interface TUIState {
  phase: "running" | "complete";
  tests: TestState[];
  startTime: number;
  summary: RunSummary | null;
  expandedTestIndex: number | null;
  verbose: boolean;
}

export const initialState: TUIState = {
  phase: "running",
  tests: [],
  startTime: Date.now(),
  summary: null,
  expandedTestIndex: null,
  verbose: false,
};

const statusToPhase = (status: "passed" | "failed" | "error"): TestState["phase"] => status;

export const tuiReducer = (state: TUIState, event: TUIEvent): TUIState => {
  switch (event.type) {
    case "run:manifest": {
      const tests: TestState[] = event.tests.map((f, i) => ({
        testIndex: i,
        name: f.name,
        file: f.file,
        phase: "queued",
        steps: Array.from({ length: f.stepCount }, () => ({
          command: "",
          args: undefined as unknown,
          phase: "pending" as const,
          duration_ms: 0,
        })),
        activeStepIndex: -1,
        stepCount: f.stepCount,
        startTime: 0,
        duration_ms: 0,
      }));
      return { ...state, tests, startTime: Date.now() };
    }

    case "test:start": {
      const tests = state.tests.map((f) =>
        f.testIndex === event.testIndex
          ? { ...f, phase: "running" as const, startTime: Date.now() }
          : f,
      );
      return { ...state, tests };
    }

    case "step:start": {
      const tests = state.tests.map((f) => {
        if (f.testIndex !== event.testIndex) return f;
        const steps = f.steps.map((s, i) =>
          i === event.stepIndex
            ? { ...s, command: event.command, args: event.args, phase: "running" as const }
            : s,
        );
        return { ...f, steps, activeStepIndex: event.stepIndex };
      });
      return { ...state, tests };
    }

    case "step:complete": {
      const tests = state.tests.map((f) => {
        if (f.testIndex !== event.testIndex) return f;
        const steps = f.steps.map((s, i) =>
          i === event.index
            ? {
                ...s,
                command: event.step.command,
                args: event.step.args,
                phase: (event.step.status === "passed" ? "passed"
                  : event.step.status === "skipped" ? "skipped"
                  : event.step.status === "failed" ? "failed"
                  : "error") as StepState["phase"],
                duration_ms: event.step.duration_ms,
                error: event.step.error,
                screenshot: event.step.screenshot,
                warnings: event.step.warnings,
              }
            : s,
        );
        return { ...f, steps };
      });
      return { ...state, tests };
    }

    case "test:complete": {
      const tests = state.tests.map((f) =>
        f.testIndex === event.testIndex
          ? {
              ...f,
              phase: statusToPhase(event.result.status),
              duration_ms: event.result.duration_ms,
            }
          : f,
      );
      return { ...state, tests };
    }

    case "run:complete": {
      return { ...state, phase: "complete", summary: event.summary };
    }
  }
};
