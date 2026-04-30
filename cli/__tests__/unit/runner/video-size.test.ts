import { describe, expect, it, vi } from "vitest";
import type { Browser } from "playwright";
import { parseVideoSize } from "../../../src/commands/run.js";
import { runOneTest } from "../../../src/runner/worker.js";
import type { WorkerStartConfig } from "../../../src/runner/ipc.js";
import type { FileRegistry, RegisteredTest } from "../../../src/api/test.js";

// B8 — assert the video-size precedence chain (CLI > test.use > viewport) and
// the parser's input validation. The runner-level assertion stubs Playwright
// just enough to capture the `recordVideo.size` field passed to `newContext`.

describe("parseVideoSize", () => {
  it("accepts WxH digits", () => {
    expect(parseVideoSize("1920x1080")).toEqual({ width: 1920, height: 1080 });
    expect(parseVideoSize("640x480")).toEqual({ width: 640, height: 480 });
    expect(parseVideoSize("1X1")).toEqual({ width: 1, height: 1 });
  });

  it("rejects malformed strings", () => {
    expect(() => parseVideoSize("1920")).toThrow(/expected/);
    expect(() => parseVideoSize("1920*1080")).toThrow(/expected/);
    expect(() => parseVideoSize("foo")).toThrow(/expected/);
    expect(() => parseVideoSize("")).toThrow(/expected/);
    expect(() => parseVideoSize("1920x")).toThrow(/expected/);
  });

  it("rejects zero, negatives (via regex), and out-of-bounds", () => {
    expect(() => parseVideoSize("0x0")).toThrow(/within/);
    expect(() => parseVideoSize("0x720")).toThrow(/within/);
    expect(() => parseVideoSize("1280x0")).toThrow(/within/);
    // Negative numbers fail the regex (no leading-sign branch) — message says "expected".
    expect(() => parseVideoSize("-1x100")).toThrow(/expected/);
    expect(() => parseVideoSize("100x-1")).toThrow(/expected/);
    expect(() => parseVideoSize("3841x1080")).toThrow(/within/);
    expect(() => parseVideoSize("1920x9999")).toThrow(/within/);
  });
});

const baseConfig = (overrides: Partial<WorkerStartConfig> = {}): WorkerStartConfig => ({
  timeout: 5_000,
  hardTimeout: 10_000,
  outputDir: "",
  envOverrides: {},
  observability: {
    forceAll: false,
    consoleRedaction: true,
    networkCaptureLimit: 50,
    duplicateWindowMs: 250,
    consoleCaptureLimit: 200,
    accessibilityDualEngine: false,
    accessibilityHtmlSnippetLimit: 200,
    accessibilityStandard: "WCAG21AA",
    autoAccessibilityAudit: false,
    accessibilityMaxRulesPerImpact: 100,
  },
  artifact: {
    fullPageScreenshots: false,
    blankFrameDetection: "off",
    writeSidecars: false,
  },
  video: true,
  trace: false,
  headed: false,
  browserEngine: "chromium",
  retries: 0,
  ...overrides,
});

interface CapturedNewContext {
  options: { recordVideo?: { dir: string; size?: { width: number; height: number } } };
}

const buildStubs = (): {
  browser: Browser;
  captured: CapturedNewContext;
} => {
  const captured: CapturedNewContext = { options: {} };
  const page = {
    goto: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    addInitScript: vi.fn(async () => undefined),
    isClosed: () => false,
    context: () => context,
  };
  const context = {
    newPage: vi.fn(async () => page),
    setDefaultTimeout: vi.fn(),
    addInitScript: vi.fn(async () => undefined),
    tracing: { start: vi.fn(), stop: vi.fn() },
    close: vi.fn(async () => undefined),
  };
  const browser = {
    newContext: vi.fn(async (options: CapturedNewContext["options"]) => {
      captured.options = options;
      return context;
    }),
  };
  return { browser: browser as unknown as Browser, captured };
};

const buildRegistry = (
  test: RegisteredTest,
  fileUse: FileRegistry["fileUse"] = {},
): FileRegistry => ({
  file: "/tmp/video-size.spec.ts",
  tests: [test],
  beforeEach: [],
  afterEach: [],
  fileUse,
});

const buildTest = (use: RegisteredTest["use"] = {}): RegisteredTest => ({
  ordinal: 0,
  id: "/tmp/video-size.spec.ts#0",
  name: "vid",
  file: "/tmp/video-size.spec.ts",
  fn: async () => undefined,
  skip: false,
  only: false,
  use,
});

describe("recordVideo.size precedence", () => {
  it("CLI flag (config.videoSize) wins over test.use and viewport", async () => {
    const { browser, captured } = buildStubs();
    const config = baseConfig({
      viewport: { width: 1280, height: 720 },
      videoSize: { width: 1920, height: 1080 },
    });
    await runOneTest(
      buildTest({ videoSize: { width: 800, height: 600 } }),
      buildRegistry(buildTest()),
      config,
      browser,
    );
    expect(captured.options.recordVideo?.size).toEqual({ width: 1920, height: 1080 });
  });

  it("test.use({ videoSize }) wins over viewport when CLI flag absent", async () => {
    const { browser, captured } = buildStubs();
    const config = baseConfig({ viewport: { width: 1280, height: 720 } });
    await runOneTest(
      buildTest({ videoSize: { width: 800, height: 600 } }),
      buildRegistry(buildTest({ videoSize: { width: 800, height: 600 } })),
      config,
      browser,
    );
    expect(captured.options.recordVideo?.size).toEqual({ width: 800, height: 600 });
  });

  it("falls back to viewport when neither CLI nor test.use sets videoSize", async () => {
    const { browser, captured } = buildStubs();
    const config = baseConfig({ viewport: { width: 1280, height: 720 } });
    await runOneTest(buildTest(), buildRegistry(buildTest()), config, browser);
    expect(captured.options.recordVideo?.size).toEqual({ width: 1280, height: 720 });
  });
});
