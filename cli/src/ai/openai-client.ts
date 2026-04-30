import type { AIClient, AIProvider, AIResult } from "./ai-client.js";
import { ProviderError, withRetry, downscalePng } from "./retry-policy.js";

export class OpenAIClient implements AIClient {
  readonly provider: AIProvider = "openai";
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? "gpt-4o";
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
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            temperature,
            max_tokens: 1024,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  {
                    type: "image_url",
                    image_url: { url: `data:image/png;base64,${base64}` },
                  },
                ],
              },
            ],
          }),
        });

        if (!response.ok) await throwProviderError(response);

        const data = (await response.json()) as {
          choices: Array<{ message: { content: string } }>;
        };
        return stripMarkdownFences(data.choices[0]?.message?.content ?? "");
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
      const messages: Array<{ role: string; content: string }> = [];
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: prompt });

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          temperature,
          max_tokens: 4096,
          messages,
        }),
      });

      if (!response.ok) await throwProviderError(response);

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      return stripMarkdownFences(data.choices[0]?.message?.content ?? "");
    });

    return { text: value, retryCount };
  }
}

async function throwProviderError(response: Response): Promise<never> {
  let body: unknown;
  const raw = await response.text();
  try {
    body = JSON.parse(raw);
  } catch {
    body = { error: { message: raw } };
  }
  const retryAfter = response.headers?.get?.("retry-after") ?? null;
  const retryAfterMs = retryAfter ? parseRetryAfter(retryAfter) : null;
  const errMsg = (body as { error?: { message?: string } })?.error?.message;
  const message = `OpenAI API error (${response.status}): ${
    typeof errMsg === "string" ? errMsg : raw.slice(0, 200)
  }`;
  throw new ProviderError(message, "openai", response.status, body, retryAfterMs);
}

function parseRetryAfter(header: string): number {
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
