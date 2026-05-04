import React from "react";
import { Box, Text, useStdout } from "ink";
import cliTruncate from "cli-truncate";
import prettyMs from "pretty-ms";
import { colors, icons } from "../theme.js";
import type { TestState } from "../types.js";
import { StepLine } from "./step-line.js";
import { StepLineCompact } from "./step-line-compact.js";

interface TestProgressProps {
  test: TestState;
  compact?: boolean;
  expanded?: boolean;
  focused?: boolean;
  verbose?: boolean;
}

const phaseIcon = (phase: TestState["phase"]): string => {
  switch (phase) {
    case "running": return icons.running;
    case "passed": return icons.pass;
    case "failed":
    case "error": return icons.fail;
    case "queued": return icons.pending;
  }
};

const phaseColor = (phase: TestState["phase"]): string => {
  switch (phase) {
    case "running": return colors.active;
    case "passed": return colors.pass;
    case "failed":
    case "error": return colors.fail;
    case "queued": return colors.dim;
  }
};

export const TestProgress = ({ test, compact, expanded, focused, verbose }: TestProgressProps) => {
  const { stdout } = useStdout();
  const width = (stdout?.columns ?? 80) - 4;
  const icon = phaseIcon(test.phase);
  const color = phaseColor(test.phase);
  const showSteps = expanded ?? test.phase === "running";

  const rightLabel = test.phase === "queued"
    ? "(queued)"
    : test.phase === "running"
      ? `${test.activeStepIndex + 1}/${test.stepCount}  ${prettyMs(Date.now() - test.startTime)}`
      : test.phase === "passed"
        ? `PASS    ${prettyMs(test.duration_ms)}`
        : `FAIL    ${prettyMs(test.duration_ms)}`;

  const nameMaxWidth = width - rightLabel.length - 6;

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" paddingX={2}>
        <Text>
          <Text color={color}>{icon}</Text>
          <Text> {cliTruncate(test.name, nameMaxWidth)}</Text>
        </Text>
        <Text color={test.phase === "queued" ? colors.dim : undefined}>{rightLabel}</Text>
      </Box>

      {showSteps && !compact && (
        <Box flexDirection="column">
          {test.steps.map((step, i) => (
            <StepLine key={i} step={step} verbose={verbose} />
          ))}
        </Box>
      )}

      {showSteps && compact && (
        <Box paddingLeft={4} gap={1}>
          {test.steps.map((step, i) => (
            <StepLineCompact key={i} step={step} />
          ))}
        </Box>
      )}
    </Box>
  );
};
