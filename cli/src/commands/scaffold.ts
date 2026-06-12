import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { loadPlaywright } from "../utils/playwright-loader.js";
import { PlaywrightDriver } from "../driver/playwright/playwright-driver.js";
import { renderSnapshot } from "./snapshot-render.js";
import { uniqueSlug } from "../utils/slug.js";
import { logger } from "../utils/logger.js";

export interface ScaffoldCommandOptions {
  output?: string;
  name?: string;
  headed?: boolean;
}

/**
 * Deterministic spec generator (no LLM). Opens the URL, snapshots its interactive
 * elements, and writes a `tests/<slug>.spec.ts` skeleton the host agent fills in
 * with real assertions. Replaces the removed AI `generate` command.
 */
export const runScaffold = async (url: string, opts: ScaffoldCommandOptions): Promise<void> => {
  const outDir = path.resolve(process.cwd(), opts.output ?? "tests");
  fs.mkdirSync(outDir, { recursive: true });

  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch({ headless: !opts.headed });
  const driver = PlaywrightDriver.fromBrowser(browser, true);
  let title = "";
  let refs: Array<{ ref: string; role: string; name: string; selectorHint: string }> = [];

  try {
    const session = await driver.newSession();
    await session.open(url, { waitUntil: "load" });
    title = await session.title();
    const capture = await session.snapshot({ viewport: true, includeCursorInteractive: true, extractLinkHrefs: true });
    refs = renderSnapshot(capture, { interactive: true }).refs.slice(0, 12);
    await session.close();
  } finally {
    await driver.close();
  }

  const base = opts.name ?? title ?? new URL(url).hostname;
  const slug = uniqueSlug(base || "scaffold", outDir);
  const file = path.join(outDir, `${slug}.spec.ts`);
  fs.writeFileSync(file, buildSpec({ url, title, slug, refs }), "utf-8");

  logger.success(`Scaffolded ${chalk.cyan(path.relative(process.cwd(), file))}`);
  logger.info(
    chalk.dim(
      `Discovered ${refs.length} interactive element(s). Fill in the commented interactions and assertions, then \`skeptic run ${path.relative(process.cwd(), file)}\`.`,
    ),
  );
};

const titleRegex = (title: string): string => {
  const trimmed = title.trim();
  if (!trimmed) return "/.*/";
  // Escape for a forgiving substring match.
  const escaped = trimmed.slice(0, 40).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return `/${escaped}/`;
};

const buildSpec = (input: {
  url: string;
  title: string;
  slug: string;
  refs: Array<{ ref: string; role: string; name: string; selectorHint: string }>;
}): string => {
  const interactions = input.refs.length
    ? input.refs
        .map((r) => {
          const label = `${r.role}${r.name ? ` "${r.name}"` : ""}`;
          return `  // ${label}\n  // await tree.byRole(${JSON.stringify(r.role)}, { name: ${JSON.stringify(r.name)} }).click();`;
        })
        .join("\n")
    : "  // (no interactive elements discovered — add your own locators)";

  return `import { test, expect } from "skeptic-cli";

// Scaffolded by \`skeptic scaffold ${input.url}\`. Fill in the real interactions
// and assertions below, then run with \`skeptic run\`.
test(${JSON.stringify(`${input.title || input.slug} smoke`)}, async ({ page, snapshot, screenshot, observability }) => {
  await page.goto(${JSON.stringify(input.url)});
  await expect(page).toHaveTitle(${titleRegex(input.title)});

  const tree = await snapshot(page, { interactive: true, compact: true });

  // Discovered interactive elements (uncomment + adapt the ones you need):
${interactions}

  await screenshot(${JSON.stringify(input.slug)}, { fullPage: true });
  await observability.expectNoConsoleErrors();
});
`;
};
