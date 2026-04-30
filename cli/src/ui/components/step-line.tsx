import React from "react";
import { Box, Text, useStdout } from "ink";
import cliTruncate from "cli-truncate";
import prettyMs from "pretty-ms";
import { colors, icons } from "../theme.js";
import type { StepState } from "../types.js";
import { Spinner } from "./spinner.js";
import { TextShimmer } from "./text-shimmer.js";

const SENSITIVE_PATTERNS = /password|secret|token|api[_-]?key|type="password"/i;

const maskArgs = (command: string, args: unknown): string => {
  if (command !== "type") return formatArgs(args);
  const str = formatArgs(args);
  if (SENSITIVE_PATTERNS.test(str)) {
    const parts = str.split(/\s+/);
    if (parts.length >= 2) {
      return parts[0] + ' "••••••••"';
    }
    return "••••••••";
  }
  return str;
};

const formatArgs = (args: unknown): string => {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return `"${args}"`;
  if (typeof args === "object") {
    try {
      return JSON.stringify(args);
    } catch {
      return String(args);
    }
  }
  return String(args);
};

interface StepLineProps {
  step: StepState;
  verbose?: boolean;
}

export const StepLine = ({ step, verbose }: StepLineProps) => {
  const { stdout } = useStdout();
  const maxWidth = (stdout?.columns ?? 80) - 8;
  const argsStr = maskArgs(step.command, step.args);
  const content = argsStr ? `${step.command} ${argsStr}` : step.command;

  switch (step.phase) {
    case "running":
      return (
        <Box>
          <Text>  </Text>
          <Spinner />
          <Text> </Text>
          <TextShimmer text={cliTruncate(content, maxWidth)} />
        </Box>
      );

    case "passed": {
      const warnings = step.warnings ?? [];
      if (warnings.length === 0) {
        return (
          <Box>
            <Text color={colors.pass}>  {icons.pass} </Text>
            <Text>{cliTruncate(content, maxWidth - 12)}</Text>
            <Text color={colors.dim}> ({prettyMs(step.duration_ms)})</Text>
          </Box>
        );
      }
      return (
        <Box flexDirection="column">
          <Box>
            <Text color={colors.pass}>  {icons.pass} </Text>
            <Text>{cliTruncate(content, maxWidth - 20)}</Text>
            <Text color={colors.dim}> ({prettyMs(step.duration_ms)})</Text>
            <Text color={colors.warn}> ⚠ {warnings.length}</Text>
          </Box>
          {verbose
            ? warnings.map((w, i) => (
                <Text key={i} color={colors.warn}>      ⚠ {w}</Text>
              ))
            : null}
        </Box>
      );
    }

    case "failed":
    case "error":
      return (
        <Box flexDirection="column">
          <Box>
            <Text color={colors.fail}>  {icons.fail} </Text>
            <Text>{cliTruncate(content, maxWidth)}</Text>
          </Box>
          {step.error && verbose ? (
            <Text color={colors.fail}>      {step.error}</Text>
          ) : null}
          {step.warnings && verbose
            ? step.warnings.map((w, i) => (
                <Text key={i} color={colors.warn}>      ⚠ {w}</Text>
              ))
            : null}
        </Box>
      );

    case "pending":
      return (
        <Box>
          <Text color={colors.dim}>  {icons.pending} {cliTruncate(content, maxWidth)}</Text>
        </Box>
      );

    case "skipped":
      return (
        <Box>
          <Text color={colors.dim}>  {"→"} {cliTruncate(content, maxWidth - 10)} [skipped]</Text>
        </Box>
      );
  }
};
