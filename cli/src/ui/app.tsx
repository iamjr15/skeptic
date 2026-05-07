import { Box, Text, useInput } from "ink";
import type { InkReporter } from "../reporter/ink-reporter.js";
import { useRunTuiSnapshot } from "./hooks/use-run-tui-snapshot.js";
import { RunScreen } from "./screens/run-screen.js";
import { ResultsScreen } from "./screens/results-screen.js";
import { Header } from "./components/header.js";
import { colors, icons } from "./theme.js";

interface AppProps {
  reporter: InkReporter;
  onAbort: () => void;
  onQuit: () => void;
}

export const App = ({ reporter, onAbort, onQuit }: AppProps) => {
  const state = useRunTuiSnapshot(reporter);

  useInput((input, key) => {
    if (key.ctrl && input === "c") onAbort();
  });

  if (state.phase === "complete") {
    return <ResultsScreen state={state} onQuit={onQuit} />;
  }

  if (state.phase === "idle") {
    return (
      <Box flexDirection="column" width="100%">
        <Header state={state} />
        <Box paddingX={1}>
          <Text color={colors.dim}>{icons.queued} Preparing test manifest...</Text>
        </Box>
      </Box>
    );
  }

  return <RunScreen state={state} />;
};
