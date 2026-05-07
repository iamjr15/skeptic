import { describe, expect, it } from "vitest";
import { RunTuiStore } from "../../../src/ui/model.js";
import type { TestIdentifier } from "../../../src/reporter/types.js";
import type { TestResult } from "../../../src/executor/types.js";

const ident = (name: string, index: number): TestIdentifier => ({
  name,
  file: "/repo/tests/example.spec.ts",
  testIndex: index,
});

describe("RunTuiStore", () => {
  it("keeps duplicate test names distinct by file and ordinal", () => {
    const store = new RunTuiStore();
    store.runStart([
      { name: "dup", file: "/repo/tests/example.spec.ts", stepCount: 0, testIndex: 0 },
      { name: "dup", file: "/repo/tests/example.spec.ts", stepCount: 0, testIndex: 1 },
    ]);

    store.testStart(ident("dup", 1));
    const snapshot = store.getSnapshot();

    expect(snapshot.tests).toHaveLength(2);
    expect(snapshot.tests[0]?.phase).toBe("queued");
    expect(snapshot.tests[1]?.phase).toBe("running");
  });

  it("tracks live action starts and reconciles final test results", () => {
    const store = new RunTuiStore();
    const test = ident("checkout smoke", 0);
    store.runStart([{ name: test.name, file: test.file, stepCount: 0, testIndex: 0 }]);
    store.testStart(test);
    store.stepStart(test, { command: "snapshot", args: {} }, 0, 1);

    expect(store.getSnapshot().tests[0]?.steps[0]?.phase).toBe("running");

    store.stepComplete(
      test,
      { command: "snapshot", args: {}, status: "passed", duration_ms: 25 },
      0,
      1,
    );
    store.testComplete(
      {
        name: test.name,
        file: test.file,
        testIndex: 0,
        status: "passed",
        duration_ms: 40,
        steps: [
          { command: "snapshot", args: {}, status: "passed", duration_ms: 25 },
          { command: "test", args: { name: test.name }, status: "passed", duration_ms: 40 },
        ],
        artifacts: { trace: "/tmp/trace.zip" },
      } satisfies TestResult,
      test,
    );

    const view = store.getSnapshot().tests[0];
    expect(view?.phase).toBe("passed");
    expect(view?.steps.map((step) => step.command)).toEqual(["snapshot", "test"]);
    expect(view?.artifacts?.trace).toBe("/tmp/trace.zip");
  });

  it("notifies subscribers once per mutation", () => {
    const store = new RunTuiStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.runStart([]);
    store.runComplete({ total: 0, passed: 0, failed: 0, duration_ms: 1, tests: [] });
    unsubscribe();
    store.runStart([]);

    expect(calls).toBe(2);
  });
});
