import type { StepResult, TestResult } from "../executor/types.js";
import type { RunSummary } from "../reporter/types.js";

export type TUIEvent =
  | { type: "run:manifest"; flows: Array<{ name: string; file: string; stepCount: number }> }
  | { type: "flow:start"; flowIndex: number; flow: { name: string; file: string } }
  | { type: "step:start"; flowIndex: number; stepIndex: number; total: number; command: string; args: unknown }
  | { type: "step:complete"; flowIndex: number; step: StepResult; index: number; total: number }
  | { type: "flow:complete"; flowIndex: number; result: TestResult }
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

export interface FlowState {
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

export interface TUIState {
  phase: "running" | "complete";
  flows: FlowState[];
  startTime: number;
  summary: RunSummary | null;
  expandedFlowIndex: number | null;
  verbose: boolean;
}

export const initialState: TUIState = {
  phase: "running",
  flows: [],
  startTime: Date.now(),
  summary: null,
  expandedFlowIndex: null,
  verbose: false,
};

const statusToPhase = (status: "passed" | "failed" | "error"): FlowState["phase"] => status;

export const tuiReducer = (state: TUIState, event: TUIEvent): TUIState => {
  switch (event.type) {
    case "run:manifest": {
      const flows: FlowState[] = event.flows.map((f, i) => ({
        flowIndex: i,
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
      return { ...state, flows, startTime: Date.now() };
    }

    case "flow:start": {
      const flows = state.flows.map((f) =>
        f.flowIndex === event.flowIndex
          ? { ...f, phase: "running" as const, startTime: Date.now() }
          : f,
      );
      return { ...state, flows };
    }

    case "step:start": {
      const flows = state.flows.map((f) => {
        if (f.flowIndex !== event.flowIndex) return f;
        const steps = f.steps.map((s, i) =>
          i === event.stepIndex
            ? { ...s, command: event.command, args: event.args, phase: "running" as const }
            : s,
        );
        return { ...f, steps, activeStepIndex: event.stepIndex };
      });
      return { ...state, flows };
    }

    case "step:complete": {
      const flows = state.flows.map((f) => {
        if (f.flowIndex !== event.flowIndex) return f;
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
      return { ...state, flows };
    }

    case "flow:complete": {
      const flows = state.flows.map((f) =>
        f.flowIndex === event.flowIndex
          ? {
              ...f,
              phase: statusToPhase(event.result.status),
              duration_ms: event.result.duration_ms,
            }
          : f,
      );
      return { ...state, flows };
    }

    case "run:complete": {
      return { ...state, phase: "complete", summary: event.summary };
    }
  }
};
