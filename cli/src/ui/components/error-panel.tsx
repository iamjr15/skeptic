import React from "react";
import { Box, Text } from "ink";
import { colors } from "../theme.js";

interface ErrorPanelProps {
  error: string;
  screenshot?: string;
  stepIndex: number;
  command: string;
}

export const ErrorPanel = ({ error, screenshot, stepIndex, command }: ErrorPanelProps) => (
  <Box flexDirection="column" paddingLeft={2}>
    <Text color={colors.fail}>{"│"} Step {stepIndex + 1}: {command}</Text>
    <Text color={colors.fail}>{"│"} {"→"} {error}</Text>
    {screenshot ? (
      <Text color={colors.dim}>{"│"} Screenshot: {screenshot}</Text>
    ) : null}
  </Box>
);
