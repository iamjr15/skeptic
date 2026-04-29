import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
import { buildAcpConnection } from "../../../src/commands/acp.js";

// In-process tests cover the dispatcher (parsing, sandboxing, generate_test
// stub). Worker-bound paths (list_tests, run_test) drive `dist/skeptic.mjs acp`
// via stdio so the runner finds `dist/worker.mjs`.
const DIST = path.resolve(import.meta.dirname, "../../../dist/skeptic.mjs");
const WORKER_DIST = path.resolve(import.meta.dirname, "../../../dist/worker.mjs");
const distAvailable = fs.existsSync(DIST) && fs.existsSync(WORKER_DIST);
const FIXTURE_DIR = path.resolve(import.meta.dirname, "../../fixtures/mcp");

interface ToolCallUpdate {
  type: "tool_call_update";
  toolCallId: string;
  status?: string;
  content?: Array<{ type: string; content?: { type: string; text: string } }>;
  rawOutput?: unknown;
}

interface ToolCall {
  type: "tool_call";
  toolCallId: string;
  title: string;
  status?: string;
}

interface AgentTextChunk {
  type: "agent_message_chunk";
  text: string;
}

type CapturedUpdate = ToolCall | ToolCallUpdate | AgentTextChunk;

class TestClient implements acp.Client {
  readonly updates: CapturedUpdate[] = [];

  async requestPermission(_params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    return {
      outcome: { outcome: "selected", optionId: "allow" },
    } as acp.RequestPermissionResponse;
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const u = params.update as { sessionUpdate: string } & Record<string, unknown>;
    if (u.sessionUpdate === "tool_call") {
      this.updates.push({
        type: "tool_call",
        toolCallId: u["toolCallId"] as string,
        title: u["title"] as string,
        ...(u["status"] !== undefined ? { status: u["status"] as string } : {}),
      });
    } else if (u.sessionUpdate === "tool_call_update") {
      const update: ToolCallUpdate = {
        type: "tool_call_update",
        toolCallId: u["toolCallId"] as string,
        ...(u["status"] !== undefined ? { status: u["status"] as string } : {}),
      };
      if (Array.isArray(u["content"])) update.content = u["content"] as ToolCallUpdate["content"];
      if (u["rawOutput"] !== undefined) update.rawOutput = u["rawOutput"];
      this.updates.push(update);
    } else if (u.sessionUpdate === "agent_message_chunk") {
      const content = u["content"] as { type: string; text?: string } | undefined;
      if (content && content.type === "text") {
        this.updates.push({ type: "agent_message_chunk", text: content.text ?? "" });
      }
    }
  }
}

const buildLinkedPair = (): {
  agentInput: ReadableStream<Uint8Array>;
  agentOutput: WritableStream<Uint8Array>;
  clientInput: ReadableStream<Uint8Array>;
  clientOutput: WritableStream<Uint8Array>;
} => {
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  return {
    agentInput: clientToAgent.readable,
    agentOutput: agentToClient.writable,
    clientInput: agentToClient.readable,
    clientOutput: clientToAgent.writable,
  };
};

const findCompletedToolUpdate = (
  client: TestClient,
  predicate: (u: ToolCallUpdate) => boolean = () => true,
): ToolCallUpdate | undefined => {
  return client.updates.find(
    (u): u is ToolCallUpdate =>
      u.type === "tool_call_update" &&
      (u.status === "completed" || u.status === "failed") &&
      predicate(u),
  );
};

describe("ACP server (B1.5) — in-process", () => {
  let client: acp.ClientSideConnection;
  let testClient: TestClient;
  let sessionId: acp.SessionId;

  beforeAll(async () => {
    const pair = buildLinkedPair();
    buildAcpConnection(pair.agentInput, pair.agentOutput);

    const stream = acp.ndJsonStream(pair.clientOutput, pair.clientInput);
    testClient = new TestClient();
    client = new acp.ClientSideConnection(() => testClient, stream);

    await client.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
    } as acp.InitializeRequest);

    const session = await client.newSession({
      cwd: FIXTURE_DIR,
      mcpServers: [],
    } as acp.NewSessionRequest);
    sessionId = session.sessionId;
  });

  afterAll(async () => {
    /* connection closes on test process exit */
  });

  it("dispatches `list devices` to list_devices and returns device profiles", async () => {
    testClient.updates.length = 0;
    const response = await client.prompt({
      sessionId,
      prompt: [{ type: "text", text: "list devices" }],
    } as acp.PromptRequest);
    expect(response.stopReason).toBe("end_turn");

    const update = findCompletedToolUpdate(testClient);
    expect(update?.status).toBe("completed");
    const text = update?.content?.[0]?.content?.text ?? "";
    expect(text).toMatch(/iphone|desktop|tablet/i);
  });

  it("returns the help message for unrecognized prompts", async () => {
    testClient.updates.length = 0;
    const response = await client.prompt({
      sessionId,
      prompt: [{ type: "text", text: "just chatting hello" }],
    } as acp.PromptRequest);
    expect(response.stopReason).toBe("end_turn");
    const helpChunk = testClient.updates.find(
      (u): u is AgentTextChunk => u.type === "agent_message_chunk",
    );
    expect(helpChunk?.text ?? "").toContain("*.spec.ts");
  });

  it("rejects path traversal in 'validate' prompts via boundPath", async () => {
    testClient.updates.length = 0;
    const response = await client.prompt({
      sessionId,
      prompt: [{ type: "text", text: "validate ../../etc/passwd.spec.ts" }],
    } as acp.PromptRequest);
    expect(response.stopReason).toBe("end_turn");
    const failed = testClient.updates.find(
      (u): u is ToolCallUpdate =>
        u.type === "tool_call_update" && u.status === "failed",
    );
    expect(failed).toBeDefined();
    const failureText = failed?.content?.[0]?.content?.text ?? "";
    expect(failureText).toMatch(/escapes session root|relative to session root/i);
  });

  it("dispatches `generate a test that …` to generate_test stub", async () => {
    testClient.updates.length = 0;
    const response = await client.prompt({
      sessionId,
      prompt: [{ type: "text", text: "generate a test that smokes the homepage" }],
    } as acp.PromptRequest);
    expect(response.stopReason).toBe("end_turn");

    const update = findCompletedToolUpdate(testClient);
    expect(update?.status).toBe("completed");
    const text = update?.content?.[0]?.content?.text ?? "";
    expect(text).toContain("B1.5 stub");
    expect(text).toContain('import { test, expect } from "skeptic-cli"');
  });
});

// Drive `dist/skeptic.mjs acp` via stdio so worker_threads can find dist/worker.mjs.
describe.skipIf(!distAvailable)("ACP server (B1.5) — dist over stdio", () => {
  let client: acp.ClientSideConnection;
  let testClient: TestClient;
  let sessionId: acp.SessionId;
  let proc: ChildProcessWithoutNullStreams;

  beforeAll(async () => {
    proc = spawn("node", [DIST, "acp"], {
      cwd: FIXTURE_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Convert Node streams to web streams the SDK expects.
    const procStdin = Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>;
    const procStdout = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;

    const stream = acp.ndJsonStream(procStdin, procStdout);
    testClient = new TestClient();
    client = new acp.ClientSideConnection(() => testClient, stream);

    await client.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
    } as acp.InitializeRequest);

    const session = await client.newSession({
      cwd: FIXTURE_DIR,
      mcpServers: [],
    } as acp.NewSessionRequest);
    sessionId = session.sessionId;
  }, 30_000);

  afterAll(async () => {
    proc?.kill("SIGTERM");
  });

  it(
    "dispatches `list tests` and returns the runner-discovered manifest",
    async () => {
      testClient.updates.length = 0;
      const response = await client.prompt({
        sessionId,
        prompt: [{ type: "text", text: "list tests tests/**/*.spec.ts" }],
      } as acp.PromptRequest);
      expect(response.stopReason).toBe("end_turn");

      const update = findCompletedToolUpdate(testClient);
      expect(update?.status).toBe("completed");
      const text = update?.content?.[0]?.content?.text ?? "";
      expect(text).toContain("smoke.spec.ts");
      expect(text).toContain("mcp smoke: trivial pass");
    },
    60_000,
  );

  it(
    "dispatches `run` and streams progress + final passing summary",
    async () => {
      testClient.updates.length = 0;
      const response = await client.prompt({
        sessionId,
        prompt: [{ type: "text", text: "run tests/smoke.spec.ts" }],
      } as acp.PromptRequest);
      expect(response.stopReason).toBe("end_turn");

      // Initial in_progress tool_call_update fires from the agent before the
      // run begins; per-test progress updates fire as onTestStart / onTestComplete
      // hit. Assert at least one in_progress streamed before the final state.
      const inProgressUpdates = testClient.updates.filter(
        (u): u is ToolCallUpdate =>
          u.type === "tool_call_update" && u.status === "in_progress",
      );
      expect(inProgressUpdates.length).toBeGreaterThan(0);
      const sawTestStart = inProgressUpdates.some((u) =>
        (u.content?.[0]?.content?.text ?? "").includes("mcp smoke: trivial pass"),
      );
      expect(sawTestStart).toBe(true);

      const final = findCompletedToolUpdate(testClient);
      expect(final?.status).toBe("completed");
      const summary = final?.rawOutput as { passed?: number; failed?: number };
      expect(summary?.passed).toBe(1);
      expect(summary?.failed).toBe(0);
    },
    180_000,
  );

  it(
    "dispatches `validate` and surfaces TS diagnostics for the broken spec",
    async () => {
      testClient.updates.length = 0;
      const response = await client.prompt({
        sessionId,
        prompt: [{ type: "text", text: "validate tests/broken.spec.ts" }],
      } as acp.PromptRequest);
      expect(response.stopReason).toBe("end_turn");

      const failed = testClient.updates.find(
        (u): u is ToolCallUpdate =>
          u.type === "tool_call_update" && u.status === "failed",
      );
      expect(failed).toBeDefined();
      const text = failed?.content?.[0]?.content?.text ?? "";
      expect(text).toContain("broken.spec.ts");
      // The exact TS error code for "Type 'string' is not assignable to type 'number'" is 2322.
      expect(text).toContain("error");
      const rawOutput = failed?.rawOutput as
        | { files?: Array<{ status: string; diagnostics: Array<unknown> }> }
        | undefined;
      expect(rawOutput?.files?.[0]?.status).toBe("error");
      expect((rawOutput?.files?.[0]?.diagnostics?.length ?? 0)).toBeGreaterThan(0);
    },
    60_000,
  );
});
