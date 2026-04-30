import type { AIClient } from "./ai-client.js";
import type { AIAssertionResult, AIExtractionResult } from "./types.js";
import {
  VISUAL_ASSERTION_PROMPT,
  ASSERT_WITH_AI_PROMPT,
  EXTRACT_TEXT_PROMPT,
} from "./prompts.js";
import { logger } from "../utils/logger.js";

export async function evaluateAssertion(
  client: AIClient,
  screenshot: Buffer,
  assertion: string,
): Promise<AIAssertionResult> {
  const prompt = ASSERT_WITH_AI_PROMPT.replace("{assertion}", assertion);
  const result = await client.analyzeImage(screenshot, prompt);
  return { ...parseAssertionResponse(result.text), retryCount: result.retryCount };
}

export async function evaluateDefects(
  client: AIClient,
  screenshot: Buffer,
): Promise<AIAssertionResult> {
  const result = await client.analyzeImage(screenshot, VISUAL_ASSERTION_PROMPT);
  return { ...parseAssertionResponse(result.text), retryCount: result.retryCount };
}

export async function extractText(
  client: AIClient,
  screenshot: Buffer,
  query: string,
): Promise<AIExtractionResult> {
  const prompt = EXTRACT_TEXT_PROMPT.replace("{query}", query);
  const result = await client.analyzeImage(screenshot, prompt, 0.1);
  const text = result.text.trim();

  return {
    text,
    confidence: text.length > 0 ? 0.8 : 0.0,
    retryCount: result.retryCount,
  };
}

export async function analyzeFailure(
  client: AIClient,
  screenshot: Buffer,
  stepCommand: string,
  errorMessage: string,
): Promise<string> {
  const prompt = [
    "A test step failed. Analyze the screenshot and provide a brief diagnosis.",
    `Step: ${stepCommand}`,
    `Error: ${errorMessage}`,
    "Respond with a concise 1-3 sentence analysis of what went wrong and a suggestion to fix it.",
  ].join("\n");

  try {
    const result = await client.analyzeImage(screenshot, prompt);
    return result.text;
  } catch {
    return "Unable to analyze failure screenshot.";
  }
}

function parseAssertionResponse(raw: string): AIAssertionResult {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      passed: Boolean(parsed["passed"]),
      confidence: typeof parsed["confidence"] === "number" ? parsed["confidence"] : 0.5,
      issues: Array.isArray(parsed["issues"])
        ? (parsed["issues"] as Array<Record<string, unknown>>).map((i) => ({
            type: String(i["type"] ?? "unknown"),
            severity: parseSeverity(i["severity"]),
            description: String(i["description"] ?? ""),
          }))
        : [],
      summary: String(parsed["summary"] ?? ""),
    };
  } catch {
    logger.debug(`Failed to parse AI response as JSON: ${raw.slice(0, 200)}`);
    // Best-effort: if response contains "passed" or "fail", infer result
    const lower = raw.toLowerCase();
    const passed = lower.includes("pass") && !lower.includes("fail");
    return {
      passed,
      confidence: 0.3,
      issues: [],
      summary: raw.slice(0, 200),
    };
  }
}

function parseSeverity(val: unknown): "low" | "medium" | "high" | "critical" {
  const s = String(val).toLowerCase();
  if (s === "low" || s === "medium" || s === "high" || s === "critical") return s;
  return "medium";
}
