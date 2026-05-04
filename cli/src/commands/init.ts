import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { PRODUCT_NAME, CONFIG_FILENAME, OUTPUT_DIR_DEFAULT } from "../constants.js";
import { logger } from "../utils/logger.js";
import { getTemplatesDir } from "../utils/asset-path.js";

const TEMPLATES_DIR = getTemplatesDir();
const PROJECT_CACHE_DIR = ".skeptic";
const PROJECT_CACHE_GITIGNORE = `*
!.gitignore
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

  // Copy config template
  const configDest = path.join(dir, CONFIG_FILENAME);
  if (fs.existsSync(configDest)) {
    logger.warn(`${CONFIG_FILENAME} already exists, skipping`);
  } else {
    fs.copyFileSync(
      path.join(TEMPLATES_DIR, "skeptic.config.yaml"),
      configDest,
    );
    logger.success(`Created ${chalk.dim(CONFIG_FILENAME)}`);
  }

  // Copy example test.
  const exampleDest = path.join(testsDir, "example.spec.ts");
  if (fs.existsSync(exampleDest)) {
    logger.warn("Example test already exists, skipping");
  } else {
    fs.copyFileSync(
      path.join(TEMPLATES_DIR, "example.spec.ts"),
      exampleDest,
    );
    logger.success(`Created ${chalk.dim("tests/example.spec.ts")}`);
  }

  // Copy tsconfig template at project root (so `*.spec.ts` typechecks against
  // the user's editor and `tsx` resolves modules correctly).
  const tsconfigDest = path.join(dir, "tsconfig.json");
  if (fs.existsSync(tsconfigDest)) {
    logger.warn("tsconfig.json already exists, skipping");
  } else {
    fs.copyFileSync(
      path.join(TEMPLATES_DIR, "tsconfig.json"),
      tsconfigDest,
    );
    logger.success(`Created ${chalk.dim("tsconfig.json")}`);
  }

  // Install Playwright browsers via the skeptic-internal helper so no-Node
  // binary users don't need npx. For users on the npm install path,
  // `npx playwright install --with-deps chromium` remains a working synonym.
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
  console.log(chalk.dim("  1.") + ` Edit ${chalk.cyan(CONFIG_FILENAME)} with your base URL`);
  console.log(chalk.dim("  2.") + ` Write tests in ${chalk.cyan("tests/*.spec.ts")}`);
  console.log(chalk.dim("  3.") + ` Run ${chalk.cyan("skeptic run")} to execute`);
  console.log();
}

function mkdirSafe(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
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
