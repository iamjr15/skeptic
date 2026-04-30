import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { Page } from "playwright";
import type { ExecutionContext } from "../executor/context.js";
import type { StepDiagnostic } from "../executor/types.js";

export interface ScreenshotOptions {
  fullPage?: boolean;
  /** B4 hook — falls back to plain capture in B1. */
  annotate?: boolean;
}

export interface ScreenshotResult {
  path: string;
  diagnostics: StepDiagnostic[];
}

const sanitizeName = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, "_");

export const takeScreenshot = async (
  page: Page,
  ctx: ExecutionContext,
  name: string,
  opts: ScreenshotOptions = {},
): Promise<ScreenshotResult> => {
  const outDir = ctx.flowDir;
  await mkdir(outDir, { recursive: true });
  const safeName = sanitizeName(name);
  const filePath = join(outDir, `${safeName}.png`);

  const fullPage = opts.fullPage ?? ctx.artifactConfig.fullPageScreenshots;
  const buffer = await page.screenshot({ fullPage, path: filePath });
  await writeFile(filePath, buffer).catch(() => {
    // page.screenshot already wrote to filePath; this is just a defensive copy if Playwright
    // ever silently swallowed the write (e.g. against an in-memory page).
  });
  ctx.addScreenshot(filePath);

  const diagnostics: StepDiagnostic[] = [];
  if (opts.annotate) {
    diagnostics.push({
      kind: "annotation-pending-b4",
      message: "annotated mode lands in Bundle 4 — captured plain screenshot",
    });
  }
  return { path: filePath, diagnostics };
};
