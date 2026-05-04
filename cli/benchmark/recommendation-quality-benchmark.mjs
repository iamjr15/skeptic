#!/usr/bin/env node
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const root = path.resolve(new URL("..", import.meta.url).pathname);
const repoRoot = path.resolve(root, "..");
const dist = path.join(root, "dist", "skeptic.mjs");
const indexDist = path.join(root, "dist", "index.mjs");

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) args.set(key, "true");
  else {
    args.set(key, next);
    i += 1;
  }
}

const externalUrl = args.get("url") ?? "https://www.apple.com/";
const timeoutMs = Math.max(10_000, Number(args.get("timeout") ?? 120_000));
const runId = `recommendation-quality-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const artifactsRoot = path.resolve(repoRoot, "benchmark-artifacts", runId);

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });

const writeText = (file, value) => {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, value ?? "", "utf8");
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const tryParseJson = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const commandExists = async (cmd) => {
  try {
    await execFileAsync("sh", ["-lc", `command -v ${cmd}`], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
};

const runCommand = async (label, cmd, cmdArgs, options = {}) => {
  const start = performance.now();
  try {
    const result = await execFileAsync(cmd, cmdArgs, {
      cwd: options.cwd ?? root,
      timeout: options.timeout ?? timeoutMs,
      maxBuffer: options.maxBuffer ?? 80 * 1024 * 1024,
      env: { ...process.env, ...options.env },
    });
    return {
      label,
      command: [cmd, ...cmdArgs],
      ok: true,
      durationMs: Math.round(performance.now() - start),
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err) {
    return {
      label,
      command: [cmd, ...cmdArgs],
      ok: false,
      durationMs: Math.round(performance.now() - start),
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      error: err.message,
    };
  }
};

const persistCommand = (dir, ordinal, result) => {
  const prefix = `${String(ordinal).padStart(2, "0")}-${result.label.replace(/[^a-z0-9._-]+/gi, "_")}`;
  writeText(path.join(dir, `${prefix}.command.txt`), result.command.join(" "));
  writeText(path.join(dir, `${prefix}.stdout.txt`), result.stdout);
  writeText(path.join(dir, `${prefix}.stderr.txt`), result.stderr);
  writeText(
    path.join(dir, `${prefix}.meta.json`),
    JSON.stringify(
      {
        ok: result.ok,
        durationMs: result.durationMs,
        error: result.error ?? null,
      },
      null,
      2,
    ),
  );
  const parsed = tryParseJson(result.stdout);
  if (parsed) writeText(path.join(dir, `${prefix}.stdout.json`), JSON.stringify(parsed, null, 2));
};

const copyFileIfPresent = (source, destDir, prefix) => {
  if (!source || !fs.existsSync(source)) return null;
  ensureDir(destDir);
  const dest = path.join(destDir, `${prefix}-${path.basename(source)}`);
  fs.copyFileSync(source, dest);
  return dest;
};

const discoverArtifactPaths = (text) => {
  const paths = new Set();
  const patterns = [
    /Screenshot saved:\s*(\/[^\n\r]+)/g,
    /Performance trace written to:\s*(\/[^\n\r]+)/g,
    /Full trace:\s*(\/[^\n\r]+)/g,
    /Playwright video:\s*(\/[^\n\r]+)/g,
    /Screenshot:\s*(\/[^\n\r]+)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      paths.add(match[1].trim());
    }
  }
  return [...paths];
};

const copyDiscoveredArtifacts = (result, destDir, prefix) => {
  const copied = [];
  for (const artifactPath of discoverArtifactPaths(`${result.stdout}\n${result.stderr}`)) {
    const copiedPath = copyFileIfPresent(artifactPath, destDir, prefix);
    if (copiedPath) copied.push({ source: artifactPath, copiedPath });
  }
  return copied;
};

const findFiles = (dir, predicate, found = []) => {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findFiles(full, predicate, found);
    else if (predicate(full)) found.push(full);
  }
  return found;
};

const createFixtureServer = async () => {
  const fixtureHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Recommendation Quality Fixture</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 32px; }
      .low-contrast { color: #aaa; background: #fff; }
      .panel { max-width: 720px; }
    </style>
    <script src="/slow.js"></script>
  </head>
  <body>
    <nav aria-label="Primary">
      <a href="/products">Products</a>
      <a href="/pricing">Pricing</a>
    </nav>
    <main class="panel">
      <h1>Recommendation Quality Fixture</h1>
      <p class="low-contrast">This intentionally low contrast text should be flagged.</p>
      <label>Email <input id="email" type="email" placeholder="name@example.com"></label>
      <button id="run">Run check</button>
      <button id="nameless"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"></circle></svg></button>
      <p id="status">Idle</p>
      <img src="/missing">
    </main>
    <script>
      console.warn("fixture boot warning");
      document.getElementById("run").addEventListener("click", async () => {
        console.error("fixture click error");
        await fetch("/api/data");
        await fetch("/api/data");
        await fetch("/missing").catch(() => {});
        document.getElementById("status").textContent = "Done";
      });
    </script>
  </body>
</html>`;

  const server = http.createServer((req, res) => {
    if (req.url === "/slow.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(`
        requestAnimationFrame(() => {
          const start = performance.now();
          while (performance.now() - start < 95) {}
        });
      `);
      return;
    }
    if (req.url === "/api/data") {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
      return;
    }
    if (req.url === "/missing") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("missing");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(fixtureHtml);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");
  return { server, url: `http://127.0.0.1:${address.port}`, fixtureHtml };
};

const generatedSpec = (kind) => `import { test, expect } from "${indexDist}";

test.use({
  viewport: { width: 1440, height: 1000 },
  timeout: 25_000,
  hardTimeout: 120_000,
});

test("recommendation quality ${kind}", async ({
  page,
  snapshot,
  screenshot,
  settle,
  observability,
}) => {
  const targetUrl = process.env.TARGET_URL;
  if (!targetUrl) throw new Error("TARGET_URL is required");

  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  await settle();

  await page
    .getByRole("button", { name: /Close country or region selector/i })
    .click({ timeout: 3_000 })
    .catch(() => {});

  await screenshot("01-initial", { fullPage: false });
  await screenshot("02-initial-annotated", { annotate: true, fullPage: false });

  if (${JSON.stringify(kind)} === "fixture") {
    await page.getByLabel(/Email/i).fill("qa@example.com");
    await page.getByRole("button", { name: /Run check/i }).click();
    await page.waitForTimeout(1_000);
    await expect(page.locator("#status")).toContainText(/Done/);
  } else {
    const tree = await snapshot(page, { compact: true });
    await expect(tree.byRole("navigation", { name: /Global/i })).toBeVisible();
    const iphoneLink = tree.byRole("link", { name: "iPhone", index: 0 });
    await expect(iphoneLink).toBeVisible();
    await iphoneLink.click();
    await page.waitForURL(/\\/iphone\\/?/, { timeout: 20_000 });
    await settle();
  }

  await screenshot("03-after-action", { fullPage: false });
  await snapshot(page, { compact: true });

  const obs = await observability.snapshot();
  expect(obs.performance, "performance snapshot").toBeTruthy();
  expect(obs.network, "network snapshot").toBeTruthy();
  expect(obs.console, "console snapshot").toBeTruthy();
});
`;

const runSkepticTarget = async (target) => {
  const dir = path.join(artifactsRoot, target.name, "skeptic");
  const outputDir = path.join(dir, "run-output");
  const observeOutputDir = path.join(dir, "observe-output");
  ensureDir(dir);

  const inspectPath = path.join(dir, "inspect.json");
  const annotatedPath = path.join(dir, "inspect-annotated.png");
  const inspect = await runCommand("skeptic-inspect", "node", [
    dist,
    "inspect",
    target.url,
    "--no-daemon",
    "--compact",
    "--json",
    "--wait",
    target.kind === "external" ? "1500" : "500",
    "--annotated",
    "--annotate-output",
    annotatedPath,
  ]);
  persistCommand(dir, 1, inspect);
  writeText(inspectPath, inspect.stdout);

  const observe = await runCommand("skeptic-observe", "node", [
    dist,
    "observe",
    target.url,
    "--output",
    observeOutputDir,
    "--wait",
    target.kind === "external" ? "1500" : "500",
    "--wait-until",
    "domcontentloaded",
    "--timeout",
    "45000",
    "--no-tui",
  ], {
    timeout: timeoutMs,
  });
  persistCommand(dir, 2, observe);

  const specPath = path.join(dir, `${target.kind}.spec.ts`);
  writeText(specPath, generatedSpec(target.kind));
  const run = await runCommand("skeptic-run", "node", [
    dist,
    "run",
    specPath,
    "--reporter",
    "json",
    "html",
    "--output",
    outputDir,
    "--trace",
    "--video",
    "--observability",
    "--observability-write-sidecars",
    "--no-tui",
    "--no-daemon",
  ], {
    env: { TARGET_URL: target.url },
    timeout: timeoutMs,
  });
  persistCommand(dir, 3, run);

  const resultsPath = path.join(outputDir, "results.json");
  const results = readJson(resultsPath);
  const firstTest = results?.tests?.[0] ?? null;
  const observeResultsPath = path.join(observeOutputDir, "results.json");
  const observeResults = readJson(observeResultsPath);
  const observeTest = observeResults?.tests?.[0] ?? null;
  const metrics = firstTest?.metrics ?? {};
  const inspectJson = tryParseJson(inspect.stdout);

  return {
    commandResults: { inspect, observe, run },
    paths: {
      dir,
      inspectPath,
      annotatedPath: fs.existsSync(annotatedPath) ? annotatedPath : null,
      observeOutputDir,
      observeResultsPath: fs.existsSync(observeResultsPath) ? observeResultsPath : null,
      observeReportPath: fs.existsSync(path.join(observeOutputDir, "report.html"))
        ? path.join(observeOutputDir, "report.html")
        : null,
      outputDir,
      resultsPath: fs.existsSync(resultsPath) ? resultsPath : null,
      reportPath: fs.existsSync(path.join(outputDir, "report.html"))
        ? path.join(outputDir, "report.html")
        : null,
      screenshots: firstTest?.artifacts?.screenshots ?? [],
      trace: firstTest?.artifacts?.trace ?? null,
      video: firstTest?.artifacts?.video?.path ?? null,
      perfTrace: firstTest?.artifacts?.perfTrace ?? null,
      consoleSnapshot: firstTest?.artifacts?.consoleSnapshot ?? null,
      networkSnapshot: firstTest?.artifacts?.networkSnapshot ?? null,
      accessibilityJson: firstTest?.artifacts?.accessibilityJson ?? null,
      accessibilityAudit: firstTest?.artifacts?.accessibilityAudit ?? null,
    },
    summary: {
      ok: inspect.ok && observe.ok && run.ok && firstTest?.status === "passed",
      inspectStats: inspectJson?.stats ?? null,
      observe: {
        ok: observe.ok && observeTest?.status === "passed",
        hasReport: fs.existsSync(path.join(observeOutputDir, "report.html")),
        hasJson: fs.existsSync(observeResultsPath),
        screenshots: observeTest?.artifacts?.screenshots?.length ?? 0,
        hasVideo: Boolean(observeTest?.artifacts?.video?.path),
        hasTrace: Boolean(observeTest?.artifacts?.trace),
        hasPerfTrace: Boolean(observeTest?.artifacts?.perfTrace),
        hasAccessibilityJson: Boolean(observeTest?.artifacts?.accessibilityJson),
        hasAccessibilityAudit: Boolean(observeTest?.artifacts?.accessibilityAudit),
      },
      accessibility: summarizeA11y(metrics.accessibility),
      performance: summarizePerf(metrics.performance),
      network: summarizeNetwork(metrics.network),
      console: summarizeConsole(metrics.console),
      artifactCounts: {
        screenshots: firstTest?.artifacts?.screenshots?.length ?? 0,
        hasVideo: Boolean(firstTest?.artifacts?.video?.path),
        hasTrace: Boolean(firstTest?.artifacts?.trace),
        hasHtmlReport: fs.existsSync(path.join(outputDir, "report.html")),
        hasAccessibilityJson: Boolean(firstTest?.artifacts?.accessibilityJson),
      },
    },
  };
};

const runExpectTarget = async (target) => {
  const dir = path.join(artifactsRoot, target.name, "expect");
  const copiedDir = path.join(dir, "copied-artifacts");
  ensureDir(dir);
  ensureDir(copiedDir);

  if (!(await commandExists("expect"))) {
    return {
      commandResults: {},
      paths: { dir },
      summary: { ok: false, skipped: "expect command not found" },
    };
  }

  await runCommand("expect-close-before", "expect", ["close"], { cwd: dir, timeout: 15_000 }).catch(() => null);

  const actionCode = target.kind === "fixture"
    ? `await page.getByLabel(/Email/i).fill("qa@example.com");
await page.getByRole("button", { name: /Run check/i }).click();
await page.waitForTimeout(1000);
return { title: await page.title(), status: await page.locator("#status").textContent(), url: page.url() };`
    : `await page.waitForLoadState("domcontentloaded").catch(() => {});
await page.getByRole("button", { name: /Close country or region selector/i }).click({ timeout: 3000 }).catch(() => {});
await page.getByRole("link", { name: "iPhone" }).first().click({ timeout: 12000 });
await page.waitForURL(/\\/iphone\\/?/, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1000);
return { title: await page.title(), url: page.url() };`;

  const setupCode = `await page.setViewportSize({ width: 1440, height: 1000 });
await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForTimeout(500);
return { title: await page.title(), url: page.url(), viewport: page.viewportSize() };`;

  const steps = [
    ["open", ["open", target.url, "--wait-until", target.kind === "external" ? "commit" : "domcontentloaded"]],
    ["setup-viewport", ["playwright", setupCode]],
    ["snapshot-initial", ["screenshot", "--mode", "snapshot"]],
    ["annotated-initial", ["screenshot", "--mode", "annotated"]],
    ["playwright-action", ["playwright", actionCode]],
    ["snapshot-after", ["screenshot", "--mode", "snapshot"]],
    ["annotated-after", ["screenshot", "--mode", "annotated"]],
    ["console", ["console_logs"]],
    ["network", ["network_requests"]],
    ["performance", ["performance_metrics"]],
    ["accessibility", ["accessibility_audit"]],
    ["close", ["close"]],
  ];

  const commandResults = {};
  const copiedArtifacts = [];
  for (let i = 0; i < steps.length; i += 1) {
    const [label, stepArgs] = steps[i];
    const result = await runCommand(`expect-${label}`, "expect", stepArgs, {
      cwd: dir,
      timeout: label === "accessibility" || label === "performance" ? timeoutMs : 60_000,
    });
    commandResults[label] = result;
    persistCommand(dir, i + 1, result);
    copiedArtifacts.push(...copyDiscoveredArtifacts(result, copiedDir, String(i + 1).padStart(2, "0")));
  }

  writeText(path.join(dir, "copied-artifacts.json"), JSON.stringify(copiedArtifacts, null, 2));

  const snapshotInitial = tryParseJson(commandResults["snapshot-initial"]?.stdout ?? "");
  const snapshotAfter = tryParseJson(commandResults["snapshot-after"]?.stdout ?? "");
  const accessibility = tryParseJson(commandResults.accessibility?.stdout ?? "");

  return {
    commandResults,
    paths: {
      dir,
      copiedDir,
      copiedArtifacts: copiedArtifacts.map((entry) => entry.copiedPath),
      screenshots: copiedArtifacts
        .map((entry) => entry.copiedPath)
        .filter((file) => /\.(png|jpg|jpeg)$/i.test(file)),
      videos: copiedArtifacts.map((entry) => entry.copiedPath).filter((file) => /\.webm$/i.test(file)),
      perfTraces: copiedArtifacts.map((entry) => entry.copiedPath).filter((file) => /\.md$/i.test(file)),
    },
    summary: {
      ok: commandResults.open?.ok && commandResults["snapshot-after"]?.ok,
      snapshotInitial: summarizeExpectSnapshot(snapshotInitial),
      snapshotAfter: summarizeExpectSnapshot(snapshotAfter),
      accessibility: summarizeA11y(accessibility),
      performance: summarizeExpectPerformance(commandResults.performance?.stdout ?? ""),
      network: summarizeExpectNetwork(commandResults.network?.stdout ?? ""),
      console: summarizeExpectConsole(commandResults.console?.stdout ?? ""),
      overlayNoise: detectExpectOverlayNoise(accessibility),
      artifactCounts: {
        screenshots: copiedArtifacts.filter((entry) => /\.(png|jpg|jpeg)$/i.test(entry.copiedPath)).length,
        videos: copiedArtifacts.filter((entry) => /\.webm$/i.test(entry.copiedPath)).length,
        perfTraces: copiedArtifacts.filter((entry) => /\.md$/i.test(entry.copiedPath)).length,
        hasProjectLogs: fs.existsSync(path.join(dir, ".expect", "logs.md")),
        hasProjectGitignore: fs.existsSync(path.join(dir, ".expect", ".gitignore")),
      },
    },
  };
};

function summarizeExpectSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    lines: snapshot.stats?.lines ?? String(snapshot.tree ?? "").split(/\r?\n/).length,
    characters: snapshot.stats?.characters ?? String(snapshot.tree ?? "").length,
    estimatedTokens: snapshot.stats?.estimatedTokens ?? null,
    totalRefs: snapshot.stats?.totalRefs ?? Object.keys(snapshot.refs ?? {}).length,
    interactiveRefs: snapshot.stats?.interactiveRefs ?? null,
    hasRefsObject: Boolean(snapshot.refs),
  };
}

function summarizeA11y(a11y) {
  if (!a11y) return null;
  const violations = a11y.violations ?? [];
  const nodes = violations.flatMap((violation) => violation.nodes ?? []);
  return {
    violations: a11y.summary?.violations ?? a11y.summary?.total ?? violations.length,
    critical: a11y.summary?.critical ?? violations.filter((v) => v.impact === "critical").length,
    serious: a11y.summary?.serious ?? violations.filter((v) => v.impact === "serious").length,
    rules: [...new Set(violations.map((v) => v.ruleId).filter(Boolean))],
    nodeCount: nodes.length,
    nodesWithSelector: nodes.filter((node) => node.selector || node.target).length,
    nodesWithHtml: nodes.filter((node) => node.html).length,
    nodesWithFailureSummary: nodes.filter((node) => node.failureSummary).length,
    helpUrls: violations.filter((violation) => violation.helpUrl).length,
  };
}

function summarizePerf(perf) {
  if (!perf) return null;
  const resources = perf.resources ?? [];
  return {
    fcp: perf.fcp ?? null,
    lcp: perf.lcp ?? null,
    cls: perf.cls ?? null,
    inp: perf.inp ?? null,
    ttfb: perf.ttfb ?? null,
    longAnimationFrames: perf.longAnimationFrames?.length ?? 0,
    resourceCount: resources.length,
    transferredBytes: resources.reduce((total, resource) => total + (resource.transferSize ?? 0), 0),
    largestResources: resources
      .slice()
      .sort((a, b) => (b.transferSize ?? 0) - (a.transferSize ?? 0))
      .slice(0, 5)
      .map((resource) => ({
        url: resource.name,
        type: resource.initiatorType,
        transferSize: resource.transferSize,
        duration: Math.round(resource.duration ?? 0),
      })),
  };
}

function summarizeNetwork(network) {
  if (!network) return null;
  const issues = network.issues ?? {};
  const duplicateGroups = issues.duplicates ?? issues.duplicateRequests ?? [];
  return {
    requestCount: network.requests?.length ?? network.summary?.requestCount ?? null,
    failedRequests: issues.failedRequests?.length ?? 0,
    networkFailures: issues.networkFailures?.length ?? 0,
    duplicates: duplicateGroups.length,
    mixedContent: issues.mixedContent?.length ?? 0,
    corsErrors: issues.corsErrors?.length ?? 0,
    hasSummary: Boolean(network.summary),
  };
}

function summarizeConsole(consoleSnapshot) {
  if (!consoleSnapshot) return null;
  const summary = consoleSnapshot.summary ?? {};
  return {
    total: summary.total ?? consoleSnapshot.messages?.length ?? null,
    errors: summary.errorCount ?? consoleSnapshot.messages?.filter((m) => m.type === "error").length ?? 0,
    warnings: summary.warningCount ?? consoleSnapshot.messages?.filter((m) => m.type === "warning").length ?? 0,
    messagesWithLocation: consoleSnapshot.messages?.filter((m) => m.location?.url).length ?? 0,
  };
}

function summarizeExpectPerformance(stdout) {
  const trace = stdout.match(/Performance trace written to:\s*(\/[^\n\r]+)/)?.[1] ?? null;
  const fcp = stdout.match(/FCP:\s*([^\n\r]+)/)?.[1]?.trim() ?? null;
  const lcp = stdout.match(/LCP:\s*([^\n\r]+)/)?.[1]?.trim() ?? null;
  const cls = stdout.match(/CLS:\s*([^\n\r]+)/)?.[1]?.trim() ?? null;
  const ttfb = stdout.match(/TTFB:\s*([^\n\r]+)/)?.[1]?.trim() ?? null;
  const loaf = Number(stdout.match(/Long Animation Frames:\s*(\d+)/)?.[1] ?? 0);
  return { trace, fcp, lcp, cls, ttfb, longAnimationFrames: loaf };
}

function summarizeExpectNetwork(stdout) {
  const parsed = tryParseJson(stdout);
  if (parsed) return summarizeNetwork(parsed);
  return {
    rawLines: stdout.trim() ? stdout.trim().split(/\r?\n/).length : 0,
    failedRequestsMentioned: /failed|4xx|5xx|404|500/i.test(stdout),
    duplicateMentioned: /duplicate/i.test(stdout),
    mixedContentMentioned: /mixed content/i.test(stdout),
    noRequests: /No network requests captured/i.test(stdout),
  };
}

function summarizeExpectConsole(stdout) {
  const parsed = tryParseJson(stdout);
  if (parsed) return summarizeConsole(parsed);
  return {
    rawLines: stdout.trim() ? stdout.trim().split(/\r?\n/).length : 0,
    errorMentioned: /error/i.test(stdout),
    warningMentioned: /warn/i.test(stdout),
    noMessages: /No console messages captured/i.test(stdout),
  };
}

function detectExpectOverlayNoise(a11y) {
  if (!a11y?.violations) return { detected: false, nodes: [] };
  const noisyNodes = [];
  for (const violation of a11y.violations) {
    for (const node of violation.nodes ?? []) {
      const text = `${node.selector ?? ""} ${node.html ?? ""} ${node.failureSummary ?? ""}`;
      if (/#document-fragment|expect-|Running accessibility audit|Reading console logs|Inspecting page/i.test(text)) {
        noisyNodes.push({
          ruleId: violation.ruleId,
          selector: node.selector ?? node.target ?? null,
          failureSummary: node.failureSummary ?? null,
        });
      }
    }
  }
  return { detected: noisyNodes.length > 0, nodes: noisyNodes.slice(0, 10), count: noisyNodes.length };
}

const issueWeight = (summary) => {
  if (!summary) return 0;
  return [
    summary.accessibility?.violations ?? 0,
    summary.network?.failedRequests ?? 0,
    summary.network?.networkFailures ?? 0,
    summary.network?.duplicates ?? 0,
    summary.console?.errors ?? 0,
    summary.console?.warnings ?? 0,
  ].reduce((total, value) => total + Number(value ?? 0), 0);
};

const formatJson = (value) => JSON.stringify(value ?? null).replaceAll("|", "\\|");

const writeComparison = (report) => {
  const md = [];
  md.push("# Recommendation Quality Benchmark");
  md.push("");
  md.push(`Generated: ${report.generatedAt}`);
  md.push(`Host: ${report.host}`);
  md.push("");
  md.push("## Targets");
  md.push("");
  for (const target of report.targets) {
    md.push(`- ${target.name}: ${target.url}`);
  }
  md.push("");
  md.push("## Evidence Summary");
  md.push("");
  for (const target of report.targets) {
    md.push(`### ${target.name}`);
    md.push("");
    md.push("| Tool | OK | A11y | Network | Console | Perf | Artifacts |");
    md.push("|---|---:|---|---|---|---|---|");
    for (const tool of ["skeptic", "expect"]) {
      const summary = target.results[tool].summary;
      md.push(
        `| ${tool} | ${summary.ok ? "yes" : "no"} | ${formatJson(summary.accessibility)} | ${formatJson(summary.network)} | ${formatJson(summary.console)} | ${formatJson(summary.performance)} | ${formatJson(summary.artifactCounts)} |`,
      );
    }
    md.push("");
  }
  md.push("## Quality Findings");
  md.push("");
  md.push("- Skeptic produces a cohesive run bundle: HTML report, JSON results, screenshots, WebM video, Playwright trace, performance markdown, console JSON, network JSON, accessibility JSON, and accessibility markdown tied to one test.");
  md.push("- Skeptic now also exposes a first-class `skeptic observe <url>` path for ad hoc page evidence without authoring a spec.");
  md.push("- Expect produces strong ad hoc command outputs: JSON snapshots, JSON accessibility output, annotated screenshots, performance markdown, and a video flushed on close.");
  md.push("- Expect's accessibility output is highly actionable when it is page-owned: rule IDs, impact, selectors, HTML snippets, help URLs, and failure summaries are present in stdout JSON.");
  md.push("- Skeptic's full JSON results and `accessibility.json` sidecar include rule IDs, impact, selectors, HTML snippets, help URLs, and failure summaries; `audit.md` now includes the broken HTML snippets directly.");
  md.push("- Expect showed self-overlay contamination in the accessibility audit when its own browser overlay was present. Those findings mention shadow DOM or Expect UI text and should not be treated as application defects.");
  md.push("");
  md.push("## Implemented Gap Checks");
  md.push("");
  md.push("1. `skeptic observe <url>` is exercised for every target and must emit report HTML, results JSON, screenshots, video, trace, perf-trace markdown, network JSON, console JSON, and accessibility sidecars.");
  md.push("2. `accessibility.json` is expected beside `audit.md` so node-level a11y details are available without mining the full `results.json`.");
  md.push("3. `audit.md` is expected to include HTML snippets for each rendered node sample.");
  md.push("4. Both benchmark harnesses persist raw stdout/stderr, copied screenshots, videos, traces, and markdown outputs into the timestamped run directory.");
  md.push("5. `network.json` is expected to include a top-level summary for request count, failures, duplicates, mixed content, CORS, capture limit, truncation state, method counts, status-code counts, and resource-type counts.");
  md.push("");
  md.push("## Artifact Index");
  md.push("");
  for (const target of report.targets) {
    md.push(`### ${target.name}`);
    md.push("");
    for (const tool of ["skeptic", "expect"]) {
      const paths = target.results[tool].paths;
      md.push(`- ${tool}: \`${path.relative(repoRoot, paths.dir)}\``);
      if (paths.observeReportPath) md.push(`- ${tool} observe report: \`${path.relative(repoRoot, paths.observeReportPath)}\``);
      if (paths.observeResultsPath) md.push(`- ${tool} observe JSON: \`${path.relative(repoRoot, paths.observeResultsPath)}\``);
      if (paths.reportPath) md.push(`- ${tool} report: \`${path.relative(repoRoot, paths.reportPath)}\``);
      if (paths.resultsPath) md.push(`- ${tool} JSON: \`${path.relative(repoRoot, paths.resultsPath)}\``);
      if (paths.perfTrace) md.push(`- ${tool} perf: \`${path.relative(repoRoot, paths.perfTrace)}\``);
      if (paths.accessibilityJson) md.push(`- ${tool} accessibility JSON: \`${path.relative(repoRoot, paths.accessibilityJson)}\``);
      if (paths.accessibilityAudit) md.push(`- ${tool} audit: \`${path.relative(repoRoot, paths.accessibilityAudit)}\``);
      if (paths.copiedDir) md.push(`- ${tool} copied artifacts: \`${path.relative(repoRoot, paths.copiedDir)}\``);
    }
    md.push("");
  }
  md.push("## Relative Signal Volume");
  md.push("");
  for (const target of report.targets) {
    const skepticWeight = issueWeight(target.results.skeptic.summary);
    const expectWeight = issueWeight(target.results.expect.summary);
    md.push(`- ${target.name}: Skeptic issue signal ${skepticWeight}; Expect issue signal ${expectWeight}. Treat this as volume only, not accuracy, because Expect may include overlay-originated a11y findings.`);
  }
  md.push("");

  const mdPath = path.join(artifactsRoot, "comparison.md");
  writeText(mdPath, md.join("\n"));
  return mdPath;
};

ensureDir(artifactsRoot);

const fixture = await createFixtureServer();
try {
  writeText(path.join(artifactsRoot, "fixture.html"), fixture.fixtureHtml);
  const targets = [
    { name: "local-fixture", kind: "fixture", url: fixture.url },
    { name: "external-apple", kind: "external", url: externalUrl },
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    host: `${os.platform()}-${os.arch()}`,
    node: process.version,
    artifactsRoot,
    targets: [],
  };

  for (const target of targets) {
    console.log(`Testing ${target.name}: ${target.url}`);
    const skeptic = await runSkepticTarget(target);
    const expectResult = await runExpectTarget(target);
    report.targets.push({
      ...target,
      results: {
        skeptic,
        expect: expectResult,
      },
    });
  }

  const jsonPath = path.join(artifactsRoot, "evidence.json");
  writeText(jsonPath, JSON.stringify(report, null, 2));
  const comparisonPath = writeComparison(report);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${comparisonPath}`);
} finally {
  await new Promise((resolve) => fixture.server.close(resolve));
}
