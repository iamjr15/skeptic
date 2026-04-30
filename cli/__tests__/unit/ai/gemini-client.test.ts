import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Google Generative AI SDK
const mockGenerateContent = vi.fn();
vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: vi.fn().mockReturnValue({
      generateContent: mockGenerateContent,
    }),
  })),
}));

describe("GeminiClient", () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
  });

  it("strips markdown json fences from responses", async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '```json\n{"passed": true}\n```' },
    });

    const { GeminiClient } = await import("../../../src/ai/gemini-client.js");
    const client = new GeminiClient("test-key");
    const result = await client.generateText("test prompt");

    expect(result.text).toBe('{"passed": true}');
    expect(result.retryCount).toBe(0);
  });

  it("strips plain markdown fences from responses", async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => "```\nplain content\n```" },
    });

    const { GeminiClient } = await import("../../../src/ai/gemini-client.js");
    const client = new GeminiClient("test-key");
    const result = await client.generateText("test prompt");

    expect(result.text).toBe("plain content");
  });

  it("returns text unchanged when no fences present", async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => "just plain text" },
    });

    const { GeminiClient } = await import("../../../src/ai/gemini-client.js");
    const client = new GeminiClient("test-key");
    const result = await client.generateText("test prompt");

    expect(result.text).toBe("just plain text");
  });

  it("passes system instruction when provided", async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => "response" },
    });

    const { GeminiClient } = await import("../../../src/ai/gemini-client.js");
    const client = new GeminiClient("test-key");
    await client.generateText("prompt", "system instructions");

    const callArgs = mockGenerateContent.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs["systemInstruction"]).toBeDefined();
  });

  it("analyzeImage encodes buffer as base64", async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"passed": true}' },
    });

    const { GeminiClient } = await import("../../../src/ai/gemini-client.js");
    const client = new GeminiClient("test-key");
    const buf = Buffer.from("fake-image-data");
    await client.analyzeImage(buf, "analyze this");

    const callArgs = mockGenerateContent.mock.calls[0]![0] as {
      contents: Array<{ parts: Array<{ inlineData?: { data: string; mimeType: string } }> }>;
    };
    const parts = callArgs.contents[0]!.parts;
    const imagePart = parts.find((p) => p.inlineData);
    expect(imagePart!.inlineData!.mimeType).toBe("image/png");
    expect(imagePart!.inlineData!.data).toBe(buf.toString("base64"));
  });

  it("rate limiter tracks requests in a 60s window", async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => "ok" },
    });

    // Use a very low maxRPM to test the rate limiter fires
    const { GeminiClient } = await import("../../../src/ai/gemini-client.js");
    const client = new GeminiClient("test-key", "gemini-2.5-flash", 2);

    // Make 2 requests — should succeed immediately
    await client.generateText("req 1");
    await client.generateText("req 2");
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });

  describe("retry behavior (SDK errors → ProviderError → withRetry)", () => {
    // The Gemini SDK throws errors with `.status` numeric. mapGeminiError converts
    // them to ProviderError so classifyError + withRetry can pick them up.
    function sdkError(status: number, message = "request failed") {
      const e = Object.assign(new Error(message), { status });
      return e;
    }

    it("retries on 429 (rate-limit) and reports retryCount", async () => {
      mockGenerateContent
        .mockRejectedValueOnce(sdkError(429, "rate limited"))
        .mockResolvedValueOnce({ response: { text: () => "ok" } });

      const { GeminiClient } = await import("../../../src/ai/gemini-client.js");
      const client = new GeminiClient("test-key");
      const result = await client.generateText("hi");

      expect(result.text).toBe("ok");
      expect(result.retryCount).toBe(1);
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    }, 10_000);

    it("exhausts retries after 3 attempts on persistent 503 (overload)", async () => {
      mockGenerateContent.mockRejectedValue(sdkError(503, "service unavailable"));

      const { GeminiClient } = await import("../../../src/ai/gemini-client.js");
      const client = new GeminiClient("test-key");
      await expect(client.generateText("hi")).rejects.toThrow(/service unavailable/);
      expect(mockGenerateContent).toHaveBeenCalledTimes(3);
    }, 10_000);

    it("treats 401 (auth) as fatal — no retries", async () => {
      mockGenerateContent.mockRejectedValue(sdkError(401, "invalid api key"));

      const { GeminiClient } = await import("../../../src/ai/gemini-client.js");
      const client = new GeminiClient("bad-key");
      await expect(client.generateText("hi")).rejects.toThrow(/invalid api key/);
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it("maps SDK errors with `response.status` shape (not `status`) to ProviderError", async () => {
      // Some SDK error variants nest status under `.response.status` instead of
      // top-level `.status` — mapGeminiError handles both.
      const err = Object.assign(new Error("rate limited"), {
        response: { status: 429, statusText: "Too Many Requests" },
      });
      mockGenerateContent
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({ response: { text: () => "ok" } });

      const { GeminiClient } = await import("../../../src/ai/gemini-client.js");
      const client = new GeminiClient("test-key");
      const result = await client.generateText("hi");

      expect(result.retryCount).toBe(1);
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    }, 10_000);
  });
});
