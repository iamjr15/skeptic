# Plan: Agent Client Protocol (ACP) Support (#27)

## Context

The Agent Client Protocol (ACP) is a JSON-RPC 2.0 protocol for **agent ↔ editor** communication, authored by Zed Industries and adopted by JetBrains, with a published spec at agentclientprotocol.com. It defines two roles: a **client** (typically an IDE / editor) sends prompts and config; an **agent** streams back thoughts, plans, and tool invocations. skeptic already speaks **MCP** (`cli/src/commands/mcp.ts`), which is a sibling protocol with overlapping JSON-RPC framing but a fundamentally different role split — MCP servers expose **tools** that AI clients call, while ACP agents are themselves **the AI** doing work, and clients (IDEs) drive them.

**Crucial finding from the source survey:** Expect is an **ACP client, not an agent**. They use `@agentclientprotocol/sdk` to **spawn external coding agents** (Claude Code, Codex, Cursor, Copilot, etc.) as subprocesses and consume their `agent_thought_chunk` / `tool_call` / `plan` streams. See `skeptic-refs/expect/packages/agent/src/acp-client.ts:548-953` (AcpClient class), `:223-546` (AcpAdapter class for each upstream agent), `:664` (ndJson framing), `:705-788` (session lifecycle). The Expect codebase therefore demonstrates the **client-side protocol shape** but doesn't show how to build the agent side.

The ACP spec defines both sides; the skeptic task is the agent side. The competitive analysis description — *"Standardized protocol for AI agent integration, so any MCP-compatible agent can drive skeptic"* — uses "MCP-compatible agent" loosely. The actual ask is: **expose skeptic as an ACP-compatible agent so editors like Claude Code, Cursor, and Zed can drive it like a coding assistant whose specialty is generating and running E2E tests.**

**What that means concretely.** When a user in Claude Code types `/skeptic test the login flow`, the editor opens an ACP session against skeptic. skeptic receives the prompt, streams back `agent_thought_chunk` ("considering the navigate target..."), creates a `plan` (proposed test steps), invokes its own `tool_call` (run the flow), and reports `tool_call_update` with progress. The user sees test execution as agentic work in their editor, with cancellation, replanning, and structured output.

**This is fundamentally different from skeptic's existing MCP server.** MCP today exposes seven tools (`run_flow`, `run_test`, `generate_flow`, etc.) that the agent calls. ACP would expose skeptic *as* an agent — skeptic gets the prompt, decides what to do, and reports progress back. The two surfaces are complementary, not competing.

**Scope decisions:**

- **skeptic-as-ACP-agent only.** Don't also build a client (Expect's role). That's a separate, larger feature ("use Claude Code to author tests via skeptic CLI"). v1 is server-side ACP.
- **Stdio transport only.** ACP also defines WebSocket and HTTP transports; stdio is the only shipping reference, and it matches skeptic's MCP transport. Defer remotes.
- **Reuse the existing MCP primitives by direct import — NO registry refactor in v1.** ACP's dispatcher invokes `parseFlowFile`, `PlaywrightEngine`, `flowToInput`, `buildMcpEngineOptions`, `loadConfig`, `createAIClient`, `loadGuidance`, `resolveFlows` directly. `cli/src/commands/mcp.ts` is unchanged in this plan. The full tool-registry abstraction is a follow-up plan.
- **Support a small set of agentic capabilities at the ACP level.** Not the full `tool_call_update` / `plan` / `config_option_update` surface yet — that's a v2. v1 ships:
  - `initialize` / `agentCapabilities` handshake
  - `newSession` (one cwd per session)
  - `prompt` (the user's natural-language ask)
  - `agent_message_chunk` (streaming output as the prompt is processed)
  - `tool_call` + `tool_call_update` for each skeptic action invoked during the session
  - Cancellation via stdin close / SIGINT
- **Use `@agentclientprotocol/sdk` directly.** Same SDK Expect uses. Don't hand-roll JSON-RPC framing — the SDK handles ndJson, request IDs, and notification dispatch.

**Out of scope (v1):**
- `plan` updates (showing the user a step plan before executing). Promising; defer.
- `config_option_update` (interactive provider/model switches mid-session). skeptic's config is file-based; this would require dual config systems.
- File-system tool exposure. ACP-compatible editors expect agents to be able to read/write project files; skeptic's job is testing, not editing. We expose **only test-related tools**.
- Multi-agent (skeptic proxying to Claude Code). Out of scope architecturally.

---

## Phase 1 — Minimal shared primitives (no registry refactor in v1)

The original draft proposed a full tool-registry refactor with a shared `skepticTool` interface plus a refactored MCP. **Removed from v1 per Codex review** — the registry abstraction is right architecturally, but it's a lot of risk to take while ACP itself is experimental and the SDK's exact wire format hasn't been validated against skeptic's needs. Smaller v1: keep `cli/src/commands/mcp.ts` exactly as it is today (no behavior changes, no test changes), and have ACP call the underlying primitives directly (`parseFlowFile`, `PlaywrightEngine`, `flowToInput`, `buildMcpEngineOptions`, `loadConfig`, `createAIClient`, `loadGuidance`, `resolveFlows`).

Once ACP is proven and its surface stabilizes, a follow-up plan can extract the tool-registry abstraction across both protocols. Until then, MCP and ACP can have small amounts of structural duplication — the underlying primitives (engine, parser, config) are already factored.

**What v1 ACP shares with MCP, by way of direct imports — not a registry:**

- `loadConfig` from `cli/src/config/loader.ts`
- `createAIClient` from `cli/src/ai/client-factory.ts`
- `parseFlowFile`, `parseFlowString` from `cli/src/parser/flow-parser.ts`
- `resolveFlows` (with explicit cwd argument) from `cli/src/parser/glob-resolver.ts`
- `PlaywrightEngine` from `cli/src/executor/playwright-engine.ts`
- `flowToInput`, `buildMcpEngineOptions` from `cli/src/commands/mcp.ts` (existing exports — unchanged)
- `loadGuidance`, `GUIDANCE_DOMAINS` from `cli/src/ai/guidance-loader.ts`
- `DEVICE_PROFILES` from `cli/src/config/device-profiles.ts`
- `missingClientMessage` from `cli/src/ai/security.ts`

**Goal of Phase 1 (now ~5 LOC):** add an optional `searchCwd` parameter to `loadConfig` so ACP can load config relative to a session's `cwd` without mutating `process.cwd()`. That's the only existing-utility change.

### 1.1 `loadConfig({ searchCwd })`

**File:** `cli/src/config/loader.ts`

Today `loadConfig({ configPath, overrides })` walks up from `process.cwd()` looking for `skeptic.config.{yaml,yml,js,mjs,cjs}`. Add an optional `searchCwd` to override that root:

```ts
export interface LoadConfigOptions {
  configPath?: string;
  overrides?: Partial<RawskepticConfig>;
  searchCwd?: string;            // override the directory from which the upward walk begins
}

export function loadConfig(opts: LoadConfigOptions = {}): skepticConfig {
  // ... existing body, except:
  // const startDir = opts.configPath ? path.dirname(opts.configPath) : process.cwd();
  const startDir = opts.configPath
    ? path.dirname(opts.configPath)
    : opts.searchCwd ?? process.cwd();
  // ... rest unchanged
}
```

Same change for `loadConfigWithMeta` if it has its own `process.cwd()` call. Existing callers (which pass no `searchCwd`) see no behavior change.

This is the single primitive ACP needs to load config relative to the session's `cwd` without `process.chdir()`.

### 1.2 (REMOVED — no registry in v1)

What was here in the original draft (full registry + MCP refactor) is deferred to a follow-up plan. Tests in `cli/__tests__/integration/commands/mcp-*.test.ts` should pass unmodified after this plan ships.

### 1.2 Tests for `loadConfig({ searchCwd })`

**File:** `cli/__tests__/unit/config/load-config-search-cwd.test.ts` (new — small)

- `loadConfig({})` walks up from `process.cwd()` (existing behavior — regression bar).
- `loadConfig({ searchCwd: "/tmp/fixture" })` walks up from `/tmp/fixture` even when `process.cwd()` is elsewhere.
- `loadConfig({ configPath: "/abs/skeptic.config.yaml" })` ignores `searchCwd` (configPath wins).
- Two concurrent `loadConfig` calls with different `searchCwd` values don't interfere (verifies no `process.chdir` is involved).

Existing `cli/__tests__/unit/config/loader.test.ts` covers the rest and should pass unchanged.

---

## Phase 2 — ACP server

### 2.1 Add the SDK and verify the wire format

**File:** `cli/package.json`

```json
"@agentclientprotocol/sdk": "^0.x.y"  // confirm latest stable on npm before pinning
```

The SDK is `@agentclientprotocol/sdk` per the official docs at agentclientprotocol.com/libraries/typescript. Expect uses the same package (`skeptic-refs/expect/packages/agent/src/acp-client.ts:1-30`). The TypeScript types expose `AgentSideConnection` (server side, what we want) and `ClientSideConnection` (Expect's side). Confirm exported symbols and exact method names by reading `node_modules/@agentclientprotocol/sdk/dist/*.d.ts` AFTER `npm install`.

**Pre-flight checks (do these BEFORE writing acp.ts code):**

1. `npm info <package-name> versions` — confirm the package exists and pin a major.
2. `npm install <package-name>` in `cli/` — installs into `node_modules`.
3. Read `node_modules/<package-name>/dist/index.d.ts` to identify:
   - The class for the agent (server) side — likely `AgentSideConnection` or similar.
   - The wire-format method names — the spec uses `session/new`, `session/prompt`, `session/cancel`, `session/update` (slash-separated, NOT camelCase).
   - The `protocolVersion` shape — integer, not string.
   - The session-update payload shape (the actual field names: `sessionUpdate`, `agentInfo`, etc.).
4. Read the spec at https://agentclientprotocol.com (cited in research) for any non-SDK details (e.g., file-system permissions, MIME types for content blocks).

If steps 1-2 fail (SDK not published or under a different package name), this plan splits: hand-rolling JSON-RPC ndJson against the spec is much larger and would be its own plan. The pre-flight check is a hard go/no-go.

**Don't commit code with guessed API names.** The implementation in 2.3 below sketches the SHAPE of the code; the actual names must come from the SDK's `.d.ts` after install. Reviewers should treat the sketch as scaffolding, not API.

### 2.2 The ACP command

**File:** `cli/src/index.ts:166-171` (after `mcp` command)

```ts
program
  .command("acp")
  .description("Start ACP agent server for IDE integration (stdio)")
  .action(async () => {
    const { runAcp } = await import("./commands/acp.js");
    await runAcp();
  });
```

### 2.3 The server module

**File:** `cli/src/commands/acp.ts` (new)

Skeleton (TREAT NAMES AS PLACEHOLDERS — confirm against installed SDK):

```ts
import * as acp from "@agentclientprotocol/sdk";  // confirm the exact import surface from .d.ts
import { setLogLevel, logger } from "../utils/logger.js";
import { CLI_NAME } from "../constants.js";
import { loadConfig } from "../config/loader.js";
import { createAIClient } from "../ai/client-factory.js";
import { redirectStdoutLogsToStderr } from "../utils/log-stdio.js";  // new helper, see 2.3.1

interface SessionState {
  sessionId: string;
  cwd: string;                                          // absolute, validated; realpath in `cwdReal`
  cwdReal: string;                                      // fs.realpathSync(cwd) — used for symlink containment checks
  config: ReturnType<typeof loadConfig>;
  aiClient: Awaited<ReturnType<typeof createAIClient>>;
  abortController: AbortController;                     // real cancellation, not a flag
  inFlightEngines: Set<{ close: () => Promise<void> }>; // tracks Playwright engines for kill-on-cancel
  timeoutHandle: NodeJS.Timeout | null;                  // session-idle timeout (5min, reset on every prompt)
}

const sessions = new Map<string, SessionState>();

export async function runAcp(): Promise<void> {
  // CRITICAL: ACP uses stdout for ndJson framing. Any stray stdout write corrupts the protocol
  // stream (see logger.ts:25 — logger.info/success/raw write to stdout today). Redirect ALL log
  // output to stderr BEFORE the SDK opens the transport.
  redirectStdoutLogsToStderr();

  // SDK API names below are placeholders. Confirm against node_modules/<pkg>/dist/index.d.ts
  // before committing. The structural pattern (per-method handlers + emit callback) is portable
  // across what the SDK is likely to call them.
  const connection = new acp.AgentSideConnection({
    onInitialize: handleInitialize,
    onSessionNew: handleSessionNew,             // wire-format method: "session/new"
    onSessionPrompt: handleSessionPrompt,       // wire-format method: "session/prompt"
    onSessionCancel: handleSessionCancel,       // wire-format method: "session/cancel"
  });
  await connection.connect({ stdin: process.stdin, stdout: process.stdout });
  // Connection.connect resolves when stdin closes; the awaited promise is the lifetime guard.
}
```

**Initialize handler — confirm shape from SDK:**

```ts
async function handleInitialize(
  params: { protocolVersion: number; clientCapabilities?: unknown },
): Promise<{
  protocolVersion: number;
  agentInfo: { name: string; version: string };
  agentCapabilities: { /* SDK-defined shape */ };
}> {
  // protocolVersion is an INTEGER per the spec, not a string. Mirror what the client sent if
  // we support it; reject if mismatched (return-with-error pattern, SDK should provide).
  return {
    protocolVersion: params.protocolVersion,
    agentInfo: { name: CLI_NAME, version: "0.1.0" },
    agentCapabilities: {
      // Capabilities flags — names from the SDK's published types.
      // What we definitely DON'T claim in v1: planUpdates, configOptions, fileSystem.
      // What we definitely claim: prompts, toolCalls, sessionUpdates.
    },
  };
}
```

**Session new — NO `process.chdir`:**

```ts
async function handleSessionNew(
  params: { cwd: string; mcpServers?: unknown[] },
): Promise<{ sessionId: string }> {
  // ACP cwd should be absolute. Validate and resolve.
  if (!path.isAbsolute(params.cwd)) {
    throw new acp.ProtocolError("cwd must be absolute");  // SDK's error class — verify name
  }
  const cwd = path.resolve(params.cwd);

  // Load config relative to the session's cwd via the new searchCwd option (Phase 1.1).
  // No process.chdir — the loadConfig call is now safe to run concurrently across sessions.
  const config = loadConfig({ searchCwd: cwd });
  const aiClient = await createAIClient(config.ai);

  const sessionId = `s${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // Realpath the cwd once at session creation so containment checks compare against a stable
  // canonical path. If the user passes /a/b/c where /a/b is a symlink, cwdReal stays the
  // realpath; later boundPath / boundResolveFlows compare every accessed path against this.
  const cwdReal = fs.realpathSync(cwd);
  sessions.set(sessionId, {
    sessionId,
    cwd,
    cwdReal,
    config,
    aiClient,
    abortController: new AbortController(),
    inFlightEngines: new Set(),
    timeoutHandle: null,                          // populated by handleSessionPrompt's idle reset (Phase 3.1)
  });
  return { sessionId };
}
```

**Session prompt — ID-stable toolCallId, AbortController, path bounding:**

```ts
async function handleSessionPrompt(
  params: { sessionId: string; prompt: string },
  emit: (update: acp.SessionUpdate) => void,
): Promise<{ stopReason: "end_turn" | "cancelled" | "max_tokens" | "error" }> {
  const session = sessions.get(params.sessionId);
  if (!session) {
    return { stopReason: "error" };  // SDK should emit a session-not-found before this
  }

  const promptText = extractPromptText(params.prompt);  // ACP prompt is a content-blocks array; extract concatenated text
  emit({ sessionUpdate: "agent_thought_chunk", text: "Routing your request..." } as acp.SessionUpdate);

  const dispatch = parsePromptToToolCall(promptText);
  if (!dispatch) {
    emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: helpMessage() },
    } as acp.SessionUpdate);
    return { stopReason: "end_turn" };
  }

  // ID-stable toolCallId — generate ONCE per invocation; reuse across all updates.
  const toolCallId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  emit({
    sessionUpdate: "tool_call",
    toolCallId,
    title: dispatch.title,
    kind: "execute",
    status: "in_progress",
    content: [{ type: "text", text: JSON.stringify(dispatch.args, null, 2) }],
  } as acp.SessionUpdate);

  try {
    const result = await runDispatch(dispatch, session, (status: string) => {
      emit({
        sessionUpdate: "tool_call_update",
        toolCallId,                                // SAME ID
        status: "in_progress",
        content: [{ type: "text", text: status }],
      } as acp.SessionUpdate);
    });

    // Tool-level success/failure surfaces in the final tool_call_update status, NOT just the text.
    // run_flow with status: "failed", run_test with summary.failed > 0, validate_file with parse
    // error — all return { failed: true } from runDispatch and become "failed" tool calls here.
    emit({
      sessionUpdate: "tool_call_update",
      toolCallId,                                  // SAME ID
      status: result.failed ? "failed" : "completed",
      content: [{ type: "text", text: result.text }],
    } as acp.SessionUpdate);
    emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: result.failed ? "Tool reported failure. See output above." : "Done." },
    } as acp.SessionUpdate);
    return { stopReason: result.failed ? "error" : "end_turn" };

  } catch (err) {
    if (err instanceof acp.CancelledError || session.abortController.signal.aborted) {
      // Critical: emit the FINAL tool_call_update BEFORE returning, so the client knows
      // the call ended. Otherwise the editor's UI is stuck "in_progress" forever.
      emit({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "cancelled",
        content: [{ type: "text", text: "Cancelled by user." }],
      } as acp.SessionUpdate);
      return { stopReason: "cancelled" };
    }
    emit({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "failed",
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
    } as acp.SessionUpdate);
    return { stopReason: "error" };
  }
}

async function handleSessionCancel(params: { sessionId: string }): Promise<void> {
  const session = sessions.get(params.sessionId);
  if (!session) return;
  session.abortController.abort();
  // Force-close any in-flight Playwright engines so the await returns promptly.
  for (const engine of session.inFlightEngines) {
    try { await engine.close(); } catch { /* engine already closing */ }
  }
}
```

**`runDispatch` — invokes the right primitive directly, with cwd-aware paths and engine tracking:**

```ts
interface DispatchResult {
  text: string;
  failed: boolean;   // true → emit tool_call_update { status: "failed" } instead of "completed"
}

async function runDispatch(
  dispatch: ToolDispatch,
  session: SessionState,
  onProgress: (status: string) => void,
): Promise<DispatchResult> {
  const { abortController, cwd, config, aiClient } = session;

  switch (dispatch.tool) {
    case "run_flow": {
      const file = boundPath(cwd, String(dispatch.args["file"]));    // path-traversal + symlink guard
      const baseUrl = (dispatch.args["baseUrl"] as string) ?? config.url ?? "";
      const headed = Boolean(dispatch.args["headed"]);

      onProgress(`parsing ${file}`);
      const flow = parseFlowFile(file);

      onProgress("launching browser");
      const input = flowToInput(flow, baseUrl, config.hooks, config.env);
      const engine = new PlaywrightEngine(buildMcpEngineOptions(config, aiClient, { headed }));
      session.inFlightEngines.add(engine);
      try {
        await engine.launch();
        if (abortController.signal.aborted) throw new acp.CancelledError();
        onProgress("executing flow");
        const result = await engine.runFlow(input);
        // Surface flow-level failure to the caller so handleSessionPrompt can mark the
        // tool_call_update as `failed` rather than `completed`. Status convention matches
        // existing reporters' shape.
        return {
          text: JSON.stringify(result, null, 2),
          failed: result.status !== "passed",
        };
      } finally {
        session.inFlightEngines.delete(engine);
        await engine.close();
      }
    }

    case "run_test": {
      const pattern = String(dispatch.args["pattern"]);
      const baseUrl = (dispatch.args["baseUrl"] as string) ?? config.url ?? "";
      // Glob form goes through boundResolveFlows which validates each match (including
      // post-realpath symlink checks) against the session root before parsing any file.
      const flows = await boundResolveFlows(cwd, session.cwdReal, pattern);
      if (flows.length === 0) {
        return { text: "No flows matched the pattern", failed: false };
      }
      const engine = new PlaywrightEngine(buildMcpEngineOptions(config, aiClient));
      session.inFlightEngines.add(engine);
      const results: FlowResult[] = [];
      try {
        await engine.launch();
        for (const flow of flows) {
          if (abortController.signal.aborted) throw new acp.CancelledError();
          const input = flowToInput(flow, baseUrl, config.hooks, config.env);
          results.push(await engine.runFlow(input));
        }
      } finally {
        session.inFlightEngines.delete(engine);
        await engine.close();
      }
      const summary: RunSummary = {
        total: results.length,
        passed: results.filter((r) => r.status === "passed").length,
        failed: results.filter((r) => r.status !== "passed").length,
        duration_ms: results.reduce((sum, r) => sum + r.duration_ms, 0),
        flows: results,
      };
      return { text: JSON.stringify(summary, null, 2), failed: summary.failed > 0 };
    }

    case "generate_flow": {
      const description = String(dispatch.args["description"]);
      const baseUrl = (dispatch.args["baseUrl"] as string) ?? config.url ?? "http://localhost:3000";
      if (!aiClient) {
        return { text: missingClientMessage(config.ai), failed: true };
      }
      const { generateFromDescription } = await import("../ai/flow-generator.js");
      const yaml = await generateFromDescription(aiClient, description, baseUrl);
      return { text: yaml, failed: false };
    }

    case "validate_flow": {
      // ACP-internal: takes the YAML string. (MCP's validate_flow tool also takes a string;
      // ACP can dispatch here directly when the prompt provides YAML inline.)
      const yamlInput = String(dispatch.args["yaml"]);
      try {
        const flow = parseFlowString(yamlInput);
        return {
          text: JSON.stringify({ valid: true, name: flow.metadata.name, steps: flow.steps.length }),
          failed: false,
        };
      } catch (err) {
        return {
          text: JSON.stringify({ valid: false, error: err instanceof Error ? err.message : String(err) }),
          failed: true,
        };
      }
    }

    case "validate_file": {
      // ACP-internal only: reads the file (cwd-bounded), then validates as YAML.
      const file = boundPath(cwd, String(dispatch.args["file"]));
      try {
        const flow = parseFlowFile(file);
        return {
          text: JSON.stringify({ valid: true, name: flow.metadata.name, steps: flow.steps.length, file }),
          failed: false,
        };
      } catch (err) {
        return {
          text: JSON.stringify({ valid: false, file, error: err instanceof Error ? err.message : String(err) }),
          failed: true,
        };
      }
    }

    case "list_flows": {
      // config.tests is `string | string[]`; pass through unchanged so an array glob spec
      // expands all patterns. boundResolveFlows accepts the union and preserves all matches.
      const pattern = (dispatch.args["pattern"] as string | string[] | undefined) ?? config.tests;
      const flows = await boundResolveFlows(cwd, session.cwdReal, pattern);
      const list = flows.map((f) => ({ name: f.metadata.name, file: f.filePath, steps: f.steps.length, tags: f.metadata.tags }));
      return { text: JSON.stringify(list, null, 2), failed: false };
    }

    case "list_devices": {
      const devices = Object.entries(DEVICE_PROFILES).map(([id, p]) => ({
        id, label: p.label, category: p.category, width: p.width, height: p.height, dpr: p.dpr,
      }));
      return { text: JSON.stringify(devices, null, 2), failed: false };
    }

    case "load_guidance": {
      const domain = String(dispatch.args["domain"] ?? "");
      const result = loadGuidance(domain, { cwd });
      return {
        text: JSON.stringify({ domain: result.domain, source: result.source, content: result.content }, null, 2),
        failed: false,
      };
    }

    default:
      // tsconfig has `noImplicitReturns: true`, so the switch must terminate exhaustively.
      // Throwing here is the right shape — `handleSessionPrompt` catches and surfaces as
      // tool_call_update { status: "failed" }. This case fires only if the parser returns a
      // tool name that runDispatch doesn't know about (a bug, not a user-input case).
      throw new Error(`Unknown dispatch tool: ${dispatch.tool}`);
  }
}

/**
 * Reject paths that escape the session's root via `..` traversal, absolute paths, or symlinks.
 *
 * Three checks:
 *   1. Lexical containment — `path.resolve(root, requested)` lands under `root` after `..` collapse.
 *   2. Symlink resolution — `fs.realpathSync(resolved)` lands under `fs.realpathSync(root)`.
 *      This catches symlinks that point outside the root (e.g., a symlink at `flows/secret`
 *      pointing to `/etc/passwd`).
 *   3. The original `requested` value isn't an absolute path masquerading as a relative one.
 *
 * `requested` is what the user supplied (could be `flows/login.yaml`, `../../etc/passwd`, or
 * `/etc/passwd`). `root` is the session's cwd (already validated absolute in handleSessionNew).
 */
function boundPath(rootDir: string, requested: string): string {
  if (path.isAbsolute(requested)) {
    // ACP protocol paths in some message types are absolute, but in OUR tool args (flow file,
    // pattern), they're always relative to the session cwd. Reject absolute strings outright
    // so absolute paths can't sneak past the lexical check.
    throw new Error(`Path must be relative to session root: ${requested}`);
  }

  const resolved = path.resolve(rootDir, requested);
  const rel = path.relative(rootDir, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes session root: ${requested}`);
  }

  // Symlink check — only run if the file exists; non-existent paths fall through to parseFlowFile
  // which raises the appropriate "file not found" error.
  if (fs.existsSync(resolved)) {
    const realResolved = fs.realpathSync(resolved);
    const realRoot = fs.realpathSync(rootDir);
    const realRel = path.relative(realRoot, realResolved);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
      throw new Error(`Symlink escapes session root: ${requested}`);
    }
  }
  return resolved;
}

/**
 * Glob-pattern variant of boundPath.
 *
 * Returns ResolvedFlow[] like the original `resolveFlows`, but with two added security
 * properties: (1) every pattern is validated to be relative+non-traversing BEFORE matching,
 * and (2) every matched file path is realpath-checked against the session root BEFORE
 * `parseFlowFile` is called on it. The earlier draft used `resolveFlows` directly, which
 * parses files INSIDE the resolution loop — meaning a symlink-escape would have been read
 * (and its YAML potentially leaked into a downstream prompt) before the boundary check fired.
 *
 * We use `resolveFlowPaths` (path-only resolution, no parse) for the glob expansion, then
 * apply boundary checks, then call `parseFlowFile` on each survivor.
 */
async function boundResolveFlows(
  rootDir: string,
  rootDirReal: string,
  patterns: string | string[],
): Promise<ResolvedFlow[]> {
  const patternList = Array.isArray(patterns) ? patterns : [patterns];

  // Validate every pattern lexically BEFORE glob expansion. This catches `../**` and absolute
  // patterns immediately and avoids letting glob even attempt to walk outside the root.
  for (const p of patternList) {
    if (path.isAbsolute(p) || p.startsWith("..") || p.includes("/../")) {
      throw new Error(`Glob pattern must be relative to session root: ${p}`);
    }
  }

  // Expand globs to absolute paths (no parsing yet — that's the security fix).
  const matchedPaths = await resolveFlowPaths(patternList, rootDir);

  // Every matched path must realpath-resolve back inside the session root.
  const validated: string[] = [];
  for (const match of matchedPaths) {
    let realMatch: string;
    try {
      realMatch = fs.realpathSync(match);
    } catch {
      // File disappeared between glob and realpath — drop, don't throw.
      continue;
    }
    const realRel = path.relative(rootDirReal, realMatch);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
      throw new Error(`Glob match escapes session root via symlink: ${match}`);
    }
    validated.push(match);
  }

  // Only NOW parse the validated files. Any parse failures throw with file context.
  return validated.map((filePath) => {
    const flow = parseFlowFile(filePath);
    return { ...flow, filePath };
  });
}
```

### 2.3.1 Logger redirect helper

**File:** `cli/src/utils/log-stdio.ts` (new — small)

```ts
import { logger } from "./logger.js";

/**
 * In ACP-server mode, all log output must go to stderr because stdout is the protocol
 * NDJSON channel. Call this BEFORE the SDK opens the transport.
 */
export function redirectStdoutLogsToStderr(): void {
  // Implementation depends on logger.ts internals. Two options:
  //   (a) the logger has a writeFn override → set it to process.stderr.write
  //   (b) the logger uses bare console.log → monkey-patch stdout writers
  // (a) is cleanest. If logger.ts doesn't expose this, add an `setLoggerStream(stream)`
  //     export at the same time as part of this plan.
  logger.setStream?.(process.stderr) ?? (() => {
    // Fallback: silence stdout writes from logger.info/success/raw.
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      console.error(...args);
    };
    process.on("exit", () => { console.log = origLog; });
  })();
}
```

A small change in `cli/src/utils/logger.ts` to expose `setStream` is preferable to monkey-patching `console.log`. If that change has scope concerns, the monkey-patch is acceptable for v1 — `skeptic acp` is a separate process with no shared global state at risk.

### 2.3.2 Existing-process logger considerations

The CLI's standard `--verbose` / `--quiet` controls (set via `setLogLevel` in `cli/src/index.ts:29-35`) still apply, but their output now lands on stderr instead of stdout when `skeptic acp` is the running command. That's the desired behavior — debug logs help users debug the agent without breaking the protocol.

### 2.4 Prompt parsing — the agentic dispatcher

The hardest design call. Three options:

**Option I: Heuristic regex.** "run flows/X" → `run_flow`, "generate a flow…" → `generate_flow`, "list flows" → `list_flows`. Cheap, deterministic, ships fast. Misses anything outside the patterns.

**Option II: LLM-based dispatch.** Send the prompt + the tool catalog to the configured LLM (skeptic's `aiClient`) with a "pick a tool and extract args" prompt. Structured JSON output. ~1s extra latency per request, costs tokens, but handles natural-language input gracefully.

**Option III: Two-tier.** Try regex first; fall back to LLM. Best of both, slightly more complexity.

**Pick Option I for v1.** Reasoning: (a) determinism is debuggable; (b) skeptic's existing `generate` command already uses the LLM; double-LLM-roundtrip per ACP request is expensive and laggy; (c) editors invoking ACP usually have their own LLM-driven UX layer that produces structured prompts (e.g., Cursor sends `/skeptic run login.yaml`, not "hey run my login flow buddy"). Option II is a clear v2 upgrade path.

**File:** `cli/src/commands/acp-prompt-parser.ts` (new)

```ts
export interface ToolDispatch {
  tool: string;
  args: Record<string, unknown>;
  title: string;
}

const RUN_FLOW_RE   = /^\s*(?:run|test)\s+(?:flow\s+)?(\S+\.ya?ml)\s*$/i;
const RUN_TEST_RE   = /^\s*(?:run|test)\s+(?:tests?\s+matching\s+)?["']?([^"']+\*[^"']*)["']?\s*$/i;
const GENERATE_RE   = /^\s*generate\s+(?:a\s+)?flow\s+(?:that\s+|to\s+|for\s+)?(.+)$/i;
const VALIDATE_RE   = /^\s*validate\s+(?:flow\s+)?(\S+\.ya?ml)\s*$/i;
const LIST_FLOWS_RE = /^\s*list\s+flows?\s*(.*)?$/i;
const LIST_DEV_RE   = /^\s*list\s+devices?\s*$/i;
const GUIDANCE_RE   = /^\s*load\s+(?:guidance\s+(?:for|on)\s+|guidance\s+)?(\w+)\s*$/i;

export function parsePromptToToolCall(prompt: string): ToolDispatch | null {
  const trimmed = prompt.trim();

  let m: RegExpMatchArray | null;
  if ((m = trimmed.match(RUN_FLOW_RE)))
    return { tool: "run_flow", args: { file: m[1] }, title: `Run flow ${m[1]}` };
  if ((m = trimmed.match(VALIDATE_RE)))
    return { tool: "validate_file", args: { file: m[1] }, title: `Validate ${m[1]}` };
  if ((m = trimmed.match(RUN_TEST_RE)))
    return { tool: "run_test", args: { pattern: m[1] }, title: `Run tests matching ${m[1]}` };
  if ((m = trimmed.match(GENERATE_RE)))
    return { tool: "generate_flow", args: { description: m[1] }, title: `Generate flow` };
  if ((m = trimmed.match(LIST_FLOWS_RE)))
    return { tool: "list_flows", args: m[1] ? { pattern: m[1] } : {}, title: `List flows` };
  if (LIST_DEV_RE.test(trimmed))
    return { tool: "list_devices", args: {}, title: `List devices` };
  if ((m = trimmed.match(GUIDANCE_RE)))
    return { tool: "load_guidance", args: { domain: m[1] }, title: `Load ${m[1]} guidance` };

  return null;
}
```

**The `validate_flow` mismatch**: the existing MCP `validate_flow` tool takes a YAML *string*, not a file path. The ACP prompt parser sees `"validate flows/login.yaml"` (file path), so we need a separate path:

- For ACP, add a `validate_file` dispatch path that reads the file via `boundPath` + `parseFlowFile` and reports validity. This is **ACP-internal only** — not added to MCP's tool list, since MCP clients can already read files themselves and pass the YAML string.
- The `runDispatch` switch in 2.3 handles this by branching to a different code path; no new tool registration in MCP.

This keeps MCP's surface unchanged (preserving the no-MCP-behavior-change goal from Phase 1), while ACP gets the file-path-friendly UX its prompt parser expects.

### 2.5 Tests

**File:** `cli/__tests__/unit/commands/acp-prompt-parser.test.ts`

- `"run flows/login.yaml"` → `{tool: "run_flow", args: {file: "flows/login.yaml"}}`.
- `"test flows/login.yaml"` → same (alias).
- `"run tests matching flows/auth-*.yaml"` → `{tool: "run_test", args: {pattern: "flows/auth-*.yaml"}}`.
- `"generate a flow that tests the cart"` → `{tool: "generate_flow", args: {description: "tests the cart"}}`.
- `"list flows"` → `{tool: "list_flows", args: {}}`.
- `"list flows tests/**/*.yaml"` → `{tool: "list_flows", args: {pattern: "tests/**/*.yaml"}}`.
- `"list devices"` → `{tool: "list_devices", args: {}}`.
- `"load guidance for performance"` → `{tool: "load_guidance", args: {domain: "performance"}}`.
- `"hello world"` → `null`.
- Case insensitivity: `"RUN flows/login.yaml"` works.

**File:** `cli/__tests__/integration/commands/acp-server.test.ts`

Spawn `skeptic acp` as a subprocess, write a JSON-RPC `initialize` request to its stdin, parse the ndJson response from stdout. Assert the protocol handshake succeeds. Then send a `newSession` followed by a `prompt` ("list flows"); assert at least one `agent_thought_chunk` and one `tool_call` arrive.

Idiom: `cli/__tests__/integration/commands/test-command.test.ts` (subprocess pattern). Use `child_process.spawn` with `stdio: ['pipe', 'pipe', 'inherit']`.

**Pitfall — test stability.** Subprocess tests are slow and flaky. Gate it as opt-in via an explicit env var — `it.runIf(process.env.ACP_INTEGRATION === "1")` (or `it.skip` unless that var is set). The earlier draft used `skipIf(!CI || SKIP_INTEGRATION)`, which runs by default in CI — wrong polarity for "opt-in." Document the env var in the test file's top-of-file comment so contributors know how to run it locally (`ACP_INTEGRATION=1 npm test cli/__tests__/integration/commands/acp-server.test.ts`).

---

## Phase 3 — Lifecycle & error handling

### 3.1 Session timeout

If a session is opened but no `session/prompt` is sent within 5 minutes, garbage-collect it. Implementation: per-session timer reset on every prompt; on expiry, abort the session's controller, close any in-flight engines, and `sessions.delete(sessionId)`. The session timer handle lives on `SessionState` (add `timeoutHandle: NodeJS.Timeout | null`) so it can be cleared on every prompt and on session close.

### 3.2 Stdio close → session cleanup

When stdin closes, the SDK's `connection.connect()` promise resolves. Teardown order matters: abort first (to interrupt any await in handleSessionPrompt), then close engines, then clear timers, then drop session state:

```ts
await connection.connect({ stdin: process.stdin, stdout: process.stdout });

// stdin closed — tear down all sessions cleanly
for (const session of sessions.values()) {
  session.abortController.abort();
  if (session.timeoutHandle) clearTimeout(session.timeoutHandle);
  for (const engine of session.inFlightEngines) {
    try { await engine.close(); } catch { /* already closed */ }
  }
  session.inFlightEngines.clear();
}
sessions.clear();
```

### 3.3 Concurrent prompts

ACP allows a session to receive multiple `session/prompt` calls (sequentially). v1 handles them serially: each `handleSessionPrompt` runs to completion before the next is dispatched. The SDK's request handler is awaited — natural FIFO. **Do not parallelize within a session** in v1; tool execution can leak state (browser windows, etc.).

Document this: a single session = a single sequential conversation. Multiple sessions = multiple concurrent users (skeptic CLI doesn't share state between sessions, so this is safe — the absence of `process.chdir` from Phase 2.3 is what makes this true).

### 3.4 Tests

**File:** `cli/__tests__/unit/commands/acp-lifecycle.test.ts`

- New session creates a fresh state with `cwd`, `config`, `aiClient`, fresh `AbortController`, empty `inFlightEngines`.
- Cancel during a long tool call → `tool_call_update` with `status: "cancelled"`, then prompt response with `{ stopReason: "cancelled" }`. Verify `engine.close()` was called.
- Stdin close → all sessions teardown: abort fired, engines closed, timers cleared, `sessions` map empty.
- Two sessions hold independent `config` (mock different `cwd` for each); aborting one does not abort the other.
- Session timeout: open session, advance 5+ minutes via `vi.useFakeTimers()`, assert session removed AND any in-flight engines closed.

---

## Phase 4 — Documentation

### 4.1 `cli/README.md`

Add after the MCP section:

```markdown
### Agent Client Protocol (ACP)

In addition to the MCP server, skeptic exposes an ACP-compatible **agent server** at \`skeptic acp\`. The protocol is the same one Zed uses for its agent integrations — your editor sends a natural-language prompt, skeptic streams back thoughts, plans, and tool invocations.

\`\`\`bash
# In an ACP-aware editor's settings (Zed, Cursor with ACP plugin, etc.):
{
  "agent": {
    "command": "skeptic",
    "args": ["acp"]
  }
}
\`\`\`

Once configured, prompt skeptic like a coding assistant whose specialty is E2E testing:
- \`run flows/login.yaml\`
- \`generate a flow that tests the cart checkout\`
- \`list flows\`
- \`load guidance for accessibility\`

ACP and MCP coexist — you can run both servers in parallel from different editor extensions. They share the same tool catalog (\`run_flow\`, \`generate_flow\`, etc.).

**v1 limitations:**
- Stdio transport only (no WebSocket / HTTP).
- Heuristic prompt parsing — skeptic recognizes specific patterns (\`run X.yaml\`, \`generate flow that…\`); arbitrary natural language falls back to a help message.
- No \`plan\` updates yet; skeptic executes tools directly without showing a step plan first.
```

### 4.2 Skill / agent docs

`skeptic add skill --agent zed` (or similar) — if skeptic has a skill installer for editors, add a Zed-specific snippet that wires ACP. Optional v1.

---

## Phase 5 — Future work (not in scope)

For the codex review and future planners, document the v2 trail:

1. **Plans** — show users a step-by-step plan before tool execution. Requires the LLM-based dispatcher (Option II from 2.4) so the plan reflects the user's actual intent, not just the regex-matched tool.
2. **Config options live update** — let editors send `config_option_update` to swap AI provider mid-session. Requires session-scoped config, not the file-loaded singleton we have today.
3. **Multi-tool composition** — "run all flows, then generate flows for any failures." Requires the dispatcher to chain tool calls and reason about state between them. This is real agentic territory.
4. **WebSocket transport** — for remote agents. ACP defines it; skeptic can expose a port.
5. **ACP client mode** — `skeptic acp-client --agent claude` opens an ACP session against an upstream coding agent. Mirrors Expect. Useful for piping skeptic-generated flow drafts through Claude for refinement before saving.

---

## Critical Files to Modify

| File | Phase | Change |
|------|-------|--------|
| `cli/package.json` | 2.1 | Add `@agentclientprotocol/sdk` (pin major after `npm info` check) |
| `cli/package-lock.json` | 2.1 | Regenerated |
| `cli/src/config/loader.ts` | 1.1 | Add `searchCwd` option to `loadConfig` (and `loadConfigWithMeta` if applicable) |
| `cli/src/utils/logger.ts` | 2.3.1 | Add `setStream(stream)` export so log output can be diverted to stderr in ACP mode |
| `cli/src/utils/log-stdio.ts` | 2.3.1 | New small file — `redirectStdoutLogsToStderr()` helper |
| `cli/src/commands/acp.ts` | 2.3 | New file — ACP server with AbortController, ID-stable toolCallId, path bounding, no `process.chdir` |
| `cli/src/commands/acp-prompt-parser.ts` | 2.4 | New file — heuristic regex dispatcher |
| `cli/package.json` | 2.1 | Add ACP SDK dependency (verify package name on npm before pinning) |
| `cli/src/index.ts` | 2.2 | Register `acp` command |
| `cli/README.md` | 4.1 | New ACP section |
| `cli/src/commands/mcp.ts` | (unchanged) | NOT modified in this plan — full registry refactor deferred to a follow-up |

Plus 5+ new test files (1.5 ×2, 2.5 ×2, 3.4) and possibly updates to the existing MCP integration tests (`cli/__tests__/integration/commands/mcp-*.test.ts` if any).

---

## Reused Utilities

- `loadConfig`, `createAIClient` — `cli/src/config/loader.ts`, `cli/src/ai/client-factory.ts`
- `flowToInput`, `buildMcpEngineOptions` — `cli/src/commands/mcp.ts:149, 314` (existing exports)
- `parseFlowFile`, `parseFlowString`, `resolveFlows` — `cli/src/parser/`
- `PlaywrightEngine` — `cli/src/executor/playwright-engine.ts`
- `loadGuidance`, `GUIDANCE_DOMAINS` — `cli/src/ai/guidance-loader.ts`
- `DEVICE_PROFILES` — `cli/src/config/device-profiles.ts`
- `logger.{info,warn,error,debug}` — `cli/src/utils/logger.ts`

The big win is *not adding new utilities* — just calling existing primitives (parser, engine, config, AI client, guidance loader, device profiles) directly from ACP. Sharing through a tool registry is a v2 follow-up after the protocol contract is proven.

---

## Verification

```bash
cd cli
npm install
npm run build
npm run check
npm test
```

**MCP regression check:** existing MCP tests in `cli/__tests__/` pass without modification. **There is no MCP refactor in this plan** — `mcp.ts` is untouched, so its tests should be a no-op gate. Run them to confirm Phase 1.1's `loadConfig({ searchCwd })` change didn't accidentally break the existing default-cwd path.

**ACP smoke test (manual):**

1. Start an ACP server in one terminal:
   ```bash
   skeptic acp 2>acp.err  # stderr captures logs
   ```
2. Send an `initialize` request via JSON-RPC over stdio. The exact wire format depends on the SDK; use the SDK's client-side helper or hand-craft JSON-RPC ndJson:
   ```
   {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}
   ```
3. Confirm the response uses INTEGER `protocolVersion` and `agentInfo`+`agentCapabilities` field names matching what the SDK requires (verify against `node_modules/<pkg>/dist/index.d.ts`).
4. Send `session/new` with an absolute `cwd`; receive a sessionId.
5. Send `session/prompt` with `"list flows"`; receive streaming `session/update` notifications with `agent_thought_chunk`, `tool_call`, `tool_call_update`, `agent_message_chunk` payloads ending with a `{ stopReason: "end_turn" }` response.
6. **Stdout-purity check:** confirm `acp.err` contains all log lines and `skeptic acp` stdout contains ONLY ndJson messages — `cat skeptic-acp.stdout | jq .` should parse every line.
7. **Cancellation check:** start a long `run_test pattern: tests/**/*.yaml`; while it's running, send `session/cancel`. Expect: tool_call_update with `status: "cancelled"`, prompt response with `stopReason: "cancelled"`, all in-flight Playwright engines closed promptly (verify via `ps`/`pgrep` for orphaned chrome processes).

**End-to-end editor smoke test:**

If a Zed/Cursor build supports ACP and is on the test machine, configure it to use `skeptic acp` and verify the editor can drive a real flow run. This is exploratory — there's no automated test for "the editor experience feels right."

**Failure mode coverage:**
- Bad JSON on stdin → SDK should reject with a JSON-RPC error; the server doesn't crash.
- Unknown prompt → falls through to `agent_message_chunk` with the help text from `helpMessage()`.
- Tool throws → captured, surfaced as `tool_call_update { status: "failed" }` then `prompt` returns `{ stopReason: "error" }`.
- SIGINT → all session abort controllers fire; in-flight Playwright engines close; ndJson stream is flushed; process exits cleanly.
- **Path traversal — lexical**: `run_flow file: "../../etc/passwd"` → `boundPath` rejects with "Path escapes session root", surfaced as `tool_call_update { status: "failed" }`. Critical security regression bar.
- **Path traversal — absolute**: `run_flow file: "/etc/passwd"` → `boundPath` rejects with "Path must be relative to session root".
- **Path traversal — symlink**: create a symlink at `<session-root>/flows/escape.yaml` pointing to `/tmp/outside.yaml`; `run_flow file: "flows/escape.yaml"` → `boundPath`'s realpath check rejects with "Symlink escapes session root".
- **Path traversal — glob**: `run_test pattern: "../../**/*.yaml"` → `boundResolveFlows` rejects with "Glob pattern must be relative to session root".
- **Path traversal — glob match symlink**: legitimate-looking pattern `tests/**/*.yaml` returns matches that include a symlink to outside the root → `boundResolveFlows` rejects each escaping match.
- **Same-process MCP and ACP**: not supported in v1 (each is its own process) — but if a user tries to start both, they should not interfere (MCP via `skeptic mcp`, ACP via `skeptic acp`, separate stdio streams in separate processes).

**SDK availability gate:** before merging, confirm `@agentclientprotocol/sdk` is published and resolves the imports used in 2.3. If the SDK isn't shipped yet, this whole plan needs to wait OR pivot to hand-rolling JSON-RPC framing (much larger phase). The pre-flight check at the top of Phase 2 is non-negotiable.
