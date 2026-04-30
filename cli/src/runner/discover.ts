import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import fastGlob from "fast-glob";
import type { TestUseOptions } from "../api/test.js";

export interface ManifestEntry {
  /** Stable id `${file}#${ordinal}` — independent of test name. */
  id: string;
  file: string;
  ordinal: number;
  name: string;
  skip: boolean;
  only: boolean;
  use: TestUseOptions;
}

export interface FileManifest {
  file: string;
  fileUse: TestUseOptions;
  hookCount: { beforeEach: number; afterEach: number };
  tests: ManifestEntry[];
  /** Set when the discovery import threw (syntax error, runtime crash at module top level). */
  error?: { message: string; stack?: string };
}

export interface DiscoverOptions {
  patterns: string | string[];
  cwd?: string;
}

/** Resolve glob patterns to absolute spec paths. */
export const resolveSpecPaths = async (
  patterns: string | string[],
  cwd: string = process.cwd(),
): Promise<string[]> => {
  const patternList = Array.isArray(patterns) ? patterns : [patterns];
  const matches = await fastGlob(patternList, {
    cwd,
    absolute: true,
    onlyFiles: true,
    dot: false,
  });
  const seen = new Set<string>();
  for (const m of matches) seen.add(resolvePath(m));
  return [...seen].sort();
};

/**
 * Resolve the worker entry. In production (after `npm run build`) the file is
 * `dist/worker.mjs`. In dev (vitest, `tsx` direct) the source is `src/runner/
 * worker.ts`; vitest's `--workspace`-style worker boot can load `.ts` files via
 * the same loader stack as the parent process. We probe `worker.mjs` first,
 * then fall back to `worker.ts` when the .mjs sibling doesn't exist.
 */
const resolveDiscoverWorkerEntry = (): URL => {
  const mjs = new URL("./worker.mjs", import.meta.url);
  try {
    if (existsSync(fileURLToPath(mjs))) return mjs;
  } catch {
    /* fall through */
  }
  return new URL("./worker.ts", import.meta.url);
};

/**
 * Discovery — for each spec path, spawn a one-shot worker that imports the spec
 * with the registry active, captures the file's manifest, then exits. We use a
 * worker (rather than a dynamic-import in the main process) so module top-level
 * crashes don't poison the runner.
 *
 * NOTE: per the plan §4.0 side-effect rule, the spec gets imported twice — once
 * here and once per execution worker. Tests authored against this contract must
 * not put browser-level side effects at module top level.
 */
export const discover = async (options: DiscoverOptions): Promise<FileManifest[]> => {
  const paths = await resolveSpecPaths(options.patterns, options.cwd);
  const manifests = await Promise.all(paths.map((file) => discoverOne(file)));
  return manifests;
};

const discoverOne = async (file: string): Promise<FileManifest> => {
  return new Promise<FileManifest>((resolve) => {
    let workerPath: URL;
    try {
      workerPath = resolveDiscoverWorkerEntry();
    } catch (err) {
      resolve({
        file,
        fileUse: {},
        hookCount: { beforeEach: 0, afterEach: 0 },
        tests: [],
        error: {
          message: err instanceof Error ? err.message : String(err),
        },
      });
      return;
    }
    const worker = new Worker(workerPath, {
      workerData: { mode: "discover", file },
      stderr: false,
      stdout: false,
    });
    let manifest: FileManifest | null = null;
    let errored: { message: string; stack?: string } | null = null;
    worker.on("message", (msg: { type: string; manifest?: FileManifest; error?: { message: string; stack?: string } }) => {
      if (msg.type === "manifest" && msg.manifest) manifest = msg.manifest;
      if (msg.type === "error" && msg.error) errored = msg.error;
    });
    worker.on("error", (err) => {
      errored = { message: err.message, stack: err.stack ?? "" };
    });
    worker.on("exit", () => {
      if (manifest) {
        resolve(manifest);
        return;
      }
      resolve({
        file,
        fileUse: {},
        hookCount: { beforeEach: 0, afterEach: 0 },
        tests: [],
        error: errored ?? { message: "discovery worker exited without manifest" },
      });
    });
  });
};

/** Resolve the entrypoint URL the worker code uses to find the runtime worker module. */
export const discoverWorkerEntryPathForTest = (): string =>
  fileURLToPath(resolveDiscoverWorkerEntry());
