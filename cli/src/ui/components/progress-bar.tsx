import React from "react";
import { Text } from "ink";
import { colors } from "../theme.js";

interface ProgressBarProps {
  current: number;
  total: number;
  width?: number;
}

export const ProgressBar = ({ current, total, width = 30 }: ProgressBarProps) => {
  const ratio = total > 0 ? Math.min(current / total, 1) : 0;
  const filled = Math.round(ratio * width);
  const empty = width - filled;

  return (
    <Text>
      <Text color={colors.pass}>{"━".repeat(filled)}</Text>
      <Text color={colors.dim}>{"░".repeat(empty)}</Text>
    </Text>
  );
};
