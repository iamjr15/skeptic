import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Browser } from "playwright";
import { runOneTest } from "../../../src/runner/worker.js";
import type { WorkerStartConfig } from "../../../src/runner/ipc.js";
import type { FileRegistry, RegisteredTest } from "../../../src/api/test.js";
import { getDeviceProfile } from "../../../src/config/device-profiles.js";

// Mock the cookie extractor so the cookies wiring can be asserted without touching the OS keychain.
vi.mock("../../../src/cookies/extractor.js", () => ({
  extractAndInjectCookies: vi.fn(async () => 1),
}));
import { extractAndInjectCookies } from "../../../src/cookies/extractor.js";

const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-wc-"));

afterAll(() => {
  fs.rmSync(outputRoot, { recursive: true, force: true });
  delete process.env["SKEPTIC_WC_ENV"];
});

beforeEach(() => {
  vi.mocked(extractAndInjectCookies).mockClear();
});

const baseConfig = (overrides: Partial<WorkerStartConfig> = {}): WorkerStartConfig => ({
  timeout: 5_000,
  hardTimeout: 10_000,
  outputDir: outputRoot,
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
  artifact: { fullPageScreenshots: false, blankFrameDetection: "off", writeSidecars: false },
  video: false,
  trace: false,
  headed: false,
  browserEngine: "chromium",
  retries: 0,
  ...overrides,
});

interface Captured {
  options: {
    viewport?: { width: number; height: number };
    baseURL?: string;
    userAgent?: string;
    deviceScaleFactor?: number;
  };
  screenshotCalls: Array<{ path?: string; fullPage?: boolean }>;
}

const buildStubs = (): { browser: Browser; context: unknown; captured: Captured } => {
  const captured: Captured = { options: {}, screenshotCalls: [] };
  const page = {
    goto: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    addInitScript: vi.fn(async () => undefined),
    isClosed: () => false,
    context: () => context,
    screenshot: vi.fn(async (opts?: { path?: string; fullPage?: boolean }) => {
      captured.screenshotCalls.push({ ...(opts ?? {}) });
      return Buffer.alloc(0);
    }),
    close: vi.fn(async () => undefined),
    video: () => undefined,
  };
  const context = {
    newPage: vi.fn(async () => page),
    setDefaultTimeout: vi.fn(),
    addInitScript: vi.fn(async () => undefined),
    addCookies: vi.fn(async () => undefined),
    tracing: { start: vi.fn(), stop: vi.fn() },
    close: vi.fn(async () => undefined),
  };
  const browser = {
    newContext: vi.fn(async (options: Captured["options"]) => {
      captured.options = options;
      return context;
    }),
  };
  return { browser: browser as unknown as Browser, context, captured };
};

const makeTest = (
  use: RegisteredTest["use"] = {},
  fn: RegisteredTest["fn"] = async () => undefined,
  name = "t",
  file = "/virtual/wc.spec.ts",
): RegisteredTest => ({
  ordinal: 0,
  id: `${file}#0`,
  name,
  file,
  fn,
  skip: false,
  only: false,
  use,
});

const makeRegistry = (test: RegisteredTest, fileUse: FileRegistry["fileUse"] = {}): FileRegistry => ({
  file: test.file,
  tests: [test],
  beforeEach: [],
  afterEach: [],
  fileUse,
});

describe("baseURL plumbing (finding #5)", () => {
  it("passes the resolved url to newContext so relative goto works", async () => {
    const { browser, captured } = buildStubs();
    const t = makeTest();
    await runOneTest(t, makeRegistry(t), baseConfig({ baseUrl: "https://example.test" }), browser);
    expect(captured.options.baseURL).toBe("https://example.test");
  });

  it("falls back to test.use({ url }) when no config baseUrl", async () => {
    const { browser, captured } = buildStubs();
    const t = makeTest({ url: "https://per-test.test" });
    await runOneTest(t, makeRegistry(t, { url: "https://per-test.test" }), baseConfig(), browser);
    expect(captured.options.baseURL).toBe("https://per-test.test");
  });
});

describe("device UA/DPR plumbing (finding #4)", () => {
  it("applies userAgent + deviceScaleFactor + viewport from the device profile", async () => {
    const { browser, captured } = buildStubs();
    const prof = getDeviceProfile("iphone_16")!;
    const t = makeTest();
    await runOneTest(t, makeRegistry(t), baseConfig({ device: "iphone_16" }), browser);
    expect(captured.options.userAgent).toBe(prof.userAgent);
    expect(captured.options.deviceScaleFactor).toBe(prof.dpr);
    expect(captured.options.viewport).toEqual({ width: prof.width, height: prof.height });
  });

  it("per-test test.use({ device }) overrides the config device", async () => {
    const { browser, captured } = buildStubs();
    const prof = getDeviceProfile("desktop_1080p")!;
    const t = makeTest({ device: "desktop_1080p" });
    await runOneTest(t, makeRegistry(t), baseConfig({ device: "iphone_16" }), browser);
    expect(captured.options.viewport).toEqual({ width: prof.width, height: prof.height });
    // desktop_1080p has a null userAgent → no override sent.
    expect(captured.options.userAgent).toBeUndefined();
  });
});

describe("env overrides (finding #4)", () => {
  it("applies envOverrides to process.env before the test body", async () => {
    const { browser } = buildStubs();
    let seen: string | undefined;
    const t = makeTest({}, async () => {
      seen = process.env["SKEPTIC_WC_ENV"];
    });
    await runOneTest(t, makeRegistry(t), baseConfig({ envOverrides: { SKEPTIC_WC_ENV: "yes" } }), browser);
    expect(seen).toBe("yes");
    expect(process.env["SKEPTIC_WC_ENV"]).toBe("yes");
  });
});

describe("cookies plumbing (finding #4)", () => {
  it("injects cookies via the extractor when enabled and a url resolves", async () => {
    const { browser, context } = buildStubs();
    const t = makeTest();
    await runOneTest(
      t,
      makeRegistry(t),
      baseConfig({ baseUrl: "https://shop.example.com", cookies: { enabled: true, browser: "chrome" } }),
      browser,
    );
    expect(extractAndInjectCookies).toHaveBeenCalledWith(context, "shop.example.com", {
      browsers: ["chrome"],
    });
  });

  it("does not inject cookies when disabled", async () => {
    const { browser } = buildStubs();
    const t = makeTest();
    await runOneTest(t, makeRegistry(t), baseConfig({ baseUrl: "https://shop.example.com" }), browser);
    expect(extractAndInjectCookies).not.toHaveBeenCalled();
  });
});

describe("failure screenshot (finding #3)", () => {
  it("captures a full-page failure.png and attaches it to the failing step", async () => {
    const { browser, captured } = buildStubs();
    const t = makeTest({}, async () => {
      throw new Error("boom");
    });
    const result = await runOneTest(t, makeRegistry(t), baseConfig(), browser);

    expect(result.status).toBe("failed");
    const last = result.steps[result.steps.length - 1]!;
    expect(last.screenshot).toBeDefined();
    expect(last.screenshot!.endsWith("failure.png")).toBe(true);
    expect(result.artifacts.screenshots).toContain(last.screenshot);
    expect(captured.screenshotCalls.some((c) => c.fullPage === true && c.path?.endsWith("failure.png"))).toBe(true);
  });

  it("skips the screenshot when screenshotOnFailure is false", async () => {
    const { browser, captured } = buildStubs();
    const t = makeTest({}, async () => {
      throw new Error("boom");
    });
    const result = await runOneTest(t, makeRegistry(t), baseConfig({ screenshotOnFailure: false }), browser);

    expect(result.status).toBe("failed");
    const last = result.steps[result.steps.length - 1]!;
    expect(last.screenshot).toBeUndefined();
    expect(captured.screenshotCalls.length).toBe(0);
  });
});

describe("artifact dir collision (finding #2)", () => {
  it("same test name in different spec files yields distinct artifact dirs", async () => {
    const fail = async (): Promise<void> => {
      throw new Error("x");
    };
    const a = makeTest({}, fail, "login", "/virtual/dir-a/auth.spec.ts");
    const b = makeTest({}, fail, "login", "/virtual/dir-b/auth.spec.ts");
    const { browser: ba } = buildStubs();
    const { browser: bb } = buildStubs();
    const ra = await runOneTest(a, makeRegistry(a), baseConfig(), ba);
    const rb = await runOneTest(b, makeRegistry(b), baseConfig(), bb);

    const dirA = path.dirname(ra.steps[ra.steps.length - 1]!.screenshot!);
    const dirB = path.dirname(rb.steps[rb.steps.length - 1]!.screenshot!);
    expect(dirA).not.toBe(dirB);
    expect(dirA.startsWith(outputRoot)).toBe(true);
    expect(dirB.startsWith(outputRoot)).toBe(true);
  });
});

describe("skipped flag (finding #8)", () => {
  it("marks a test.skip(...) test with result.skipped while keeping status passed", async () => {
    const { browser } = buildStubs();
    const base = makeTest();
    const skipped: RegisteredTest = { ...base, skip: true };
    const result = await runOneTest(skipped, makeRegistry(skipped), baseConfig(), browser);
    expect(result.status).toBe("passed");
    expect(result.skipped).toBe(true);
    expect(result.steps[result.steps.length - 1]!.status).toBe("skipped");
  });
});

describe("timeout vs hardTimeout de-conflation (finding #6)", () => {
  it("a soft test.use({ timeout }) does NOT become the hard kill ceiling", async () => {
    const { browser } = buildStubs();
    // Soft action timeout 50ms, body sleeps 150ms, hard ceiling 3000ms → must pass.
    const t = makeTest({ timeout: 50 }, async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    const result = await runOneTest(t, makeRegistry(t), baseConfig({ hardTimeout: 3_000 }), browser);
    expect(result.status).toBe("passed");
  });

  it("an explicit test.use({ hardTimeout }) still enforces the ceiling", async () => {
    const { browser } = buildStubs();
    const t = makeTest({ hardTimeout: 40 }, async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    const result = await runOneTest(t, makeRegistry(t), baseConfig({ hardTimeout: 3_000 }), browser);
    expect(result.status).toBe("failed");
    expect(result.steps[result.steps.length - 1]!.error).toMatch(/timeout exceeded/);
  });
});
