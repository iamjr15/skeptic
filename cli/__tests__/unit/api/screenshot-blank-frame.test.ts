import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PNG } from "pngjs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { takeScreenshot } from "../../../src/api/screenshot.js";
import { ExecutionContext, DEFAULT_ARTIFACT_CONFIG } from "../../../src/executor/context.js";
import type { ArtifactRuntimeConfig } from "../../../src/executor/types.js";

const buildPng = (width: number, height: number, fill: number): Buffer => {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = fill;
    png.data[i + 1] = fill;
    png.data[i + 2] = fill;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
};

// Tiny all-black PNG: < 8KB and zero pixel variance → detectBlankFrame.blank === true.
const BLANK = buildPng(40, 40, 0);

const makePage = (buffer: Buffer) =>
  ({
    screenshot: async () => buffer,
  }) as unknown as Parameters<typeof takeScreenshot>[0];

const ctxWith = (
  page: ReturnType<typeof makePage>,
  testDir: string,
  mode: ArtifactRuntimeConfig["blankFrameDetection"],
): ExecutionContext =>
  new ExecutionContext(page as never, "https://example.com", testDir, testDir, 30_000, [], {
    ...DEFAULT_ARTIFACT_CONFIG,
    blankFrameDetection: mode,
  });

describe("takeScreenshot blank-frame detection", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-blank-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("throws on a blank screenshot when mode is 'fail'", async () => {
    const ctx = ctxWith(makePage(BLANK), tmp, "fail");
    await expect(takeScreenshot(ctx.page, ctx, "blank")).rejects.toThrow(/blank screenshot/i);
  });

  it("emits a diagnostic (not a throw) when mode is 'warn'", async () => {
    const ctx = ctxWith(makePage(BLANK), tmp, "warn");
    const result = await takeScreenshot(ctx.page, ctx, "blank");
    expect(result.diagnostics.some((d) => d.kind === "blank-screenshot")).toBe(true);
  });

  it("ignores blank frames when mode is 'off'", async () => {
    const ctx = ctxWith(makePage(BLANK), tmp, "off");
    const result = await takeScreenshot(ctx.page, ctx, "blank");
    expect(result.diagnostics).toHaveLength(0);
  });
});
