import React from "react";
import { Box, Text } from "ink";
import { colors } from "../theme.js";

interface HintBarProps {
  context: "running" | "results" | "watch";
}

const hints: Record<string, Array<{ key: string; label: string }>> = {
  running: [
    { key: "v", label: "verbose" },
    { key: "enter", label: "expand" },
    { key: "ctrl+c", label: "abort" },
  ],
  results: [
    { key: "r", label: "re-run" },
    { key: "f", label: "re-run failed" },
    { key: "q", label: "quit" },
  ],
  watch: [
    { key: "r", label: "re-run" },
    { key: "f", label: "re-run failed" },
    { key: "q", label: "quit" },
  ],
};

export const HintBar = ({ context }: HintBarProps) => {
  const items = hints[context] ?? [];

  return (
    <Box paddingX={2} gap={2}>
      {items.map((item) => (
        <Text key={item.key} color={colors.dim}>
          <Text bold>{item.key}</Text> {item.label}
        </Text>
      ))}
    </Box>
  );
};
