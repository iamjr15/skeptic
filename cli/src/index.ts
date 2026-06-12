import { Command, InvalidArgumentError } from "commander";
import { CLI_NAME, PRODUCT_NAME } from "./constants.js";
// All command runners are dynamic-imported in their `.action(...)` handlers
// so cold-start (especially `--help`) doesn't pay the load cost of every
// runner's transitive deps. Type-only imports stay at the top — they're
// erased at build time and add zero runtime cost.
import type { RunCommandOptions } from "./commands/run.js";
import type { AddGitHubActionOptions, AddSkillOptions } from "./commands/add.js";
import { setLogLevel } from "./utils/logger.js";
import type { LogLevel } from "./utils/logger.js";

export function parsePositiveInt(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new InvalidArgumentError(`expected a positive integer, got "${value}"`);
  }
  return Number(value);
}

// Accepts 0 — used for counters where zero is a meaningful value (retries: no
// retries; idle timeout: disabled). Bare `parseInt` silently yields NaN on junk
// input (e.g. `--retries abc`), which then poisons downstream arithmetic; this
// fails loudly instead.
export function parseNonNegativeInt(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError(`expected a non-negative integer, got "${value}"`);
  }
  return Number(value);
}

function parseWaitUntil(value: string): "load" | "domcontentloaded" | "networkidle" | "commit" {
  if (value === "load" || value === "domcontentloaded" || value === "networkidle" || value === "commit") {
    return value;
  }
  throw new InvalidArgumentError(
    `expected one of load, domcontentloaded, networkidle, or commit; got "${value}"`,
  );
}

function parseBlankFrameDetection(value: string): "off" | "warn" | "fail" {
  if (value === "off" || value === "warn" || value === "fail") {
    return value;
  }
  throw new InvalidArgumentError(`expected one of off, warn, or fail; got "${value}"`);
}

function parseWaitState(value: string): "attached" | "detached" | "visible" | "hidden" {
  if (value === "attached" || value === "detached" || value === "visible" || value === "hidden") {
    return value;
  }
  throw new InvalidArgumentError(
    `expected one of attached, detached, visible, or hidden; got "${value}"`,
  );
}

// `ios` gets a distinct message: it's a deliberately-unsupported target, not a
// typo. Without this guard an unknown platform silently folds to a chromium web
// session (see daemonOpts in browser-verbs), changing behavior with no error.
function parsePlatform(value: string): "web" | "android" {
  if (value === "web" || value === "android") {
    return value;
  }
  if (value === "ios") {
    throw new InvalidArgumentError("ios is not supported yet; expected one of web or android");
  }
  throw new InvalidArgumentError(`unknown platform "${value}"; expected one of web or android`);
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

const addRunOptions = (
  command: Command,
  opts: { includeWatch?: boolean } = {},
): Command => {
  const withCommonOptions = command
    .option("-c, --config <path>", "path to config file")
    .option("--headed", "run browser in headed mode")
    .option("--verbose", "verbose output")
    .option("--ci", "force CI mode (headless, no prompts)")
    .option("--bail", "stop on first failure")
    .option("--retries <n>", "retry failed tests N times", parseNonNegativeInt)
    .option("--timeout <ms>", "soft per-action default timeout in ms", parsePositiveInt)
    .option("--hard-timeout <ms>", "hard per-test ceiling in ms", parsePositiveInt)
    .option("--device <id>", "device profile for viewport emulation")
    .option("--reporter <format...>", "reporter format(s): console, json, junit, html")
    .option("--output <dir>", "output directory for reports")
    .option("--cookies", "enable browser cookie extraction (opt-in)")
    .option("--cookies-from <browser>", "extract cookies from specific browser only")
    .option("--video", "record video of test execution (WebM)")
    .option(
      "--video-size <WxH>",
      "video recording resolution (e.g., 1920x1080); overrides viewport size for video only",
    );

  if (opts.includeWatch) {
    withCommonOptions.option("-w, --watch", "watch for file changes and re-run");
  }

  withCommonOptions
    .option("-u, --url <url>", "base URL (overrides config)")
    .option("--parallel <n>", "run N test files concurrently", parsePositiveInt)
    .option("--shard-split <n>", "split tests across N runs (each runs disjoint subset)", parseShardCount)
    .option("--shard-all <n>", "run all tests on each of N runs", parseShardCount)
    .option(
      "--shard-index <n>",
      "1-based shard index for --shard-split / --shard-all (also via SKEPTIC_SHARD_INDEX)",
      parsePositiveInt,
    );

  return withCommonOptions
    .option("--trace", "record Playwright trace for each test")
    .option("--har", "capture a HAR (HTTP archive) of network traffic per test")
    .option(
      "--observability",
      "enable the full observability bundle: settle + fullPage + perf+net+console+a11y(auto) + sidecar md",
    )
    .option("--full-page-screenshot", "force fullPage=true on all screenshot calls")
    .option("--no-full-page-screenshot", "force fullPage=false (overrides config)")
    .option("--visual-settle", "enable the visual-settle helper before screenshots")
    .option("--no-visual-settle", "disable the visual-settle helper")
    .option("--blank-frame-detection <mode>", "off | warn | fail", parseBlankFrameDetection)
    .option(
      "--observability-write-sidecars",
      "write per-test perf-trace.md + console.json + network.json",
    )
    .option("--list", "discover tests without running them")
    .option("--tag <tag...>", "filter tests by tag (declared via test.use({ tags }))")
    .option("--env <KEY=VALUE...>", "set environment variables")
    .option("--no-daemon", "bypass the persistent BrowserServer daemon")
    .option(
      "--daemon-idle-timeout <seconds>",
      "auto-stop the daemon after N seconds idle (default 300; 0 disables)",
      parseNonNegativeInt,
    );
};

program
  .name(CLI_NAME)
  .description(`${PRODUCT_NAME} — CLI-first E2E testing with TypeScript test specs`)
  .version(__SKEPTIC_CLI_VERSION__)
  .option("-v, --verbose", "enable verbose logging")
  .option("-q, --quiet", "suppress all output except errors")
  .option("--features", "print build-time feature map and exit")
  .addHelpText(
    "after",
    `
Examples:
  $ skeptic tui
  $ skeptic tui tests/login.spec.ts
  $ skeptic run tests/login.spec.ts --observability --video --trace
  $ skeptic inspect https://example.com --interactive --compact`,
  )
  .hook("preAction", (_thisCommand, _actionCommand) => {
    const opts = program.opts<{ verbose?: boolean; quiet?: boolean }>();
    let level: LogLevel = "info";
    if (opts.verbose) level = "debug";
    if (opts.quiet) level = "error";
    setLogLevel(level);
  });

program
  .command("init")
  .alias("setup")
  .description("Initialize a new skeptic project")
  .argument("[dir]", "target directory", ".")
  .action(async (dir: string) => {
    const { runInit } = await import("./commands/init.js");
    await runInit(dir);
  });

addRunOptions(
  program
    .command("run")
    .description("Run TypeScript test specs")
    .argument("[specs...]", "spec file globs (default: tests/**/*.spec.ts)"),
  { includeWatch: true },
)
  .action(async (specs: string[], cmdOpts: RunCommandOptions) => {
    const { runRun } = await import("./commands/run.js");
    await runRun(specs.length > 0 ? specs : undefined, cmdOpts);
  });

addRunOptions(
  program
    .command("tui")
    .description("Open the interactive test runner TUI")
    .argument("[specs...]", "spec file globs (default: tests/**/*.spec.ts)"),
)
  .addHelpText(
    "after",
    `
Examples:
  $ skeptic tui
  $ skeptic tui tests/login.spec.ts
  $ skeptic tui tests/**/*.spec.ts --reporter json`,
  )
  .action(async (specs: string[], cmdOpts: RunCommandOptions) => {
    const { runRun } = await import("./commands/run.js");
    await runRun(specs.length > 0 ? specs : undefined, { ...cmdOpts, forceTui: true });
  });

program
  .command("mail")
  .description("Start a local SMTP sink and print the one-time code from a verification email")
  .option("--to <address>", "only match emails addressed to this recipient (substring)")
  .option("--port <n>", "SMTP listen port (point the app's SMTP here)", parsePositiveInt, 2525)
  .option("--timeout <ms>", "how long to wait for the email", parsePositiveInt, 60_000)
  .option("--json", "machine-readable output (includes full message)")
  .action(async (cmdOpts: import("./commands/mail.js").MailCommandOptions) => {
    const { runMail } = await import("./commands/mail.js");
    await runMail(cmdOpts);
  });

program
  .command("scaffold")
  .description("Generate a TypeScript spec skeleton from a live page (deterministic, no AI)")
  .argument("<url>", "URL to scaffold a spec from")
  .option("-o, --output <dir>", "output directory", "tests")
  .option("--name <name>", "base name for the spec file")
  .option("--headed", "show the browser")
  .action(async (url: string, cmdOpts: import("./commands/scaffold.js").ScaffoldCommandOptions) => {
    const { runScaffold } = await import("./commands/scaffold.js");
    await runScaffold(url, cmdOpts);
  });

const addCmd = program
  .command("add")
  .description("Add integrations and scaffolding");

addCmd
  .command("github-action")
  .description("Generate a GitHub Actions workflow for E2E tests")
  .option("--dev-command <cmd>", "dev server start command", "npm run dev")
  .option("--dev-url <url>", "dev server URL", "http://localhost:3000")
  .option("-c, --config <path>", "path to config file")
  .action(async (cmdOpts: AddGitHubActionOptions) => {
    const { runAddGitHubAction } = await import("./commands/add.js");
    await runAddGitHubAction(cmdOpts);
  });

addCmd
  .command("skill")
  .description("Install skeptic skill for an AI coding agent")
  .option("--agent <name>", "agent name: claude, codex, cursor, opencode, all")
  .option("--scope <scope>", "skill scope: project or user", "project")
  .action(async (cmdOpts: AddSkillOptions) => {
    const { runAddSkill } = await import("./commands/add.js");
    await runAddSkill(cmdOpts);
  });

const cookiesCmd = program
  .command("cookies")
  .description("Manage browser cookie extraction");

// `skeptic browsers install [chromium|firefox|webkit|all]` — installs
// Playwright browsers without requiring users to know Playwright's own CLI.
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
  .command("doctor")
  .description("Diagnose skeptic setup, browser installs, optional engines, daemon state, and agent DX")
  .option("--json", "emit machine-readable JSON")
  .option("--quick", "skip live browser launch checks")
  .option("--fix", "create missing skeptic-owned directories when safe")
  .action(async (cmdOpts: import("./commands/doctor.js").DoctorOptions) => {
    const { runDoctor } = await import("./commands/doctor.js");
    await runDoctor(cmdOpts);
  });

program
  .command("observe")
  .description("Run one ad hoc browser observability pass and write a full artifact bundle")
  .argument("<url>", "URL to observe")
  .option("-c, --config <path>", "path to config file")
  .option("--headed", "run browser in headed mode")
  .option("--device <id>", "device profile for viewport emulation")
  .option("--output <dir>", "output directory for reports")
  .option("--wait <ms>", "extra wait after navigation before capture", parseNonNegativeInt)
  .option("--wait-until <strategy>", "navigation wait strategy: load, domcontentloaded, networkidle, or commit", parseWaitUntil)
  .option("--full-page", "capture full-page screenshots")
  .option("--video", "record video of the observation")
  .option("--no-video", "disable video recording")
  .option("--video-size <WxH>", "video recording resolution (e.g., 1920x1080)")
  .option("--trace", "record Playwright trace")
  .option("--no-trace", "disable Playwright trace")
  .option("--cookies", "enable browser cookie extraction")
  .option("--cookies-from <browser>", "extract cookies from specific browser only")
  .option("--timeout <ms>", "default timeout in ms", parsePositiveInt)
  .option("--no-tui", "suppress live console progress")
  .action(async (url: string, cmdOpts: import("./commands/observe.js").ObserveCommandOptions) => {
    const { runObserve } = await import("./commands/observe.js");
    await runObserve(url, cmdOpts);
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
  .option("--wait <ms>", "extra settle in ms after navigation before snapshot (default 0; the adaptive networkidle settle runs regardless)")
  .option("--connect <url>", "CDP auto-discover and attach (host:port or ws URL)")
  .option("--with-playwright-hints", "also emit Playwright snippet per ref")
  .option("--annotated", "capture an annotated PNG with numbered badges over each ref")
  .option("--annotate-output <path>", "output path for the annotated PNG (defaults to ./skeptic-inspect-<ts>.png)")
  .option("--no-daemon", "bypass the persistent daemon and launch a fresh browser")
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
    parseNonNegativeInt,
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
  .option("-n, --lines <n>", "show last N lines (default 200)", parsePositiveInt)
  .action(async (cmdOpts: { lines?: number }) => {
    const { runDaemonLogs } = await import("./commands/daemon.js");
    await runDaemonLogs(cmdOpts);
  });

// Hidden: the interactive-session daemon (the dedicated headed slot). Not for
// manual use — auto-spawned by the browser-session verbs via ensureSessionDaemon.
program
  .command("session-daemon", { hidden: true })
  .description("(internal) interactive browser-session daemon — auto-spawned by session verbs")
  .option("--engine <engine>", "browser engine", "chromium")
  .option("--headed", "run headed (default)")
  .option("--headless", "run headless")
  .option("--idle-timeout <seconds>", "daemon idle shutdown", parseNonNegativeInt)
  .option("--session-idle <seconds>", "per-session idle reap", parseNonNegativeInt)
  .action(async (cmdOpts: import("./commands/session-daemon-cmd.js").SessionDaemonCmdOptions) => {
    const { runSessionDaemon } = await import("./commands/session-daemon-cmd.js");
    await runSessionDaemon(cmdOpts);
  });

// ── Browser-session interaction verbs ────────────────────────────────────────
// Persistent daemon-held session: refs from `skeptic snapshot` survive into the
// next `skeptic click @eN` because the session lives in the session daemon.
type SessionVerbOpts = import("./commands/browser-verbs.js").BrowserVerbOptions;

const addSessionOpts = (command: Command): Command =>
  command
    .option("--session <name>", "isolated session name", "default")
    .option("--json", "machine-readable JSON output")
    .option(
      "--platform <platform>",
      "web (default) | android (drives a device/emulator via adb)",
      parsePlatform,
    )
    .option("--headed", "run the session browser headed (default; web only)")
    .option("--headless", "run the session browser headless (web only)");

addSessionOpts(
  program.command("open").description("Open a URL in a persistent browser session").argument("<url>", "URL to open"),
)
  .option("--wait-until <s>", "navigation wait: load, domcontentloaded, networkidle, commit", parseWaitUntil)
  .action(async (url: string, opts: import("./commands/browser-verbs.js").OpenVerbOptions) => {
    const { runOpen } = await import("./commands/browser-verbs.js");
    await runOpen(url, opts);
  });

addSessionOpts(
  program.command("snapshot").description("Snapshot the open session's page — mints @eN refs + selectorHints"),
)
  .option("-i, --interactive", "filter to interactive refs")
  .option("-c, --compact", "interactive + minimal ancestors")
  .action(async (opts: import("./commands/browser-verbs.js").SnapshotVerbOptions) => {
    const { runSnapshot } = await import("./commands/browser-verbs.js");
    await runSnapshot(opts);
  });

addSessionOpts(
  program.command("click").description("Click an element (@eN ref or selector)").argument("<target>", "@eN or selector"),
).action(async (target: string, opts: SessionVerbOpts) => {
  const { runClick } = await import("./commands/browser-verbs.js");
  await runClick(target, opts);
});

addSessionOpts(
  program.command("fill").description("Fill an input (clears first)").argument("<target>", "@eN or selector").argument("<text>", "text"),
).action(async (target: string, text: string, opts: SessionVerbOpts) => {
  const { runFill } = await import("./commands/browser-verbs.js");
  await runFill(target, text, opts);
});

addSessionOpts(
  program.command("type").description("Type into an element (no clear)").argument("<target>", "@eN or selector").argument("<text>", "text"),
).action(async (target: string, text: string, opts: SessionVerbOpts) => {
  const { runType } = await import("./commands/browser-verbs.js");
  await runType(target, text, opts);
});

addSessionOpts(
  program.command("press").description("Press a key on an element").argument("<target>", "@eN or selector").argument("<key>", 'e.g. "Enter"'),
).action(async (target: string, key: string, opts: SessionVerbOpts) => {
  const { runPress } = await import("./commands/browser-verbs.js");
  await runPress(target, key, opts);
});

addSessionOpts(
  program.command("hover").description("Hover an element").argument("<target>", "@eN or selector"),
).action(async (target: string, opts: SessionVerbOpts) => {
  const { runHover } = await import("./commands/browser-verbs.js");
  await runHover(target, opts);
});

addSessionOpts(
  program.command("check").description("Check a checkbox").argument("<target>", "@eN or selector"),
).action(async (target: string, opts: SessionVerbOpts) => {
  const { runCheck } = await import("./commands/browser-verbs.js");
  await runCheck(target, opts);
});

addSessionOpts(
  program.command("uncheck").description("Uncheck a checkbox").argument("<target>", "@eN or selector"),
).action(async (target: string, opts: SessionVerbOpts) => {
  const { runUncheck } = await import("./commands/browser-verbs.js");
  await runUncheck(target, opts);
});

addSessionOpts(
  program.command("select").description("Select an option").argument("<target>", "@eN or selector").argument("<value>", "option value"),
).action(async (target: string, value: string, opts: SessionVerbOpts) => {
  const { runSelect } = await import("./commands/browser-verbs.js");
  await runSelect(target, value, opts);
});

addSessionOpts(
  program.command("get").description("Read text|box|url|title from the session").argument("<query>", "text | box | url | title").argument("[target]", "@eN or selector"),
).action(async (query: string, target: string | undefined, opts: SessionVerbOpts) => {
  const { runGet } = await import("./commands/browser-verbs.js");
  await runGet(query, target, opts);
});

addSessionOpts(
  program.command("screenshot").description("Capture a screenshot of the session (returns a file path)"),
)
  .option("--name <name>", "artifact name", "screenshot")
  .option("--full", "full-page capture")
  .option("--annotate", "numbered badges over interactive refs")
  .action(async (opts: import("./commands/browser-verbs.js").ScreenshotVerbOptions) => {
    const { runScreenshot } = await import("./commands/browser-verbs.js");
    await runScreenshot(opts);
  });

addSessionOpts(
  program.command("console").description("Read the session's console messages (or --errors only)"),
)
  .option("--errors", "only uncaught errors / console.error")
  .action(async (opts: import("./commands/browser-verbs.js").ConsoleVerbOptions) => {
    const { runConsole } = await import("./commands/browser-verbs.js");
    await runConsole(opts);
  });

addSessionOpts(
  program.command("wait").description("Wait for a duration (--ms) or a selector"),
)
  .option("--ms <n>", "milliseconds to wait", parseNonNegativeInt)
  .option("--selector <sel>", "wait for a selector")
  .option("--state <state>", "visible | hidden | attached | detached", parseWaitState)
  .option("--timeout-ms <n>", "wait timeout", parseNonNegativeInt)
  .action(async (opts: import("./commands/browser-verbs.js").WaitVerbOptions) => {
    const { runWait } = await import("./commands/browser-verbs.js");
    await runWait(opts);
  });

addSessionOpts(
  program.command("close").description("Close the session (--all closes every session)"),
)
  .option("--all", "close all sessions")
  .action(async (opts: import("./commands/browser-verbs.js").CloseVerbOptions) => {
    const { runClose } = await import("./commands/browser-verbs.js");
    await runClose(opts);
  });

addSessionOpts(program.command("list").description("List open browser sessions")).action(
  async (opts: SessionVerbOpts) => {
    const { runList } = await import("./commands/browser-verbs.js");
    await runList(opts);
  },
);

program
  .command("devices")
  .description("List connected devices/emulators (Android via adb; iOS preview via simctl)")
  .option("--json", "machine-readable JSON output")
  .action(async (cmdOpts: import("./commands/devices.js").DevicesCommandOptions) => {
    const { runDevices } = await import("./commands/devices.js");
    await runDevices(cmdOpts);
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

program.action(() => {
  program.outputHelp();
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
} from "./api/index.js";

// Re-export types for other teammates to consume
export type {
  skepticConfig,
  BrowserConfig,
  AuthConfig,
  ExecutionConfig,
  OutputConfig,
  SafetyConfig,
} from "./config/schema.js";
export type { DeviceProfile, DeviceCategory } from "./config/device-profiles.js";
export type { EnvironmentInfo } from "./utils/ci-detect.js";
export { loadConfig } from "./config/loader.js";
export { DEVICE_PROFILES, getDeviceProfile, getProfilesByCategory } from "./config/device-profiles.js";
export { detectCI } from "./utils/ci-detect.js";
export { logger, setLogLevel, getLogLevel } from "./utils/logger.js";
export { Timer } from "./utils/timer.js";
export { interpolateEnv, interpolateEnvDeep } from "./utils/env.js";
