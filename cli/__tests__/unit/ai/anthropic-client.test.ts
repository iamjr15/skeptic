import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AnthropicClient } from "../../../src/ai/anthropic-client.js";

describe("AnthropicClient", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({
        content: [{ type: "text", text: "response text" }],
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("declares provider 'anthropic'", () => {
    const client = new AnthropicClient("key");
    expect(client.provider).toBe("anthropic");
  });

  it("defaults model to claude-sonnet-4 when not specified", async () => {
    const client = new AnthropicClient("test-key");
    await client.generateText("hello");
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.model).toBe("claude-sonnet-4-20250514");
  });

  it("generateText POSTs to anthropic messages with x-api-key", async () => {
    const client = new AnthropicClient("test-key", "claude-haiku-4-5");
    await client.generateText("hello world", "system prompt");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers["x-api-key"]).toBe("test-key");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.system).toBe("system prompt");
    expect(body.messages[0]).toEqual({ role: "user", content: "hello world" });
  });

  it("analyzeImage sends a base64 image content block", async () => {
    const client = new AnthropicClient("test-key");
    const buf = Buffer.from("fake-png-bytes");
    await client.analyzeImage(buf, "describe");

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    const content = body.messages[0].content;
    expect(content[0].type).toBe("image");
    expect(content[0].source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: buf.toString("base64"),
    });
    expect(content[1]).toEqual({ type: "text", text: "describe" });
  });

  it("throws on non-OK response after exhausting retries", async () => {
    // Phase 4: withRetry retries 429s up to maxAttempts (default 3) before
    // surfacing the error. Use mockResolvedValue (not Once) so every retry
    // also fails — the throw should happen on attempt 3.
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });
    const client = new AnthropicClient("bad-key");
    await expect(client.generateText("hi")).rejects.toThrow(/Anthropic API error.*429/);
    // Verify the retry actually happened (3 calls, not 1).
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  }, 10_000);
});
