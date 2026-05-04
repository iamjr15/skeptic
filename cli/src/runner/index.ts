import { discover, type FileManifest, type ManifestEntry } from "./discover.js";
import { executeRun, type RunnerExecuteOptions, type RunnerExecuteOutcome } from "./execute.js";
import type { Reporter } from "../reporter/types.js";
import type { WorkerStartConfig } from "./ipc.js";

export interface RunnerOptions {
  patterns: string | string[];
  cwd?: string;
  reporters: Reporter[];
  config: WorkerStartConfig;
  bail?: boolean;
  /** Tag filter — when set, only tests whose `test.use({ tags })` includes one of these run. */
  tagFilter?: string[];
  /** Name filter — when set, only tests whose registered `test(name, …)` matches one of these run.
   *  Used by MCP/ACP run_test to honor "narrow by test name" without running unrelated tests. */
  nameFilter?: string[];
  /** Sharding — `--shard-split N` + the active index `1..N`. `--shard-all` is treated as
   *  N copies of the same allowlist (each shard gets every test). */
  shardSplit?: { count: number; index: number };
  shardAll?: { count: number; index: number };
  /** When true, skip execution and return the manifest only. Wires `--list`. */
  listOnly?: boolean;
  /** Optional override of the worker entry URL — vitest tests can substitute a fake. */
  workerEntry?: URL;
  killGraceMs?: number;
}

export interface RunnerOutcome extends RunnerExecuteOutcome {
  manifests: FileManifest[];
}

export interface ListOutcome {
  manifests: FileManifest[];
}

const filterByTags = (entry: ManifestEntry, tagFilter: string[] | undefined): boolean => {
  if (!tagFilter || tagFilter.length === 0) return true;
  const tags = entry.use.tags ?? [];
  return tagFilter.some((t) => tags.includes(t));
};

const filterByName = (entry: ManifestEntry, nameFilter: string[] | undefined): boolean => {
  if (!nameFilter || nameFilter.length === 0) return true;
  return nameFilter.includes(entry.name);
};

const applyOnly = (entries: ManifestEntry[]): ManifestEntry[] => {
  const onlys = entries.filter((e) => e.only);
  return onlys.length > 0 ? onlys : entries;
};

const filterEntries = (
  entries: ManifestEntry[],
  tagFilter: string[] | undefined,
  nameFilter: string[] | undefined,
): ManifestEntry[] => {
  return applyOnly(
    entries.filter((e) => filterByTags(e, tagFilter) && filterByName(e, nameFilter)),
  );
};

const partitionByShard = (
  entries: ManifestEntry[],
  options: RunnerOptions,
): ManifestEntry[] => {
  if (options.shardSplit) {
    const { count, index } = options.shardSplit;
    if (count <= 1) return entries;
    return entries.filter((_, i) => i % count === (index - 1));
  }
  if (options.shardAll) {
    // every shard runs the full set
    return entries;
  }
  return entries;
};

const groupByFile = (entries: ManifestEntry[]): Map<string, ManifestEntry[]> => {
  const map = new Map<string, ManifestEntry[]>();
  for (const entry of entries) {
    const list = map.get(entry.file) ?? [];
    list.push(entry);
    map.set(entry.file, list);
  }
  // Stable per-file ordering: preserve registration ordinal.
  for (const list of map.values()) list.sort((a, b) => a.ordinal - b.ordinal);
  return map;
};

export const runSpecs = async (options: RunnerOptions): Promise<RunnerOutcome> => {
  const manifests = await discover({ patterns: options.patterns, cwd: options.cwd });
  const allEntries = manifests.flatMap((m) =>
    m.error
      ? [
          {
            id: `${m.file}#discovery-error`,
            file: m.file,
            ordinal: 0,
            name: `discovery error: ${m.file}`,
            skip: false,
            only: false,
            use: {},
          } as ManifestEntry,
        ]
      : m.tests,
  );
  const filtered = filterEntries(allEntries, options.tagFilter, options.nameFilter);
  const sharded = partitionByShard(filtered, options);
  const partition = groupByFile(sharded);

  const manifestMap = new Map<string, FileManifest>();
  for (const m of manifests) manifestMap.set(m.file, m);

  if (options.listOnly) {
    return {
      manifests,
      results: [],
      summary: {
        total: filtered.length,
        passed: 0,
        failed: 0,
        duration_ms: 0,
        tests: [],
      },
    };
  }

  const executeOptions: RunnerExecuteOptions = {
    config: options.config,
    reporters: options.reporters,
    partition,
    manifests: manifestMap,
    bail: options.bail ?? false,
    concurrency: options.config.parallel ?? 1,
    ...(options.workerEntry !== undefined ? { workerEntry: options.workerEntry } : {}),
    ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
  };
  const outcome = await executeRun(executeOptions);
  return { ...outcome, manifests };
};

export const listSpecs = async (
  patterns: string | string[],
  cwd?: string,
): Promise<ListOutcome> => {
  const manifests = await discover({ patterns, cwd: cwd ?? process.cwd() });
  return { manifests };
};

export type { FileManifest, ManifestEntry } from "./discover.js";
export type { RunnerExecuteOutcome } from "./execute.js";
export type { WorkerStartConfig } from "./ipc.js";
