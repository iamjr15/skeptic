import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { Header } from "../components/header.js";
import { FlowProgress } from "../components/flow-progress.js";
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
  const failedFlows = useMemo(
    () => state.flows.filter((f) => f.phase === "failed" || f.phase === "error"),
    [state.flows],
  );

  const [expandedFlowIndex, setExpandedFlowIndex] = useState<number | null>(
    () => failedFlows.length > 0 ? failedFlows[0]!.flowIndex : null,
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
      const flow = state.flows[focusedIndex];
      if (flow) {
        setExpandedFlowIndex((prev) =>
          prev === flow.flowIndex ? null : flow.flowIndex,
        );
      }
    } else if (key.upArrow) {
      setFocusedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setFocusedIndex((prev) => Math.min(state.flows.length - 1, prev + 1));
    }
  });

  return (
    <Box flexDirection="column">
      <Header label="Results" />
      <Box flexDirection="column" flexGrow={1} paddingX={2}>
        {state.flows.map((flow, i) => (
          <FlowProgress
            key={flow.flowIndex}
            flow={flow}
            compact={false}
            expanded={expandedFlowIndex === flow.flowIndex}
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
