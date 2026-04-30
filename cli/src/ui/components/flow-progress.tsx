import React from "react";
import { Box, Text, useStdout } from "ink";
import cliTruncate from "cli-truncate";
import prettyMs from "pretty-ms";
import { colors, icons } from "../theme.js";
import type { FlowState } from "../types.js";
import { StepLine } from "./step-line.js";
import { StepLineCompact } from "./step-line-compact.js";

interface FlowProgressProps {
  flow: FlowState;
  compact?: boolean;
  expanded?: boolean;
  focused?: boolean;
  verbose?: boolean;
}

const phaseIcon = (phase: FlowState["phase"]): string => {
  switch (phase) {
    case "running": return icons.running;
    case "passed": return icons.pass;
    case "failed":
    case "error": return icons.fail;
    case "queued": return icons.pending;
  }
};

const phaseColor = (phase: FlowState["phase"]): string => {
  switch (phase) {
    case "running": return colors.active;
    case "passed": return colors.pass;
    case "failed":
    case "error": return colors.fail;
    case "queued": return colors.dim;
  }
};

export const FlowProgress = ({ flow, compact, expanded, focused, verbose }: FlowProgressProps) => {
  const { stdout } = useStdout();
  const width = (stdout?.columns ?? 80) - 4;
  const icon = phaseIcon(flow.phase);
  const color = phaseColor(flow.phase);
  const showSteps = expanded ?? flow.phase === "running";

  const rightLabel = flow.phase === "queued"
    ? "(queued)"
    : flow.phase === "running"
      ? `${flow.activeStepIndex + 1}/${flow.stepCount}  ${prettyMs(Date.now() - flow.startTime)}`
      : flow.phase === "passed"
        ? `PASS    ${prettyMs(flow.duration_ms)}`
        : `FAIL    ${prettyMs(flow.duration_ms)}`;

  const nameMaxWidth = width - rightLabel.length - 6;

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" paddingX={2}>
        <Text>
          <Text color={color}>{icon}</Text>
          <Text> {cliTruncate(flow.name, nameMaxWidth)}</Text>
        </Text>
        <Text color={flow.phase === "queued" ? colors.dim : undefined}>{rightLabel}</Text>
      </Box>

      {showSteps && !compact && (
        <Box flexDirection="column">
          {flow.steps.map((step, i) => (
            <StepLine key={i} step={step} verbose={verbose} />
          ))}
        </Box>
      )}

      {showSteps && compact && (
        <Box paddingLeft={4} gap={1}>
          {flow.steps.map((step, i) => (
            <StepLineCompact key={i} step={step} />
          ))}
        </Box>
      )}
    </Box>
  );
};
