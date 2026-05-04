import * as fs from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SafetyConfig } from "../config/schema.js";
import {
  safeJsonStringify,
  truncateText,
  wrapContentBoundaries,
} from "../utils/safe-json.js";

const inlineText = (
  text: string,
  safety: SafetyConfig,
  label: string,
): string => {
  const truncated = truncateText(text, safety.maxOutputChars);
  return safety.contentBoundaries ? wrapContentBoundaries(truncated, label) : truncated;
};

export const jsonToolResult = (
  data: unknown,
  safety: SafetyConfig,
  label = "skeptic-json",
): CallToolResult => {
  const text = safeJsonStringify(data, {
    maxStringLength: safety.maxOutputChars,
  });
  return {
    content: [{ type: "text", text: inlineText(text, safety, label) }],
    structuredContent: data as Record<string, unknown>,
  };
};

export const textToolResult = (
  text: string,
  safety: SafetyConfig,
  label = "skeptic-text",
): CallToolResult => ({
  content: [{ type: "text", text: inlineText(text, safety, label) }],
});

export const imageToolResult = (
  filePath: string,
  structured: Record<string, unknown>,
  safety: SafetyConfig,
): CallToolResult => {
  const data = fs.readFileSync(filePath).toString("base64");
  const text = inlineText(safeJsonStringify(structured), safety, "skeptic-image-meta");
  return {
    content: [
      { type: "text", text },
      { type: "image", data, mimeType: "image/png" },
    ],
    structuredContent: structured,
  };
};

export const errorToolResult = (
  err: unknown,
  safety: SafetyConfig,
): CallToolResult => {
  const message = err instanceof Error ? err.message : String(err);
  return {
    ...jsonToolResult({ error: message }, safety, "skeptic-error"),
    isError: true,
  };
};
