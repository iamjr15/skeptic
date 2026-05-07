import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { PRODUCT_NAME, CONFIG_FILENAME, OUTPUT_DIR_DEFAULT } from "../constants.js";
import { logger } from "../utils/logger.js";
import { readTemplate } from "../utils/asset-path.js";

const PROJECT_CACHE_DIR = ".skeptic";
const PROJECT_CACHE_GITIGNORE = `*
!.gitignore
`;
const TESTS_PACKAGE_JSON = `{
  "type": "module"
}
`;

/** Scaffold a new skeptic project in the given directory. */
export async function runInit(targetDir: string = process.cwd()): Promise<void> {
  const dir = path.resolve(targetDir);
  logger.info(`Initializing ${PRODUCT_NAME} project in ${chalk.cyan(dir)}`);

  // Create tests directory
  const testsDir = path.join(dir, "tests");
  mkdirSafe(testsDir);
  logger.success(`Created ${chalk.dim("tests/")}`);

  ensureProjectCacheIgnored(dir);
  ensureRootGitignoreEntries(dir);
  ensureRootPackageJson(dir);
  ensureTestsPackageJson(testsDir);

  // Copy config template
  const configDest = path.join(dir, CONFIG_FILENAME);
  if (fs.existsSync(configDest)) {
    logger.warn(`${CONFIG_FILENAME} already exists, skipping`);
  } else {
    fs.writeFileSync(configDest, readTemplate("skeptic.config.yaml"));
    logger.success(`Created ${chalk.dim(CONFIG_FILENAME)}`);
  }

  // Copy example test.
  const exampleDest = path.join(testsDir, "example.spec.ts");
  if (fs.existsSync(exampleDest)) {
    logger.warn("Example test already exists, skipping");
  } else {
    fs.writeFileSync(exampleDest, readTemplate("example.spec.ts"));
    logger.success(`Created ${chalk.dim("tests/example.spec.ts")}`);
  }

  // Copy tsconfig template at project root (so `*.spec.ts` typechecks against
  // the user's editor and `tsx` resolves modules correctly).
  const tsconfigDest = path.join(dir, "tsconfig.json");
  if (fs.existsSync(tsconfigDest)) {
    logger.warn("tsconfig.json already exists, skipping");
  } else {
    fs.writeFileSync(tsconfigDest, readTemplate("tsconfig.json"));
    logger.success(`Created ${chalk.dim("tsconfig.json")}`);
  }

  // Install Playwright browsers via the skeptic-internal helper. The
  // equivalent `npx playwright install --with-deps chromium` remains a
  // working fallback.
  logger.info("Installing Playwright browsers...");
  try {
    const { runBrowsersInstall } = await import("./browsers-install.js");
    await runBrowsersInstall(["chromium"], { withDeps: true });
    logger.success("Playwright Chromium installed");
  } catch {
    logger.warn(
      "Failed to install Playwright browsers automatically.\n" +
      `  Run manually: ${chalk.cyan("skeptic browsers install --with-deps chromium")}`,
    );
  }

  // Print next steps
  console.log();
  console.log(chalk.bold("  Next steps:"));
  let step = 1;
  console.log(chalk.dim(`  ${step}.`) + ` Run ${chalk.cyan(detectInstallCommand(dir).join(" "))}`);
  step += 1;
  console.log(chalk.dim(`  ${step}.`) + ` Edit ${chalk.cyan(CONFIG_FILENAME)} with your base URL`);
  step += 1;
  console.log(chalk.dim(`  ${step}.`) + ` Write tests in ${chalk.cyan("tests/*.spec.ts")}`);
  step += 1;
  console.log(chalk.dim(`  ${step}.`) + ` Run ${chalk.cyan("skeptic run")} to execute`);
  console.log();
}

function detectInstallCommand(projectDir: string): [string, ...string[]] {
  if (fs.existsSync(path.join(projectDir, "pnpm-lock.yaml"))) return ["pnpm", "install"];
  if (fs.existsSync(path.join(projectDir, "yarn.lock"))) return ["yarn", "install"];
  if (
    fs.existsSync(path.join(projectDir, "bun.lock")) ||
    fs.existsSync(path.join(projectDir, "bun.lockb"))
  ) {
    return ["bun", "install"];
  }
  return ["npm", "install"];
}

function mkdirSafe(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ensureRootPackageJson(projectDir: string): void {
  const packagePath = path.join(projectDir, "package.json");
  const desiredVersion = `^${__SKEPTIC_CLI_VERSION__}`;

  if (!fs.existsSync(packagePath)) {
    const name = path.basename(projectDir).replace(/[^a-zA-Z0-9._-]/g, "-") || "skeptic-project";
    const pkg = {
      name,
      private: true,
      type: "module",
      scripts: {
        "test:e2e": "skeptic run",
      },
      devDependencies: {
        "skeptic-cli": desiredVersion,
      },
    };
    fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
    logger.success(`Created ${chalk.dim("package.json")}`);
    return;
  }

  let pkg: {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  try {
    pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8")) as typeof pkg;
  } catch {
    logger.warn("package.json exists but could not be parsed, skipping dependency/script update");
    return;
  }

  let changed = false;
  pkg.scripts ??= {};
  if (!pkg.scripts["test:e2e"]) {
    pkg.scripts["test:e2e"] = "skeptic run";
    changed = true;
  }

  const hasRuntimeDependency =
    pkg.dependencies?.["skeptic-cli"] !== undefined ||
    pkg.devDependencies?.["skeptic-cli"] !== undefined;
  if (!hasRuntimeDependency) {
    pkg.devDependencies ??= {};
    pkg.devDependencies["skeptic-cli"] = desiredVersion;
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
    logger.success(`Updated ${chalk.dim("package.json")} for skeptic`);
  } else {
    logger.warn("package.json already has skeptic script/dependency, skipping");
  }
}

function ensureTestsPackageJson(testsDir: string): void {
  const packagePath = path.join(testsDir, "package.json");
  if (fs.existsSync(packagePath)) {
    logger.warn("tests/package.json already exists, skipping");
    return;
  }
  fs.writeFileSync(packagePath, TESTS_PACKAGE_JSON, "utf-8");
  logger.success(`Created ${chalk.dim("tests/package.json")}`);
}

function ensureProjectCacheIgnored(projectDir: string): void {
  const cacheDir = path.join(projectDir, PROJECT_CACHE_DIR);
  mkdirSafe(cacheDir);

  const gitignorePath = path.join(cacheDir, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    logger.warn(`${PROJECT_CACHE_DIR}/.gitignore already exists, skipping`);
    return;
  }

  fs.writeFileSync(gitignorePath, PROJECT_CACHE_GITIGNORE, "utf-8");
  logger.success(`Created ${chalk.dim(`${PROJECT_CACHE_DIR}/.gitignore`)}`);
}

function ensureRootGitignoreEntries(projectDir: string): void {
  const gitignorePath = path.join(projectDir, ".gitignore");
  const outputDirPattern = gitignorePatternForPath(OUTPUT_DIR_DEFAULT);
  const desiredEntries = [PROJECT_CACHE_DIR + "/", outputDirPattern];
  const hadGitignore = fs.existsSync(gitignorePath);

  const existing = hadGitignore
    ? fs.readFileSync(gitignorePath, "utf-8")
    : "";
  const normalizedExisting = normalizeGitignoreLines(existing);
  const missingEntries = desiredEntries.filter((entry) => !normalizedExisting.has(normalizeGitignoreEntry(entry)));

  if (missingEntries.length === 0) {
    logger.warn(".gitignore already ignores skeptic artifacts, skipping");
    return;
  }

  const lines: string[] = [];
  if (existing.length > 0 && !existing.endsWith("\n")) {
    lines.push("");
  }
  if (existing.trim().length > 0) {
    lines.push("");
  }
  lines.push("# Skeptic artifacts", ...missingEntries);

  fs.appendFileSync(gitignorePath, `${lines.join("\n")}\n`, "utf-8");
  logger.success(
    hadGitignore
      ? `Updated ${chalk.dim(".gitignore")} for skeptic artifacts`
      : `Created ${chalk.dim(".gitignore")}`,
  );
}

function normalizeGitignoreLines(content: string): Set<string> {
  const entries = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const entry = normalizeGitignoreEntry(rawLine);
    if (entry.length > 0) {
      entries.add(entry);
    }
  }
  return entries;
}

function normalizeGitignoreEntry(entry: string): string {
  const withoutInlineComment = entry.replace(/\s+#.*$/, "");
  const trimmed = withoutInlineComment.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return "";
  }
  return trimmed.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function gitignorePatternForPath(value: string): string {
  const normalized = normalizeGitignoreEntry(value.replaceAll(path.sep, "/"));
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}
