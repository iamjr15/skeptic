import type { CollectorName } from "../observability/types.js";
import type { SkepticFixture } from "./fixture.js";

export interface TestUseOptions {
  /**
   * Base URL for the test page. Relative `page.goto('/path')` calls resolve
   * against it — the runner passes it through as Playwright's browser-context
   * `baseURL` (see `worker.ts`). Pass an absolute URL to `page.goto(...)` to
   * override it for a single navigation. CLI `--base-url` takes precedence.
   */
  url?: string;
  viewport?: { width: number; height: number };
  /**
   * Video recording resolution. When set, overrides the default of using the
   * viewport size for `recordVideo.size`. Page rendering still happens at
   * viewport dimensions; this only changes the WebM resolution. Precedence
   * is CLI `--video-size` > `test.use({ videoSize })` > viewport.
   */
  videoSize?: { width: number; height: number };
  device?: string;
  cookies?: boolean | { browser?: string };
  env?: Record<string, string>;
  tags?: string[];
  /** Declarative collector attach. `--observability` overrides this with the full set. */
  collectors?: CollectorName[];
  /** Soft per-action default timeout (Playwright `setDefaultTimeout`). */
  timeout?: number;
  /** Hard per-test ceiling enforced by the runner via Promise.race + worker.terminate(). */
  hardTimeout?: number;
  retries?: number;
}

export type TestFn = (fixture: SkepticFixture) => Promise<void> | void;
export type HookFn = (fixture: SkepticFixture) => Promise<void> | void;

export interface RegisteredTest {
  ordinal: number;
  id: string;
  name: string;
  file: string;
  fn: TestFn;
  skip: boolean;
  only: boolean;
  use: TestUseOptions;
}

export interface RegisteredHook {
  fn: HookFn;
  use: TestUseOptions;
}

/**
 * Per-file registry. The registry is module-scoped so a worker that imports
 * one spec file ends up with exactly one registry instance for the run.
 *
 * NOTE: spec files are imported twice — once by the discovery worker (manifest
 * build) and once by each execution worker that has tests from that file. The
 * runner resets the active registry between phases so ordinals stay stable.
 */
export interface FileRegistry {
  file: string;
  tests: RegisteredTest[];
  beforeEach: RegisteredHook[];
  afterEach: RegisteredHook[];
  fileUse: TestUseOptions;
}

// Shared across module instances — both the runner's bundle and the user's spec
// resolve `skeptic-cli` to potentially different file URLs (dist/index.mjs vs.
// dist/worker.mjs in production builds, dev/tests use src/ TS directly). Module-
// scoped state would split into two registries; globalThis keys it once.
const REGISTRY_KEY = "__skepticActiveRegistry__";

interface GlobalWithRegistry {
  [REGISTRY_KEY]?: FileRegistry | null;
}

const getStore = (): GlobalWithRegistry => globalThis as unknown as GlobalWithRegistry;

export const beginRegistration = (file: string): FileRegistry => {
  const registry: FileRegistry = {
    file,
    tests: [],
    beforeEach: [],
    afterEach: [],
    fileUse: {},
  };
  getStore()[REGISTRY_KEY] = registry;
  return registry;
};

export const endRegistration = (): FileRegistry | null => {
  const store = getStore();
  const registry = store[REGISTRY_KEY] ?? null;
  store[REGISTRY_KEY] = null;
  return registry;
};

const requireActive = (call: string): FileRegistry => {
  const registry = getStore()[REGISTRY_KEY];
  if (!registry) {
    throw new Error(
      `[skeptic] ${call}() called outside a spec file. ` +
        `Tests must be defined at module top level of a *.spec.ts file imported by the runner.`,
    );
  }
  return registry;
};

const buildTestFactory = (skip: boolean, only: boolean) => {
  return (name: string, fn: TestFn, useOverride?: TestUseOptions): void => {
    const registry = requireActive("test");
    const ordinal = registry.tests.length;
    const id = `${registry.file}#${ordinal}`;
    registry.tests.push({
      ordinal,
      id,
      name,
      file: registry.file,
      fn,
      skip,
      only,
      use: useOverride ?? {},
    });
  };
};

interface TestApi {
  (name: string, fn: TestFn, use?: TestUseOptions): void;
  skip: (name: string, fn: TestFn, use?: TestUseOptions) => void;
  only: (name: string, fn: TestFn, use?: TestUseOptions) => void;
  use: (options: TestUseOptions) => void;
  beforeEach: (fn: HookFn, use?: TestUseOptions) => void;
  afterEach: (fn: HookFn, use?: TestUseOptions) => void;
}

const baseTest = buildTestFactory(false, false) as TestApi;

baseTest.skip = buildTestFactory(true, false);
baseTest.only = buildTestFactory(false, true);

/**
 * File-level configuration. Calling `test.use({...})` merges into `fileUse`;
 * later calls overwrite per-key. Per-test overrides win at execution time.
 */
baseTest.use = (options: TestUseOptions): void => {
  const registry = requireActive("test.use");
  registry.fileUse = { ...registry.fileUse, ...options };
};

baseTest.beforeEach = (fn: HookFn, use?: TestUseOptions): void => {
  const registry = requireActive("test.beforeEach");
  registry.beforeEach.push({ fn, use: use ?? {} });
};

baseTest.afterEach = (fn: HookFn, use?: TestUseOptions): void => {
  const registry = requireActive("test.afterEach");
  registry.afterEach.push({ fn, use: use ?? {} });
};

export const test = baseTest;
