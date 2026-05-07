import type { RunSummary, TestIdentifier } from "../reporter/types.js";
import type { StepResult, TestArtifacts, TestResult } from "../executor/types.js";

export type TestPhase = "queued" | "running" | "passed" | "failed" | "error";
export type StepPhase = "pending" | "running" | "passed" | "failed" | "error" | "skipped";

export interface StepView {
  index: number;
  command: string;
  args: unknown;
  phase: StepPhase;
  durationMs: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  screenshot?: string;
  baselinePath?: string;
  currentPath?: string;
  diffPath?: string;
  warnings?: string[];
  diagnostics?: StepResult["diagnostics"];
}

export interface TestView {
  key: string;
  name: string;
  file: string;
  testIndex: number;
  phase: TestPhase;
  steps: StepView[];
  stepCount: number;
  activeStepIndex: number;
  startedAt?: number;
  completedAt?: number;
  durationMs: number;
  artifacts?: TestArtifacts;
  metrics?: Record<string, unknown>;
  shardId?: number;
}

export interface RunTuiSnapshot {
  version: number;
  phase: "idle" | "running" | "complete";
  startedAt: number;
  completedAt?: number;
  tests: TestView[];
  summary: RunSummary | null;
  focusedKey: string | null;
}

export interface RunManifestTest {
  name: string;
  file: string;
  stepCount: number;
  testIndex?: number;
}

const now = (): number => Date.now();

const testKey = (test: { file: string; testIndex?: number; name: string }): string =>
  `${test.file}#${test.testIndex ?? test.name}`;

const statusToTestPhase = (status: TestResult["status"]): TestPhase =>
  status === "passed" ? "passed" : status === "failed" ? "failed" : "error";

const statusToStepPhase = (status: StepResult["status"]): StepPhase => {
  switch (status) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "error":
      return "error";
    case "skipped":
      return "skipped";
  }
};

const emptyStep = (index: number): StepView => ({
  index,
  command: "",
  args: undefined,
  phase: "pending",
  durationMs: 0,
});

const applyStepResult = (step: StepView, result: StepResult): StepView => {
  step.command = result.command;
  step.args = result.args;
  step.phase = statusToStepPhase(result.status);
  step.durationMs = result.duration_ms;
  step.completedAt = now();
  step.error = result.error;
  step.screenshot = result.screenshot;
  step.baselinePath = result.baselinePath;
  step.currentPath = result.currentPath;
  step.diffPath = result.diffPath;
  step.warnings = result.warnings;
  step.diagnostics = result.diagnostics;
  return step;
};

export class RunTuiStore {
  private snapshot: RunTuiSnapshot = {
    version: 0,
    phase: "idle",
    startedAt: now(),
    tests: [],
    summary: null,
    focusedKey: null,
  };

  private readonly testsByKey = new Map<string, TestView>();
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): RunTuiSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  runStart(tests: RunManifestTest[]): void {
    this.testsByKey.clear();
    const startedAt = now();
    const views = tests.map((test, index) => {
      const testIndex = test.testIndex ?? index;
      const view: TestView = {
        key: testKey({ ...test, testIndex }),
        name: test.name,
        file: test.file,
        testIndex,
        phase: "queued",
        steps: Array.from({ length: test.stepCount }, (_unused, stepIndex) =>
          emptyStep(stepIndex),
        ),
        stepCount: test.stepCount,
        activeStepIndex: -1,
        durationMs: 0,
      };
      this.testsByKey.set(view.key, view);
      return view;
    });
    this.publish({
      phase: "running",
      startedAt,
      completedAt: undefined,
      tests: views,
      summary: null,
      focusedKey: views[0]?.key ?? null,
    });
  }

  testStart(test: TestIdentifier): void {
    const view = this.ensureTest(test);
    view.phase = "running";
    view.startedAt = now();
    this.publish({ focusedKey: view.key });
  }

  stepStart(
    test: TestIdentifier,
    step: { command: string; args: unknown },
    index: number,
    total: number,
  ): void {
    const view = this.ensureTest(test);
    view.phase = "running";
    view.stepCount = Math.max(view.stepCount, total, index + 1);
    const stepView = this.ensureStep(view, index);
    stepView.command = step.command;
    stepView.args = step.args;
    stepView.phase = "running";
    stepView.startedAt = now();
    stepView.completedAt = undefined;
    stepView.error = undefined;
    view.activeStepIndex = index;
    this.publish({ focusedKey: view.key });
  }

  stepComplete(test: TestIdentifier, result: StepResult, index: number, total: number): void {
    const view = this.ensureTest(test);
    view.stepCount = Math.max(view.stepCount, total, index + 1);
    applyStepResult(this.ensureStep(view, index), result);
    this.publish();
  }

  testComplete(result: TestResult, test: TestIdentifier): void {
    const view = this.ensureTest({
      ...test,
      name: result.name,
      file: result.file,
      testIndex: result.testIndex ?? test.testIndex,
    });
    view.phase = statusToTestPhase(result.status);
    view.durationMs = result.duration_ms;
    view.completedAt = now();
    view.artifacts = result.artifacts;
    view.metrics = result.metrics;
    view.shardId = result.shardId;
    view.stepCount = Math.max(view.stepCount, result.steps.length);
    for (let index = 0; index < result.steps.length; index++) {
      const step = result.steps[index];
      if (step) applyStepResult(this.ensureStep(view, index), step);
    }
    this.publish();
  }

  runComplete(summary: RunSummary): void {
    this.publish({
      phase: "complete",
      completedAt: now(),
      summary,
      focusedKey: this.snapshot.focusedKey ?? this.snapshot.tests[0]?.key ?? null,
    });
  }

  private ensureTest(test: TestIdentifier): TestView {
    const key = testKey(test);
    const existing = this.testsByKey.get(key);
    if (existing) {
      existing.name = test.name;
      existing.file = test.file;
      existing.testIndex = test.testIndex;
      return existing;
    }
    const view: TestView = {
      key,
      name: test.name,
      file: test.file,
      testIndex: test.testIndex,
      phase: "queued",
      steps: [],
      stepCount: 0,
      activeStepIndex: -1,
      durationMs: 0,
    };
    this.testsByKey.set(key, view);
    this.snapshot.tests.push(view);
    return view;
  }

  private ensureStep(test: TestView, index: number): StepView {
    while (test.steps.length <= index) {
      test.steps.push(emptyStep(test.steps.length));
    }
    return test.steps[index]!;
  }

  private publish(next: Partial<Omit<RunTuiSnapshot, "version">> = {}): void {
    this.snapshot = {
      ...this.snapshot,
      ...next,
      version: this.snapshot.version + 1,
    };
    for (const listener of this.listeners) listener();
  }
}
