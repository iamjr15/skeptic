import { Command, InvalidArgumentError } from "commander";
import { CLI_NAME, PRODUCT_NAME } from "./constants.js";
// All command runners are dynamic-imported in their `.action(...)` handlers
// so cold-start (especially `--help`) doesn't pay the load cost of every
// runner's transitive deps. Type-only imports stay at the top — they're
// erased at build time and add zero runtime cost.
import type { RunCommandOptions } from "./commands/run.js";
import type { GenerateCommandOptions } from "./commands/generate.js";
import type { AddGitHubActionOptions, AddSkillOptions } from "./commands/add.js";
import { setLogLevel } from "./utils/logger.js";
import type { LogLevel } from "./utils/logger.js";

function parsePositiveInt(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new InvalidArgumentError(`expected a positive integer, got "${value}"`);
  }
  return Number(value);
}

const SHARD_MAX = 64;
function parseShardCount(value: string): number {
  const n = parsePositiveInt(value);
  if (n > SHARD_MAX) {
    throw new InvalidArgumentError(
      `must be at most ${SHARD_MAX}, got ${n} (use a coordinator if you need more parallelism)`,
    );
  }
  return n;
}

export const program = new Command();

program
  .name(CLI_NAME)
  .description(`${PRODUCT_NAME} — CLI-first E2E testing with TypeScript test specs`)
  .version(__SKEPTIC_CLI_VERSION__)
  .option("-v, --verbose", "enable verbose logging")
  .option("-q, --quiet", "suppress all output except errors")
  .option("--features", "print build-time feature map and exit")
  .hook("preAction", (_thisCommand, _actionCommand) => {
    const opts = program.opts<{ verbose?: boolean; quiet?: boolean }>();
    let level: LogLevel = "info";
    if (opts.verbose) level = "debug";
    if (opts.quiet) level = "error";
    setLogLevel(level);
  });

program
  .command("init")
  .description("Initialize a new skeptic project")
  .argument("[dir]", "target directory", ".")
  .action(async (dir: string) => {
    const { runInit } = await import("./commands/init.js");
    await runInit(dir);
  });

program
  .command("run")
  .description("Run TS test specs (the v0.2 successor to `test`)")
  .argument("[specs...]", "spec file globs (default: tests/**/*.spec.ts)")
  .option("-c, --config <path>", "path to config file")
  .option("--headed", "run browser in headed mode")
  .option("--verbose", "verbose output")
  .option("--ci", "force CI mode (headless, no prompts)")
  .option("--bail", "stop on first failure")
  .option("--retries <n>", "retry failed tests N times", parseInt)
  .option("--timeout <ms>", "soft per-action default timeout in ms", parseInt)
  .option("--hard-timeout <ms>", "hard per-test ceiling in ms", parseInt)
  .option("--device <id>", "device profile for viewport emulation")
  .option("--reporter <format...>", "reporter format(s): console, json, junit, html")
  .option("--output <dir>", "output directory for reports")
  .option("--cookies", "enable browser cookie extraction (opt-in)")
  .option("--cookies-from <browser>", "extract cookies from specific browser only")
  .option("--video", "record video of test execution (WebM)")
  .option(
    "--video-size <WxH>",
    "video recording resolution (e.g., 1920x1080); overrides viewport size for video only",
  )
  .option("-w, --watch", "watch for file changes and re-run")
  .option("-u, --url <url>", "base URL (overrides config)")
  .option("--parallel <n>", "run N test files concurrently", parsePositiveInt)
  .option("--shard-split <n>", "split tests across N runs (each runs disjoint subset)", parseShardCount)
  .option("--shard-all <n>", "run all tests on each of N runs", parseShardCount)
  .option("--shard-index <n>", "1-based shard index for --shard-split / --shard-all (also via SKEPTIC_SHARD_INDEX)", parsePositiveInt)
  .option("--no-tui", "disable interactive TUI, use plain text output")
  .option("--trace", "record Playwright trace for each test")
  .option("--observability", "enable the full observability bundle: settle + fullPage + perf+net+console+a11y(auto) + sidecar md")
  .option("--observe", "alias of --observability")
  .option("--full-page-screenshot", "force fullPage=true on all screenshot calls")
  .option("--no-full-page-screenshot", "force fullPage=false (overrides config)")
  .option("--visual-settle", "enable the visual-settle helper before screenshots")
  .option("--no-visual-settle", "disable the visual-settle helper")
  .option("--blank-frame-detection <mode>", "off | warn | fail")
  .option("--observability-write-sidecars", "write per-test perf-trace.md + console.json + network.json")
  .option("--sidecars", "alias of --observability-write-sidecars")
  .option("--list", "discover tests without running them")
  .option("--tag <tag...>", "filter tests by tag (declared via test.use({ tags }))")
  .option("--connect <url>", "connect to a running browser via CDP (B2)")
  .option("--env <KEY=VALUE...>", "set environment variables")
  .option("--analyze", "use AI to analyze test failures (best-effort post-run)")
  .option("--no-daemon", "bypass the persistent BrowserServer daemon (pre-B10 fresh-launch behavior)")
  .option(
    "--daemon-idle-timeout <seconds>",
    "auto-stop the daemon after N seconds idle (default 300; 0 disables)",
    parseInt,
  )
  .action(async (specs: string[], cmdOpts: RunCommandOptions) => {
    const { runRun } = await import("./commands/run.js");
    await runRun(specs.length > 0 ? specs : undefined, cmdOpts);
  });

program
  .command("generate")
  .description("Generate test flows using AI")
  .option("--diff", "generate from git diff")
  .option("--target <mode>", "diff scope: changes, unstaged, branch", "changes")
  .option("-u, --url <url>", "base URL for generated flows")
  .option("-m, --message <description>", "generate from a text description")
  .option("-o, --output <dir>", "output directory for generated flows")
  .option("--save", "save to .skeptic/generated/ with timestamp")
  .option("--model <model>", "AI model to use (overrides ai.model in config)")
  .option("-c, --config <path>", "path to config file")
  .option(
    "--guidance <domains>",
    "comma-separated domain guidance to attach (e.g. animation,accessibility)",
  )
  .option("--no-coverage", "skip the coverage analysis injected into AI prompts")
  .option("-y, --yes", "skip interactive review, auto-approve")
  .action(async (cmdOpts: GenerateCommandOptions) => {
    const { runGenerate } = await import("./commands/generate.js");
    await runGenerate(cmdOpts);
  });

const addCmd = program
  .command("add")
  .description("Add integrations and scaffolding");

addCmd
  .command("github-action")
  .description("Generate a GitHub Actions workflow for E2E tests")
  .option("--dev-command <cmd>", "dev server start command", "npm run dev")
  .option("--dev-url <url>", "dev server URL", "http://localhost:3000")
  .option("--ai", "enable AI features in workflow")
  .option(
    "--provider <name>",
    "AI provider: gemini, openai, or anthropic (overrides ai.provider in config)",
  )
  .option("-c, --config <path>", "path to config file")
  .action(async (cmdOpts: AddGitHubActionOptions) => {
    const { runAddGitHubAction } = await import("./commands/add.js");
    await runAddGitHubAction(cmdOpts);
  });

addCmd
  .command("skill")
  .description("Install skeptic skill for an AI coding agent")
  .option("--agent <name>", "agent name: claude, codex, cursor")
  .action(async (cmdOpts: AddSkillOptions) => {
    const { runAddSkill } = await import("./commands/add.js");
    await runAddSkill(cmdOpts);
  });

const cookiesCmd = program
  .command("cookies")
  .description("Manage browser cookie extraction");

// `skeptic browsers install [chromium|firefox|webkit|all]` — installs
// Playwright browsers without requiring `npx`. Useful for the SEA-binary
// distribution where users may not have Node/npm.
const browsersCmd = program
  .command("browsers")
  .description("Manage Playwright browser binaries");

browsersCmd
  .command("install")
  .description("Download Playwright browser binaries")
  .argument(
    "[browsers...]",
    "browsers to install (chromium, firefox, webkit, all). Defaults to chromium.",
  )
  .option("--with-deps", "also install OS-level dependencies (sudo on Linux)")
  .option("--dry-run", "print what would be installed without installing")
  .action(async (browsers: string[], cmdOpts: { withDeps?: boolean; dryRun?: boolean }) => {
    const { runBrowsersInstall } = await import("./commands/browsers-install.js");
    const target = browsers.length > 0 ? browsers : ["chromium"];
    await runBrowsersInstall(target, cmdOpts);
  });

cookiesCmd
  .command("list")
  .description("List detected browsers for cookie extraction")
  .action(async () => {
    const { runCookiesList } = await import("./commands/cookies.js");
    await runCookiesList();
  });

program
  .command("comment")
  .description("Upsert a PR comment with test results (uses `gh` CLI)")
  .option("--results <path>", "path to results.json", "./skeptic-output/results.json")
  .option("--pr <number>", "PR number (default: auto-detect)")
  .option("--marker <string>", "HTML comment marker", "<!-- skeptic-qa-results -->")
  .option("--run-url <url>", "URL to CI run page")
  .option("--dry-run", "print body to stdout instead of posting")
  .option("-c, --config <path>", "path to config file")
  .action(async (cmdOpts: import("./commands/comment.js").CommentCommandOptions) => {
    const { runComment } = await import("./commands/comment.js");
    await runComment(cmdOpts);
  });

program
  .command("mcp")
  .description("Start MCP server for AI agent integration (stdio)")
  .action(async () => {
    if (__SKEPTIC_FEATURE_MCP__) {
      const { runMcp } = await import("./commands/mcp.js");
      await runMcp();
    } else {
      console.error("skeptic mcp: not built into this binary");
      process.exit(1);
    }
  });

program
  .command("acp")
  .description("Start ACP agent server for IDE integration (stdio)")
  .action(async () => {
    if (__SKEPTIC_FEATURE_ACP__) {
      const { runAcp } = await import("./commands/acp.js");
      await runAcp();
    } else {
      console.error("skeptic acp: not built into this binary");
      process.exit(1);
    }
  });

program
  .command("inspect")
  .description("Inspect a page — emit ARIA + cursor-interactive refs with stable selectorHints")
  .argument("<url>", "URL to inspect")
  .option("--interactive", "filter to lines with refs")
  .option("--compact", "interactive + minimal ancestors")
  .option("--selector <css>", "scope to a CSS subtree")
  .option("--json", "emit machine-readable JSON")
  .option("--device <id>", "device profile (e.g. iphone_15)")
  .option("--headed", "show the browser")
  .option("--wait <ms>", "extra settle before snapshot (default 1500)")
  .option("--connect <url>", "CDP auto-discover and attach (host:port or ws URL)")
  .option("--with-playwright-hints", "also emit Playwright snippet per ref")
  .option("--annotated", "capture an annotated PNG with numbered badges over each ref")
  .option("--annotate-output <path>", "output path for the annotated PNG (defaults to ./skeptic-inspect-<ts>.png)")
  .option("--no-daemon", "bypass the persistent daemon and launch a fresh browser (pre-B10)")
  .action(async (url: string, cmdOpts: import("./commands/inspect.js").InspectCommandOptions) => {
    const { runInspect } = await import("./commands/inspect.js");
    await runInspect(url, cmdOpts);
  });

// B10 — daemon control plane. Lifecycle commands for the persistent
// BrowserServer at `~/.skeptic/daemon.sock`.
const daemonCmd = program
  .command("daemon")
  .description("Manage the persistent BrowserServer daemon (B10)");

daemonCmd
  .command("start")
  .description("Start the daemon (foreground; auto-spawned by `run`/`inspect` when needed)")
  .option("--engine <engine>", "browser engine: chromium | firefox | webkit", "chromium")
  .option("--headed", "run BrowserServer in headed mode")
  .option(
    "--daemon-idle-timeout <seconds>",
    "auto-stop after N idle seconds (default 300; 0 disables)",
    parseInt,
  )
  .action(
    async (cmdOpts: { engine?: string; headed?: boolean; daemonIdleTimeout?: number }) => {
      const { runDaemonStart } = await import("./commands/daemon.js");
      await runDaemonStart(cmdOpts);
    },
  );

daemonCmd
  .command("stop")
  .description("Stop the running daemon")
  .action(async () => {
    const { runDaemonStop } = await import("./commands/daemon.js");
    await runDaemonStop();
  });

daemonCmd
  .command("status")
  .description("Show daemon status (running/uptime/clients/engine)")
  .action(async () => {
    const { runDaemonStatus } = await import("./commands/daemon.js");
    await runDaemonStatus();
  });

daemonCmd
  .command("logs")
  .description("Tail the daemon log file at ~/.skeptic/daemon.log")
  .option("-n, --lines <n>", "show last N lines (default 200)", parseInt)
  .action(async (cmdOpts: { lines?: number }) => {
    const { runDaemonLogs } = await import("./commands/daemon.js");
    await runDaemonLogs(cmdOpts);
  });

// Re-export `commandUsesBrowser` so existing callers (and the
// `auto-spawn-discipline` unit test) keep working. The implementation lives
// in `daemon/auto-spawn.ts` next to the only function that calls it on the
// runtime path — see B10 audit on task #17 (the inline copy here was
// dead code on the production path).
export { commandUsesBrowser, prewarmDaemonIfNeeded } from "./daemon/auto-spawn.js";

program
  .command("audit")
  .description("Run project lint, type-check, and quality scripts")
  .option("--fix", "attempt to auto-fix issues")
  .action(async (cmdOpts: { fix?: boolean }) => {
    const { runAudit } = await import("./commands/audit.js");
    await runAudit(cmdOpts);
  });

// Public test-author surface — `import { test, expect } from "skeptic-cli"`.
export { test, expect } from "./api/index.js";
export type {
  TestUseOptions,
  TestFn,
  HookFn,
  SkepticFixture,
  SnapshotTree,
  SnapshotOptions,
  ScreenshotOptions,
  ScreenshotResult,
  ObservabilityFixture,
  PerfThresholds,
  NetworkAssertOpts,
  ConsoleAssertOpts,
  AxeAuditOpts,
  AiFixture,
  AiAssertOpts,
  AiDefectsOpts,
  AiExtractOpts,
} from "./api/index.js";

// Re-export types for other teammates to consume
export type {
  skepticConfig,
  BrowserConfig,
  AuthConfig,
  ExecutionConfig,
  OutputConfig,
  AIConfig,
} from "./config/schema.js";
export type { DeviceProfile, DeviceCategory } from "./config/device-profiles.js";
export type { EnvironmentInfo } from "./utils/ci-detect.js";
export { loadConfig } from "./config/loader.js";
export { DEVICE_PROFILES, getDeviceProfile, getProfilesByCategory } from "./config/device-profiles.js";
export { detectCI } from "./utils/ci-detect.js";
export { logger, setLogLevel, getLogLevel } from "./utils/logger.js";
export { Timer } from "./utils/timer.js";
export { interpolateEnv, interpolateEnvDeep } from "./utils/env.js";
