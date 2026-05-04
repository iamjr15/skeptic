import React from "react";
import { Box, Text, useStdout } from "ink";
import { colors } from "../theme.js";
import type { TestState } from "../types.js";
import { useScrollable } from "../hooks/use-scrollable.js";
import { TestProgress } from "./test-progress.js";

interface TestListProps {
  tests: TestState[];
  compact?: boolean;
  expandedTestIndex?: number | null;
}

export const TestList = ({ tests, compact, expandedTestIndex }: TestListProps) => {
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  const maxVisible = Math.max(3, termHeight - 8);

  const { visible, canScrollUp, canScrollDown } = useScrollable(tests, maxVisible);

  return (
    <Box flexDirection="column">
      {canScrollUp && (
        <Text color={colors.dim}>  {"▲"} more above</Text>
      )}

      {visible.map((test) => (
        <TestProgress
          key={test.testIndex}
          test={test}
          compact={compact}
          expanded={expandedTestIndex === test.testIndex}
        />
      ))}

      {canScrollDown && (
        <Text color={colors.dim}>  {"▼"} more below</Text>
      )}
    </Box>
  );
};
