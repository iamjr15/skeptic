import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OpenAIClient } from "../../../src/ai/openai-client.js";

describe("OpenAIClient", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({
        choices: [{ message: { content: "response text" } }],
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("declares provider 'openai'", () => {
    const client = new OpenAIClient("key");
    expect(client.provider).toBe("openai");
  });

  it("defaults model to gpt-4o when not specified", async () => {
    const client = new OpenAIClient("test-key");
    await client.generateText("hello");
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.model).toBe("gpt-4o");
  });

  it("generateText POSTs to openai chat completions with bearer auth", async () => {
    const client = new OpenAIClient("test-key", "gpt-4o-mini");
    await client.generateText("hello world", "system prompt");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer test-key");

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages[0]).toEqual({ role: "system", content: "system prompt" });
    expect(body.messages[1]).toEqual({ role: "user", content: "hello world" });
  });

  it("analyzeImage sends a base64 image_url content block", async () => {
    const client = new OpenAIClient("test-key");
    const buf = Buffer.from("fake-png-bytes");
    await client.analyzeImage(buf, "what is in this image?");

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    const content = body.messages[0].content;
    expect(content[0]).toEqual({ type: "text", text: "what is in this image?" });
    expect(content[1].type).toBe("image_url");
    expect(content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it("throws on non-OK response (fatal — auth)", async () => {
    // 401 is fatal in classifyError — withRetry throws on first attempt, no retries.
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => '{"error":{"code":"invalid_api_key","message":"Unauthorized"}}',
    });
    const client = new OpenAIClient("bad-key");
    await expect(client.generateText("hi")).rejects.toThrow(/OpenAI API error.*401/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  describe("retry behavior", () => {
    function rateLimited() {
      return {
        ok: false,
        status: 429,
        text: async () => '{"error":{"code":"rate_limit_exceeded","message":"slow down"}}',
        headers: { get: () => null },
      };
    }

    function ok() {
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ choices: [{ message: { content: "ok" } }] }),
      };
    }

    it("retries on 429 (rate_limit_exceeded) and reports retryCount", async () => {
      // First call rate-limited, second succeeds.
      fetchSpy
        .mockResolvedValueOnce(rateLimited())
        .mockResolvedValueOnce(ok());

      const client = new OpenAIClient("test-key");
      const result = await client.generateText("hi");
      expect(result.text).toBe("ok");
      expect(result.retryCount).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    }, 10_000);

    it("exhausts retries after 3 attempts on persistent 429", async () => {
      fetchSpy.mockResolvedValue(rateLimited());

      const client = new OpenAIClient("bad-key");
      await expect(client.generateText("hi")).rejects.toThrow(/OpenAI API error.*429/);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    }, 10_000);

    it("treats 429 WITHOUT rate_limit_exceeded code as fatal (quota — no retry)", async () => {
      // Per classifyError: openai 429 only retries when error.code === "rate_limit_exceeded".
      // Quota / billing errors should NOT auto-retry.
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => '{"error":{"code":"insufficient_quota","message":"Out of credits"}}',
        headers: { get: () => null },
      });

      const client = new OpenAIClient("low-balance-key");
      await expect(client.generateText("hi")).rejects.toThrow(/OpenAI API error.*429/);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("retries on 503 (overload)", async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: async () => '{"error":{"message":"server overloaded"}}',
          headers: { get: () => null },
        })
        .mockResolvedValueOnce(ok());

      const client = new OpenAIClient("test-key");
      const result = await client.generateText("hi");
      expect(result.retryCount).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    }, 10_000);
  });
});
