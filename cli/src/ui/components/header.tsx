import { Box, Text } from "ink";
import { PRODUCT_NAME } from "../../constants.js";
import { colors, icons } from "../theme.js";
import type { RunTuiSnapshot } from "../model.js";
import { formatDuration } from "../format.js";

interface HeaderProps {
  state: RunTuiSnapshot;
}

export const Header = ({ state }: HeaderProps) => {
  const completed = state.tests.filter(
    (test) => test.phase === "passed" || test.phase === "failed" || test.phase === "error",
  ).length;
  const failed = state.tests.filter(
    (test) => test.phase === "failed" || test.phase === "error",
  ).length;
  const running = state.tests.filter((test) => test.phase === "running").length;
  const elapsed = formatDuration((state.completedAt ?? Date.now()) - state.startedAt);

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text>
        <Text color={colors.brand}>{icons.brand}</Text>{" "}
        <Text bold>{PRODUCT_NAME}</Text>{" "}
        <Text color={colors.dim}>
          {state.phase === "complete" ? "complete" : "running"}
        </Text>
      </Text>
      <Text color={colors.dim}>
        {completed}/{state.tests.length} done
        {running > 0 ? `, ${running} active` : ""}
        {failed > 0 ? `, ${failed} failed` : ""} {elapsed}
      </Text>
    </Box>
  );
};
