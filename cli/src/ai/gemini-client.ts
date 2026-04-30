import { GoogleGenerativeAI, type GenerativeModel, type Part } from "@google/generative-ai";
import type { AIClient, AIProvider, AIResult } from "./ai-client.js";
import { logger } from "../utils/logger.js";
import { ProviderError, withRetry, downscalePng } from "./retry-policy.js";

export class GeminiClient implements AIClient {
  readonly provider: AIProvider = "gemini";
  private readonly model: GenerativeModel;
  private readonly maxRPM: number;
  private readonly requestTimestamps: number[] = [];

  constructor(apiKey: string, model: string = "gemini-2.5-flash", maxRPM: number = 55) {
    const genAI = new GoogleGenerativeAI(apiKey);
    this.model = genAI.getGenerativeModel({ model });
    this.maxRPM = maxRPM;
  }

  async analyzeImage(
    imageBuffer: Buffer,
    prompt: string,
    temperature: number = 0.2,
  ): Promise<AIResult> {
    let buf = imageBuffer;

    const { value, retryCount } = await withRetry(
      async () => {
        await this.waitForRateLimit();
        const imagePart: Part = {
          inlineData: {
            mimeType: "image/png",
            data: buf.toString("base64"),
          },
        };
        try {
          const result = await this.model.generateContent({
            contents: [{ role: "user", parts: [imagePart, { text: prompt }] }],
            generationConfig: { temperature },
          });
          return stripMarkdownFences(result.response.text());
        } catch (err) {
          throw mapGeminiError(err);
        }
      },
      {
        onContextLengthError: async () => {
          const downscaled = downscalePng(buf);
          if (!downscaled) return false;
          buf = downscaled;
          return true;
        },
      },
    );

    return { text: value, retryCount };
  }

  async generateText(
    prompt: string,
    system?: string,
    temperature: number = 0.4,
  ): Promise<AIResult> {
    const { value, retryCount } = await withRetry(async () => {
      await this.waitForRateLimit();
      const contents = [{ role: "user" as const, parts: [{ text: prompt }] }];
      try {
        const result = await this.model.generateContent({
          contents,
          ...(system ? { systemInstruction: { role: "user", parts: [{ text: system }] } } : {}),
          generationConfig: { temperature },
        });
        return stripMarkdownFences(result.response.text());
      } catch (err) {
        throw mapGeminiError(err);
      }
    });

    return { text: value, retryCount };
  }

  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const windowStart = now - 60_000;

    // Remove timestamps outside the window
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0]! < windowStart) {
      this.requestTimestamps.shift();
    }

    if (this.requestTimestamps.length >= this.maxRPM) {
      const oldestInWindow = this.requestTimestamps[0]!;
      const waitMs = oldestInWindow + 60_000 - now + 100;
      logger.debug(`Rate limit: waiting ${waitMs}ms before next request`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    this.requestTimestamps.push(Date.now());
  }
}

/**
 * The Gemini SDK throws `GoogleGenerativeAIFetchError` (and related
 * subclasses) with a `.status` numeric, `.statusText`, and an
 * `.errorDetails` array in some failure modes. Other failures throw plain
 * `Error`. Map both shapes to a `ProviderError` so `classifyError` /
 * `withRetry` can decide what to do.
 */
function mapGeminiError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const e = err as {
    status?: number;
    message?: string;
    response?: { status?: number; statusText?: string };
    errorDetails?: unknown;
  };
  const status = e.status ?? e.response?.status ?? 0;
  const message = e.message ?? "Gemini request failed";
  // The SDK doesn't expose a parsed body; pass message through as the
  // body's error.message so classifyError's regex tests can still match.
  const body = { error: { message } };
  return new ProviderError(message, "gemini", status, body, null);
}

function stripMarkdownFences(text: string): string {
  let result = text.trim();
  // Strip ```json ... ``` or ``` ... ```
  if (result.startsWith("```")) {
    const firstNewline = result.indexOf("\n");
    if (firstNewline !== -1) {
      result = result.slice(firstNewline + 1);
    }
    if (result.endsWith("```")) {
      result = result.slice(0, -3);
    }
    result = result.trim();
  }
  return result;
}
