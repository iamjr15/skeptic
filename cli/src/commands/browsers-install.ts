import { logger } from "../utils/logger.js";
import { loadPlaywrightCoreServer } from "../utils/playwright-loader.js";

export interface BrowsersInstallOptions {
  withDeps?: boolean;
  dryRun?: boolean;
}

/**
 * `skeptic browsers install [--with-deps] [chromium|firefox|webkit|all]`
 *
 * Mirrors the Playwright CLI install sequence. Verified against
 * `playwright-core/lib/server/registry/index.js:979` (real `install`
 * signature) and `lib/cli/installActions.js:119-148` (CLI's call pattern:
 * resolveBrowsers → installDeps → install → validateHostRequirements).
 *
 * Why this exists: users can stay inside the skeptic CLI instead of remembering
 * Playwright's separate install command. `npx playwright install` remains a
 * working synonym because both paths call into `playwright-core/lib/server`.
 */
export async function runBrowsersInstall(
  args: string[],
  opts: BrowsersInstallOptions = {},
): Promise<void> {
  const server = await loadPlaywrightCoreServer();
  const { registry } = server;

  // resolveBrowsers does not special-case "all" — empty array means
  // "install defaults" per registry/index.js. Normalize before passing.
  const normalizedArgs = args.includes("all") ? [] : args;
  const executables = registry.resolveBrowsers(normalizedArgs, {});

  const describeExecutables = (): string => {
    const names = executables.map((e) => e.name).filter(Boolean);
    return names.length > 0 ? names.join(", ") : "default browsers";
  };

  // --dry-run: report what WOULD be installed and make NO changes. Previously `dryRun` was only
  // forwarded to `installDeps` (and only under --with-deps); `registry.install(...)` ran
  // unconditionally, so `--dry-run` still downloaded the browser binaries. Gate the whole
  // install path here so the flag is honest.
  if (opts.dryRun) {
    if (opts.withDeps) {
      logger.info(
        "[dry-run] Would install OS-level dependencies for Playwright browsers (sudo on Linux).",
      );
      // installDeps honors its own dryRun flag — it prints the commands without executing them.
      await registry.installDeps(executables, true);
    }
    logger.info(`[dry-run] Would install Playwright browsers: ${describeExecutables()}`);
    logger.info("[dry-run] No changes made. Re-run without --dry-run to install.");
    return;
  }

  if (opts.withDeps) {
    logger.info("Installing system dependencies for Playwright browsers…");
    await registry.installDeps(executables, false);
  }

  logger.info("Installing Playwright browsers…");
  await registry.install(executables, { force: false });

  try {
    await registry.validateHostRequirementsForExecutablesIfNeeded(
      executables,
      "javascript",
    );
  } catch (err) {
    const e = err as Error;
    e.name = "Playwright Host validation warning";
    logger.warn(e.message);
  }

  logger.success("Playwright browser install complete.");
}
