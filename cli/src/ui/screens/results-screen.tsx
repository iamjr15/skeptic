import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { RunTuiSnapshot, TestView } from "../model.js";
import { Header } from "../components/header.js";
import { HintBar } from "../components/hint-bar.js";
import { SummaryBar } from "../components/summary-bar.js";
import { TestRow } from "../components/test-row.js";
import { colors, icons } from "../theme.js";

interface ResultsScreenProps {
  state: RunTuiSnapshot;
  onQuit: () => void;
}

const failedTest = (test: TestView): boolean =>
  test.phase === "failed" || test.phase === "error";

export const ResultsScreen = ({ state, onQuit }: ResultsScreenProps) => {
  const [verbose, setVerbose] = useState(false);
  const [showArtifacts, setShowArtifacts] = useState(true);
  const failures = state.tests.filter(failedTest);
  const passed = state.tests.filter((test) => test.phase === "passed").length;

  useInput((input, key) => {
    if (input === "v") setVerbose((value) => !value);
    if (input === "a") setShowArtifacts((value) => !value);
    if (input === "q" || key.escape) onQuit();
  });

  return (
    <Box flexDirection="column" width="100%">
      <Header state={state} />
      <Box flexDirection="column" paddingX={1}>
        {failures.length === 0 ? (
          <Text color={colors.pass}>
            {icons.pass} Passed {passed}/{state.tests.length} tests
          </Text>
        ) : (
          <Text color={colors.fail}>
            {icons.fail} Failed {failures.length}/{state.tests.length} tests
          </Text>
        )}
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        {(failures.length > 0 ? failures : state.tests.slice(0, 8)).map((test) => (
          <TestRow
            key={test.key}
            test={test}
            expanded={failedTest(test) || verbose}
            verbose={verbose}
            showArtifacts={showArtifacts}
          />
        ))}
        {failures.length === 0 && state.tests.length > 8 && (
          <Text color={colors.dim}>  +{state.tests.length - 8} more passed tests</Text>
        )}
      </Box>

      <SummaryBar state={state} />
      <HintBar
        hints={[
          { keyName: "v", label: verbose ? "compact" : "verbose" },
          { keyName: "a", label: showArtifacts ? "hide artifacts" : "artifacts" },
          { keyName: "q", label: "close" },
        ]}
      />
    </Box>
  );
};
