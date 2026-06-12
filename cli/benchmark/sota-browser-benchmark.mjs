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
const dist = path.join(root, "dist", "skeptic.mjs");
const artifactsRoot = path.resolve(
  root,
  "..",
  "benchmark-artifacts",
  `sota-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);

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

const iterations = Math.max(1, Number(args.get("iterations") ?? 2));
const externalUrl = args.get("url") ?? "";
const timeoutMs = Math.max(5_000, Number(args.get("timeout") ?? 45_000));
// Per-verb warm-latency ceiling (ms) for the skeptic session path. The plan
// targets ~220-250ms warm open/snapshot/click/screenshot; the run FAILS
// (non-zero exit) when any warm verb median exceeds this budget.
const warmBudgetMs = Math.max(1, Number(args.get("warm-budget") ?? 250));
// The interactive session daemon runs headed by default (its dedicated slot);
// `--session-headless` is an escape hatch for display-less CI.
const sessionHeadless = args.get("session-headless") === "true";

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });

const writeText = (file, value) => {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, value ?? "", "utf8");
};

const tryParseJson = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const readPidFile = (file) => {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const readTextFile = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

// The session verbs print `{ success, data }` under `--json`; pull refs / paths
// from that envelope. Snapshot refs are `{ ref: "eN", role, name, ... }`.
const snapshotRefs = (jsonStdout) => {
  const refs = tryParseJson(jsonStdout)?.data?.refs;
  return Array.isArray(refs) ? refs : [];
};

const pickClickableRef = (jsonStdout) => {
  const refs = snapshotRefs(jsonStdout);
  if (refs.length === 0) return null;
  const interactive = refs.find(
    (r) => /button/i.test(r.role ?? "") || /run check/i.test(r.name ?? ""),
  );
  const chosen = interactive ?? refs[0];
  return chosen?.ref ? `@${chosen.ref}` : null;
};

const extractScreenshotPath = (jsonStdout) => tryParseJson(jsonStdout)?.data?.path ?? null;

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
      maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
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
  writeText(path.join(dir, `${prefix}.command.txt`), result.command?.join(" ") ?? result.label);
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
  if (path.resolve(source) === path.resolve(dest)) return dest;
  fs.copyFileSync(source, dest);
  return dest;
};

const discoverArtifactPaths = (text) => {
  const paths = new Set();
  const patterns = [
    /Screenshot saved:\s*(\/[^\n\r]+)/g,
    /Saved screenshot(?: to)?:\s*(\/[^\n\r]+)/g,
    /Performance trace written to:\s*(\/[^\n\r]+)/g,
    /Full trace:\s*(\/[^\n\r]+)/g,
    /Playwright video:\s*(\/[^\n\r]+)/g,
    /Screenshot:\s*(\/[^\n\r]+)/g,
    /"(?:path|reportPath|trace|video)"\s*:\s*"(\/[^"]+)"/g,
    /(\/[^\s'"<>]+?\.(?:png|jpe?g|webm|zip|md|json|html))\b/g,
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
  for (const artifactPath of discoverArtifactPaths(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)) {
    const copiedPath = copyFileIfPresent(artifactPath, destDir, prefix);
    if (copiedPath) copied.push({ source: artifactPath, copiedPath });
  }
  return copied;
};

const createFixtureServer = async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/slow.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(`
        console.info("fixture script loaded");
        requestAnimationFrame(() => {
          const start = performance.now();
          while (performance.now() - start < 80) {}
        });
      `);
      return;
    }
    if (req.url === "/api/data") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
      return;
    }
    if (req.url === "/missing") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("missing");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Skeptic SOTA Benchmark</title>
    <script src="/slow.js"></script>
  </head>
  <body>
    <nav aria-label="Primary">
      <a href="/products">Products</a>
      <a href="/pricing">Pricing</a>
    </nav>
    <main>
      <h1>Skeptic SOTA Benchmark</h1>
      <label>Email <input id="email" type="email" placeholder="name@example.com"></label>
      <button id="run">Run check</button>
      <p id="status">Idle</p>
      <img src="/missing">
    </main>
    <script>
      document.getElementById("run").addEventListener("click", async () => {
        console.warn("benchmark button clicked");
        await fetch("/api/data");
        await fetch("/missing").catch(() => {});
        document.getElementById("status").textContent = "Done";
      });
    </script>
  </body>
</html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");
  return { server, url: `http://127.0.0.1:${address.port}` };
};

const summarizeSnapshotText = (text) => ({
  chars: text.length,
  lines: text.split(/\r?\n/).length,
  refs: (text.match(/(?:\[ref=e\d+\]|@e\d+)/g) ?? []).length,
  hasUrlMetadata: /\/url:|href|url/i.test(text),
});

const summarizeSnapshotOutput = (text) => {
  try {
    const parsed = JSON.parse(text);
    const snapshotText =
      parsed?.data?.snapshot ??
      parsed?.snapshot ??
      parsed?.structuredContent?.yaml ??
      "";
    const base = summarizeSnapshotText(String(snapshotText || text));
    const refs = parsed?.data?.refs
      ? Object.keys(parsed.data.refs).length
      : Array.isArray(parsed?.refs)
        ? parsed.refs.length
        : base.refs;
    return { ...base, refs };
  } catch {
    return summarizeSnapshotText(text);
  }
};

const runSkepticInspect = async (url, targetDir) => {
  const dir = path.join(targetDir, "skeptic-inspect");
  ensureDir(dir);
  const runs = [];
  for (let i = 0; i < iterations; i += 1) {
    const annotatedPath = path.join(dir, `iter-${i + 1}-annotated.png`);
    const result = await runCommand("skeptic.inspect", "node", [
      dist,
      "inspect",
      url,
      "--no-daemon",
      "--compact",
      "--json",
      "--wait",
      "500",
      "--annotated",
      "--annotate-output",
      annotatedPath,
    ]);
    persistCommand(dir, i + 1, result);
    const parsed = (() => {
      try {
        return JSON.parse(result.stdout);
      } catch {
        return null;
      }
    })();
    runs.push({
      ...result,
      quality: parsed
        ? {
            refs: parsed.refs?.length ?? parsed.stats?.renderedRefs ?? 0,
            stats: parsed.stats ?? null,
            hasSelectorHints: JSON.stringify(parsed).includes("selectorHint"),
            hasAnnotatedScreenshot: fs.existsSync(annotatedPath),
          }
        : summarizeSnapshotText(result.stdout),
      artifactDir: dir,
    });
  }
  return runs;
};

const summarizeSessionErrors = (steps) =>
  steps
    .filter((r) => !r.ok)
    .map((r) => ({ label: r.label, error: r.error ?? null, stderr: (r.stderr ?? "").slice(0, 1000) }));

// Drive the real CLI session verbs as separate short-lived processes against a
// warm daemon-held browser: open → snapshot → click → screenshot → close. This
// is the agent-native path that replaced the removed MCP client. The first full
// pass pays the cold daemon-spawn + browser-launch cost and is DISCARDED; warm
// passes feed the per-verb latency budget gate. We also prove the interactive
// headed session daemon (session.sock) is a distinct process from the headless
// test daemon (daemon.sock).
const runSkepticSession = async (url, targetDir) => {
  const dir = path.join(targetDir, "skeptic-session");
  const copiedDir = path.join(dir, "copied-artifacts");
  ensureDir(dir);
  ensureDir(copiedDir);

  // Isolated daemon home so session.sock / daemon.sock land in a known,
  // inspectable place and a benchmark run never clobbers the user's real
  // ~/.skeptic daemons.
  const daemonHome = path.join(dir, "daemon-home");
  ensureDir(daemonHome);
  const env = { SKEPTIC_DAEMON_DIR: daemonHome };

  const sessionName = "bench";
  const headedFlag = sessionHeadless ? "--headless" : "--headed";
  const sessionFlags = ["--session", sessionName, headedFlag, "--json"];

  const verbLatencies = { open: [], snapshot: [], click: [], screenshot: [] };
  const warmRuns = [];
  let coldTotalMs = null;
  let lastRef = null;

  // pass 0 is the cold warmup (daemon spawn + browser launch) and is discarded;
  // passes 1..iterations are warm and measured per verb.
  for (let pass = 0; pass <= iterations; pass += 1) {
    const cold = pass === 0;
    const passDir = path.join(dir, cold ? "cold" : `warm-${pass}`);
    ensureDir(passDir);

    const open = await runCommand("skeptic.session.open", "node", [
      dist, "open", url, ...sessionFlags, "--wait-until", "networkidle",
    ], { env });
    const snapshot = await runCommand("skeptic.session.snapshot", "node", [
      dist, "snapshot", "-i", ...sessionFlags,
    ], { env });
    const ref = pickClickableRef(snapshot.stdout) ?? lastRef ?? "@e1";
    lastRef = ref;
    const click = await runCommand("skeptic.session.click", "node", [
      dist, "click", ref, ...sessionFlags,
    ], { env });
    const screenshot = await runCommand("skeptic.session.screenshot", "node", [
      dist, "screenshot", "--annotate", ...sessionFlags,
    ], { env });

    const steps = [open, snapshot, click, screenshot];
    steps.forEach((result, index) => persistCommand(passDir, index + 1, result));

    const shotPath = extractScreenshotPath(screenshot.stdout);
    if (shotPath) copyFileIfPresent(shotPath, copiedDir, cold ? "cold" : `warm-${pass}`);

    const totalMs = steps.reduce((sum, r) => sum + r.durationMs, 0);
    if (cold) {
      coldTotalMs = totalMs;
      continue;
    }
    if (open.ok) verbLatencies.open.push(open.durationMs);
    if (snapshot.ok) verbLatencies.snapshot.push(snapshot.durationMs);
    if (click.ok) verbLatencies.click.push(click.durationMs);
    if (screenshot.ok) verbLatencies.screenshot.push(screenshot.durationMs);
    warmRuns.push({
      label: "skeptic.session",
      ok: steps.every((r) => r.ok),
      durationMs: totalMs,
      quality: {
        ref,
        refs: snapshotRefs(snapshot.stdout).length,
        verbMs: {
          open: open.durationMs,
          snapshot: snapshot.durationMs,
          click: click.durationMs,
          screenshot: screenshot.durationMs,
        },
        screenshot: shotPath ? path.basename(shotPath) : null,
      },
      errors: summarizeSessionErrors(steps),
      artifactDir: passDir,
    });
  }

  // Spawn the headless test daemon in the SAME daemon home so we can prove it is
  // a distinct process/socket from the interactive session daemon. `inspect`
  // without `--no-daemon` auto-spawns the persistent headless BrowserServer.
  const headlessProbe = await runCommand("skeptic.session.headless-daemon-probe", "node", [
    dist, "inspect", url, "--json", "--wait", "200",
  ], { env });
  persistCommand(dir, 90, headlessProbe);

  const sessionSocketPath = path.join(daemonHome, "session.sock");
  const daemonSocketPath = path.join(daemonHome, "daemon.sock");
  const sessionPid = readPidFile(path.join(daemonHome, "session.pid"));
  const daemonPid = readPidFile(path.join(daemonHome, "daemon.pid"));
  const sessionSocketExists = fs.existsSync(sessionSocketPath);
  const daemonSocketExists = fs.existsSync(daemonSocketPath);
  const isolation = {
    sessionSocketPath,
    daemonSocketPath,
    sessionSocketExists,
    daemonSocketExists,
    sessionPid,
    daemonPid,
    sessionHeaded: /headed/.test(readTextFile(path.join(daemonHome, "session.engine"))),
    distinctSockets: sessionSocketPath !== daemonSocketPath && sessionSocketExists && daemonSocketExists,
    distinctProcesses: Boolean(sessionPid && daemonPid && sessionPid !== daemonPid),
  };

  // Tear down both daemons we spawned (isolated home, but stay tidy).
  await runCommand("skeptic.session.close", "node", [dist, "close", "--all", "--json"], { env });
  await runCommand("skeptic.daemon.stop", "node", [dist, "daemon", "stop"], { env });

  const verbMedians = {
    open: median(verbLatencies.open),
    snapshot: median(verbLatencies.snapshot),
    click: median(verbLatencies.click),
    screenshot: median(verbLatencies.screenshot),
  };
  const orderedMedians = [verbMedians.open, verbMedians.snapshot, verbMedians.click, verbMedians.screenshot];
  const maxMedianMs = orderedMedians.every((v) => v !== null) ? Math.max(...orderedMedians) : null;
  const warm = {
    budgetMs: warmBudgetMs,
    ...verbMedians,
    coldTotalMs,
    maxMedianMs,
    withinBudget: maxMedianMs !== null && maxMedianMs <= warmBudgetMs,
    samples: verbLatencies,
  };

  writeText(path.join(dir, "session-summary.json"), JSON.stringify({ warm, isolation }, null, 2));

  console.log(
    `  skeptic.session warm medians (ms): ` +
      `open=${warm.open ?? "n/a"} snapshot=${warm.snapshot ?? "n/a"} ` +
      `click=${warm.click ?? "n/a"} screenshot=${warm.screenshot ?? "n/a"} ` +
      `| budget=${warmBudgetMs} within=${warm.withinBudget}`,
  );
  console.log(
    `  daemon isolation: session.sock pid=${isolation.sessionPid ?? "n/a"} ` +
      `vs daemon.sock pid=${isolation.daemonPid ?? "n/a"} ` +
      `distinct=${isolation.distinctSockets && isolation.distinctProcesses}`,
  );

  return { runs: warmRuns, warm, isolation };
};

const runExpectCli = async (url, targetDir) => {
  const baseDir = path.join(targetDir, "expect");
  ensureDir(baseDir);
  if (!(await commandExists("expect"))) return [{ label: "expect", ok: false, skipped: "expect not found" }];
  const runs = [];
  for (let i = 0; i < iterations; i += 1) {
    const dir = path.join(baseDir, `iter-${i + 1}`);
    const copiedDir = path.join(dir, "copied-artifacts");
    ensureDir(dir);
    ensureDir(copiedDir);
    const closeBefore = await runCommand("expect.close-before", "expect", ["close"], {
      cwd: dir,
      timeout: 15_000,
    }).catch(() => null);
    if (closeBefore) persistCommand(dir, 0, closeBefore);
    const open = await runCommand("expect.open", "expect", ["open", url], { cwd: dir });
    const snapshot = await runCommand("expect.snapshot", "expect", [
      "screenshot",
      "--mode",
      "snapshot",
    ], { cwd: dir });
    const annotated = await runCommand("expect.annotated", "expect", [
      "screenshot",
      "--mode",
      "annotated",
    ], { cwd: dir });
    const perf = await runCommand("expect.performance", "expect", ["performance_metrics"], { cwd: dir });
    const a11y = await runCommand("expect.a11y", "expect", ["accessibility_audit"], { cwd: dir });
    const close = await runCommand("expect.close", "expect", ["close"], { cwd: dir, timeout: 15_000 });
    const commands = [open, snapshot, annotated, perf, a11y, close];
    const copiedArtifacts = [];
    commands.forEach((result, index) => {
      persistCommand(dir, index + 1, result);
      copiedArtifacts.push(...copyDiscoveredArtifacts(result, copiedDir, String(index + 1).padStart(2, "0")));
    });
    writeText(path.join(dir, "copied-artifacts.json"), JSON.stringify(copiedArtifacts, null, 2));
    runs.push({
      label: "expect",
      ok: open.ok && snapshot.ok,
      durationMs: open.durationMs + snapshot.durationMs + annotated.durationMs + perf.durationMs + a11y.durationMs,
      quality: {
        snapshot: summarizeSnapshotOutput(snapshot.stdout),
        hasPerf: perf.ok,
        hasA11y: a11y.ok,
        hasAnnotatedScreenshot: annotated.ok,
        copiedArtifacts: copiedArtifacts.length,
        hasProjectGitignore: fs.existsSync(path.join(dir, ".expect", ".gitignore")),
      },
      artifactDir: dir,
      errors: [open, snapshot, annotated, perf, a11y].filter((r) => !r.ok).map((r) => ({
        label: r.label,
        error: r.error,
        stderr: r.stderr.slice(0, 1000),
      })),
    });
  }
  return runs;
};

const runAgentBrowser = async (url, targetDir) => {
  const baseDir = path.join(targetDir, "agent-browser");
  ensureDir(baseDir);
  if (!(await commandExists("agent-browser"))) {
    return [{ label: "agent-browser", ok: false, skipped: "agent-browser not found" }];
  }
  const runs = [];
  for (let i = 0; i < iterations; i += 1) {
    const dir = path.join(baseDir, `iter-${i + 1}`);
    const copiedDir = path.join(dir, "copied-artifacts");
    ensureDir(dir);
    ensureDir(copiedDir);
    const screenshotPath = path.join(dir, "annotated.png");
    const open = await runCommand("agent-browser.open", "agent-browser", [
      "--auto-connect",
      "open",
      url,
    ]);
    const wait = await runCommand("agent-browser.wait", "agent-browser", [
      "--auto-connect",
      "wait",
      "--load",
      "networkidle",
    ], { timeout: 15_000 });
    const snapshot = await runCommand("agent-browser.snapshot", "agent-browser", [
      "--auto-connect",
      "snapshot",
      "-i",
      "-c",
      "--json",
    ]);
    const screenshot = await runCommand("agent-browser.screenshot", "agent-browser", [
      "--auto-connect",
      "screenshot",
      "--annotate",
      screenshotPath,
    ]);
    const commands = [open, wait, snapshot, screenshot];
    const copiedArtifacts = [];
    commands.forEach((result, index) => {
      persistCommand(dir, index + 1, result);
      copiedArtifacts.push(...copyDiscoveredArtifacts(result, copiedDir, String(index + 1).padStart(2, "0")));
    });
    if (fs.existsSync(screenshotPath)) {
      copiedArtifacts.push({
        source: screenshotPath,
        copiedPath: copyFileIfPresent(screenshotPath, copiedDir, "explicit") ?? screenshotPath,
      });
    }
    writeText(path.join(dir, "copied-artifacts.json"), JSON.stringify(copiedArtifacts, null, 2));
    runs.push({
      label: "agent-browser",
      ok: open.ok && snapshot.ok,
      durationMs: open.durationMs + wait.durationMs + snapshot.durationMs + screenshot.durationMs,
      quality: {
        snapshot: summarizeSnapshotOutput(snapshot.stdout),
        hasAnnotatedScreenshot: screenshot.ok && fs.existsSync(screenshotPath),
        copiedArtifacts: copiedArtifacts.length,
      },
      artifactDir: dir,
      errors: [open, wait, snapshot, screenshot].filter((r) => !r.ok).map((r) => ({
        label: r.label,
        error: r.error,
        stderr: r.stderr.slice(0, 1000),
      })),
    });
  }
  return runs;
};

const median = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
};

const summarizeRuns = (runs) => {
  const okRuns = runs.filter((r) => r.ok);
  return {
    attempts: runs.length,
    passed: okRuns.length,
    failed: runs.length - okRuns.length,
    medianDurationMs: median(okRuns.map((r) => r.durationMs)),
    samples: runs,
  };
};

const writeArtifacts = async (report) => {
  ensureDir(artifactsRoot);
  const jsonPath = path.join(artifactsRoot, "benchmark.json");
  const mdPath = path.join(artifactsRoot, "benchmark.md");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  const lines = ["# SOTA Browser Benchmark", ""];
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  for (const target of report.targets) {
    lines.push(`## ${target.name}`);
    lines.push("");
    lines.push("| Tool | Pass | Median ms | Quality notes |");
    lines.push("|---|---:|---:|---|");
    for (const [tool, summary] of Object.entries(target.tools)) {
      const notes = summary.samples
        .map((sample) => sample.quality ? JSON.stringify(sample.quality) : sample.skipped ?? sample.error ?? "")
        .join("<br>");
      lines.push(
        `| ${tool} | ${summary.passed}/${summary.attempts} | ${summary.medianDurationMs ?? "n/a"} | ${notes.replaceAll("|", "\\|")} |`,
      );
    }
    lines.push("");
    const session = target.tools["skeptic.session"];
    if (session?.warm) {
      const w = session.warm;
      lines.push(`### skeptic warm-latency (budget ${w.budgetMs}ms, first cold call discarded)`);
      lines.push("");
      lines.push("| Verb | Warm median ms |");
      lines.push("|---|---:|");
      for (const verb of ["open", "snapshot", "click", "screenshot"]) {
        lines.push(`| ${verb} | ${w[verb] ?? "n/a"} |`);
      }
      lines.push("");
      lines.push(`Cold open+snapshot+click+screenshot total: ${w.coldTotalMs ?? "n/a"}ms`);
      lines.push(
        `Within budget: ${w.withinBudget ? "yes" : "NO"}` +
          (w.maxMedianMs !== null ? ` (max warm median ${w.maxMedianMs}ms)` : " (no successful warm samples)"),
      );
      lines.push("");
    }
    const iso = session?.isolation;
    if (iso) {
      lines.push("### daemon isolation (interactive headed session vs headless test daemon)");
      lines.push("");
      lines.push(
        `- session daemon: \`${iso.sessionSocketPath}\` ` +
          `(exists: ${iso.sessionSocketExists}, pid: ${iso.sessionPid ?? "n/a"}, ${iso.sessionHeaded ? "headed" : "headless"})`,
      );
      lines.push(
        `- test daemon: \`${iso.daemonSocketPath}\` ` +
          `(exists: ${iso.daemonSocketExists}, pid: ${iso.daemonPid ?? "n/a"})`,
      );
      lines.push(`- distinct sockets: ${iso.distinctSockets ? "yes" : "NO"}; distinct processes: ${iso.distinctProcesses ? "yes" : "NO"}`);
      lines.push("");
    }
  }
  fs.writeFileSync(mdPath, lines.join("\n"), "utf-8");
  return { jsonPath, mdPath };
};

const runTarget = async (name, url) => {
  console.log(`Benchmarking ${name}: ${url}`);
  const targetDir = path.join(artifactsRoot, name);
  ensureDir(targetDir);
  const inspect = summarizeRuns(await runSkepticInspect(url, targetDir));
  const session = await runSkepticSession(url, targetDir);
  return {
    name,
    url,
    artifactDir: targetDir,
    tools: {
      "skeptic.inspect": inspect,
      "skeptic.session": { ...summarizeRuns(session.runs), warm: session.warm, isolation: session.isolation },
      expect: summarizeRuns(await runExpectCli(url, targetDir)),
      "agent-browser": summarizeRuns(await runAgentBrowser(url, targetDir)),
    },
  };
};

// Gate the run on the two hard invariants the plan asks for: warm latency stays
// within budget, and the interactive headed session daemon is a distinct
// process/socket from the headless test daemon.
const evaluateVerdict = (targets) => {
  const failures = [];
  for (const target of targets) {
    const session = target.tools["skeptic.session"];
    if (!session) continue;
    const w = session.warm;
    if (w && !w.withinBudget) {
      failures.push(
        w.maxMedianMs === null
          ? `${target.name}: skeptic session path produced no successful warm samples`
          : `${target.name}: warm latency ${w.maxMedianMs}ms exceeds budget ${w.budgetMs}ms`,
      );
    }
    const iso = session.isolation;
    if (iso && (!iso.distinctSockets || !iso.distinctProcesses)) {
      failures.push(`${target.name}: session daemon not isolated from headless test daemon (session.sock vs daemon.sock)`);
    }
  }
  return failures;
};

const fixture = await createFixtureServer();
try {
  const targets = [await runTarget("local-fixture", fixture.url)];
  if (externalUrl) targets.push(await runTarget("external-url", externalUrl));
  const failures = evaluateVerdict(targets);
  const report = {
    generatedAt: new Date().toISOString(),
    host: `${os.platform()}-${os.arch()}`,
    node: process.version,
    iterations,
    warmBudgetMs,
    verdict: { ok: failures.length === 0, failures },
    targets,
  };
  const paths = await writeArtifacts(report);
  console.log(`Wrote ${paths.jsonPath}`);
  console.log(`Wrote ${paths.mdPath}`);
  if (failures.length > 0) {
    console.error("Benchmark gate FAILED:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`Benchmark gate passed (warm latency within ${warmBudgetMs}ms; daemon isolation verified).`);
  }
} finally {
  await new Promise((resolve) => fixture.server.close(resolve));
}
