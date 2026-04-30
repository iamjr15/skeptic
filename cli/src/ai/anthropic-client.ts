import type { AIClient, AIProvider, AIResult } from "./ai-client.js";
import { ProviderError, withRetry, downscalePng } from "./retry-policy.js";

export class AnthropicClient implements AIClient {
  readonly provider: AIProvider = "anthropic";
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? "claude-sonnet-4-20250514";
  }

  async analyzeImage(
    imageBuffer: Buffer,
    prompt: string,
    temperature: number = 0.2,
  ): Promise<AIResult> {
    let buf = imageBuffer;

    const { value, retryCount } = await withRetry(
      async () => {
        const base64 = buf.toString("base64");
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: 1024,
            temperature,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: base64,
                    },
                  },
                  { type: "text", text: prompt },
                ],
              },
            ],
          }),
        });

        if (!response.ok) await throwProviderError(response);

        const data = (await response.json()) as {
          content: Array<{ type: string; text: string }>;
        };
        const text = data.content.find((block) => block.type === "text")?.text ?? "";
        return stripMarkdownFences(text);
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
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 4096,
          temperature,
          ...(system ? { system } : {}),
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!response.ok) await throwProviderError(response);

      const data = (await response.json()) as {
        content: Array<{ type: string; text: string }>;
      };
      const text = data.content.find((block) => block.type === "text")?.text ?? "";
      return stripMarkdownFences(text);
    });

    return { text: value, retryCount };
  }
}

/**
 * Anthropic returns either JSON `{ "type": "error", "error": { … } }` or
 * (rarely) plain text on hard 5xx. Read both shapes; surface a
 * ProviderError with status, headers' Retry-After, and parsed body so
 * `classifyError` can see Anthropic's `error.type === "overloaded_error"`.
 */
async function throwProviderError(response: Response): Promise<never> {
  let body: unknown;
  const raw = await response.text();
  try {
    body = JSON.parse(raw);
  } catch {
    body = { error: { message: raw } };
  }
  // Tests mock fetch with plain objects that don't carry headers; tolerate
  // missing `headers` rather than crashing during error mapping.
  const retryAfter = response.headers?.get?.("retry-after") ?? null;
  const retryAfterMs = retryAfter ? parseRetryAfter(retryAfter) : null;
  const message = `Anthropic API error (${response.status}): ${
    typeof (body as { error?: { message?: string } })?.error?.message === "string"
      ? (body as { error: { message: string } }).error.message
      : raw.slice(0, 200)
  }`;
  throw new ProviderError(message, "anthropic", response.status, body, retryAfterMs);
}

function parseRetryAfter(header: string): number {
  // Either delta-seconds or HTTP-date; we only handle delta-seconds.
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return 0;
}

function stripMarkdownFences(text: string): string {
  let result = text.trim();
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
