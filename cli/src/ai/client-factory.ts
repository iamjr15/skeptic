import { ENV_KEY_BY_PROVIDER, type AIClient, type AIProvider } from "./ai-client.js";

interface AIConfig {
  provider: AIProvider;
  apiKey?: string;
  model?: string;
  maxRequestsPerMinute?: number;
}

const DEFAULT_MODEL_BY_PROVIDER: Record<AIProvider, string> = {
  gemini: "gemini-2.5-flash",
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-20250514",
};

/**
 * Thrown when `createAIClient` is called against a slim build that doesn't
 * include AI assertions. Callers (test, generate, mcp, acp) catch this and
 * either exit 2 with a clear message (CLI commands) or surface a
 * protocol-friendly error response (MCP/ACP). Distinguishes "AI was
 * configured out of this binary" from "no API key configured", which the
 * caller used to interpret as the same thing — see security.ts:22.
 */
export class AIFeatureNotBuiltError extends Error {
  constructor() {
    super(
      "AI assertions are not built into this binary. " +
        "Install via npm for AI support: `npm i -g skeptic-cli`",
    );
    this.name = "AIFeatureNotBuiltError";
  }
}

export async function createAIClient(config?: AIConfig): Promise<AIClient | undefined> {
  // Positive-branch DCE: when __SKEPTIC_FEATURE_AI_ASSERTIONS__ is build-time
  // false, esbuild folds the truthy block (including the `await import`s for
  // every provider client + GoogleGenerativeAI SDK) and tree-shakes them
  // out. The else throws a typed error that callers catch.
  if (__SKEPTIC_FEATURE_AI_ASSERTIONS__) {
    const provider: AIProvider = config?.provider ?? "gemini";
    const envKey = ENV_KEY_BY_PROVIDER[provider];
    // `||` (not `??`) so an empty-string apiKey (e.g. interpolated from an unset env var
    // like `apiKey: $GEMINI_API_KEY` in a context where GEMINI_API_KEY is unset) falls
    // through to the provider env var instead of triggering the `!apiKey` early return below.
    const apiKey = config?.apiKey || process.env[envKey];

    if (!apiKey) return undefined;

    const model = config?.model ?? DEFAULT_MODEL_BY_PROVIDER[provider];

    switch (provider) {
      case "gemini": {
        const { GeminiClient } = await import("./gemini-client.js");
        return new GeminiClient(apiKey, model, config?.maxRequestsPerMinute);
      }
      case "openai": {
        const { OpenAIClient } = await import("./openai-client.js");
        return new OpenAIClient(apiKey, model);
      }
      case "anthropic": {
        const { AnthropicClient } = await import("./anthropic-client.js");
        return new AnthropicClient(apiKey, model);
      }
      default:
        return undefined;
    }
  } else {
    throw new AIFeatureNotBuiltError();
  }
}
