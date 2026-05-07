import { useMemo, useState } from "react";
import { Box, Static, Text, useInput } from "ink";
import type { RunTuiSnapshot, TestView } from "../model.js";
import { Header } from "../components/header.js";
import { HintBar } from "../components/hint-bar.js";
import { SummaryBar } from "../components/summary-bar.js";
import { TestRow } from "../components/test-row.js";
import { colors, icons } from "../theme.js";
import { useScrollableList } from "../hooks/use-scrollable-list.js";
import { useStdoutDimensions } from "../hooks/use-stdout-dimensions.js";

interface RunScreenProps {
  state: RunTuiSnapshot;
}

const isComplete = (test: TestView): boolean =>
  test.phase === "passed" || test.phase === "failed" || test.phase === "error";

export const RunScreen = ({ state }: RunScreenProps) => {
  const [, rows] = useStdoutDimensions();
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(new Set());
  const [verbose, setVerbose] = useState(false);
  const [showArtifacts, setShowArtifacts] = useState(false);

  const completedTests = useMemo(() => state.tests.filter(isComplete), [state]);
  const activeTests = useMemo(() => state.tests.filter((test) => !isComplete(test)), [state]);
  const runningCount = activeTests.filter((test) => test.phase === "running").length;
  const visibleCount = Math.max(1, Math.min(8, rows - 9));
  const { highlightedIndex, scrollOffset, handleNavigation } = useScrollableList({
    itemCount: activeTests.length,
    visibleCount,
  });
  const visibleActiveTests = activeTests.slice(scrollOffset, scrollOffset + visibleCount);
  const compactSteps = runningCount > 1;

  useInput((input, key) => {
    if (handleNavigation(input, key)) return;
    if (input === "v") {
      setVerbose((value) => !value);
      return;
    }
    if (input === "a") {
      setShowArtifacts((value) => !value);
      return;
    }
    if (input === "e" || key.return) {
      const selected = activeTests[highlightedIndex];
      if (!selected) return;
      setExpandedKeys((previous) => {
        const next = new Set(previous);
        if (next.has(selected.key)) next.delete(selected.key);
        else next.add(selected.key);
        return next;
      });
    }
  });

  return (
    <Box flexDirection="column" width="100%">
      <Header state={state} />
      <Box flexDirection="column" flexGrow={1}>
        <Static items={completedTests}>
          {(test) => (
            <TestRow
              key={test.key}
              test={test}
              verbose={verbose}
              showArtifacts={showArtifacts}
              compactSteps={compactSteps}
            />
          )}
        </Static>

        {visibleActiveTests.map((test, visibleIndex) => {
          const absoluteIndex = scrollOffset + visibleIndex;
          const focused = absoluteIndex === highlightedIndex;
          const expanded =
            expandedKeys.has(test.key) ||
            (test.phase === "running" && (runningCount === 1 || focused));
          return (
            <TestRow
              key={test.key}
              test={test}
              focused={focused}
              expanded={expanded}
              verbose={verbose}
              showArtifacts={showArtifacts}
              compactSteps={compactSteps}
            />
          );
        })}

        {activeTests.length === 0 && (
          <Box paddingX={1}>
            <Text color={colors.dim}>{icons.queued} Finalizing reports...</Text>
          </Box>
        )}
      </Box>
      <SummaryBar state={state} />
      <HintBar
        hints={[
          { keyName: "j/k", label: "move" },
          { keyName: "enter", label: "expand" },
          { keyName: "v", label: verbose ? "compact" : "verbose" },
          { keyName: "a", label: showArtifacts ? "hide artifacts" : "artifacts" },
          { keyName: "ctrl-c", label: "abort" },
        ]}
      />
    </Box>
  );
};
