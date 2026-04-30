import React from "react";
import { Box, Text, useStdout } from "ink";
import { colors } from "../theme.js";
import type { FlowState } from "../types.js";
import { useScrollable } from "../hooks/use-scrollable.js";
import { FlowProgress } from "./flow-progress.js";

interface FlowListProps {
  flows: FlowState[];
  compact?: boolean;
  expandedFlowIndex?: number | null;
}

export const FlowList = ({ flows, compact, expandedFlowIndex }: FlowListProps) => {
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  const maxVisible = Math.max(3, termHeight - 8);

  const { visible, canScrollUp, canScrollDown } = useScrollable(flows, maxVisible);

  return (
    <Box flexDirection="column">
      {canScrollUp && (
        <Text color={colors.dim}>  {"▲"} more above</Text>
      )}

      {visible.map((flow) => (
        <FlowProgress
          key={flow.flowIndex}
          flow={flow}
          compact={compact}
          expanded={expandedFlowIndex === flow.flowIndex}
        />
      ))}

      {canScrollDown && (
        <Text color={colors.dim}>  {"▼"} more below</Text>
      )}
    </Box>
  );
};
