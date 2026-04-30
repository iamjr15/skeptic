import React from "react";
import { Box, Text, useStdout } from "ink";
import { colors, icons } from "../theme.js";

interface HeaderProps {
  version?: string;
  label?: string;
}

export const Header = ({ version = "0.1.0", label }: HeaderProps) => {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;

  return (
    <Box width={width} justifyContent="space-between" paddingX={2}>
      <Text>
        <Text color={colors.brand} bold>{icons.brand} skeptic</Text>
        {label ? <Text color={colors.dim}> {label}</Text> : null}
      </Text>
      <Text color={colors.dim}>v{version}</Text>
    </Box>
  );
};
