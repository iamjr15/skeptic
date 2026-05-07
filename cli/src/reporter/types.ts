import type { StepResult, TestResult } from "../executor/types.js";

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  duration_ms: number;
  tests: TestResult[];
}

export interface TestIdentifier {
  name: string;
  file: string;
  testIndex: number;
}

export interface Reporter {
  onRunStart?(manifest: { tests: Array<{ name: string; file: string; stepCount: number; testIndex?: number }>; totalTests: number }): void;
  onStepStart?(step: { command: string; args: unknown }, index: number, total: number, test: TestIdentifier): void;
  onTestStart(test: TestIdentifier): void;
  onStepComplete(step: StepResult, index: number, total: number, test: TestIdentifier): void;
  onTestComplete(result: TestResult, test: TestIdentifier): void;
  onRunComplete(summary: RunSummary): void | Promise<void>;
}

/** Render a test's display name. Suffixes:
 *  - `[shard N]` when the test ran under `--shard-all` and `shardId` is set.
 *  - `#${ordinal}` when the same name appears multiple times in the same file
 *    (plan §4.0.1 — duplicate test names within a file are allowed; reporter
 *    output disambiguates by registration ordinal).
 *
 * The `siblings` parameter passes the full result list so the helper can detect
 * collisions; when omitted, only the shard suffix is applied. */
export const formatTestDisplayName = (
  test: { name: string; file?: string; shardId?: number; testIndex?: number },
  siblings?: ReadonlyArray<{ name: string; file?: string; testIndex?: number }>,
): string => {
  let display = test.name;
  if (siblings && test.testIndex !== undefined) {
    const collisions = siblings.filter(
      (s) => s.name === test.name && s.file === test.file,
    ).length;
    if (collisions > 1) {
      display = `${display}#${test.testIndex}`;
    }
  }
  if (test.shardId !== undefined) {
    display = `${display} [shard ${test.shardId + 1}]`;
  }
  return display;
};

export type { StepResult, TestResult };
