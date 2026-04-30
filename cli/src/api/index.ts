export { test } from "./test.js";
export { expect } from "./expect-skeptic.js";

export type {
  TestUseOptions,
  TestFn,
  HookFn,
  RegisteredTest,
  RegisteredHook,
  FileRegistry,
} from "./test.js";
export type { SkepticFixture, ActionEvent } from "./fixture.js";
export type { SnapshotTree, SnapshotOptions, ByRoleOptions } from "./snapshot.js";
export type { ScreenshotOptions, ScreenshotResult } from "./screenshot.js";
export type {
  ObservabilityFixture,
  PerfThresholds,
  NetworkAssertOpts,
  ConsoleAssertOpts,
  AxeAuditOpts,
} from "./observability.js";
export type { AiFixture, AiAssertOpts, AiDefectsOpts, AiExtractOpts } from "./ai.js";

export { buildFixture } from "./fixture.js";
export {
  beginRegistration,
  endRegistration,
} from "./test.js";
