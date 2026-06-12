import * as fs from "node:fs";
import * as path from "node:path";
import { PRODUCT_NAME } from "../constants.js";
import type { Reporter, RunSummary, TestResult, StepResult, TestIdentifier } from "./types.js";
import { formatTestDisplayName } from "./types.js";
import type {
  AccessibilitySnapshot,
  ConsoleSnapshot,
  NetworkSnapshot,
  PerformanceSnapshot,
} from "../observability/types.js";
import { logger } from "../utils/logger.js";

const DEFAULT_HTML_EMBED_MAX_KB = 1024;

interface ScreenshotAsset {
  filePath: string;
  bytes: number;
  base64?: string;
}

export class HtmlReporter implements Reporter {
  private readonly outputDir: string;
  private readonly silent: boolean;

  constructor(outputDir: string, opts: { silent?: boolean } = {}) {
    this.outputDir = outputDir;
    this.silent = opts.silent ?? false;
  }

  onTestStart(_test: TestIdentifier): void {}
  onStepComplete(_step: StepResult, _index: number, _total: number, _test: TestIdentifier): void {}
  onTestComplete(_result: TestResult, _test: TestIdentifier): void {}

  onRunComplete(summary: RunSummary): void {
    fs.mkdirSync(this.outputDir, { recursive: true });
    const outPath = path.join(this.outputDir, "report.html");

    const testsHtml = summary.tests
      .map((test, i) => buildTestSection(test, i, summary.tests, this.outputDir))
      .join("\n");
    const passRate = summary.total > 0 ? Math.round((summary.passed / summary.total) * 100) : 0;
    const duration = formatDuration(summary.duration_ms);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${PRODUCT_NAME} Test Report</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f0f0f; color: #e0e0e0; padding: 2rem; max-width: 1100px; margin: 0 auto; }
  h1 { color: #ffd700; margin-bottom: 0.5rem; font-size: 1.5rem; }
  .meta { color: #888; font-size: 0.85rem; margin-bottom: 2rem; }
  .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
  .card { background: #1a1a1a; border-radius: 8px; padding: 1.25rem; text-align: center; }
  .card .value { font-size: 2rem; font-weight: 700; }
  .card .label { font-size: 0.75rem; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 0.25rem; }
  .passed .value { color: #4caf50; }
  .failed .value { color: #f44336; }
  .total .value { color: #ffd700; }
  .duration .value { color: #90caf9; font-size: 1.5rem; }
  .test { background: #1a1a1a; border-radius: 8px; margin-bottom: 1rem; overflow: hidden; }
  .test-header { padding: 1rem 1.25rem; cursor: pointer; display: flex; align-items: center; gap: 0.75rem; user-select: none; }
  .test-header:hover { background: #222; }
  .test-header .badge { font-size: 0.7rem; font-weight: 700; padding: 0.2rem 0.5rem; border-radius: 4px; text-transform: uppercase; }
  .badge-pass { background: #1b5e20; color: #4caf50; }
  .badge-fail { background: #b71c1c; color: #ef9a9a; }
  .test-header .name { flex: 1; font-weight: 600; }
  .test-header .dur { color: #888; font-size: 0.85rem; }
  .test-header .arrow { color: #666; transition: transform 0.2s; }
  .test.open .test-header .arrow { transform: rotate(90deg); }
  .test-body { display: none; padding: 0 1.25rem 1rem; }
  .test.open .test-body { display: block; }
  .file { color: #666; font-size: 0.8rem; margin-top: 0.25rem; margin-bottom: 0.5rem; }

  .artifacts { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin: 0.75rem 0; padding: 0.75rem; background: #141414; border-radius: 6px; border: 1px solid #222; }
  .artifacts h4 { font-size: 0.85rem; color: #ffd700; margin-bottom: 0.5rem; }
  .artifact-card { background: #1f1f1f; padding: 0.75rem; border-radius: 4px; }
  .artifact-card video, .artifact-card img { width: 100%; max-height: 320px; object-fit: contain; border-radius: 4px; border: 1px solid #333; background: #000; display: block; }
  .artifact-card a { color: #90caf9; text-decoration: none; font-size: 0.85rem; word-break: break-all; }
  .artifact-card a:hover { text-decoration: underline; }
  .artifact-card .hint { color: #666; font-size: 0.75rem; margin-top: 0.4rem; }
  .artifact-card code { font-family: ui-monospace, monospace; background: #0a0a0a; padding: 0.1rem 0.3rem; border-radius: 2px; color: #b3e5fc; }
  .copy-btn { background: #2a2a2a; color: #90caf9; border: 1px solid #333; border-radius: 4px; padding: 0.2rem 0.5rem; cursor: pointer; font-size: 0.7rem; margin-left: 0.4rem; }
  .copy-btn:hover { background: #333; }

  .step { display: flex; align-items: flex-start; gap: 0.5rem; padding: 0.4rem 0; font-size: 0.9rem; border-bottom: 1px solid #222; }
  .step:last-child { border-bottom: none; }
  .step .icon { width: 1.2rem; flex-shrink: 0; text-align: center; }
  .step .icon.pass { color: #4caf50; }
  .step .icon.fail { color: #f44336; }
  .step .icon.err { color: #ff9800; }
  .step .cmd { color: #90caf9; font-family: monospace; min-width: 8rem; }
  .step .desc { flex: 1; color: #aaa; }
  .step .sdur { color: #666; font-size: 0.8rem; min-width: 4rem; text-align: right; }
  .step-error { color: #ef9a9a; font-size: 0.8rem; padding: 0.25rem 0 0 1.7rem; }
  .step-warning { color: #ffd54f; font-size: 0.8rem; padding: 0.25rem 0 0 1.7rem; }
  .step-diagnostic { color: #ffb74d; font-size: 0.8rem; padding: 0.25rem 0 0 1.7rem; }
  .diag-chip { display: inline-block; background: #2a1d10; color: #ffb74d; border: 1px solid #5a3d20; border-radius: 999px; padding: 0.05rem 0.5rem; font-size: 0.7rem; margin-right: 0.4rem; }

  .screenshot { margin: 0.5rem 0 0 1.7rem; }
  .screenshot img { max-width: 100%; border-radius: 4px; border: 1px solid #333; }
  .visual-diff { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; margin: 0.5rem 0 0 1.7rem; }
  .visual-diff figure { margin: 0; }
  .visual-diff figcaption { font-size: 0.8rem; color: #888; margin-bottom: 0.25rem; }
  .visual-diff img { max-width: 100%; border: 1px solid #333; border-radius: 4px; }

  .test-metrics { margin-top: 0.75rem; padding: 0.75rem 1rem; background: #141414; border-radius: 6px; }
  .test-metrics summary { cursor: pointer; color: #90caf9; font-weight: 600; }
  .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 0.75rem; margin-top: 0.5rem; }
  .metric-card { background: #1f1f1f; padding: 0.75rem; border-radius: 4px; }
  .metric-card h4 { font-size: 0.85rem; color: #ffd700; margin-bottom: 0.5rem; }
  .metric-card table { width: 100%; border-collapse: collapse; }
  .metric-card td { padding: 0.1rem 0.3rem; font-size: 0.8rem; }
  .metric-card td.label { color: #888; }
  .metric-card .issue-list { margin-top: 0.3rem; font-size: 0.8rem; color: #ef9a9a; }
  .metric-card .issue-list li { margin-left: 1rem; }
  .metric-card .console-banner { background: #2a1d10; color: #ffb74d; border-radius: 4px; padding: 0.25rem 0.5rem; margin-top: 0.4rem; font-size: 0.75rem; }
</style>
</head>
<body>
<h1>${PRODUCT_NAME} Test Report</h1>
<div class="meta">Generated ${new Date().toISOString()} | ${passRate}% pass rate</div>

<div class="summary">
  <div class="card total"><div class="value">${summary.total}</div><div class="label">Total</div></div>
  <div class="card passed"><div class="value">${summary.passed}</div><div class="label">Passed</div></div>
  <div class="card failed"><div class="value">${summary.failed}</div><div class="label">Failed</div></div>
  <div class="card duration"><div class="value">${duration}</div><div class="label">Duration</div></div>
</div>

${testsHtml}

<script>
document.querySelectorAll('.test-header').forEach(h => {
  h.addEventListener('click', () => h.parentElement.classList.toggle('open'));
});
// Auto-open failed tests
document.querySelectorAll('.test.failed').forEach(f => f.classList.add('open'));
// Copy-to-clipboard for trace command
document.querySelectorAll('.copy-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const code = btn.previousElementSibling;
    if (!code) return;
    navigator.clipboard.writeText(code.textContent || '').then(() => {
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    });
  });
});
</script>
</body>
</html>`;

    fs.writeFileSync(outPath, html, "utf-8");
    if (!this.silent) logger.info(`HTML report written to ${outPath}`);
  }
}

function buildTestSection(
  test: TestResult,
  _index: number,
  siblings: TestResult[],
  outputDir: string,
): string {
  const isPassed = test.status === "passed";
  const badge = isPassed
    ? '<span class="badge badge-pass">PASS</span>'
    : '<span class="badge badge-fail">FAIL</span>';

  const stepsHtml = test.steps.map((step) => buildStepRow(step, outputDir)).join("\n");

  const videoPath = test.artifacts?.video?.path;
  const videoLink = videoPath
    ? `<span style="color:#90caf9;font-size:0.8rem;margin-left:0.5rem;" title="${esc(videoPath)}">&#127909; Video</span>`
    : "";

  const artifactsPanel = buildArtifactsPanel(test, outputDir);
  const metricsHtml = buildMetricsSection(test.metrics);

  return `<div class="test ${isPassed ? "passed" : "failed"}">
  <div class="test-header">
    ${badge}
    <span class="name">${esc(formatTestDisplayName(test, siblings))}${videoLink}</span>
    <span class="dur">${formatDuration(test.duration_ms)}</span>
    <span class="arrow">&#9654;</span>
  </div>
  <div class="test-body">
    <div class="file">${esc(test.file)}</div>
${artifactsPanel}
${stepsHtml}${metricsHtml}
  </div>
</div>`;
}

function buildStepRow(step: StepResult, outputDir: string): string {
  const icon =
    step.status === "passed"
      ? '<span class="icon pass">&#10003;</span>'
      : step.status === "failed"
        ? '<span class="icon fail">&#10007;</span>'
        : step.status === "skipped"
          ? '<span class="icon">&#8226;</span>'
          : '<span class="icon err">&#9888;</span>';

  let extra = "";
  if (step.error) {
    extra += `\n      <div class="step-error">${esc(step.error)}</div>`;
  }
  if (step.warnings && step.warnings.length > 0) {
    for (const w of step.warnings) {
      extra += `\n      <div class="step-warning">⚠ ${esc(w)}</div>`;
    }
  }
  if (step.diagnostics && step.diagnostics.length > 0) {
    const chips = step.diagnostics
      .map((d) => `<span class="diag-chip">${esc(d.kind)}</span>`)
      .join("");
    const messages = step.diagnostics.map((d) => esc(d.message)).join(" · ");
    extra += `\n      <div class="step-diagnostic">${chips}${messages}</div>`;
  }
  // Visual regression failure: side-by-side baseline / current / diff
  if (step.baselinePath && step.currentPath && step.diffPath) {
    const baseline = readScreenshotAsset(step.baselinePath);
    const current = readScreenshotAsset(step.currentPath);
    const diff = readScreenshotAsset(step.diffPath);
    if (baseline && current && diff) {
      extra += `\n      <div class="visual-diff">`;
      extra += renderScreenshotFigure("Baseline", baseline, "baseline screenshot", outputDir);
      extra += renderScreenshotFigure("Current", current, "current screenshot", outputDir);
      extra += renderScreenshotFigure("Diff", diff, "diff screenshot", outputDir);
      extra += `</div>`;
    }
  } else if (step.screenshot) {
    const screenshot = readScreenshotAsset(step.screenshot);
    if (screenshot) {
      const isFailure = step.status === "failed" || step.status === "error";
      const stepLabel = formatArgs(step.args);
      const altText = isFailure
        ? `failure evidence — ${step.command}${stepLabel ? ` ${stepLabel}` : ""}`
        : `${step.command} screenshot${stepLabel ? ` — ${stepLabel}` : ""}`;
      extra += `\n      <div class="screenshot">${renderScreenshotMedia(screenshot, altText, outputDir)}</div>`;
    }
  }

  return `    <div class="step">
      ${icon}
      <span class="cmd">${esc(step.command)}</span>
      <span class="desc">${esc(formatArgs(step.args))}</span>
      <span class="sdur">${step.duration_ms}ms</span>
    </div>${extra}`;
}

function buildArtifactsPanel(test: TestResult, outputDir: string): string {
  const a = test.artifacts ?? {};
  const cards: string[] = [];

  // Screenshot card — pick the most relevant: failure auto-cap if present, else the last
  // explicit `screenshot:` step result.
  const failureStep = test.steps.find(
    (s) => (s.status === "failed" || s.status === "error") && s.screenshot,
  );
  const lastShot = [...test.steps].reverse().find((s) => s.screenshot && s.command === "screenshot");
  const heroPath = failureStep?.screenshot ?? lastShot?.screenshot ?? a.screenshots?.[a.screenshots.length - 1];
  if (heroPath) {
    const asset = readScreenshotAsset(heroPath);
    if (asset) {
      const altLabel = failureStep
        ? "failure evidence"
        : "last screenshot";
      cards.push(
        `<div class="artifact-card"><h4>Screenshot</h4>${renderScreenshotMedia(asset, altLabel, outputDir)}<div class="hint">${esc(reportHref(outputDir, heroPath))}</div></div>`,
      );
    }
  }

  // Video card — embed playable. `src` is relative to report.html (which lives in
  // outputDir) so the link resolves when the report is opened from disk.
  if (a.video) {
    const href = reportHref(outputDir, a.video.path);
    cards.push(
      `<div class="artifact-card"><h4>Video (${a.video.width}×${a.video.height})</h4><video controls preload="metadata" src="${esc(href)}"></video><div class="hint">${esc(href)}</div></div>`,
    );
  }

  // Trace card — link (relative to the report) plus copy-to-clipboard for the show-trace
  // command, which keeps the original path so it's runnable from the user's shell.
  if (a.trace) {
    const cmd = `npx playwright show-trace ${a.trace}`;
    cards.push(
      `<div class="artifact-card"><h4>Playwright Trace</h4><a href="${esc(reportHref(outputDir, a.trace))}">Open trace zip</a><div class="hint">View interactively: <code>${esc(cmd)}</code><button class="copy-btn">Copy</button></div></div>`,
    );
  }

  // HAR card — HTTP archive of all network traffic, captured under --har. Linked relative to
  // the report like the other artifacts; openable in Playwright/DevTools HAR viewers.
  if (a.har) {
    cards.push(
      `<div class="artifact-card"><h4>HAR (network archive)</h4><a href="${esc(reportHref(outputDir, a.har))}">Open HAR archive</a></div>`,
    );
  }

  // Perf-trace markdown sidecar
  if (a.perfTrace) {
    cards.push(
      `<div class="artifact-card"><h4>Performance Trace</h4><a href="${esc(reportHref(outputDir, a.perfTrace))}">Open performance-trace.md</a></div>`,
    );
  }

  // Accessibility audit markdown sidecar — full violation list, no rule-level truncation.
  if (a.accessibilityAudit) {
    cards.push(
      `<div class="artifact-card"><h4>Accessibility Audit</h4><a href="${esc(reportHref(outputDir, a.accessibilityAudit))}">Open audit.md</a></div>`,
    );
  }

  // Console / network sidecars (Bundle 4 will write them under --observability-write-sidecars)
  const sidecarLinks: string[] = [];
  if (a.consoleSnapshot) sidecarLinks.push(`<a href="${esc(reportHref(outputDir, a.consoleSnapshot))}">console.json</a>`);
  if (a.networkSnapshot) sidecarLinks.push(`<a href="${esc(reportHref(outputDir, a.networkSnapshot))}">network.json</a>`);
  if (a.accessibilityJson) sidecarLinks.push(`<a href="${esc(reportHref(outputDir, a.accessibilityJson))}">accessibility.json</a>`);
  if (a.testJson) sidecarLinks.push(`<a href="${esc(reportHref(outputDir, a.testJson))}">test.json</a>`);
  if (sidecarLinks.length > 0) {
    cards.push(
      `<div class="artifact-card"><h4>Sidecars</h4>${sidecarLinks.join(" · ")}</div>`,
    );
  }

  if (cards.length === 0) return "";
  return `\n    <div class="artifacts">${cards.join("")}</div>`;
}

function buildMetricsSection(metrics: Record<string, unknown> | undefined): string {
  if (!metrics) return "";
  const cards: string[] = [];

  const perf = metrics["performance"] as PerformanceSnapshot | undefined;
  if (perf) {
    const rows: string[] = [];
    const add = (label: string, value: string | null) => {
      if (value === null) return;
      rows.push(`<tr><td class="label">${label}</td><td>${esc(value)}</td></tr>`);
    };
    add("FCP", perf.fcp === null ? null : formatMsValue(perf.fcp));
    add("LCP", perf.lcp === null ? null : formatMsValue(perf.lcp));
    add("CLS", perf.cls === null ? null : perf.cls.toFixed(3));
    add("INP", perf.inp === null ? null : formatMsValue(perf.inp));
    add("TTFB", perf.ttfb === null ? null : formatMsValue(perf.ttfb));
    if (perf.longAnimationFrames.length > 0) {
      rows.push(
        `<tr><td class="label">LoAF</td><td>${perf.longAnimationFrames.length} frames</td></tr>`,
      );
    }
    if (rows.length > 0) {
      cards.push(
        `<div class="metric-card"><h4>Core Web Vitals</h4><table>${rows.join("")}</table></div>`,
      );
    }
  }

  const net = metrics["network"] as NetworkSnapshot | undefined;
  if (net) {
    const issues: string[] = [];
    if (net.issues.failedRequests.length > 0) {
      issues.push(
        `<li>${net.issues.failedRequests.length} HTTP failure(s) (4xx/5xx)</li>`,
      );
    }
    if (net.issues.networkFailures.length > 0) {
      issues.push(
        `<li>${net.issues.networkFailures.length} network failure(s) (DNS/TCP/aborted)</li>`,
      );
    }
    if (net.issues.duplicates.length > 0) {
      issues.push(`<li>${net.issues.duplicates.length} duplicate group(s)</li>`);
    }
    if (net.issues.mixedContent.length > 0) {
      issues.push(`<li>${net.issues.mixedContent.length} mixed-content resource(s)</li>`);
    }
    if (net.issues.corsErrors.length > 0) {
      issues.push(`<li>${net.issues.corsErrors.length} CORS error(s)</li>`);
    }
    const issueHtml =
      issues.length > 0 ? `<ul class="issue-list">${issues.join("")}</ul>` : "";
    cards.push(
      `<div class="metric-card"><h4>Network</h4><p>${net.requests.length} request(s)</p>${issueHtml}</div>`,
    );
  }

  const con = metrics["console"] as ConsoleSnapshot | undefined;
  if (con) {
    const banner = con.summary.redactionDisabled
      ? `<div class="console-banner">⚠ redaction disabled — text may contain credentials/PII</div>`
      : "";
    const errs = con.summary.errorCount;
    const warns = con.summary.warningCount;
    const top = con.messages
      .filter((m) => m.type === "error" || m.type === "warning")
      .slice(0, 5)
      .map((m) => `<li><strong>${esc(m.type)}</strong>: ${esc(m.text)}</li>`)
      .join("");
    cards.push(
      `<div class="metric-card"><h4>Console</h4><p>${con.summary.total} message(s) — ${errs} error(s), ${warns} warning(s)</p>${top ? `<ul class="issue-list">${top}</ul>` : ""}${banner}</div>`,
    );
  }

  const a11y = metrics["accessibility"] as AccessibilitySnapshot | undefined;
  if (a11y) {
    const engines = a11y.summary.dualEngine ? "axe-core + IBM Equal Access" : "axe-core";
    const top = a11y.violations
      .slice(0, 5)
      .map(
        (v) =>
          `<li>[${esc(v.impact)}] ${esc(v.ruleId)}${v.engine === "equal-access" ? " <em>(equal-access)</em>" : ""}</li>`,
      )
      .join("");
    const more =
      a11y.violations.length > 5 ? ` (and ${a11y.violations.length - 5} more)` : "";
    const violationList =
      a11y.summary.violations > 0
        ? `<ul class="issue-list">${top}</ul>${more ? `<p>${more}</p>` : ""}`
        : "";
    cards.push(
      `<div class="metric-card"><h4>Accessibility</h4><p>${esc(a11y.standard)} — ${a11y.summary.violations} violation(s), ${a11y.summary.passes} passes (${engines})</p>${violationList}</div>`,
    );
  }

  if (cards.length === 0) return "";
  return `\n    <details class="test-metrics" open><summary>Metrics</summary><div class="metrics-grid">${cards.join("")}</div></details>`;
}

function formatMsValue(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
}

function readScreenshotAsset(filePath: string): ScreenshotAsset | null {
  try {
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      const asset: ScreenshotAsset = { filePath, bytes: stat.size };
      if (stat.size <= htmlEmbedMaxBytes()) {
        asset.base64 = fs.readFileSync(filePath).toString("base64");
      }
      return asset;
    }
  } catch {
    // best-effort
  }
  return null;
}

function renderScreenshotFigure(
  label: string,
  asset: ScreenshotAsset,
  alt: string,
  outputDir: string,
): string {
  return `<figure><figcaption>${esc(label)}</figcaption>${renderScreenshotMedia(asset, alt, outputDir)}</figure>`;
}

function renderScreenshotMedia(asset: ScreenshotAsset, alt: string, outputDir: string): string {
  if (asset.base64) {
    return `<img src="data:image/png;base64,${asset.base64}" alt="${esc(alt)}">`;
  }
  // Large assets are linked, not embedded. The href is relative to report.html (in
  // outputDir); the title keeps the full on-disk path as a tooltip.
  return `<a href="${esc(reportHref(outputDir, asset.filePath))}" title="${esc(asset.filePath)}">Open image (${formatBytes(asset.bytes)})</a>`;
}

/**
 * Resolve an artifact path to an href relative to the report file's directory (outputDir),
 * where report.html is written. Artifact paths in results may be CWD-relative or absolute;
 * `path.relative` normalizes both against the report location so links resolve when the
 * report is opened from disk. Separators are normalized to `/` for URL use.
 */
function reportHref(outputDir: string, target: string): string {
  const rel = path.relative(outputDir, target);
  return (rel.length > 0 ? rel : target).split(path.sep).join("/");
}

function htmlEmbedMaxBytes(): number {
  const raw = process.env["SKEPTIC_HTML_EMBED_MAX_KB"];
  const kb = raw ? Number.parseInt(raw, 10) : DEFAULT_HTML_EMBED_MAX_KB;
  return (Number.isFinite(kb) && kb > 0 ? kb : DEFAULT_HTML_EMBED_MAX_KB) * 1024;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function formatArgs(args: unknown): string {
  if (typeof args === "string") return args;
  if (typeof args === "object" && args !== null) {
    const a = args as Record<string, unknown>;
    const parts: string[] = [];
    if (a["target"]) parts.push(String(a["target"]));
    if (a["value"] !== undefined) parts.push(String(a["value"]));
    if (a["description"]) return String(a["description"]);
    if (a["name"]) return String(a["name"]);
    return parts.join(" = ");
  }
  return String(args ?? "");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
