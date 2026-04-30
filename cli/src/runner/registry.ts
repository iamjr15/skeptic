/**
 * Re-exports of the file-scoped registry primitives so the runner has one
 * import path. The actual store lives in `cli/src/api/test.ts` because
 * `import { test } from "skeptic-cli"` registers into it.
 */
export {
  beginRegistration,
  endRegistration,
  type FileRegistry,
  type RegisteredTest,
  type RegisteredHook,
  type TestUseOptions,
} from "../api/test.js";
