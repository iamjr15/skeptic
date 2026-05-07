/**
 * ACP server for IDE and agent integrations.
 *
 * Stdio framing: the SDK frames newline-delimited JSON over stdout, so logs
 * are diverted to stderr via `redirectStdoutLogsToStderr()` before the
 * transport opens.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionId,
  SetSessionModeRequest,
  SetSessionModeResponse,
  ToolCallContent,
} from "@agentclientprotocol/sdk";
import fastGlob from "fast-glob";
import { OUTPUT_DIR_DEFAULT, PRODUCT_NAME } from "../constants.js";
import { loadConfig } from "../config/loader.js";
import { redirectStdoutLogsToStderr } from "../utils/log-stdio.js";
import { logger } from "../utils/logger.js";
import {
  listSpecs,
  runSpecs,
  type FileManifest,
  type WorkerStartConfig,
} from "../runner/index.js";
import type { Reporter, RunSummary, TestIdentifier } from "../reporter/types.js";
import type { TestResult, StepResult } from "../executor/types.js";
import { DEVICE_PROFILES } from "../config/device-profiles.js";
import { parsePromptToToolCall, helpMessage, type ToolDispatch } from "./acp-prompt-parser.js";
import { typecheckSpecs, mergeImportErrors } from "./spec-validation.js";
import { createAIClient, AIFeatureNotBuiltError } from "../ai/client-factory.js";
import { generateFromDescription } from "../ai/test-generator.js";
import { missingClientMessage } from "../ai/security.js";

interface SessionState {
  cwd: string;
  cwdReal: string;
  abort: AbortController | null;
}

const PROTOCOL_VERSION_FALLBACK = 1;

/** Reject paths that escape the session root via traversal, absolute path, or symlink. */
export const boundPath = (
  rootDir: string,
  rootDirReal: string,
  requested: string,
): string => {
  if (path.isAbsolute(requested)) {
    throw new Error(`Path must be relative to session root: ${requested}`);
  }
  const resolved = path.resolve(rootDir, requested);
  const rel = path.relative(rootDir, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes session root: ${requested}`);
  }
  if (fs.existsSync(resolved)) {
    const realResolved = fs.realpathSync(resolved);
    const realRel = path.relative(rootDirReal, realResolved);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
      throw new Error(`Symlink escapes session root: ${requested}`);
    }
  }
  return resolved;
};

/** Glob expansion variant of boundPath for spec files. */
export const boundResolveSpecs = async (
  rootDir: string,
  rootDirReal: string,
  patterns: string | string[],
): Promise<string[]> => {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  for (const p of list) {
    if (path.isAbsolute(p) || p.startsWith("..") || p.includes("/../")) {
      throw new Error(`Glob pattern must be relative to session root: ${p}`);
    }
  }
  const matched = await fastGlob(list, { cwd: rootDir, absolute: true, onlyFiles: true });
  const validated: string[] = [];
  for (const file of matched) {
    let real: string;
    try {
      real = fs.realpathSync(file);
    } catch {
      continue;
    }
    const realRel = path.relative(rootDirReal, real);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
      throw new Error(`Glob match escapes session root via symlink: ${file}`);
    }
    validated.push(file);
  }
  return validated;
};

const buildAcpWorkerConfig = (
  cfg: ReturnType<typeof loadConfig>,
  outputDir: string,
): WorkerStartConfig => {
  const workerConfig: WorkerStartConfig = {
    timeout: cfg.browser.timeout,
    hardTimeout: cfg.browser.timeout,
    outputDir,
    envOverrides: { ...cfg.env },
    observability: {
      forceAll: false,
      consoleRedaction: cfg.observability.consoleRedaction ?? true,
      networkCaptureLimit: cfg.observability.networkCaptureLimit,
      duplicateWindowMs: cfg.observability.duplicateWindowMs,
      consoleCaptureLimit: cfg.observability.consoleCaptureLimit ?? 200,
      accessibilityDualEngine: cfg.observability.accessibilityDualEngine,
      accessibilityHtmlSnippetLimit: cfg.observability.accessibilityHtmlSnippetLimit,
      accessibilityStandard: cfg.observability.accessibilityStandard ?? "WCAG21AA",
      autoAccessibilityAudit: cfg.observability.autoAccessibilityAudit ?? false,
      accessibilityMaxRulesPerImpact:
        cfg.observability.accessibilityMaxRulesPerImpact ?? 100,
    },
    artifact: {
      fullPageScreenshots: cfg.observability.fullPageScreenshots,
      blankFrameDetection: cfg.observability.blankFrameDetection ?? "warn",
      writeSidecars: false,
    },
    video: false,
    trace: false,
    headed: !cfg.browser.headless,
    browserEngine: cfg.browser.engine,
    viewport: cfg.browser.viewport,
    retries: cfg.execution.retries,
    parallel: cfg.execution.parallel,
  };
  if (cfg.url) workerConfig.baseUrl = cfg.url;
  if (cfg.browser.device) workerConfig.device = cfg.browser.device;
  if (cfg.auth.cookies) workerConfig.cookies = { enabled: true };
  return workerConfig;
};

const textBlock = (text: string): ToolCallContent => ({
  type: "content",
  content: { type: "text", text },
});

const stringifyManifests = (manifests: FileManifest[]): string => {
  if (manifests.length === 0) return "(no spec files matched)";
  const lines: string[] = [];
  for (const m of manifests) {
    const rel = m.file;
    if (m.error) {
      lines.push(`✗ ${rel} — discovery error: ${m.error.message}`);
      continue;
    }
    lines.push(`${rel} (${m.tests.length} test${m.tests.length === 1 ? "" : "s"})`);
    for (const t of m.tests) {
      const flag = t.skip ? " [skip]" : t.only ? " [only]" : "";
      lines.push(`  #${t.ordinal} ${t.name}${flag}`);
    }
  }
  return lines.join("\n");
};

const stringifyRunSummary = (summary: RunSummary): string => {
  const lines: string[] = [];
  lines.push(
    `${summary.passed}/${summary.total} passed (${summary.duration_ms}ms${summary.failed > 0 ? `, ${summary.failed} failed` : ""})`,
  );
  for (const t of summary.tests) {
    const status = t.status === "passed" ? "✓" : "✗";
    lines.push(`  ${status} ${t.name} (${t.duration_ms}ms)`);
    if (t.status !== "passed") {
      const failedStep = t.steps.find((s: StepResult) => s.status !== "passed");
      if (failedStep?.error) {
        const trimmed = failedStep.error.length > 512 ? `${failedStep.error.slice(0, 512)}…` : failedStep.error;
        lines.push(`      → ${trimmed}`);
      }
    }
  }
  return lines.join("\n");
};

class SkepticAgent implements Agent {
  readonly connection: AgentSideConnection;
  readonly sessions = new Map<SessionId, SessionState>();
  private toolCallCounter = 0;

  constructor(connection: AgentSideConnection) {
    this.connection = connection;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION ?? PROTOCOL_VERSION_FALLBACK,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: "skeptic-acp", version: __SKEPTIC_CLI_VERSION__ },
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  async setSessionMode(_params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = randomSessionId();
    const cwd = params.cwd && path.isAbsolute(params.cwd) ? params.cwd : process.cwd();
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`session cwd is not a directory: ${cwd}`);
    }
    const cwdReal = fs.realpathSync(cwd);
    this.sessions.set(sessionId, { cwd, cwdReal, abort: null });
    return { sessionId };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    session?.abort?.abort();
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Session ${params.sessionId} not found`);

    // Cancel any in-flight prompt (shouldn't happen — clients serialize).
    session.abort?.abort();
    session.abort = new AbortController();
    const signal = session.abort.signal;

    const text = extractPromptText(params);
    const dispatch = parsePromptToToolCall(text);
    if (!dispatch) {
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: helpMessage() },
        },
      });
      session.abort = null;
      return { stopReason: "end_turn" };
    }

    try {
      await this.dispatchTool(params.sessionId, session, dispatch, signal);
    } catch (err) {
      if (signal.aborted) {
        return { stopReason: "cancelled" };
      }
      // Tool-level failure surfaces via the final tool_call_update.status: "failed"
      // (lessons.md #18: StopReason has no "error" variant). Surface a tail
      // message so the client gets a readable summary, then fall through to
      // the end_turn return below.
      const message = err instanceof Error ? err.message : String(err);
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `skeptic: ${message}` },
        },
      });
    } finally {
      session.abort = null;
    }
    return { stopReason: "end_turn" };
  }

  private async dispatchTool(
    sessionId: SessionId,
    session: SessionState,
    dispatch: ToolDispatch,
    signal: AbortSignal,
  ): Promise<void> {
    const toolCallId = this.nextToolCallId();
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: dispatch.title,
        status: "in_progress",
        kind: "execute",
        rawInput: dispatch.args as unknown as Record<string, unknown>,
      },
    });

    try {
      switch (dispatch.tool) {
        case "list_tests":
          await this.runListTests(sessionId, session, dispatch, toolCallId);
          break;
        case "validate_tests":
          await this.runValidateTests(sessionId, session, dispatch, toolCallId);
          break;
        case "run_test":
          await this.runRunTest(sessionId, session, dispatch, toolCallId, signal);
          break;
        case "generate_test":
          await this.runGenerateTest(sessionId, session, dispatch, toolCallId);
          break;
        case "list_devices":
          await this.runListDevices(sessionId, toolCallId);
          break;
        case "load_guidance":
          await this.runLoadGuidance(sessionId, session, dispatch, toolCallId);
          break;
      }
    } catch (err) {
      const message = signal.aborted
        ? "Cancelled by user."
        : err instanceof Error
          ? err.message
          : String(err);
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "failed",
          content: [textBlock(message)],
        },
      });
      throw err;
    }
  }

  private nextToolCallId(): string {
    this.toolCallCounter += 1;
    return `skeptic-${this.toolCallCounter}`;
  }

  private resolvePattern(session: SessionState, dispatch: ToolDispatch): string | string[] {
    const pattern = dispatch.args["pattern"] as string | undefined;
    const file = dispatch.args["file"] as string | undefined;
    const files = dispatch.args["files"] as string[] | undefined;
    if (Array.isArray(files)) {
      // Validate each via boundPath, but pass through the relative form so
      // listSpecs can resolve via cwd (matches the realpath envelope).
      for (const f of files) boundPath(session.cwd, session.cwdReal, f);
      return files;
    }
    if (file) {
      boundPath(session.cwd, session.cwdReal, file);
      return file;
    }
    return pattern ?? "tests/**/*.spec.ts";
  }

  private async runListTests(
    sessionId: SessionId,
    session: SessionState,
    dispatch: ToolDispatch,
    toolCallId: string,
  ): Promise<void> {
    const pattern = this.resolvePattern(session, dispatch);
    // boundResolveSpecs enforces the realpath envelope on globs; non-glob
    // single files are validated by resolvePattern.
    if (typeof pattern === "string" && /[*?[]/.test(pattern)) {
      await boundResolveSpecs(session.cwd, session.cwdReal, pattern);
    }
    const { manifests } = await listSpecs(pattern, session.cwd);
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [textBlock(stringifyManifests(manifests))],
        rawOutput: { files: manifests.map((m) => ({ file: m.file, tests: m.tests.length })) },
      },
    });
  }

  private async runValidateTests(
    sessionId: SessionId,
    session: SessionState,
    dispatch: ToolDispatch,
    toolCallId: string,
  ): Promise<void> {
    const pattern = this.resolvePattern(session, dispatch);
    const targets = Array.isArray(pattern)
      ? await Promise.all(pattern.map(async (f) => boundPath(session.cwd, session.cwdReal, f)))
      : (await boundResolveSpecs(session.cwd, session.cwdReal, pattern));

    const { manifests } = await listSpecs(targets, session.cwd);
    const importErrors = new Map<string, string>();
    for (const m of manifests) {
      if (m.error) importErrors.set(m.file, m.error.message);
    }
    const tsFiles = await typecheckSpecs(targets, session.cwd);
    const results = mergeImportErrors(tsFiles, importErrors, targets);

    const ok = results.filter((r) => r.status === "ok").length;
    const lines: string[] = [
      `${ok}/${results.length} spec file${results.length === 1 ? "" : "s"} validate cleanly`,
    ];
    for (const r of results) {
      if (r.status === "ok") {
        lines.push(`✓ ${r.file}`);
      } else {
        lines.push(`✗ ${r.file}`);
        for (const d of r.diagnostics) {
          const loc = d.line !== undefined ? `:${d.line}${d.column !== undefined ? `:${d.column}` : ""}` : "";
          const codePrefix = d.code !== undefined ? ` TS${d.code}` : "";
          lines.push(`    [${d.category}${codePrefix}]${loc} ${d.message}`);
        }
      }
    }
    const allOk = results.every((r) => r.status === "ok");
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: allOk ? "completed" : "failed",
        content: [textBlock(lines.join("\n"))],
        rawOutput: { files: results },
      },
    });
  }

  private async runRunTest(
    sessionId: SessionId,
    session: SessionState,
    dispatch: ToolDispatch,
    toolCallId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const pattern = this.resolvePattern(session, dispatch);
    if (typeof pattern === "string" && /[*?[]/.test(pattern)) {
      await boundResolveSpecs(session.cwd, session.cwdReal, pattern);
    }

    const cfg = loadConfig({ searchCwd: session.cwd });
    const outputDir = path.resolve(session.cwd, cfg.output.dir ?? OUTPUT_DIR_DEFAULT);
    const workerConfig = buildAcpWorkerConfig(cfg, outputDir);

    const reporter: Reporter = {
      onTestStart: (test: TestIdentifier) => {
        void this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
            content: [textBlock(`▶ ${test.name}  (${test.file})`)],
          },
        });
      },
      // onStepStart wires through the (currently optional) runner hook so when
      // the runner adds step:start emission, ACP forwards it without further
      // changes. The runner's IPC currently only ships step:complete.
      onStepStart: (
        step: { command: string; args: unknown },
        index: number,
        total: number,
        test: TestIdentifier,
      ): void => {
        void this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
            content: [
              textBlock(`  ${test.name} step ${index + 1}/${total} ${step.command}: started`),
            ],
          },
        });
      },
      onStepComplete: (
        step: StepResult,
        index: number,
        total: number,
        test: TestIdentifier,
      ): void => {
        // Always surface step results so clients see the streaming pulse;
        // failures get a louder marker so they're easy to spot in the log.
        const marker = step.status === "passed" ? "·" : "✗";
        void this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
            content: [
              textBlock(
                `  ${marker} ${test.name} step ${index + 1}/${total} ${step.command}: ${step.status}`,
              ),
            ],
          },
        });
      },
      onTestComplete: (result: TestResult) => {
        void this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
            content: [
              textBlock(
                `${result.status === "passed" ? "✓" : "✗"} ${result.name} (${result.duration_ms}ms)`,
              ),
            ],
          },
        });
      },
      onRunComplete: () => {
        /* terminal summary handled below */
      },
    };

    const runPromise = runSpecs({
      patterns: pattern,
      cwd: session.cwd,
      reporters: [reporter],
      config: workerConfig,
      bail: false,
    });

    const cancelPromise = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => reject(new Error("cancelled"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });

    const outcome = await Promise.race([runPromise, cancelPromise]);

    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: outcome.summary.failed > 0 ? "failed" : "completed",
        content: [textBlock(stringifyRunSummary(outcome.summary))],
        rawOutput: {
          total: outcome.summary.total,
          passed: outcome.summary.passed,
          failed: outcome.summary.failed,
          duration_ms: outcome.summary.duration_ms,
        },
      },
    });
  }

  private async runGenerateTest(
    sessionId: SessionId,
    session: SessionState,
    dispatch: ToolDispatch,
    toolCallId: string,
  ): Promise<void> {
    const description = (dispatch.args["description"] as string | undefined) ?? "generated test";
    const cfg = loadConfig({ searchCwd: session.cwd });
    let client;
    try {
      client = await createAIClient({
        provider: cfg.ai.provider,
        ...(cfg.ai.apiKey !== undefined ? { apiKey: cfg.ai.apiKey } : {}),
        ...(cfg.ai.model !== undefined ? { model: cfg.ai.model } : {}),
      });
    } catch (err) {
      if (err instanceof AIFeatureNotBuiltError) {
        await this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "failed",
            content: [textBlock(err.message)],
          },
        });
        return;
      }
      throw err;
    }
    if (!client) {
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "failed",
          content: [textBlock(missingClientMessage(cfg.ai))],
        },
      });
      return;
    }

    const [generated] = await generateFromDescription(client, description, cfg.url, session.cwd);
    if (!generated) {
      throw new Error("generate_test produced no tests");
    }
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [textBlock(`Proposed file: ${generated.filename}\n\n\`\`\`ts\n${generated.source}\`\`\``)],
      },
    });
  }

  private async runListDevices(sessionId: SessionId, toolCallId: string): Promise<void> {
    const lines = Object.entries(DEVICE_PROFILES).map(
      ([id, d]) => `${id}\t${d.width}×${d.height}@${d.dpr}x`,
    );
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [textBlock(lines.join("\n"))],
      },
    });
  }

  private async runLoadGuidance(
    sessionId: SessionId,
    session: SessionState,
    dispatch: ToolDispatch,
    toolCallId: string,
  ): Promise<void> {
    const domain = (dispatch.args["domain"] as string | undefined) ?? "";
    const safe = domain.replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safe) {
      throw new Error(`load_guidance: invalid domain '${domain}'`);
    }
    const guidancePath = path.resolve(session.cwd, "guidance", `${safe}.md`);
    boundPath(session.cwd, session.cwdReal, path.relative(session.cwd, guidancePath));
    if (!fs.existsSync(guidancePath)) {
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "failed",
          content: [textBlock(`No guidance found at ${path.relative(session.cwd, guidancePath)}`)],
        },
      });
      return;
    }
    const content = fs.readFileSync(guidancePath, "utf-8");
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [textBlock(content)],
      },
    });
  }
}

const extractPromptText = (params: PromptRequest): string => {
  for (const block of params.prompt) {
    if (block.type === "text") return block.text;
  }
  return "";
};

const randomSessionId = (): SessionId => {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("") as SessionId;
};

/**
 * Build the agent connection over the supplied stdio streams. Exported for
 * in-process integration tests; the production path wires `process.stdin` /
 * `process.stdout` and is invoked by `runAcp`.
 */
export const buildAcpConnection = (input: ReadableStream<Uint8Array>, output: WritableStream<Uint8Array>): AgentSideConnection => {
  const stream = acp.ndJsonStream(output, input);
  return new acp.AgentSideConnection((conn) => new SkepticAgent(conn), stream);
};

export const runAcp = async (): Promise<void> => {
  // Stdio framing: stdout is JSON-RPC, stderr is for logs. Redirect BEFORE
  // the SDK opens the transport (lessons.md #19).
  redirectStdoutLogsToStderr();
  logger.info(`${PRODUCT_NAME} ACP server starting (stdio)…`);

  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const connection = buildAcpConnection(input, output);
  await connection.closed;
};

// Test-only export for unit coverage of worker config construction.
export const __testing = { SkepticAgent };
