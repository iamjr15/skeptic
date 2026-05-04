import React, { useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { Header } from "../components/header.js";
import { colors, icons } from "../theme.js";

interface ParsedGeneratedTest {
  index: number;
  name: string;
  stepCount: number;
  tags: string[];
  parseError?: string;
}

interface GenerateReviewScreenProps {
  tests: string[];
  onApprove: (indices: number[]) => void;
  onSkip: () => void;
}

const parseGeneratedTest = (raw: string, index: number): ParsedGeneratedTest => {
  const nameMatch = raw.match(/test\(\s*["'`]([^"'`]+)["'`]/) ?? raw.match(/^name:\s*(.+)$/m);
  return {
    index,
    name: nameMatch?.[1]?.trim() ?? `test-${index + 1}`,
    stepCount: 0,
    tags: [],
  };
};

export const GenerateReviewScreen = ({ tests, onApprove, onSkip }: GenerateReviewScreenProps) => {
  const parsed = useMemo(() => tests.map(parseGeneratedTest), [tests]);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(parsed.map((_, i) => i)),
  );

  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const overhead = 10;
  const listRows = parsed.length + 2;
  const previewMaxLines = Math.max(6, rows - listRows - overhead);
  const focusedSource = tests[focusedIndex] ?? "";
  const previewLines = focusedSource.split("\n");
  const previewText = previewLines.slice(0, previewMaxLines).join("\n");
  const truncated = previewLines.length > previewMaxLines;
  const focused = parsed[focusedIndex];

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onSkip();
      return;
    }
    if (input === "q") {
      onSkip();
    } else if (input === "a") {
      onApprove(parsed.map((_, i) => i));
    } else if (input === "s") {
      onApprove([...selected].sort((a, b) => a - b));
    } else if (key.return || input === " ") {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(focusedIndex)) next.delete(focusedIndex);
        else next.add(focusedIndex);
        return next;
      });
    } else if (key.upArrow || input === "k") {
      setFocusedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow || input === "j") {
      setFocusedIndex((prev) => Math.min(parsed.length - 1, prev + 1));
    }
  });

  return (
    <Box flexDirection="column">
      <Header label="Review generated tests" />
      <Box paddingX={2} marginTop={1}>
        <Text color={colors.dim}>
          {parsed.length} test file(s) generated. Select which to save.
        </Text>
      </Box>
      <Box flexDirection="column" paddingX={2} marginTop={1}>
        {parsed.map((test, i) => {
          const isSelected = selected.has(test.index);
          const isFocused = focusedIndex === i;
          const pointer = isFocused ? icons.running : " ";
          const checkbox = isSelected ? "[x]" : "[ ]";
          const lineColor = isFocused ? colors.active : isSelected ? colors.text : colors.dim;
          const tagsSuffix = test.tags.length > 0 ? `, tags: ${test.tags.join(", ")}` : "";
          const stepsLabel = `${test.stepCount} step${test.stepCount === 1 ? "" : "s"}`;
          return (
            <Box key={test.index}>
              <Text color={lineColor}>
                {pointer} {checkbox} {test.name}{" "}
                <Text color={colors.dim}>
                  ({stepsLabel}
                  {tagsSuffix})
                </Text>
                {test.parseError ? <Text color={colors.fail}> ⚠ parse error</Text> : null}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box paddingX={2} marginTop={1}>
        <Text color={colors.dim}>{"─".repeat(56)}</Text>
      </Box>
      <Box flexDirection="column" paddingX={2}>
        <Text color={colors.dim}>Preview — {focused?.name ?? ""}</Text>
        <Text>{previewText}</Text>
        {truncated ? (
          <Text color={colors.dim}>
            … +{previewLines.length - previewMaxLines} more lines (resize terminal to see more)
          </Text>
        ) : null}
      </Box>
      <Box paddingX={2} marginTop={1}>
        <Text color={colors.dim}>{"─".repeat(56)}</Text>
      </Box>
      <Box paddingX={2} gap={2}>
        <Text color={colors.dim}>
          <Text bold>j/k</Text> navigate
        </Text>
        <Text color={colors.dim}>
          <Text bold>space</Text> toggle
        </Text>
        <Text color={colors.dim}>
          <Text bold>a</Text> approve all
        </Text>
        <Text color={colors.dim}>
          <Text bold>s</Text> save selected
        </Text>
        <Text color={colors.dim}>
          <Text bold>q</Text> skip
        </Text>
      </Box>
    </Box>
  );
};
