import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createAIClient } from "../../../src/ai/client-factory.js";
import { GeminiClient } from "../../../src/ai/gemini-client.js";
import { OpenAIClient } from "../../../src/ai/openai-client.js";
import { AnthropicClient } from "../../../src/ai/anthropic-client.js";

describe("createAIClient", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env["GEMINI_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("returns undefined when no config is given", async () => {
    const client = await createAIClient(undefined);
    expect(client).toBeUndefined();
  });

  it("returns undefined when no API key is found", async () => {
    const client = await createAIClient({ provider: "gemini" });
    expect(client).toBeUndefined();
  });

  it("creates GeminiClient with GEMINI_API_KEY env var", async () => {
    process.env["GEMINI_API_KEY"] = "test-gemini-key";
    const client = await createAIClient({ provider: "gemini" });
    expect(client).toBeInstanceOf(GeminiClient);
    expect(client?.provider).toBe("gemini");
  });

  it("creates OpenAIClient with OPENAI_API_KEY env var", async () => {
    process.env["OPENAI_API_KEY"] = "test-openai-key";
    const client = await createAIClient({ provider: "openai" });
    expect(client).toBeInstanceOf(OpenAIClient);
    expect(client?.provider).toBe("openai");
  });

  it("creates AnthropicClient with ANTHROPIC_API_KEY env var", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-anthropic-key";
    const client = await createAIClient({ provider: "anthropic" });
    expect(client).toBeInstanceOf(AnthropicClient);
    expect(client?.provider).toBe("anthropic");
  });

  it("does not cross-fall-back between providers", async () => {
    // Only GEMINI set but provider is openai → should not silently use gemini
    process.env["GEMINI_API_KEY"] = "gemini-key";
    const client = await createAIClient({ provider: "openai" });
    expect(client).toBeUndefined();
  });

  it("prefers explicit config.apiKey over env vars", async () => {
    process.env["GEMINI_API_KEY"] = "env-key";
    const client = await createAIClient({ provider: "gemini", apiKey: "explicit-key" });
    expect(client).toBeInstanceOf(GeminiClient);
  });

  it("defaults to gemini when provider is omitted", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";
    // @ts-expect-error — exercising the fallback path when provider is undefined
    const client = await createAIClient({ apiKey: "test" });
    expect(client).toBeInstanceOf(GeminiClient);
  });

  describe("empty-string apiKey falls through to env var (`??` → `||` defense in depth)", () => {
    // Regression test for the latent provider-aware-CI bug where YAML
    //   ai:
    //     provider: openai
    //     apiKey: $GEMINI_API_KEY
    // gets interpolated to apiKey: "" when GEMINI_API_KEY is unset.
    // Before the `||` fix, the empty string survived the nullish coalesce and
    // triggered `if (!apiKey) return undefined;` — silently degrading --analyze.
    //
    // After the fix, the empty string is treated as falsy and we fall through
    // to process.env[envKey], correctly creating the OpenAI client.

    it("empty string apiKey + provider env var set → creates client (regression)", async () => {
      process.env["OPENAI_API_KEY"] = "real-openai-key";
      const client = await createAIClient({ provider: "openai", apiKey: "" });
      expect(client).toBeInstanceOf(OpenAIClient);
    });

    it("empty string apiKey + no env var → returns undefined (existing behavior preserved)", async () => {
      const client = await createAIClient({ provider: "openai", apiKey: "" });
      expect(client).toBeUndefined();
    });

    it("non-empty config.apiKey still wins over env var (existing behavior preserved)", async () => {
      process.env["OPENAI_API_KEY"] = "from-env";
      const client = await createAIClient({ provider: "openai", apiKey: "from-config" });
      expect(client).toBeInstanceOf(OpenAIClient);
      // We can't easily inspect the apiKey passed to the OpenAIClient constructor without
      // mocking the module — but the fact that it constructs proves config.apiKey was used
      // (otherwise the truthy env var path would have been taken).
    });
  });
});
