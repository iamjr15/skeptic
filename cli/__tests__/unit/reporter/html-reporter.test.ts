import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HtmlReporter } from "../../../src/reporter/html-reporter.js";
import type { RunSummary, TestResult, StepResult } from "../../../src/reporter/types.js";

describe("HtmlReporter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-html-"));
  });

  afterEach(() => {
    delete process.env["SKEPTIC_HTML_EMBED_MAX_KB"];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
    return {
      total: 2,
      passed: 1,
      failed: 1,
      duration_ms: 3000,
      tests: [
        makeTest("Login Test", "tests/login.spec.ts", "passed"),
        makeTest("Search Test", "tests/search.spec.ts", "failed"),
      ],
      ...overrides,
    };
  }

  function makeTest(
    name: string,
    file: string,
    status: "passed" | "failed",
    opts: { videoPath?: string; steps?: StepResult[] } = {},
  ): TestResult {
    return {
      name,
      file,
      status,
      duration_ms: 1500,
      steps: opts.steps ?? [
        { command: "navigate", args: "/", status: "passed", duration_ms: 100 },
        { command: "click", args: "Submit", status, duration_ms: 200, error: status === "failed" ? "Element not found" : undefined },
      ],
      artifacts: opts.videoPath
        ? { video: { path: opts.videoPath, width: 1280, height: 720 } }
        : {},
    };
  }

  it("generates a self-contained HTML file", () => {
    const reporter = new HtmlReporter(tmpDir);
    reporter.onRunComplete(makeSummary());

    const htmlPath = path.join(tmpDir, "report.html");
    expect(fs.existsSync(htmlPath)).toBe(true);

    const html = fs.readFileSync(htmlPath, "utf-8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
    expect(html).toContain("<style>");
  });

  it("renders the Android device-evidence metric cards (perf/a11y/network)", () => {
    const reporter = new HtmlReporter(tmpDir);
    const test: TestResult = {
      name: "android smoke",
      file: "tests/m.spec.ts",
      status: "passed",
      duration_ms: 100,
      steps: [],
      artifacts: {},
      metrics: {
        mobilePerformance: {
          platform: "android",
          launch: { totalTimeMs: 2116, waitTimeMs: 13 },
          frames: { totalFrames: 537, jankyFrames: 14, jankyPercent: 2.61, percentiles: { p50: 16, p90: 18, p95: 18, p99: 31 }, missedVsync: 0, deadlineMissed: 14 },
          memory: { totalPssKb: 112368, totalRssKb: 199132 },
        },
        mobileAccessibility: {
          platform: "android",
          issues: [{ rule: "unlabeled-clickable", impact: "serious", className: "ImageButton", bounds: { x1: 0, y1: 0, x2: 1, y2: 1 }, detail: "no label" }],
          summary: { issues: 1, checked: 5, minTouchTargetPx: 126, note: "structural only" },
        },
        mobileNetwork: { platform: "android", degraded: true, totals: { rxBytes: 1765338, txBytes: 3151693 }, requests: [], note: "degraded" },
      },
    };
    reporter.onRunComplete({ total: 1, passed: 1, failed: 0, duration_ms: 100, tests: [test] });
    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain("Device Performance");
    expect(html).toContain("537 (2.61% janky)");
    expect(html).toContain("Device Accessibility");
    expect(html).toContain("unlabeled-clickable");
    expect(html).toContain("Device Network");
    expect(html).toMatch(/degraded/i);
  });

  it("includes test names and step counts in the report", () => {
    const reporter = new HtmlReporter(tmpDir);
    reporter.onRunComplete(makeSummary());

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain("Login Test");
    expect(html).toContain("Search Test");
    expect(html).toContain("navigate");
    expect(html).toContain("click");
  });

  it("shows summary counts", () => {
    const reporter = new HtmlReporter(tmpDir);
    reporter.onRunComplete(makeSummary({ total: 5, passed: 3, failed: 2 }));

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    // Summary cards contain the counts
    expect(html).toContain(">5<");
    expect(html).toContain(">3<");
    expect(html).toContain(">2<");
  });

  it("includes video link when TestResult has artifacts.video.path", () => {
    const reporter = new HtmlReporter(tmpDir);
    const summary = makeSummary({
      tests: [
        makeTest("Video Test", "tests/video.spec.ts", "passed", {
          videoPath: "/output/video.webm",
        }),
      ],
    });
    reporter.onRunComplete(summary);

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain("Video");
    expect(html).toContain("video.webm");
  });

  it("renders an embedded <video controls> in the artifacts panel when artifacts.video is set", () => {
    const reporter = new HtmlReporter(tmpDir);
    // Real artifacts live UNDER outputDir; the report.html is written into outputDir, so the
    // <video src> must be relative to it (here `test-0/video.webm`), not the on-disk path.
    const videoPath = path.join(tmpDir, "test-0", "video.webm");
    const summary = makeSummary({
      tests: [
        makeTest("Video Test", "tests/video.spec.ts", "passed", { videoPath }),
      ],
    });
    reporter.onRunComplete(summary);

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain('<video controls preload="metadata" src="test-0/video.webm">');
    expect(html).toContain("1280×720");
  });

  it("makes artifact hrefs relative to the report directory (not CWD)", () => {
    // Repro for the 404 bug: artifacts were linked with CWD-relative/absolute paths while
    // report.html lives inside outputDir, so the browser resolved them against the report
    // dir and 404'd. Every artifact href must be relative to outputDir.
    const videoPath = path.join(tmpDir, "test-0", "video.webm");
    const tracePath = path.join(tmpDir, "test-0", "trace.zip");
    const consolePath = path.join(tmpDir, "test-0", "console.json");
    const test: TestResult = {
      ...makeTest("Rel Test", "tests/rel.spec.ts", "passed"),
      artifacts: {
        video: { path: videoPath, width: 1280, height: 720 },
        trace: tracePath,
        consoleSnapshot: consolePath,
      },
    };
    const reporter = new HtmlReporter(tmpDir);
    reporter.onRunComplete({
      total: 1,
      passed: 1,
      failed: 0,
      duration_ms: 1500,
      tests: [test],
    });

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain('src="test-0/video.webm"');
    expect(html).toContain('href="test-0/trace.zip"');
    expect(html).toContain('href="test-0/console.json"');
    // The absolute on-disk paths must NOT appear as hrefs/srcs.
    expect(html).not.toContain(`src="${videoPath}"`);
    expect(html).not.toContain(`href="${tracePath}"`);
    // ...but the runnable show-trace command keeps the real path.
    expect(html).toContain(`npx playwright show-trace ${tracePath}`);
  });

  it("renders a trace link with copyable show-trace command when artifacts.trace is set", () => {
    const test: TestResult = {
      ...makeTest("Trace Test", "tests/trace.spec.ts", "passed"),
      artifacts: { trace: "/output/x.trace.zip" },
    };
    const reporter = new HtmlReporter(tmpDir);
    reporter.onRunComplete({
      total: 1,
      passed: 1,
      failed: 0,
      duration_ms: 1500,
      tests: [test],
    });

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain("Playwright Trace");
    expect(html).toContain("npx playwright show-trace /output/x.trace.zip");
    expect(html).toContain("copy-btn");
  });

  it("renders a perf-trace markdown link when artifacts.perfTrace is set", () => {
    const test: TestResult = {
      ...makeTest("Perf Test", "tests/perf.spec.ts", "passed"),
      artifacts: { perfTrace: "/output/perf-trace.md" },
    };
    const reporter = new HtmlReporter(tmpDir);
    reporter.onRunComplete({
      total: 1,
      passed: 1,
      failed: 0,
      duration_ms: 1500,
      tests: [test],
    });

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain("Performance Trace");
    expect(html).toContain("performance-trace.md");
  });

  it("renders a HAR (network archive) link relative to the report when artifacts.har is set", () => {
    const harPath = path.join(tmpDir, "test-0", "search-test.har");
    const test: TestResult = {
      ...makeTest("Har Test", "tests/har.spec.ts", "passed"),
      artifacts: { har: harPath },
    };
    const reporter = new HtmlReporter(tmpDir);
    reporter.onRunComplete({
      total: 1,
      passed: 1,
      failed: 0,
      duration_ms: 1500,
      tests: [test],
    });

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain("HAR (network archive)");
    expect(html).toContain('href="test-0/search-test.har"');
    // The absolute on-disk path must NOT appear as the href.
    expect(html).not.toContain(`href="${harPath}"`);
  });

  it("omits the HAR card when artifacts.har is absent", () => {
    const reporter = new HtmlReporter(tmpDir);
    reporter.onRunComplete(makeSummary());

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).not.toContain("HAR (network archive)");
  });

  it("uses contextual alt text on screenshots, not 'failure screenshot' on passing tests", () => {
    const screenshotPath = path.join(tmpDir, "homepage.png");
    fs.writeFileSync(screenshotPath, Buffer.alloc(64 * 1024, 1));

    const test = makeTest("Pass With Shot", "tests/pass.spec.ts", "passed", {
      steps: [
        {
          command: "screenshot",
          args: "homepage",
          status: "passed",
          duration_ms: 50,
          screenshot: screenshotPath,
        },
      ],
    });
    const reporter = new HtmlReporter(tmpDir);
    reporter.onRunComplete({
      total: 1,
      passed: 1,
      failed: 0,
      duration_ms: 1500,
      tests: [test],
    });

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain('alt="screenshot screenshot — homepage"');
    expect(html).not.toContain('alt="failure screenshot"');
  });

  it("renders diagnostics chips and console banner when redaction was disabled", () => {
    const test: TestResult = {
      name: "Diag Test",
      file: "tests/diag.spec.ts",
      status: "passed",
      duration_ms: 1200,
      steps: [
        {
          command: "screenshot",
          args: "blank",
          status: "passed",
          duration_ms: 30,
          warnings: ["screenshot appears blank"],
          diagnostics: [
            { kind: "blank-screenshot", message: "channel range 0", meta: { byteSize: 4255 } },
          ],
        },
      ],
      artifacts: {},
      metrics: {
        console: {
          messages: [{ type: "error", text: "boom", timestamp: 1 }],
          summary: {
            total: 1,
            errorCount: 1,
            warningCount: 0,
            infoCount: 0,
            redactionDisabled: true,
          },
        },
      },
    };
    const reporter = new HtmlReporter(tmpDir);
    reporter.onRunComplete({
      total: 1,
      passed: 1,
      failed: 0,
      duration_ms: 1500,
      tests: [test],
    });

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain("diag-chip");
    expect(html).toContain("blank-screenshot");
    expect(html).toContain("redaction disabled");
  });

  it("does not include video link when videoPath is absent", () => {
    const reporter = new HtmlReporter(tmpDir);
    const summary = makeSummary({
      tests: [makeTest("No Video", "tests/novid.spec.ts", "passed")],
    });
    reporter.onRunComplete(summary);

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    // The camera emoji used for video links should not be present
    expect(html).not.toContain("&#127909;");
  });

  it("escapes special characters in test names for XSS prevention", () => {
    const reporter = new HtmlReporter(tmpDir);
    const summary = makeSummary({
      tests: [
        makeTest('<script>alert("xss")</script>', "tests/xss.spec.ts", "passed"),
      ],
    });
    reporter.onRunComplete(summary);

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    // Raw <script> should NOT appear
    expect(html).not.toContain("<script>alert");
    // Escaped version should appear
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows PASS and FAIL badges", () => {
    const reporter = new HtmlReporter(tmpDir);
    reporter.onRunComplete(makeSummary());

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain("badge-pass");
    expect(html).toContain("badge-fail");
    expect(html).toContain("PASS");
    expect(html).toContain("FAIL");
  });

  it("includes error messages for failed steps", () => {
    const reporter = new HtmlReporter(tmpDir);
    reporter.onRunComplete(makeSummary());

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain("Element not found");
  });

  it("renders shardId suffix on test header under sharding", () => {
    const summary: RunSummary = {
      total: 2,
      passed: 2,
      failed: 0,
      duration_ms: 3000,
      tests: [
        { ...makeTest("Login Test", "tests/login.spec.ts", "passed"), shardId: 0 },
        { ...makeTest("Login Test", "tests/login.spec.ts", "passed"), shardId: 1 },
      ],
    };
    const reporter = new HtmlReporter(tmpDir);
    reporter.onRunComplete(summary);

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain("Login Test [shard 1]");
    expect(html).toContain("Login Test [shard 2]");
  });

  it("does NOT add shard suffix when shardId is undefined", () => {
    const reporter = new HtmlReporter(tmpDir);
    reporter.onRunComplete(makeSummary());

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).not.toContain("[shard ");
  });

  it("links screenshots larger than SKEPTIC_HTML_EMBED_MAX_KB instead of embedding them", () => {
    process.env["SKEPTIC_HTML_EMBED_MAX_KB"] = "1";
    const screenshotPath = path.join(tmpDir, "large.png");
    fs.writeFileSync(screenshotPath, Buffer.alloc(2048, 1));

    const reporter = new HtmlReporter(tmpDir);
    reporter.onRunComplete(makeSummary({
      total: 1,
      passed: 0,
      failed: 1,
      tests: [
        makeTest("Large Screenshot", "tests/large.spec.ts", "failed", {
          steps: [
            {
              command: "click",
              args: "Submit",
              status: "failed",
              duration_ms: 200,
              error: "Element not found",
              screenshot: screenshotPath,
            },
          ],
        }),
      ],
    }));

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain("Open image (2 KB)");
    expect(html).toContain(screenshotPath);
    expect(html).not.toContain("data:image/png;base64");
  });

  it("embeds screenshots at or below SKEPTIC_HTML_EMBED_MAX_KB", () => {
    process.env["SKEPTIC_HTML_EMBED_MAX_KB"] = "1";
    const screenshotPath = path.join(tmpDir, "small.png");
    fs.writeFileSync(screenshotPath, Buffer.alloc(1024, 1));

    const reporter = new HtmlReporter(tmpDir);
    reporter.onRunComplete(makeSummary({
      total: 1,
      passed: 0,
      failed: 1,
      tests: [
        makeTest("Small Screenshot", "tests/small.spec.ts", "failed", {
          steps: [
            {
              command: "click",
              args: "Submit",
              status: "failed",
              duration_ms: 200,
              error: "Element not found",
              screenshot: screenshotPath,
            },
          ],
        }),
      ],
    }));

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain("data:image/png;base64");
    expect(html).not.toContain("Open image");
  });
});
