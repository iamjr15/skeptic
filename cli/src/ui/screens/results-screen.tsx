import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { Header } from "../components/header.js";
import { TestProgress } from "../components/test-progress.js";
import { SummaryBar } from "../components/summary-bar.js";
import { HintBar } from "../components/hint-bar.js";
import { colors } from "../theme.js";
import type { TUIState } from "../types.js";

interface ResultsScreenProps {
  state: TUIState;
  onRerun: () => Promise<void>;
  onRerunFailed: () => Promise<void>;
  onQuit: () => Promise<void>;
}

export const ResultsScreen = ({ state, onRerun, onRerunFailed, onQuit }: ResultsScreenProps) => {
  const failedTests = useMemo(
    () => state.tests.filter((f) => f.phase === "failed" || f.phase === "error"),
    [state.tests],
  );

  const [expandedTestIndex, setExpandedTestIndex] = useState<number | null>(
    () => failedTests.length > 0 ? failedTests[0]!.testIndex : null,
  );
  const [focusedIndex, setFocusedIndex] = useState(0);

  useInput((input, key) => {
    if (input === "r") {
      onRerun();
    } else if (input === "f") {
      onRerunFailed();
    } else if (input === "q") {
      onQuit();
    } else if (key.return) {
      const test = state.tests[focusedIndex];
      if (test) {
        setExpandedTestIndex((prev) =>
          prev === test.testIndex ? null : test.testIndex,
        );
      }
    } else if (key.upArrow) {
      setFocusedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setFocusedIndex((prev) => Math.min(state.tests.length - 1, prev + 1));
    }
  });

  return (
    <Box flexDirection="column">
      <Header label="Results" />
      <Box flexDirection="column" flexGrow={1} paddingX={2}>
        {state.tests.map((test, i) => (
          <TestProgress
            key={test.testIndex}
            test={test}
            compact={false}
            expanded={expandedTestIndex === test.testIndex}
            focused={i === focusedIndex}
            verbose={true}
          />
        ))}
      </Box>
      <Box paddingX={2} marginTop={1}>
        <Text color={colors.dim}>{"─".repeat(56)}</Text>
      </Box>
      <SummaryBar
        phase="complete"
        passed={state.summary?.passed ?? 0}
        failed={state.summary?.failed ?? 0}
        total={state.summary?.total ?? 0}
        duration_ms={state.summary?.duration_ms}
      />
      <HintBar context="results" />
    </Box>
  );
};
