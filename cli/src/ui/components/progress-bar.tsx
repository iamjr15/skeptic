import { Box, Text } from "ink";
import { colors } from "../theme.js";

interface ProgressBarProps {
  current: number;
  total: number;
  width: number;
}

export const ProgressBar = ({ current, total, width }: ProgressBarProps) => {
  const safeWidth = Math.max(4, width);
  const ratio = total > 0 ? Math.min(1, Math.max(0, current / total)) : 0;
  const filled = Math.round(safeWidth * ratio);
  const empty = safeWidth - filled;

  return (
    <Box>
      <Text color={colors.active}>[</Text>
      <Text color={colors.active}>{"=".repeat(filled)}</Text>
      <Text color={colors.dim}>{"-".repeat(empty)}</Text>
      <Text color={colors.active}>]</Text>
    </Box>
  );
};
