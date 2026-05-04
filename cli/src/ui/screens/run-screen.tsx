import React, { useState, useMemo } from "react";
import { Box, Static, useInput } from "ink";
import { Header } from "../components/header.js";
import { TestProgress } from "../components/test-progress.js";
import { SummaryBar } from "../components/summary-bar.js";
import { HintBar } from "../components/hint-bar.js";
import type { TUIState, TestState } from "../types.js";

interface RunScreenProps {
  state: TUIState;
}

export const RunScreen = ({ state }: RunScreenProps) => {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [expandedTestIndex, setExpandedTestIndex] = useState<number | null>(null);
  const [verbose, setVerbose] = useState(false);

  const completedTests = useMemo(
    () => state.tests.filter((f) => f.phase === "passed" || f.phase === "failed" || f.phase === "error"),
    [state.tests],
  );

  const activeAndPendingTests = useMemo(
    () => state.tests.filter((f) => f.phase === "running" || f.phase === "queued"),
    [state.tests],
  );

  const isParallel = state.tests.filter((f) => f.phase === "running").length > 1;

  const passedCount = state.tests.filter((f) => f.phase === "passed").length;
  const failedCount = state.tests.filter((f) => f.phase === "failed" || f.phase === "error").length;

  useInput((input, key) => {
    if (input === "v") {
      setVerbose((v) => !v);
    } else if (key.return) {
      const test = activeAndPendingTests[focusedIndex];
      if (test) {
        setExpandedTestIndex((prev) =>
          prev === test.testIndex ? null : test.testIndex,
        );
      }
    } else if (key.upArrow) {
      setFocusedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setFocusedIndex((prev) =>
        Math.min(activeAndPendingTests.length - 1, prev + 1),
      );
    }
  });

  return (
    <Box flexDirection="column">
      <Header />
      <Box flexDirection="column" flexGrow={1} paddingX={2}>
        <Static items={completedTests}>
          {(test: TestState) => (
            <TestProgress
              key={test.testIndex}
              test={test}
              compact={isParallel}
              expanded={false}
              verbose={verbose}
            />
          )}
        </Static>
        {activeAndPendingTests.map((test, i) => (
          <TestProgress
            key={test.testIndex}
            test={test}
            compact={isParallel}
            expanded={expandedTestIndex === test.testIndex || (!isParallel && test.phase === "running")}
            focused={i === focusedIndex}
            verbose={verbose}
          />
        ))}
      </Box>
      <SummaryBar
        phase="running"
        passed={passedCount}
        failed={failedCount}
        total={state.tests.length}
        startTime={state.startTime}
      />
      <HintBar context="running" />
    </Box>
  );
};
