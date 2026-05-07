/**
 * Watch-mode helper. Lazy-imports chokidar so normal runs avoid the startup
 * cost when watch is not requested.
 */
export interface WatchOptions {
  patterns: string[];
  cwd?: string;
  onChange: (file: string) => void | Promise<void>;
}

export interface Watcher {
  close: () => Promise<void>;
}

export const startWatching = async (opts: WatchOptions): Promise<Watcher> => {
  const { watch } = await import("chokidar");
  const watcher = watch(opts.patterns, {
    cwd: opts.cwd ?? process.cwd(),
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  watcher.on("change", (file) => {
    void Promise.resolve(opts.onChange(file as string));
  });
  return {
    close: async () => {
      await watcher.close();
    },
  };
};
