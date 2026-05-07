import { Box, Text } from "ink";
import type { TestView } from "../model.js";
import {
  artifactLinks,
  formatDuration,
  shortPath,
  statusColor,
  statusIcon,
  visibleTruncate,
} from "../format.js";
import { colors } from "../theme.js";
import { StepRow } from "./step-row.js";
import { useStdoutDimensions } from "../hooks/use-stdout-dimensions.js";

interface TestRowProps {
  test: TestView;
  focused?: boolean;
  expanded?: boolean;
  verbose?: boolean;
  showArtifacts?: boolean;
  compactSteps?: boolean;
}

const rightLabel = (test: TestView): string => {
  if (test.phase === "queued") return "queued";
  if (test.phase === "running") {
    const elapsed = test.startedAt ? Date.now() - test.startedAt : 0;
    const current = Math.max(0, test.activeStepIndex + 1);
    const total = Math.max(test.stepCount, test.steps.length);
    return `${current}/${total || "?"} ${formatDuration(elapsed)}`;
  }
  return `${test.phase.toUpperCase()} ${formatDuration(test.durationMs)}`;
};

export const TestRow = ({
  test,
  focused = false,
  expanded = false,
  verbose = false,
  showArtifacts = false,
  compactSteps = false,
}: TestRowProps) => {
  const [columns] = useStdoutDimensions();
  const color = statusColor(test.phase);
  const label = rightLabel(test);
  const nameWidth = Math.max(12, columns - label.length - 12);
  const artifacts = artifactLinks(test.artifacts);
  const shouldShowSteps = expanded || test.phase === "running";
  const showFile = focused || expanded || verbose;

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" paddingX={1}>
        <Text>
          <Text color={focused ? colors.active : colors.dim}>{focused ? ">" : " "}</Text>{" "}
          <Text color={color}>{statusIcon(test.phase)}</Text>{" "}
          <Text>{visibleTruncate(test.name, nameWidth)}</Text>
        </Text>
        <Box marginLeft={1}>
          <Text color={test.phase === "queued" ? colors.dim : color}>{label}</Text>
        </Box>
      </Box>

      {showFile && (
        <Box paddingLeft={4}>
          <Text color={colors.dim}>{visibleTruncate(shortPath(test.file), columns - 6)}</Text>
        </Box>
      )}

      {shouldShowSteps && compactSteps && test.steps.length > 0 && (
        <Box paddingLeft={4}>
          {test.steps.map((step) => (
            <Box key={step.index} marginRight={1}>
              <StepRow step={step} verbose={verbose} compact />
            </Box>
          ))}
        </Box>
      )}

      {shouldShowSteps && !compactSteps && (
        <Box flexDirection="column">
          {test.steps.map((step) => (
            <StepRow key={step.index} step={step} verbose={verbose} />
          ))}
        </Box>
      )}

      {showArtifacts && artifacts.length > 0 && (
        <Box flexDirection="column" paddingLeft={4}>
          {artifacts.slice(0, verbose ? artifacts.length : 4).map((artifact, index) => (
            <Text key={`${artifact.label}-${index}`} color={colors.dim}>
              {artifact.label}: {visibleTruncate(artifact.path, columns - 16)}
            </Text>
          ))}
          {!verbose && artifacts.length > 4 && (
            <Text color={colors.dim}>+{artifacts.length - 4} more artifacts</Text>
          )}
        </Box>
      )}
    </Box>
  );
};
