import { describe, it, expect, vi } from "vitest";

function createMockClient(response: string) {
  // Phase 4: AIClient methods now return AIResult { text, retryCount }.
  // Tests that don't care about retries can pass retryCount: 0.
  const result = { text: response, retryCount: 0 };
  return {
    analyzeImage: vi.fn().mockResolvedValue(result),
    generateText: vi.fn().mockResolvedValue(result),
  };
}

describe("assertion-evaluator", () => {
  describe("evaluateAssertion", () => {
    it("parses valid JSON response with pass result", async () => {
      const { evaluateAssertion } = await import("../../../src/ai/assertion-evaluator.js");
      const client = createMockClient(
        JSON.stringify({
          passed: true,
          confidence: 0.95,
          issues: [],
          summary: "Assertion passed",
        }),
      );

      const result = await evaluateAssertion(
        client as never,
        Buffer.from("fake-screenshot"),
        "the page should show a welcome message",
      );

      expect(result.passed).toBe(true);
      expect(result.confidence).toBe(0.95);
      expect(result.issues).toEqual([]);
      expect(result.summary).toBe("Assertion passed");
    });

    it("parses valid JSON response with fail result and issues", async () => {
      const { evaluateAssertion } = await import("../../../src/ai/assertion-evaluator.js");
      const client = createMockClient(
        JSON.stringify({
          passed: false,
          confidence: 0.88,
          issues: [
            { type: "assertion", severity: "high", description: "Welcome message not visible" },
          ],
          summary: "Expected text not found",
        }),
      );

      const result = await evaluateAssertion(
        client as never,
        Buffer.from("fake"),
        "welcome visible",
      );

      expect(result.passed).toBe(false);
      expect(result.confidence).toBe(0.88);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]!.severity).toBe("high");
    });

    it("handles garbage response gracefully with fallback", async () => {
      const { evaluateAssertion } = await import("../../../src/ai/assertion-evaluator.js");
      const client = createMockClient("this is not json at all");

      const result = await evaluateAssertion(
        client as never,
        Buffer.from("fake"),
        "something",
      );

      // Garbage text without "pass" → passed = false
      expect(result.passed).toBe(false);
      expect(result.confidence).toBe(0.3);
      expect(result.issues).toEqual([]);
    });

    it("infers pass from text containing 'pass' keyword", async () => {
      const { evaluateAssertion } = await import("../../../src/ai/assertion-evaluator.js");
      const client = createMockClient("The assertion passes — everything looks good.");

      const result = await evaluateAssertion(
        client as never,
        Buffer.from("fake"),
        "something",
      );

      expect(result.passed).toBe(true);
      expect(result.confidence).toBe(0.3);
    });

    it("infers fail when text contains both 'pass' and 'fail'", async () => {
      const { evaluateAssertion } = await import("../../../src/ai/assertion-evaluator.js");
      const client = createMockClient("This does not pass, it fails badly.");

      const result = await evaluateAssertion(
        client as never,
        Buffer.from("fake"),
        "something",
      );

      // Contains both "pass" and "fail" → passed = false
      expect(result.passed).toBe(false);
    });
  });

  describe("analyzeFailure", () => {
    it("returns analysis string from client", async () => {
      const { analyzeFailure } = await import("../../../src/ai/assertion-evaluator.js");
      const client = createMockClient("The button was not visible because the modal was closed.");

      const result = await analyzeFailure(
        client as never,
        Buffer.from("fake"),
        "click",
        "Element not found",
      );

      expect(result).toBe("The button was not visible because the modal was closed.");
    });

    it("returns fallback when client throws", async () => {
      const { analyzeFailure } = await import("../../../src/ai/assertion-evaluator.js");
      const client = {
        analyzeImage: vi.fn().mockRejectedValue(new Error("API error")),
        generateText: vi.fn(),
      };

      const result = await analyzeFailure(
        client as never,
        Buffer.from("fake"),
        "click",
        "err",
      );

      expect(result).toBe("Unable to analyze failure screenshot.");
    });
  });

  describe("evaluateDefects", () => {
    it("parses defect scan response", async () => {
      const { evaluateDefects } = await import("../../../src/ai/assertion-evaluator.js");
      const client = createMockClient(
        JSON.stringify({
          passed: true,
          confidence: 0.9,
          issues: [],
          summary: "No visual defects found",
        }),
      );

      const result = await evaluateDefects(
        client as never,
        Buffer.from("fake"),
      );

      expect(result.passed).toBe(true);
      expect(result.summary).toBe("No visual defects found");
    });
  });

  describe("extractText", () => {
    it("returns extracted text and confidence", async () => {
      const { extractText } = await import("../../../src/ai/assertion-evaluator.js");
      const client = createMockClient("John Doe");

      const result = await extractText(
        client as never,
        Buffer.from("fake"),
        "the user's name",
      );

      expect(result.text).toBe("John Doe");
      expect(result.confidence).toBe(0.8);
    });

    it("returns zero confidence for empty extraction", async () => {
      const { extractText } = await import("../../../src/ai/assertion-evaluator.js");
      const client = createMockClient("   ");

      const result = await extractText(
        client as never,
        Buffer.from("fake"),
        "nonexistent data",
      );

      expect(result.text).toBe("");
      expect(result.confidence).toBe(0.0);
    });
  });
});
