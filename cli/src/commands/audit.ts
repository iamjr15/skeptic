import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import { logger } from "../utils/logger.js";

const AUDIT_SCRIPTS = ["lint", "check", "typecheck", "type-check", "format", "tsc"];

export async function runAudit(opts: { fix?: boolean }): Promise<void> {
  const pkgPath = "package.json";
  if (!fs.existsSync(pkgPath)) {
    logger.error("No package.json found in current directory");
    process.exitCode = 1;
    return;
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};

  // Detect package manager
  const pm = fs.existsSync("pnpm-lock.yaml")
    ? "pnpm"
    : fs.existsSync("yarn.lock")
      ? "yarn"
      : "npm";

  // Find matching audit scripts
  const matched = Object.keys(scripts).filter((name) =>
    AUDIT_SCRIPTS.some((pattern) => name.includes(pattern)),
  );

  if (matched.length === 0) {
    logger.warn("No lint/check/typecheck scripts found in package.json");
    return;
  }

  logger.info(`Running ${matched.length} quality check(s) with ${chalk.cyan(pm)}...\n`);

  let passed = 0;
  let failed = 0;

  for (const name of matched) {
    const start = performance.now();
    try {
      execFileSync(pm, ["run", name], { stdio: "pipe", encoding: "utf-8" });
      const ms = Math.round(performance.now() - start);
      console.log(`  ${chalk.green("✔")} ${name} ${chalk.dim(`(${ms}ms)`)}`);
      passed++;
    } catch (err) {
      const ms = Math.round(performance.now() - start);
      console.log(`  ${chalk.red("✖")} ${name} ${chalk.dim(`(${ms}ms)`)}`);
      if (err && typeof err === "object" && "stdout" in err) {
        const output = String((err as { stdout: unknown }).stdout).trim();
        if (output) {
          console.log(chalk.dim(`    ${output.split("\n").slice(0, 5).join("\n    ")}`));
        }
      }
      failed++;
    }
  }

  console.log();
  logger.info(`${chalk.green(`${passed} passed`)}, ${failed > 0 ? chalk.red(`${failed} failed`) : "0 failed"}`);

  if (opts.fix) {
    const fixScript = Object.keys(scripts).find((s) => s === "lint:fix" || s === "fix");
    if (fixScript) {
      logger.info(`\nRunning ${chalk.cyan(`${pm} run ${fixScript}`)}...`);
      try {
        execFileSync(pm, ["run", fixScript], { stdio: "inherit" });
      } catch {
        logger.warn("Auto-fix completed with issues");
      }
    } else {
      logger.warn("No lint:fix or fix script found — skipping --fix");
    }
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}
