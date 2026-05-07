import { Box, Text } from "ink";
import { colors } from "../theme.js";
import type { RunTuiSnapshot } from "../model.js";
import { formatDuration } from "../format.js";
import { ProgressBar } from "./progress-bar.js";
import { useStdoutDimensions } from "../hooks/use-stdout-dimensions.js";

interface SummaryBarProps {
  state: RunTuiSnapshot;
}

export const SummaryBar = ({ state }: SummaryBarProps) => {
  const [columns] = useStdoutDimensions();
  const passed = state.tests.filter((test) => test.phase === "passed").length;
  const failed = state.tests.filter(
    (test) => test.phase === "failed" || test.phase === "error",
  ).length;
  const complete = passed + failed;
  const total = state.tests.length;
  const elapsed = state.summary
    ? state.summary.duration_ms
    : (state.completedAt ?? Date.now()) - state.startedAt;
  const barWidth = Math.min(30, Math.max(8, columns - 56));

  return (
    <Box paddingX={1}>
      <ProgressBar current={complete} total={total} width={barWidth} />
      <Text color={colors.dim}>
        {"  "}
        {complete}/{total} tests
        {"  "}
      </Text>
      {passed > 0 && <Text color={colors.pass}>{passed} passed </Text>}
      {failed > 0 && <Text color={colors.fail}>{failed} failed </Text>}
      <Text color={colors.dim}>{formatDuration(elapsed)}</Text>
    </Box>
  );
};
