import React from "react";
import { useInput } from "ink";
import { useTestEvents } from "./hooks/use-test-events.js";
import { RunScreen } from "./screens/run-screen.js";
import { ResultsScreen } from "./screens/results-screen.js";
import { WatchScreen } from "./screens/watch-screen.js";
import type { InkReporter } from "../reporter/ink-reporter.js";
import type { TUIOptions } from "./render.js";

interface AppProps extends TUIOptions {
  reporter: InkReporter;
}

export const App = ({ reporter, watch, onRerun, onRerunFailed, onAbort, onQuit }: AppProps) => {
  const state = useTestEvents(reporter);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onAbort();
    }
  });

  if (state.phase === "running") {
    return <RunScreen state={state} />;
  }

  if (watch) {
    return (
      <WatchScreen
        state={state}
        onRerun={onRerun}
        onRerunFailed={onRerunFailed}
        onQuit={onQuit}
      />
    );
  }

  return (
    <ResultsScreen
      state={state}
      onRerun={onRerun}
      onRerunFailed={onRerunFailed}
      onQuit={onQuit}
    />
  );
};
