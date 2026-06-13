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
  /** `--platform android|ios-sim` scaffolds a `device`-fixture spec against an app. */
  platform?: "web" | "android" | "ios-sim";
  /** Device/emulator serial or simulator UDID for --platform android|ios-sim. */
  target?: string;
}

interface DiscoveredRef {
  ref: string;
  role: string;
  name: string;
  selectorHint: string;
}

/**
 * Deterministic spec generator (no LLM). Opens the target (URL on web, a package
 * name / deep link on android), snapshots its interactive elements, and writes a
 * `tests/<slug>.spec.ts` skeleton the host agent fills in with real assertions.
 * Replaces the removed AI `generate` command.
 */
export const runScaffold = async (target: string, opts: ScaffoldCommandOptions): Promise<void> => {
  const outDir = path.resolve(process.cwd(), opts.output ?? "tests");
  fs.mkdirSync(outDir, { recursive: true });

  const platform = opts.platform === "android" || opts.platform === "ios-sim" ? opts.platform : "web";
  const isDevice = platform !== "web";
  const { title, refs } =
    platform === "android"
      ? await discoverAndroid(target, opts, outDir)
      : platform === "ios-sim"
        ? await discoverIos(target, opts, outDir)
        : await discoverWeb(target, opts);

  const base = opts.name ?? title ?? (isDevice ? target : new URL(target).hostname);
  const slug = uniqueSlug(base || "scaffold", outDir);
  const file = path.join(outDir, `${slug}.spec.ts`);
  const spec = isDevice
    ? buildDeviceSpec({ target, title, slug, refs, platform })
    : buildSpec({ url: target, title, slug, refs });
  fs.writeFileSync(file, spec, "utf-8");

  const runHint = isDevice
    ? `skeptic run ${path.relative(process.cwd(), file)} --platform ${platform}`
    : `skeptic run ${path.relative(process.cwd(), file)}`;
  logger.success(`Scaffolded ${chalk.cyan(path.relative(process.cwd(), file))}`);
  logger.info(
    chalk.dim(
      `Discovered ${refs.length} interactive element(s). Fill in the commented interactions and assertions, then \`${runHint}\`.`,
    ),
  );
};

const discoverWeb = async (
  url: string,
  opts: ScaffoldCommandOptions,
): Promise<{ title: string; refs: DiscoveredRef[] }> => {
  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch({ headless: !opts.headed });
  const driver = PlaywrightDriver.fromBrowser(browser, true);
  try {
    const session = await driver.newSession();
    await session.open(url, { waitUntil: "load" });
    const title = await session.title();
    const capture = await session.snapshot({ viewport: true, includeCursorInteractive: true, extractLinkHrefs: true });
    const refs = renderSnapshot(capture, { interactive: true }).refs.slice(0, 12);
    await session.close();
    return { title, refs };
  } finally {
    await driver.close();
  }
};

const discoverAndroid = async (
  target: string,
  opts: ScaffoldCommandOptions,
  outDir: string,
): Promise<{ title: string; refs: DiscoveredRef[] }> => {
  const { createAdb, listDevices } = await import("../driver/mobile/adb.js");
  const { AndroidAdbDriverSession } = await import("../driver/mobile/adb-session.js");
  let serial = opts.target;
  if (!serial) {
    const devices = (await listDevices().catch(() => [])).filter((d) => d.state === "device");
    if (devices.length === 0) {
      throw new Error("[android] no device/emulator found. Start one (or pass --target <serial>); `skeptic devices` lists them.");
    }
    serial = devices[0]!.serial;
  }
  const session = new AndroidAdbDriverSession(createAdb({ serial }), serial, outDir);
  await session.open(target);
  const title = await session.title();
  const capture = await session.snapshot();
  const refs = renderSnapshot(capture, { interactive: true }).refs.slice(0, 12);
  await session.close();
  return { title, refs };
};

const discoverIos = async (
  target: string,
  opts: ScaffoldCommandOptions,
  outDir: string,
): Promise<{ title: string; refs: DiscoveredRef[] }> => {
  const { IosSimDriver } = await import("../driver/mobile/simctl-driver.js");
  const driver = await IosSimDriver.create({ ...(opts.target ? { udid: opts.target } : {}) });
  try {
    const session = await driver.newSession({ artifactDir: outDir });
    await session.open(target);
    const title = await session.title();
    const capture = await session.snapshot();
    const refs = renderSnapshot(capture, { interactive: true }).refs.slice(0, 12);
    await session.close();
    return { title, refs };
  } finally {
    await driver.close();
  }
};

const titleRegex = (title: string): string => {
  const trimmed = title.trim();
  if (!trimmed) return "/.*/";
  // Escape for a forgiving substring match.
  const escaped = trimmed.slice(0, 40).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return `/${escaped}/`;
};

const buildDeviceSpec = (input: {
  target: string;
  title: string;
  slug: string;
  refs: DiscoveredRef[];
  platform: "android" | "ios-sim";
}): string => {
  const interactions = input.refs.length
    ? input.refs
        .map((r) => {
          const label = `${r.role}${r.name ? ` "${r.name}"` : ""}`;
          const target = r.selectorHint || `@${r.ref}`;
          return `  // ${label}\n  // await device.click(${JSON.stringify(target)});`;
        })
        .join("\n")
    : "  // (no interactive elements discovered — add your own selectorHints)";

  const firstHint = input.refs.find((r) => r.selectorHint)?.selectorHint;
  return `import { test, expect } from "skeptic-cli";

// Scaffolded by \`skeptic scaffold ${input.target} --platform ${input.platform}\`. Fill in
// the real interactions + assertions, then run with
// \`skeptic run tests/${input.slug}.spec.ts --platform ${input.platform}\`.
test(${JSON.stringify(`${input.title || input.slug} smoke`)}, async ({ device }) => {
  await device.open(${JSON.stringify(input.target)});
  const snap = await device.snapshot();

  // Discovered interactive elements (uncomment + adapt; re-snapshot after each screen change):
${interactions}

  ${firstHint ? `expect(snap.has(${JSON.stringify(firstHint)})).toBe(true);` : "// expect(snap.has(\"text=...\")).toBe(true);"}
  await device.screenshot(${JSON.stringify(input.slug)});
});
`;
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
