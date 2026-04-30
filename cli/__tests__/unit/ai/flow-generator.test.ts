import { describe, it, expect } from "vitest";
import {
  validateGeneratedSource,
  generateFromDescription,
} from "../../../src/ai/flow-generator.js";
import type { AIClient, AIResult } from "../../../src/ai/ai-client.js";

const makeMockClient = (text: string): AIClient => ({
  provider: "gemini",
  analyzeImage: async (): Promise<AIResult> => ({ text: "", retryCount: 0 }),
  generateText: async (): Promise<AIResult> => ({ text, retryCount: 0 }),
});

describe("validateGeneratedSource — tsc --noEmit + dynamic-import sanity", () => {
  it("accepts a compiling spec with ≥1 test() call", async () => {
    const source = `
import { test } from "skeptic-cli";
test("smoke", async ({ page }) => {
  await page.goto("/");
});
`;
    const { result } = await validateGeneratedSource(source, process.cwd(), {
      importForTestCount: true,
    });
    expect(result.ok).toBe(true);
    expect(result.testCount).toBeGreaterThanOrEqual(1);
  });

  it("rejects a non-compiling spec (TS error)", async () => {
    const source = `
import { test } from "skeptic-cli";
const x: number = "not a number";
test("broken", async ({ page }) => { await page.goto("/"); });
`;
    const { result } = await validateGeneratedSource(source, process.cwd(), {
      importForTestCount: false,
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.startsWith("[error]"))).toBe(true);
  });

  it("rejects a syntactically broken spec", async () => {
    const source = `import { test } from "skeptic-cli";\nthis is not valid typescript\n`;
    const { result } = await validateGeneratedSource(source, process.cwd(), {
      importForTestCount: false,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects when importForTestCount is enabled but 0 test() calls registered", async () => {
    const source = `
import { test } from "skeptic-cli";
// no test() call here
const noop = () => undefined;
noop();
`;
    const { result } = await validateGeneratedSource(source, process.cwd(), {
      importForTestCount: true,
    });
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some((d) => d.includes("0 test() calls")),
    ).toBe(true);
  });
});

describe("generateFromDescription — end-to-end with mocked LLM", () => {
  it("returns a GeneratedTest with valid source and ≥1 test() call", async () => {
    const goodSpec = `import { test, expect } from "skeptic-cli";

test("homepage smoke", async ({ page }) => {
  await page.goto("https://example.com/");
  await expect(page).toHaveURL(/.+/);
});
`;
    const client = makeMockClient(goodSpec);
    const results = await generateFromDescription(
      client,
      "homepage smoke",
      "https://example.com",
      process.cwd(),
    );
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.testCount).toBeGreaterThanOrEqual(1);
    expect(r.source).toContain("import { test");
    expect(r.filename.endsWith(".spec.ts")).toBe(true);
  });

  it("strips ```ts ... ``` fences from LLM output", async () => {
    const fenced = "```ts\n" +
      `import { test } from "skeptic-cli";\n` +
      `test("fenced", async ({ page }) => { await page.goto("/"); });\n` +
      "```";
    const client = makeMockClient(fenced);
    const [r] = await generateFromDescription(
      client,
      "fenced",
      "https://example.com",
      process.cwd(),
    );
    expect(r!.source.startsWith("```")).toBe(false);
    expect(r!.source).toContain("import { test");
  });

  it("throws when the LLM emits invalid TS", async () => {
    const broken = `not even close to typescript)) {{{`;
    const client = makeMockClient(broken);
    await expect(
      generateFromDescription(client, "broken", "https://example.com", process.cwd()),
    ).rejects.toThrow(/failed validation/);
  });
});
