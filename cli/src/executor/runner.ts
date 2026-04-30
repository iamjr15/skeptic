import type { EngineOptions, TestInput, TestResult } from "./types.js";
import { PlaywrightEngine } from "./playwright-engine.js";

/**
 * Helper for callers that want a single shot at the engine without bringing
 * up the full runner (e.g. integration tests that exercise the engine API
 * directly). Real production runs go through `cli/src/runner/`.
 */
export const runTests = async (
  tests: TestInput[],
  options: EngineOptions = {},
): Promise<TestResult[]> => {
  const engine = new PlaywrightEngine(options);
  const results: TestResult[] = [];
  try {
    await engine.launch();
    for (const test of tests) {
      results.push(await engine.runTest(test));
    }
  } finally {
    await engine.close();
  }
  return results;
};

export { PlaywrightEngine };
