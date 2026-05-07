import { Box, Text } from "ink";
import { colors } from "../theme.js";

export interface Hint {
  keyName: string;
  label: string;
}

interface HintBarProps {
  hints: Hint[];
}

export const HintBar = ({ hints }: HintBarProps) => (
  <Box paddingX={1}>
    {hints.map((hint, index) => (
      <Box key={`${hint.keyName}:${hint.label}`}>
        <Text color={colors.dim}>{hint.label} </Text>
        <Text color={colors.active}>[{hint.keyName}]</Text>
        {index < hints.length - 1 && <Text color={colors.dim}>   </Text>}
      </Box>
    ))}
  </Box>
);
