import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../../../src/ui/app.js";
import { InkReporter } from "../../../src/reporter/ink-reporter.js";

const tick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("run TUI rendering", () => {
  it("renders live action progress and final failure details", async () => {
    const reporter = new InkReporter();
    const app = render(
      <App reporter={reporter} onAbort={() => undefined} onQuit={() => undefined} />,
    );
    const test = { name: "login smoke", file: "/repo/tests/login.spec.ts", testIndex: 0 };

    reporter.onRunStart({
      tests: [{ ...test, stepCount: 0 }],
      totalTests: 1,
    });
    reporter.onTestStart(test);
    reporter.onStepStart({ command: "screenshot", args: {} }, 0, 1, test);
    await tick();

    expect(app.lastFrame()).toContain("login smoke");
    expect(app.lastFrame()).toContain("screenshot");

    reporter.onStepComplete(
      {
        command: "screenshot",
        args: {},
        status: "failed",
        duration_ms: 15,
        error: "button is hidden",
      },
      0,
      1,
      test,
    );
    reporter.onTestComplete(
      {
        ...test,
        status: "failed",
        duration_ms: 20,
        steps: [
          {
            command: "screenshot",
            args: {},
            status: "failed",
            duration_ms: 15,
            error: "button is hidden",
          },
        ],
        artifacts: {},
      },
      test,
    );
    reporter.onRunComplete({
      total: 1,
      passed: 0,
      failed: 1,
      duration_ms: 20,
      tests: [],
    });
    await tick();

    const frame = app.lastFrame();
    expect(frame).toContain("Failed 1/1 tests");
    expect(frame).toContain("button is hidden");
    app.unmount();
  });
});
