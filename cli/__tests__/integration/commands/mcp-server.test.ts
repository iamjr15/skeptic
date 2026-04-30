import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer } from "../../../src/commands/mcp.js";
import type { AIClient, AIResult } from "../../../src/ai/ai-client.js";

// Two paths exercised here:
//   - In-process registration & generate_test (pure helpers; no worker spawn).
//   - dist/skeptic.mjs mcp via stdio for list_tests / validate_tests / run_test
//     (these reach into worker_threads, so they need the built worker.mjs).
const DIST = path.resolve(import.meta.dirname, "../../../dist/skeptic.mjs");
const WORKER_DIST = path.resolve(import.meta.dirname, "../../../dist/worker.mjs");
const distAvailable = fs.existsSync(DIST) && fs.existsSync(WORKER_DIST);
const FIXTURE_DIR = path.resolve(import.meta.dirname, "../../fixtures/mcp");

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

const callTool = async (client: Client, name: string, args: unknown): Promise<ToolResult> => {
  return (await client.callTool({
    name,
    arguments: args as Record<string, unknown>,
  })) as unknown as ToolResult;
};

describe("MCP server (B1.5) — in-process", () => {
  let client: Client;
  let serverTransport: InMemoryTransport;

  beforeAll(async () => {
    const server = buildMcpServer({ cwd: FIXTURE_DIR });
    const [clientTransport, st] = InMemoryTransport.createLinkedPair();
    serverTransport = st;
    await server.connect(serverTransport);

    client = new Client({ name: "skeptic-mcp-test", version: "0.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await serverTransport.close().catch(() => {});
  });

  it("registers exactly the four B1.5 tools", async () => {
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name).sort();
    expect(names).toEqual(["generate_test", "list_tests", "run_test", "validate_tests"]);
  });

  it("each tool's description references the TS-pivot semantics, not YAML", async () => {
    const list = await client.listTools();
    for (const tool of list.tools) {
      expect(tool.description ?? "").not.toMatch(/yaml/i);
    }
    const runTest = list.tools.find((t) => t.name === "run_test");
    expect(runTest?.description ?? "").toMatch(/spec/i);
  });

  it("generate_test returns a graceful fallback when no AIClient is available", async () => {
    // The default in-process server has no aiClientOverride and the test env
    // has no provider API keys → handler must return the missing-key note,
    // NOT crash. The empty source signals "configure AI to use this tool".
    const prevKeys = {
      gemini: process.env["GEMINI_API_KEY"],
      openai: process.env["OPENAI_API_KEY"],
      anthropic: process.env["ANTHROPIC_API_KEY"],
    };
    delete process.env["GEMINI_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const result = await callTool(client, "generate_test", {
        description: "homepage smoke",
        url: "https://example.com",
      });
      const structured = result.structuredContent as {
        source: string;
        filename: string;
        notes: string[];
      };
      expect(structured.source).toBe("");
      expect(structured.filename).toBe("");
      expect(structured.notes.some((n) => /api key/i.test(n))).toBe(true);
    } finally {
      if (prevKeys.gemini) process.env["GEMINI_API_KEY"] = prevKeys.gemini;
      if (prevKeys.openai) process.env["OPENAI_API_KEY"] = prevKeys.openai;
      if (prevKeys.anthropic) process.env["ANTHROPIC_API_KEY"] = prevKeys.anthropic;
    }
  });
});

// Mock-AI path: inject a stub AIClient so the handler routes through
// generateFromDescription end-to-end without hitting a real provider.
describe("MCP server (B1.5) — generate_test with injected AIClient", () => {
  let client: Client;
  let serverTransport: InMemoryTransport;
  let lastPrompt: string | null = null;

  const mockSpec = `import { test, expect } from "skeptic-cli";

test("homepage smoke", async ({ page }) => {
  await page.goto("https://example.com/");
  await expect(page).toHaveURL(/.+/);
});
`;

  const mockClient: AIClient = {
    provider: "gemini",
    analyzeImage: async (): Promise<AIResult> => ({ text: "", retryCount: 0 }),
    generateText: async (prompt: string): Promise<AIResult> => {
      lastPrompt = prompt;
      return { text: mockSpec, retryCount: 0 };
    },
  };

  beforeAll(async () => {
    const server = buildMcpServer({ cwd: FIXTURE_DIR, aiClientOverride: mockClient });
    const [clientTransport, st] = InMemoryTransport.createLinkedPair();
    serverTransport = st;
    await server.connect(serverTransport);

    client = new Client({ name: "skeptic-mcp-test-ai", version: "0.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await serverTransport.close().catch(() => {});
  });

  it("invokes generateFromDescription and returns the validated source", async () => {
    lastPrompt = null;
    const result = await callTool(client, "generate_test", {
      description: "homepage smoke",
      url: "https://example.com",
    });
    const structured = result.structuredContent as {
      source: string;
      filename: string;
      notes: string[];
    };

    // The mock LLM was called with the description-driven prompt — proving
    // the handler routes through flow-generator, not the old hand-rolled stub.
    expect(lastPrompt).toBeTruthy();
    expect(lastPrompt!).toContain("homepage smoke");
    expect(lastPrompt!).toContain("import { test, expect }");

    // The returned source matches what the mock emitted, run through the
    // typecheck+import sanity gate.
    expect(structured.filename).toBe("homepage-smoke.spec.ts");
    expect(structured.source).toContain('import { test, expect } from "skeptic-cli"');
    expect(structured.source).toContain('test("homepage smoke"');
    // No stub-era notes in the new shape.
    expect(structured.notes.every((n) => !/B1\.5 stub/i.test(n))).toBe(true);
  });
});

// Worker_threads can only resolve `worker.mjs` against the dist layout, so the
// runner-touching tools (list_tests, validate_tests, run_test) drive the
// production binary over stdio instead of running in-process. Same gate as
// runner-acceptance.test.ts.
interface CapturedProgressEvent {
  event: string;
  testName?: string;
  file?: string;
  status?: string;
  command?: string;
  index?: number;
  total?: number;
}

describe.skipIf(!distAvailable)("MCP server (B1.5) — dist over stdio", () => {
  let client: Client;
  let transport: StdioClientTransport;
  const progressEvents: CapturedProgressEvent[] = [];

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: "node",
      args: [DIST, "mcp"],
      cwd: FIXTURE_DIR,
      env: process.env as Record<string, string>,
    });
    client = new Client(
      { name: "skeptic-mcp-stdio-test", version: "0.0.0" },
      { capabilities: { logging: {} } },
    );
    // Subscribe to logging notifications BEFORE connect so progress events
    // emitted during run_test land here.
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      const params = notification.params;
      if (params.logger === "skeptic-mcp" && params.data && typeof params.data === "object") {
        progressEvents.push(params.data as CapturedProgressEvent);
      }
    });
    await client.connect(transport);
    // Server only delivers logging messages after the client opts in via
    // logging/setLevel. Without this, sendLoggingMessage is silently dropped
    // by the level-filter at SDK level.
    await client.setLoggingLevel("debug");
  }, 30_000);

  afterAll(async () => {
    await client.close().catch(() => {});
  });

  it(
    "list_tests discovers the smoke + broken specs",
    async () => {
      const result = await callTool(client, "list_tests", {
        pattern: "tests/**/*.spec.ts",
      });
      const structured = result.structuredContent as {
        files: Array<{
          file: string;
          tests: Array<{ name: string; testIndex: number; skip: boolean; only: boolean }>;
          error?: string;
        }>;
      };
      expect(structured.files.length).toBeGreaterThanOrEqual(2);
      const filenames = structured.files.map((f) => path.basename(f.file)).sort();
      expect(filenames).toEqual(["broken.spec.ts", "multi.spec.ts", "smoke.spec.ts"]);
      const smoke = structured.files.find((f) => f.file.endsWith("smoke.spec.ts"));
      expect(smoke?.tests).toEqual([
        { name: "mcp smoke: trivial pass", testIndex: 0, skip: false, only: false },
      ]);
    },
    60_000,
  );

  it(
    "validate_tests reports OK for the smoke spec and ERROR for the broken one",
    async () => {
      const okResult = await callTool(client, "validate_tests", {
        files: ["tests/smoke.spec.ts"],
      });
      const okStructured = okResult.structuredContent as {
        files: Array<{
          file: string;
          status: "ok" | "error";
          diagnostics: Array<unknown>;
        }>;
      };
      expect(okStructured.files).toHaveLength(1);
      expect(okStructured.files[0]?.status).toBe("ok");

      const brokenResult = await callTool(client, "validate_tests", {
        files: ["tests/broken.spec.ts"],
      });
      const brokenStructured = brokenResult.structuredContent as {
        files: Array<{
          file: string;
          status: "ok" | "error";
          diagnostics: Array<{ category: string; message: string }>;
        }>;
      };
      expect(brokenStructured.files).toHaveLength(1);
      expect(brokenStructured.files[0]?.status).toBe("error");
      expect(brokenStructured.files[0]?.diagnostics.length).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    "run_test executes the smoke spec and returns a passing summary",
    async () => {
      const result = await callTool(client, "run_test", {
        files: ["tests/smoke.spec.ts"],
      });
      const summary = result.structuredContent as {
        total: number;
        passed: number;
        failed: number;
        tests: Array<{ name: string; status: string }>;
      };
      expect(summary.total).toBe(1);
      expect(summary.passed).toBe(1);
      expect(summary.failed).toBe(0);
      expect(summary.tests[0]?.name).toBe("mcp smoke: trivial pass");
      expect(summary.tests[0]?.status).toBe("passed");
    },
    180_000,
  );

  it(
    "run_test{testName} narrows execution to matching tests via the runner's name filter",
    async () => {
      const result = await callTool(client, "run_test", {
        files: ["tests/multi.spec.ts"],
        testName: "multi: alpha",
      });
      const summary = result.structuredContent as {
        total: number;
        passed: number;
        tests: Array<{ name: string }>;
      };
      // Only "multi: alpha" should run — "multi: beta" must NOT execute.
      expect(summary.total).toBe(1);
      expect(summary.passed).toBe(1);
      expect(summary.tests.map((t) => t.name)).toEqual(["multi: alpha"]);
    },
    180_000,
  );

  it(
    "run_test streams test:start / test:complete progress events as logging notifications",
    async () => {
      // Reset the capture buffer and run a fresh test so we know the events
      // we see came from THIS call (server is shared across tests in the suite).
      progressEvents.length = 0;
      await callTool(client, "run_test", { files: ["tests/smoke.spec.ts"] });

      const events = progressEvents.filter((e) => e.testName === "mcp smoke: trivial pass");
      const eventTypes = events.map((e) => e.event);
      expect(eventTypes).toContain("test:start");
      expect(eventTypes).toContain("test:complete");
      // step:complete WILL fire here once the runner's worker IPC ships
      // StepCompleteMessage; today only the test boundary events flow.
      const completeEvent = events.find((e) => e.event === "test:complete");
      expect(completeEvent?.status).toBe("passed");
    },
    180_000,
  );
});
