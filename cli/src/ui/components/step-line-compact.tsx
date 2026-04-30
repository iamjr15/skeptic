import React from "react";
import { Text } from "ink";
import cliTruncate from "cli-truncate";
import { colors, icons } from "../theme.js";
import type { StepState } from "../types.js";
import { Spinner } from "./spinner.js";

interface StepLineCompactProps {
  step: StepState;
}

export const StepLineCompact = ({ step }: StepLineCompactProps) => {
  switch (step.phase) {
    case "running":
      return <Spinner />;
    case "passed":
      if (step.warnings && step.warnings.length > 0) {
        return <Text color={colors.warn}>⚠</Text>;
      }
      return <Text color={colors.pass}>{icons.pass}</Text>;
    case "failed":
    case "error":
      return <Text color={colors.fail}>{icons.fail}</Text>;
    case "pending":
      return <Text color={colors.dim}>{icons.pending}</Text>;
    case "skipped":
      return <Text color={colors.dim}>{"→"}</Text>;
  }
};
