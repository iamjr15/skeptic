import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { OUTPUT_DIR_DEFAULT, PRODUCT_NAME } from "../constants.js";
import { loadConfigWithMeta } from "../config/loader.js";
import { detectBrowsers } from "../cookies/extractor.js";
import {
  ensureDaemonDir,
  getDaemonDir,
  getEnginePath,
  getLogPath,
  getPidPath,
  getSocketPath,
  getVersionPath,
} from "../daemon/socket.js";
import { isPidAlive } from "../daemon/lifecycle.js";
import { ENV_KEY_BY_PROVIDER } from "../ai/ai-client.js";
import { loadPlaywright } from "../utils/playwright-loader.js";
import { logger } from "../utils/logger.js";
import { safeJsonStringify } from "../utils/safe-json.js";

export type DoctorStatus = "pass" | "warn" | "fail" | "info";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  title: string;
  detail: string;
  data?: Record<string, unknown>;
}

export interface DoctorReport {
  product: string;
  version: string;
  cwd: string;
  platform: {
    os: string;
    arch: string;
    node: string;
  };
  summary: Record<DoctorStatus, number>;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  json?: boolean;
  quick?: boolean;
  fix?: boolean;
  cwd?: string;
}

const req = createRequire(import.meta.url);

const push = (
  checks: DoctorCheck[],
  id: string,
  status: DoctorStatus,
  title: string,
  detail: string,
  data?: Record<string, unknown>,
): void => {
  checks.push({ id, status, title, detail, ...(data ? { data } : {}) });
};

const canWriteDir = (dir: string, create: boolean): { ok: boolean; detail: string } => {
  try {
    if (!fs.existsSync(dir)) {
      if (!create) return { ok: false, detail: "directory does not exist" };
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.accessSync(dir, fs.constants.W_OK);
    return { ok: true, detail: "writable" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
};

const optionalDependencyCheck = (name: string, subpath?: string): boolean => {
  try {
    req.resolve(subpath ?? name);
    return true;
  } catch {
    return false;
  }
};

const readFirstLine = (filePath: string): string | null => {
  try {
    return fs.readFileSync(filePath, "utf-8").split(/\r?\n/, 1)[0] ?? null;
  } catch {
    return null;
  }
};

export const collectDoctorReport = async (
  options: DoctorOptions = {},
): Promise<DoctorReport> => {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const checks: DoctorCheck[] = [];

  push(checks, "runtime", "info", "Runtime", "Node and OS detected", {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    home: os.homedir(),
  });

  let cfgMeta: ReturnType<typeof loadConfigWithMeta> | null = null;
  try {
    cfgMeta = loadConfigWithMeta({ searchCwd: cwd });
    push(
      checks,
      "config",
      "pass",
      "Config",
      cfgMeta.configPath ? `loaded ${cfgMeta.configPath}` : "no config found; using defaults",
      {
        configPath: cfgMeta.configPath,
        tests: cfgMeta.config.tests,
        browser: cfgMeta.config.browser.engine,
      },
    );
  } catch (err) {
    push(
      checks,
      "config",
      "fail",
      "Config",
      err instanceof Error ? err.message : String(err),
    );
  }

  const cfg = cfgMeta?.config;
  const daemonDir = getDaemonDir();
  const daemonWritable = canWriteDir(daemonDir, Boolean(options.fix));
  push(
    checks,
    "home-dir",
    daemonWritable.ok ? "pass" : "warn",
    "Home Directory",
    `${daemonDir}: ${daemonWritable.detail}${options.fix ? " (fix enabled)" : ""}`,
  );
  if (options.fix && daemonWritable.ok) {
    ensureDaemonDir();
  }

  const outputDir = path.resolve(cwd, cfg?.output.dir ?? OUTPUT_DIR_DEFAULT);
  const outputWritable = canWriteDir(outputDir, Boolean(options.fix));
  push(
    checks,
    "output-dir",
    outputWritable.ok ? "pass" : "warn",
    "Output Directory",
    `${outputDir}: ${outputWritable.detail}`,
  );

  const axeOk = optionalDependencyCheck("@axe-core/playwright");
  push(
    checks,
    "axe-core",
    axeOk ? "pass" : "fail",
    "axe-core",
    axeOk ? "installed" : "missing @axe-core/playwright; accessibility audits cannot run",
  );

  const ibmOk = optionalDependencyCheck(
    "accessibility-checker-engine",
    "accessibility-checker-engine/ace.js",
  );
  push(
    checks,
    "ibm-equal-access",
    ibmOk ? "pass" : "warn",
    "IBM Equal Access",
    ibmOk
      ? "installed"
      : "optional dependency missing; dual-engine accessibility will fall back to axe-core",
  );

  const sqliteOk = optionalDependencyCheck("better-sqlite3");
  push(
    checks,
    "better-sqlite3",
    sqliteOk ? "pass" : "warn",
    "Cookie SQLite Reader",
    sqliteOk
      ? "installed"
      : "optional dependency missing; Chromium/Firefox cookie extraction may be limited",
  );

  try {
    const pw = await loadPlaywright();
    for (const engine of ["chromium", "firefox", "webkit"] as const) {
      try {
        const executablePath = pw[engine].executablePath();
        push(
          checks,
          `playwright-${engine}`,
          fs.existsSync(executablePath) ? "pass" : "warn",
          `Playwright ${engine}`,
          fs.existsSync(executablePath)
            ? `browser executable found at ${executablePath}`
            : `browser executable not found at ${executablePath}; run skeptic browsers install ${engine}`,
          { executablePath },
        );
      } catch (err) {
        push(
          checks,
          `playwright-${engine}`,
          "warn",
          `Playwright ${engine}`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    if (!options.quick && cfg) {
      try {
        const browser = await pw[cfg.browser.engine].launch({
          headless: cfg.browser.headless,
        });
        await browser.close();
        push(
          checks,
          "playwright-launch",
          "pass",
          "Browser Launch",
          `${cfg.browser.engine} launched and closed successfully`,
        );
      } catch (err) {
        push(
          checks,
          "playwright-launch",
          "fail",
          "Browser Launch",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  } catch (err) {
    push(
      checks,
      "playwright",
      "fail",
      "Playwright",
      err instanceof Error ? err.message : String(err),
    );
  }

  const pidPath = getPidPath();
  const pidRaw = readFirstLine(pidPath);
  const pid = pidRaw ? Number(pidRaw) : null;
  const daemonAlive = pid !== null && Number.isFinite(pid) && isPidAlive(pid);
  push(
    checks,
    "daemon",
    daemonAlive ? "pass" : pidRaw ? "warn" : "info",
    "Daemon",
    daemonAlive
      ? `running at PID ${pid}`
      : pidRaw
        ? `stale or inaccessible PID sidecar at ${pidPath}`
        : "not running",
    {
      socketPath: getSocketPath(),
      pidPath,
      versionPath: getVersionPath(),
      enginePath: getEnginePath(),
      logPath: getLogPath(),
      version: readFirstLine(getVersionPath()),
      engine: readFirstLine(getEnginePath()),
    },
  );

  const cookieBrowsers = detectBrowsers();
  push(
    checks,
    "cookies",
    cookieBrowsers.length > 0 ? "pass" : "warn",
    "Cookie Profiles",
    cookieBrowsers.length > 0
      ? `detected ${cookieBrowsers.length} supported browser profile(s)`
      : "no supported browser profiles detected",
    {
      browsers: cookieBrowsers.map((profile) => ({
        browser: profile.browser,
        profilePath: profile.profilePath,
      })),
    },
  );

  if (cfg) {
    const envKey = ENV_KEY_BY_PROVIDER[cfg.ai.provider];
    const hasConfiguredKey = Boolean(cfg.ai.apiKey || process.env[envKey]);
    push(
      checks,
      "ai-provider",
      hasConfiguredKey ? "pass" : "warn",
      "AI Provider",
      hasConfiguredKey
        ? `${cfg.ai.provider} key configured (${cfg.ai.apiKey ? "config" : envKey})`
        : `${cfg.ai.provider} selected but ${envKey} is not set`,
      { provider: cfg.ai.provider, envKey, model: cfg.ai.model ?? null },
    );
  }

  const summary: Record<DoctorStatus, number> = {
    pass: 0,
    warn: 0,
    fail: 0,
    info: 0,
  };
  for (const check of checks) summary[check.status] += 1;

  return {
    product: PRODUCT_NAME,
    version: __SKEPTIC_CLI_VERSION__,
    cwd,
    platform: {
      os: process.platform,
      arch: process.arch,
      node: process.version,
    },
    summary,
    checks,
  };
};

const statusSymbol = (status: DoctorStatus): string => {
  if (status === "pass") return "PASS";
  if (status === "warn") return "WARN";
  if (status === "fail") return "FAIL";
  return "INFO";
};

const printTextReport = (report: DoctorReport): void => {
  logger.raw(`${PRODUCT_NAME} doctor`);
  logger.raw(`cwd: ${report.cwd}`);
  logger.raw(
    `runtime: ${report.platform.os}-${report.platform.arch}, ${report.platform.node}`,
  );
  logger.raw(
    `summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail, ${report.summary.info} info`,
  );
  logger.raw("");
  for (const check of report.checks) {
    logger.raw(`${statusSymbol(check.status).padEnd(4)}  ${check.title}: ${check.detail}`);
  }
};

export const runDoctor = async (options: DoctorOptions = {}): Promise<void> => {
  const report = await collectDoctorReport(options);
  if (options.json) {
    process.stdout.write(`${safeJsonStringify(report)}\n`);
  } else {
    printTextReport(report);
  }
  if (report.summary.fail > 0) {
    process.exitCode = 1;
  }
};
