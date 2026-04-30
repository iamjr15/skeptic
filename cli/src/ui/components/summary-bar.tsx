import React from "react";
import { Box, Text, useStdout } from "ink";
import prettyMs from "pretty-ms";
import { colors } from "../theme.js";
import { ProgressBar } from "./progress-bar.js";
import { useElapsed } from "../hooks/use-elapsed.js";

interface SummaryBarProps {
  phase: "running" | "complete";
  passed: number;
  failed: number;
  total: number;
  startTime?: number;
  duration_ms?: number;
}

export const SummaryBar = ({ phase, passed, failed, total, startTime, duration_ms }: SummaryBarProps) => {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  const elapsed = useElapsed(startTime ?? Date.now());
  const displayTime = phase === "complete" && duration_ms != null ? duration_ms : elapsed;

  if (phase === "running") {
    const completed = passed + failed;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    return (
      <Box paddingX={2}>
        <ProgressBar current={completed} total={total} width={Math.min(30, width - 40)} />
        <Text color={colors.dim}>
          {"  "}{completed}/{total} flows  {pct}%  {"•"}  {prettyMs(displayTime)}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={2}>
      <Box gap={1}>
        <Text> Tests:</Text>
        {passed > 0 && <Text color={colors.pass}>{passed} passed</Text>}
        {passed > 0 && failed > 0 && <Text color={colors.dim}>{"│"}</Text>}
        {failed > 0 && <Text color={colors.fail}>{failed} failed</Text>}
        <Text color={colors.dim}>{"│"}</Text>
        <Text>{total} total</Text>
      </Box>
      <Box gap={1}>
        <Text> Time:</Text>
        <Text>{prettyMs(displayTime)}</Text>
      </Box>
    </Box>
  );
};
