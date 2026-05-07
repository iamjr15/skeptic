import path from "node:path";
import cliTruncate from "cli-truncate";
import prettyMs from "pretty-ms";
import stringWidth from "string-width";
import type { TestArtifacts } from "../executor/types.js";
import { colors, icons } from "./theme.js";
import type { StepView, TestView } from "./model.js";

const SENSITIVE_PATTERN = /password|passwd|secret|token|api[_-]?key|authorization|cookie/i;

export const formatDuration = (ms: number): string =>
  prettyMs(Math.max(0, Math.round(ms)), { compact: true });

export const shortPath = (file: string, cwd = process.cwd()): string => {
  const relative = path.relative(cwd, file);
  return relative && !relative.startsWith("..") ? relative : file;
};

export const visibleTruncate = (value: string, width: number): string => {
  if (width <= 0) return "";
  return stringWidth(value) > width ? cliTruncate(value, width) : value;
};

const stringifyArg = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export const formatStepLabel = (step: Pick<StepView, "command" | "args">): string => {
  const args = stringifyArg(step.args);
  if (!args) return step.command;
  if (SENSITIVE_PATTERN.test(`${step.command} ${args}`)) {
    return `${step.command} [redacted]`;
  }
  return `${step.command} ${args}`;
};

export const statusIcon = (phase: TestView["phase"] | StepView["phase"]): string => {
  switch (phase) {
    case "passed":
      return icons.pass;
    case "failed":
    case "error":
      return icons.fail;
    case "running":
      return icons.running;
    case "skipped":
      return icons.skipped;
    case "queued":
      return icons.queued;
    case "pending":
      return icons.pending;
  }
};

export const statusColor = (
  phase: TestView["phase"] | StepView["phase"],
): string | undefined => {
  switch (phase) {
    case "passed":
      return colors.pass;
    case "failed":
    case "error":
      return colors.fail;
    case "running":
      return colors.active;
    case "skipped":
      return colors.warn;
    case "queued":
    case "pending":
      return colors.dim;
  }
};

export interface ArtifactLink {
  label: string;
  path: string;
}

export const artifactLinks = (artifacts: TestArtifacts | undefined): ArtifactLink[] => {
  if (!artifacts) return [];
  const links: ArtifactLink[] = [];
  if (artifacts.video?.path) links.push({ label: "video", path: artifacts.video.path });
  if (artifacts.trace) links.push({ label: "trace", path: artifacts.trace });
  if (artifacts.perfTrace) links.push({ label: "perf", path: artifacts.perfTrace });
  if (artifacts.accessibilityAudit) {
    links.push({ label: "audit", path: artifacts.accessibilityAudit });
  }
  if (artifacts.testJson) links.push({ label: "test json", path: artifacts.testJson });
  if (artifacts.screenshots) {
    for (const screenshot of artifacts.screenshots) {
      links.push({ label: "screenshot", path: screenshot });
    }
  }
  return links;
};
