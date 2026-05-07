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

  if (opts.withDeps) {
    logger.info("Installing system dependencies for Playwright browsers…");
    await registry.installDeps(executables, !!opts.dryRun);
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
