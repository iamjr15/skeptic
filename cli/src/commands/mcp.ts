/**
 * MCP server for AI agent integration.
 *
 * Discovery (`list_tests`/`validate_tests`) imports specs in throwaway workers
 * via the runner's existing `discover()` path; that worker never reaches the
 * execution path, so a spec's top-level side effects fire but its `test(...)`
 * callbacks do not. `run_test` delegates to `runSpecs` so worker-per-file
 * isolation, hard-timeout enforcement, and reporter wiring all carry forward.
 *
 * Stdio framing: stdout is owned by the JSON-RPC transport; logs go to stderr
 * via `redirectStdoutLogsToStderr()` before the transport opens.
 */
import * as path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OUTPUT_DIR_DEFAULT, PRODUCT_NAME } from "../constants.js";
import { loadConfig } from "../config/loader.js";
import { redirectStdoutLogsToStderr } from "../utils/log-stdio.js";
import { logger } from "../utils/logger.js";
import {
  listSpecs,
  runSpecs,
  type FileManifest,
  type ManifestEntry,
  type RunnerExecuteOutcome,
  type WorkerStartConfig,
} from "../runner/index.js";
import type { Reporter, RunSummary, TestIdentifier } from "../reporter/types.js";
import type { StepResult, TestResult } from "../executor/types.js";
import {
  typecheckSpecs,
  mergeImportErrors,
  type SpecValidateFileResult,
} from "./spec-validation.js";
import type { AIClient } from "../ai/ai-client.js";
import { createAIClient, AIFeatureNotBuiltError } from "../ai/client-factory.js";
import { missingClientMessage } from "../ai/security.js";
import { generateFromDescription } from "../ai/test-generator.js";
import { registerBrowserMcpTools } from "../mcp/browser-tools.js";

interface ListTestsResult {
  files: Array<{
    file: string;
    tests: Array<{ name: string; testIndex: number; skip: boolean; only: boolean }>;
    error?: string;
  }>;
}

interface ValidateTestsResult {
  files: SpecValidateFileResult[];
}

interface GenerateTestResult {
  source: string;
  filename: string;
  notes: string[];
}

interface RunTestSummary {
  total: number;
  passed: number;
  failed: number;
  duration_ms: number;
  tests: Array<{
    name: string;
    file: string;
    status: TestResult["status"];
    duration_ms: number;
    error?: string | undefined;
  }>;
}

const sanitizeStepError = (err: string | undefined): string | undefined => {
  if (!err) return undefined;
  // Cap at 1 KB to keep MCP frames small; the JSON reporter already redacts
  // PII before constructing TestResult so we just truncate here.
  return err.length > 1024 ? `${err.slice(0, 1024)}…` : err;
};

const summarizeTests = (summary: RunSummary): RunTestSummary => ({
  total: summary.total,
  passed: summary.passed,
  failed: summary.failed,
  duration_ms: summary.duration_ms,
  tests: summary.tests.map((t) => {
    const failedStep = t.steps.find((s: StepResult) => s.status !== "passed");
    return {
      name: t.name,
      file: t.file,
      status: t.status,
      duration_ms: t.duration_ms,
      error: sanitizeStepError(failedStep?.error),
    };
  }),
});

const PROGRESS_LOGGER = "skeptic-mcp";

interface ProgressEvent {
  event: "test:start" | "test:complete" | "step:start" | "step:complete";
  testName?: string;
  file?: string;
  status?: TestResult["status"];
  index?: number;
  total?: number;
  command?: string;
}

/**
 * Reporter that pipes runner events into a single emit() callback. Wires every
 * Reporter hook the runner currently calls (onTestStart, onStepComplete,
 * onTestComplete) plus the optional `onStepStart` so when the runner adds
 * step-start emission (B1's IPC currently only ships step:complete), MCP
 * forwards step:start automatically.
 */
const buildProgressReporter = (
  emit: (event: ProgressEvent) => void,
): Reporter => ({
  onTestStart(test: TestIdentifier): void {
    emit({ event: "test:start", testName: test.name, file: test.file });
  },
  onStepStart(
    step: { command: string; args: unknown },
    index: number,
    total: number,
    test: TestIdentifier,
  ): void {
    emit({
      event: "step:start",
      testName: test.name,
      file: test.file,
      index,
      total,
      command: step.command,
    });
  },
  onStepComplete(step: StepResult, index: number, total: number, test: TestIdentifier): void {
    emit({
      event: "step:complete",
      testName: test.name,
      file: test.file,
      index,
      total,
      command: step.command,
    });
  },
  onTestComplete(result: TestResult, test: TestIdentifier): void {
    emit({
      event: "test:complete",
      testName: test.name,
      file: test.file,
      status: result.status,
    });
  },
  onRunComplete(): void {
    /* terminal summary is returned as the tool result, not streamed */
  },
});

/**
 * Build a `WorkerStartConfig` from the project's resolved config. Mirrors what
 * `commands/run.ts` does when no flags are given — MCP run_test is intended for
 * agent-driven smoke runs, so we keep flag overrides minimal.
 */
export const buildMcpWorkerConfig = (
  cfg: ReturnType<typeof loadConfig>,
  outputDir: string,
  envOverrides: Record<string, string>,
  overrides: { headed?: boolean; baseUrl?: string } = {},
): WorkerStartConfig => {
  const workerConfig: WorkerStartConfig = {
    timeout: cfg.browser.timeout,
    hardTimeout: cfg.browser.timeout,
    outputDir,
    envOverrides,
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
    headed: overrides.headed ?? !cfg.browser.headless,
    browserEngine: cfg.browser.engine,
    viewport: cfg.browser.viewport,
    retries: cfg.execution.retries,
    parallel: cfg.execution.parallel,
    // MCP runs happen inside a long-lived stdio child. Prewarming the daemon
    // from the parent CLI is not available here, so use the deterministic
    // fresh-launch branch and avoid worker-side daemon spawn timeouts.
    noDaemon: true,
  };
  const baseUrl = overrides.baseUrl ?? cfg.url;
  if (baseUrl) workerConfig.baseUrl = baseUrl;
  if (cfg.browser.device) workerConfig.device = cfg.browser.device;
  if (cfg.auth.cookies) workerConfig.cookies = { enabled: true };
  return workerConfig;
};

const manifestsToListResult = (manifests: FileManifest[]): ListTestsResult => ({
  files: manifests.map((m) => {
    const file: ListTestsResult["files"][number] = {
      file: m.file,
      tests: m.tests.map((t: ManifestEntry) => ({
        name: t.name,
        testIndex: t.ordinal,
        skip: t.skip,
        only: t.only,
      })),
    };
    if (m.error) file.error = m.error.message;
    return file;
  }),
});

/**
 * Build a `generate_test` response for the no-AI fallback path. We don't crash
 * the MCP call — agents asking for code generation against a binary that
 * lacks AI need a structured signal they can react to (e.g. surface a config
 * hint to the user) without losing the response frame.
 */
const buildGenerateFallback = (note: string): GenerateTestResult => ({
  source: "",
  filename: "",
  notes: [note],
});

interface BuildMcpServerOptions {
  cwd?: string;
  /**
   * Test seam: inject a pre-built AIClient instead of calling
   * `createAIClient(config.ai)`. Production callers leave this undefined.
   */
  aiClientOverride?: AIClient | null;
}

/**
 * Build (but do not start) the MCP server. Exported for in-process integration
 * tests — they wire a transport pair directly to avoid spawning a child.
 */
export const buildMcpServer = (options: BuildMcpServerOptions = {}): McpServer => {
  const cwd = options.cwd ?? process.cwd();

  // `capabilities.logging: {}` is required for `sendLoggingMessage` to actually
  // deliver — the SDK silently drops calls when the server doesn't advertise
  // logging support. run_test streams test:start / step:* / test:complete via
  // logging notifications, so this gate is load-bearing.
  const server = new McpServer(
    { name: "skeptic-mcp", version: __SKEPTIC_CLI_VERSION__ },
    { capabilities: { logging: {} } },
  );

  server.registerTool(
    "list_tests",
    {
      title: "List skeptic tests",
      description:
        "Glob *.spec.ts under the session root and emit per-file test names + indices via the runner's discovery pass. " +
        "Discovery imports each spec under tsx so module top-level side effects fire ONCE per list_tests call — but " +
        "no test() body runs. Worst case across list_tests + run_test: each spec imports twice (discovery + execution " +
        "worker). Don't put browser-level side effects at the top of a spec.",
      inputSchema: {
        pattern: z
          .string()
          .optional()
          .describe(
            "Glob pattern relative to the session root (default: tests/**/*.spec.ts).",
          ),
      },
      outputSchema: {
        files: z.array(
          z.object({
            file: z.string(),
            tests: z.array(
              z.object({
                name: z.string(),
                testIndex: z.number().int().nonnegative(),
                skip: z.boolean(),
                only: z.boolean(),
              }),
            ),
            error: z.string().optional(),
          }),
        ),
      },
    },
    async (args): Promise<CallToolResult> => {
      const pattern = args?.pattern ?? "tests/**/*.spec.ts";
      const { manifests } = await listSpecs(pattern, cwd);
      const result = manifestsToListResult(manifests);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "validate_tests",
    {
      title: "Validate skeptic tests",
      description:
        "Typecheck spec files via the TypeScript compiler API and run the runner's tsx-import sanity pass. " +
        "Never executes the tests. Discovery imports each spec under tsx — top-level side effects fire ONCE per " +
        "validate_tests call (and once more per list_tests/run_test). Don't put browser-level side effects at the " +
        "top of a spec.",
      inputSchema: {
        files: z.array(z.string()).optional().describe("Explicit list of spec paths."),
        pattern: z
          .string()
          .optional()
          .describe("Glob pattern (used when `files` is not provided)."),
      },
      outputSchema: {
        files: z.array(
          z.object({
            file: z.string(),
            status: z.enum(["ok", "error"]),
            diagnostics: z.array(
              z.object({
                file: z.string(),
                line: z.number().int().optional(),
                column: z.number().int().optional(),
                code: z.union([z.number(), z.string()]).optional(),
                category: z.enum(["error", "warning", "import"]),
                message: z.string(),
              }),
            ),
          }),
        ),
      },
    },
    async (args): Promise<CallToolResult> => {
      const explicit = args?.files ?? [];
      const pattern = args?.pattern;
      let targets: string[];
      if (explicit.length > 0) {
        targets = explicit.map((f: string) => path.resolve(cwd, f));
      } else {
        const { manifests } = await listSpecs(pattern ?? "tests/**/*.spec.ts", cwd);
        targets = manifests.map((m) => m.file);
      }

      if (targets.length === 0) {
        const empty: ValidateTestsResult = { files: [] };
        return {
          content: [{ type: "text", text: JSON.stringify(empty) }],
          structuredContent: empty as unknown as Record<string, unknown>,
        };
      }

      const importResult = await listSpecs(targets, cwd);
      const importErrors = new Map<string, string>();
      for (const m of importResult.manifests) {
        if (m.error) importErrors.set(m.file, m.error.message);
      }

      const tsFiles = await typecheckSpecs(targets, cwd);
      const merged = mergeImportErrors(tsFiles, importErrors, targets);
      const result: ValidateTestsResult = { files: merged };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "generate_test",
    {
      title: "Generate skeptic test",
      description:
        "Generate a *.spec.ts file from a natural-language description using the configured AI provider. " +
        "The output is run through `tsc --noEmit` and dynamic-imported to verify it registers ≥1 `test(...)` call " +
        "before being returned. When no API key is configured (or AI assertions weren't built into the binary), " +
        "the call returns an empty `source` with a `notes[]` entry explaining how to enable AI — agents should " +
        "surface that note rather than treat the empty source as a valid test.",
      inputSchema: {
        description: z.string().describe("Natural-language description of the test to generate."),
        url: z.string().url().optional().describe("Target URL the test should navigate to."),
      },
      outputSchema: {
        source: z.string(),
        filename: z.string(),
        notes: z.array(z.string()),
      },
    },
    async (args): Promise<CallToolResult> => {
      const cfg = loadConfig({ searchCwd: cwd });
      const baseUrl = args.url ?? cfg.url;

      // Resolve the AIClient. The override is the test seam; production
      // calls run through createAIClient. Both paths use the same fallback
      // shape so MCP callers don't have to branch on which built the binary.
      let client: AIClient | undefined;
      try {
        if (options.aiClientOverride !== undefined) {
          client = options.aiClientOverride ?? undefined;
        } else {
          client = await createAIClient({
            provider: cfg.ai.provider,
            ...(cfg.ai.apiKey !== undefined ? { apiKey: cfg.ai.apiKey } : {}),
            ...(cfg.ai.model !== undefined ? { model: cfg.ai.model } : {}),
          });
        }
      } catch (err) {
        if (err instanceof AIFeatureNotBuiltError) {
          const fallback = buildGenerateFallback(err.message);
          return {
            content: [{ type: "text", text: JSON.stringify(fallback) }],
            structuredContent: fallback as unknown as Record<string, unknown>,
          };
        }
        throw err;
      }

      if (!client) {
        const fallback = buildGenerateFallback(missingClientMessage(cfg.ai));
        return {
          content: [{ type: "text", text: JSON.stringify(fallback) }],
          structuredContent: fallback as unknown as Record<string, unknown>,
        };
      }

      try {
        const generated = await generateFromDescription(
          client,
          args.description,
          baseUrl,
          cwd,
        );
        const first = generated[0];
        if (!first) {
          const fallback = buildGenerateFallback(
            "[skeptic] generator returned no results — try refining the description.",
          );
          return {
            content: [{ type: "text", text: JSON.stringify(fallback) }],
            structuredContent: fallback as unknown as Record<string, unknown>,
          };
        }
        const result: GenerateTestResult = {
          source: first.source,
          filename: first.filename,
          notes: first.diagnostics,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const fallback = buildGenerateFallback(message);
        return {
          content: [{ type: "text", text: JSON.stringify(fallback) }],
          structuredContent: fallback as unknown as Record<string, unknown>,
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "run_test",
    {
      title: "Run skeptic tests",
      description:
        "Invoke the runner against one or more spec files. `testName` narrows execution to matching tests via the " +
        "runner's name filter — unrelated tests in the same file do not run. Streams `test:start` / `step:start` / " +
        "`step:complete` / `test:complete` events as MCP logging notifications during the run; returns a RunSummary " +
        "JSON when complete. Honors worker-per-file isolation and hard-timeout enforcement. Discovery imports each " +
        "spec under tsx — top-level side effects fire ONCE per run_test call (and once more per execution worker, " +
        "i.e. twice in worst case). Don't put browser-level side effects at the top of a spec.",
      inputSchema: {
        files: z.array(z.string()).optional().describe("Explicit spec paths to run."),
        pattern: z.string().optional().describe("Glob pattern (used when `files` is not provided)."),
        testName: z
          .string()
          .optional()
          .describe(
            "Optional test name filter — only tests whose registered name === testName run. " +
              "Plumbed into the runner's name filter so unrelated tests are NOT executed.",
          ),
        url: z.string().url().optional().describe("Override base URL (overrides config)."),
        headed: z.boolean().optional().describe("Run browser in headed mode (default: headless)."),
      },
      outputSchema: {
        total: z.number().int().nonnegative(),
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        duration_ms: z.number().nonnegative(),
        tests: z.array(
          z.object({
            name: z.string(),
            file: z.string(),
            status: z.enum(["passed", "failed", "error"]),
            duration_ms: z.number().nonnegative(),
            error: z.string().optional(),
          }),
        ),
      },
    },
    async (args): Promise<CallToolResult> => {
      const cfg = loadConfig({ searchCwd: cwd });
      const outputDir = cfg.output.dir ?? OUTPUT_DIR_DEFAULT;
      const envOverrides: Record<string, string> = { ...cfg.env };
      const workerConfig = buildMcpWorkerConfig(cfg, outputDir, envOverrides, {
        ...(args.headed !== undefined ? { headed: args.headed } : {}),
        ...(args.url !== undefined ? { baseUrl: args.url } : {}),
      });

      const patterns =
        args.files && args.files.length > 0
          ? args.files
          : args.pattern
            ? [args.pattern]
            : Array.isArray(cfg.tests)
              ? cfg.tests
              : [cfg.tests];

      const reporters: Reporter[] = [
        buildProgressReporter((event) => {
          // Per-event MCP logging notification. The client typically renders
          // these as a streaming progress feed.
          server
            .sendLoggingMessage({
              level: "info",
              logger: PROGRESS_LOGGER,
              data: event,
            })
            .catch(() => {
              /* connection may have dropped — best effort */
            });
        }),
      ];

      const outcome: RunnerExecuteOutcome & { manifests?: unknown } = await runSpecs({
        patterns,
        cwd,
        reporters,
        config: workerConfig,
        bail: false,
        ...(args.testName ? { nameFilter: [args.testName] } : {}),
      });

      const summary = summarizeTests(outcome.summary);
      return {
        content: [{ type: "text", text: JSON.stringify(summary) }],
        structuredContent: summary as unknown as Record<string, unknown>,
      };
    },
  );

  registerBrowserMcpTools(server, { cwd });

  return server;
};

export const runMcp = async (): Promise<void> => {
  // Stdio framing: stdout is JSON-RPC, stderr is for logs. Redirect BEFORE
  // the SDK opens the transport (lessons.md #19). Order matters — any stray
  // stdout write after this corrupts the channel.
  redirectStdoutLogsToStderr();
  logger.info(`${PRODUCT_NAME} MCP server starting (stdio)…`);

  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Block until the transport closes. In Node's TLA entrypoint an unresolved
  // promise does not keep the event loop alive, so also resolve on stdin close;
  // otherwise `node dist/skeptic.mjs mcp` can emit the noisy "unsettled
  // top-level await" warning after clients disconnect.
  await new Promise<void>((resolve) => {
    let resolved = false;
    const done = (): void => {
      if (resolved) return;
      resolved = true;
      process.stdin.off("close", done);
      process.stdin.off("end", done);
      resolve();
    };
    server.server.onclose = done;
    process.stdin.once("close", done);
    process.stdin.once("end", done);
  });
};
