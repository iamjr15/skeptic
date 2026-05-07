import { Box, Text } from "ink";
import type { StepView } from "../model.js";
import {
  formatDuration,
  formatStepLabel,
  statusColor,
  statusIcon,
  visibleTruncate,
} from "../format.js";
import { colors } from "../theme.js";
import { Spinner } from "./spinner.js";
import { useStdoutDimensions } from "../hooks/use-stdout-dimensions.js";

interface StepRowProps {
  step: StepView;
  verbose: boolean;
  compact?: boolean;
}

const hasDetails = (step: StepView): boolean =>
  Boolean(
    step.error ||
      step.screenshot ||
      step.diffPath ||
      step.warnings?.length ||
      step.diagnostics?.length,
  );

export const StepRow = ({ step, verbose, compact = false }: StepRowProps) => {
  const [columns] = useStdoutDimensions();
  const label = formatStepLabel(step);
  const maxLabelWidth = Math.max(12, columns - (compact ? 18 : 20));
  const icon = statusIcon(step.phase);
  const color = statusColor(step.phase);
  const detailVisible = verbose || step.phase === "failed" || step.phase === "error";

  if (compact) {
    return (
      <Text color={color}>
        {step.phase === "running" ? "..." : icon}
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>    </Text>
        {step.phase === "running" ? <Spinner /> : <Text color={color}>{icon}</Text>}
        <Text> </Text>
        <Text color={step.phase === "pending" ? colors.dim : undefined}>
          {visibleTruncate(label || "(pending)", maxLabelWidth)}
        </Text>
        {step.phase !== "pending" && step.phase !== "running" && (
          <Text color={colors.dim}> {formatDuration(step.durationMs)}</Text>
        )}
        {!detailVisible && hasDetails(step) && (
          <Text color={colors.warn}> details</Text>
        )}
      </Box>
      {detailVisible && step.error && (
        <Text color={colors.fail}>      {visibleTruncate(step.error, columns - 8)}</Text>
      )}
      {detailVisible && step.warnings?.map((warning, index) => (
        <Text key={`warning-${index}`} color={colors.warn}>
          {"      "}
          {visibleTruncate(warning, columns - 8)}
        </Text>
      ))}
      {detailVisible && step.diagnostics?.map((diagnostic, index) => (
        <Text key={`diagnostic-${index}`} color={colors.warn}>
          {"      "}
          {visibleTruncate(`${diagnostic.kind}: ${diagnostic.message}`, columns - 8)}
        </Text>
      ))}
      {detailVisible && step.diffPath && (
        <Text color={colors.dim}>      diff: {visibleTruncate(step.diffPath, columns - 14)}</Text>
      )}
      {detailVisible && step.screenshot && (
        <Text color={colors.dim}>
          {"      "}
          screenshot: {visibleTruncate(step.screenshot, columns - 20)}
        </Text>
      )}
    </Box>
  );
};
