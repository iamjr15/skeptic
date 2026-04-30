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
        makeFlow("Login Flow", "tests/login.yaml", "passed"),
        makeFlow("Search Flow", "tests/search.yaml", "failed"),
      ],
      ...overrides,
    };
  }

  function makeFlow(
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

  it("includes flow names and step counts in the report", () => {
    const reporter = new HtmlReporter(tmpDir);
    reporter.onRunComplete(makeSummary());

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain("Login Flow");
    expect(html).toContain("Search Flow");
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
        makeFlow("Video Flow", "tests/video.yaml", "passed", {
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
    const summary = makeSummary({
      tests: [
        makeFlow("Video Flow", "tests/video.yaml", "passed", {
          videoPath: "/output/video.webm",
        }),
      ],
    });
    reporter.onRunComplete(summary);

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain('<video controls preload="metadata" src="/output/video.webm">');
    expect(html).toContain("1280×720");
  });

  it("renders a trace link with copyable show-trace command when artifacts.trace is set", () => {
    const flow: TestResult = {
      ...makeFlow("Trace Flow", "tests/trace.yaml", "passed"),
      artifacts: { trace: "/output/x.trace.zip" },
    };
    const reporter = new HtmlReporter(tmpDir);
    reporter.onRunComplete({
      total: 1,
      passed: 1,
      failed: 0,
      duration_ms: 1500,
      tests: [flow],
    });

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain("Playwright Trace");
    expect(html).toContain("npx playwright show-trace /output/x.trace.zip");
    expect(html).toContain("copy-btn");
  });

  it("renders a perf-trace markdown link when artifacts.perfTrace is set", () => {
    const flow: TestResult = {
      ...makeFlow("Perf Flow", "tests/perf.yaml", "passed"),
      artifacts: { perfTrace: "/output/perf-trace.md" },
    };
    const reporter = new HtmlReporter(tmpDir);
    reporter.onRunComplete({
      total: 1,
      passed: 1,
      failed: 0,
      duration_ms: 1500,
      tests: [flow],
    });

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain("Performance Trace");
    expect(html).toContain("performance-trace.md");
  });

  it("uses contextual alt text on screenshots, not 'failure screenshot' on passing flows", () => {
    const screenshotPath = path.join(tmpDir, "homepage.png");
    fs.writeFileSync(screenshotPath, Buffer.alloc(64 * 1024, 1));

    const flow = makeFlow("Pass With Shot", "tests/pass.yaml", "passed", {
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
      tests: [flow],
    });

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain('alt="screenshot screenshot — homepage"');
    expect(html).not.toContain('alt="failure screenshot"');
  });

  it("renders diagnostics chips and console banner when redaction was disabled", () => {
    const flow: TestResult = {
      name: "Diag Flow",
      file: "tests/diag.yaml",
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
      tests: [flow],
    });

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain("diag-chip");
    expect(html).toContain("blank-screenshot");
    expect(html).toContain("redaction disabled");
  });

  it("does not include video link when videoPath is absent", () => {
    const reporter = new HtmlReporter(tmpDir);
    const summary = makeSummary({
      tests: [makeFlow("No Video", "tests/novid.yaml", "passed")],
    });
    reporter.onRunComplete(summary);

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    // The camera emoji used for video links should not be present
    expect(html).not.toContain("&#127909;");
  });

  it("escapes special characters in flow names for XSS prevention", () => {
    const reporter = new HtmlReporter(tmpDir);
    const summary = makeSummary({
      tests: [
        makeFlow('<script>alert("xss")</script>', "tests/xss.yaml", "passed"),
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

  it("renders shardId suffix on flow header under sharding", () => {
    const summary: RunSummary = {
      total: 2,
      passed: 2,
      failed: 0,
      duration_ms: 3000,
      tests: [
        { ...makeFlow("Login Flow", "tests/login.yaml", "passed"), shardId: 0 },
        { ...makeFlow("Login Flow", "tests/login.yaml", "passed"), shardId: 1 },
      ],
    };
    const reporter = new HtmlReporter(tmpDir);
    reporter.onRunComplete(summary);

    const html = fs.readFileSync(path.join(tmpDir, "report.html"), "utf-8");
    expect(html).toContain("Login Flow [shard 1]");
    expect(html).toContain("Login Flow [shard 2]");
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
        makeFlow("Large Screenshot", "tests/large.yaml", "failed", {
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
        makeFlow("Small Screenshot", "tests/small.yaml", "failed", {
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
