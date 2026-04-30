import React, { useState, useMemo } from "react";
import { Box, Static, useInput } from "ink";
import { Header } from "../components/header.js";
import { FlowProgress } from "../components/flow-progress.js";
import { SummaryBar } from "../components/summary-bar.js";
import { HintBar } from "../components/hint-bar.js";
import type { TUIState, FlowState } from "../types.js";

interface RunScreenProps {
  state: TUIState;
}

export const RunScreen = ({ state }: RunScreenProps) => {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [expandedFlowIndex, setExpandedFlowIndex] = useState<number | null>(null);
  const [verbose, setVerbose] = useState(false);

  const completedFlows = useMemo(
    () => state.flows.filter((f) => f.phase === "passed" || f.phase === "failed" || f.phase === "error"),
    [state.flows],
  );

  const activeAndPendingFlows = useMemo(
    () => state.flows.filter((f) => f.phase === "running" || f.phase === "queued"),
    [state.flows],
  );

  const isParallel = state.flows.filter((f) => f.phase === "running").length > 1;

  const passedCount = state.flows.filter((f) => f.phase === "passed").length;
  const failedCount = state.flows.filter((f) => f.phase === "failed" || f.phase === "error").length;

  useInput((input, key) => {
    if (input === "v") {
      setVerbose((v) => !v);
    } else if (key.return) {
      const flow = activeAndPendingFlows[focusedIndex];
      if (flow) {
        setExpandedFlowIndex((prev) =>
          prev === flow.flowIndex ? null : flow.flowIndex,
        );
      }
    } else if (key.upArrow) {
      setFocusedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setFocusedIndex((prev) =>
        Math.min(activeAndPendingFlows.length - 1, prev + 1),
      );
    }
  });

  return (
    <Box flexDirection="column">
      <Header />
      <Box flexDirection="column" flexGrow={1} paddingX={2}>
        <Static items={completedFlows}>
          {(flow: FlowState) => (
            <FlowProgress
              key={flow.flowIndex}
              flow={flow}
              compact={isParallel}
              expanded={false}
              verbose={verbose}
            />
          )}
        </Static>
        {activeAndPendingFlows.map((flow, i) => (
          <FlowProgress
            key={flow.flowIndex}
            flow={flow}
            compact={isParallel}
            expanded={expandedFlowIndex === flow.flowIndex || (!isParallel && flow.phase === "running")}
            focused={i === focusedIndex}
            verbose={verbose}
          />
        ))}
      </Box>
      <SummaryBar
        phase="running"
        passed={passedCount}
        failed={failedCount}
        total={state.flows.length}
        startTime={state.startTime}
      />
      <HintBar context="running" />
    </Box>
  );
};
