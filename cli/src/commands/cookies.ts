import chalk from "chalk";
import { logger } from "../utils/logger.js";

export async function runCookiesList(): Promise<void> {
  // Positive-branch DCE: when __SKEPTIC_FEATURE_COOKIE_EXTRACTION__ is
  // build-time false, esbuild folds this `if` and the dynamic import to the
  // else branch, dropping `../cookies/extractor.js` (and its better-sqlite3
  // dependency) from the bundle.
  if (__SKEPTIC_FEATURE_COOKIE_EXTRACTION__) {
    const { detectBrowsers } = await import("../cookies/extractor.js");
    const browsers = detectBrowsers();

    if (browsers.length === 0) {
      logger.warn("No supported browsers detected on this machine.");
      return;
    }

    console.log();
    console.log(chalk.bold("Detected browsers:"));
    console.log();

    const nameWidth = Math.max(...browsers.map((b) => b.browser.length), 7) + 2;
    const header = `${"Browser".padEnd(nameWidth)} Profile Path`;
    console.log(chalk.dim(header));
    console.log(chalk.dim("-".repeat(header.length + 40)));

    for (const b of browsers) {
      const name = chalk.cyan(b.browser.padEnd(nameWidth));
      const profilePath = chalk.dim(b.profilePath);
      console.log(`${name} ${profilePath}`);
    }

    console.log();
    console.log(
      chalk.dim(`${browsers.length} browser(s) detected. Use --cookies to inject cookies during tests.`),
    );
  } else {
    console.error("skeptic cookies: cookie extraction is not built into this binary.");
    console.error("Install via npm for cookie support: `npm i -g skeptic-cli`");
    process.exit(2);
  }
}
