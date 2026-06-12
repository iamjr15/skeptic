import type {
  AccessibilitySnapshot,
  ConsoleSnapshot,
  NetworkSnapshot,
  PerformanceSnapshot,
  ResourceTiming,
} from "../observability/types.js";

export interface PerfTraceInput {
  performance?: PerformanceSnapshot;
  network?: NetworkSnapshot;
  accessibility?: AccessibilitySnapshot;
  console?: ConsoleSnapshot;
}

export interface PerfTraceOptions {
  /**
   * Per-impact-bucket cap for the Accessibility section. When the bucket
   * holds more than `cap` rules, the markdown renders the first `cap` and
   * appends a "...and N more — see audit.md" footer. The per-test `audit.md`
   * sidecar always lists every rule regardless of this cap. Default = 100.
   */
  accessibilityMaxRulesPerImpact?: number;
}

/** Match the Expect-flavoured ms formatting in the benchmark perf-trace markdown:
 *  use ms up through ~9 999, only switch to seconds for very long durations. Keeps the
 *  output side-by-side comparable with expect-pass output. */
const fmtMs = (v: number | null | undefined): string => {
  if (v === null || v === undefined) return "—";
  if (v >= 10_000) return `${(v / 1000).toFixed(2)}s`;
  return `${Math.round(v)}ms`;
};

const fmtBytes = (b: number): string => {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1024 / 1024).toFixed(2)}MB`;
};

const webVitalRating = (
  metric: "fcp" | "lcp" | "cls" | "inp",
  value: number | null,
): string => {
  if (value === null) return "—";
  if (metric === "fcp") return value <= 1800 ? "good" : value <= 3000 ? "needs-improvement" : "poor";
  if (metric === "lcp") return value <= 2500 ? "good" : value <= 4000 ? "needs-improvement" : "poor";
  if (metric === "cls") return value <= 0.1 ? "good" : value <= 0.25 ? "needs-improvement" : "poor";
  if (metric === "inp") return value <= 200 ? "good" : value <= 500 ? "needs-improvement" : "poor";
  return "—";
};

/**
 * Pure formatter for the per-test perf-trace markdown sidecar. Matches the section layout
 * Expect emits today (Web Vitals → Navigation Timing → LoAF → Resources → Network issues
 * → Accessibility) without copying any code.
 *
 * Sections are omitted entirely when their input snapshot is missing — never rendered with
 * "0 B" placeholder rows. The Resources section reads from `PerformanceSnapshot.resources`
 * (zero-cost browser-side capture); when that field is empty the section is dropped.
 */
export const formatPerfTraceMarkdown = (
  input: PerfTraceInput,
  options: PerfTraceOptions = {},
): string => {
  const a11yCap = options.accessibilityMaxRulesPerImpact ?? 100;
  const parts: string[] = ["# Performance Trace", ""];

  const perf = input.performance;
  if (perf) {
    parts.push("## Web Vitals", "");
    parts.push(`- **FCP**: ${fmtMs(perf.fcp)} (${webVitalRating("fcp", perf.fcp)})`);
    parts.push(`- **LCP**: ${fmtMs(perf.lcp)} (${webVitalRating("lcp", perf.lcp)})`);
    parts.push(
      `- **CLS**: ${perf.cls === null ? "—" : perf.cls.toFixed(3)} (${webVitalRating("cls", perf.cls)})`,
    );
    parts.push(`- **INP**: ${fmtMs(perf.inp)} (${webVitalRating("inp", perf.inp)})`);
    parts.push("");

    if (perf.navigationTiming) {
      parts.push("## Navigation Timing", "");
      parts.push(`- **TTFB**: ${fmtMs(perf.navigationTiming.ttfb)}`);
      parts.push(`- **DOM Content Loaded**: ${fmtMs(perf.navigationTiming.domContentLoaded)}`);
      parts.push(`- **Load Complete**: ${fmtMs(perf.navigationTiming.loadComplete)}`);
      const serverTiming = perf.navigationTiming.serverTiming;
      if (serverTiming && serverTiming.length > 0) {
        parts.push("- **Server-Timing**:");
        for (const s of serverTiming) {
          const dur = typeof s.duration === "number" ? ` (${fmtMs(s.duration)})` : "";
          const desc = s.description ? ` — ${s.description}` : "";
          parts.push(`  - \`${s.name}\`${dur}${desc}`);
        }
      }
      parts.push("");
    }

    if (perf.longAnimationFrames.length > 0) {
      parts.push("## Long Animation Frames (LoAF)", "");
      parts.push(`${perf.longAnimationFrames.length} long animation frames detected.`);
      parts.push("");
      const top = perf.longAnimationFrames.slice(0, 10);
      top.forEach((f, idx) => {
        // Bumped from 100 to 150 ms to match Expect's POOR threshold and Chromium's
        // updated LoAF guidance — the previous 100 ms cutoff was too noisy on real apps.
        const poor = f.blockingDuration > 150 ? " ⚠ POOR" : "";
        const maxForcedLayout = f.scripts.reduce(
          (m, s) => Math.max(m, s.forcedStyleAndLayoutDuration ?? 0),
          0,
        );
        const forcedFlag = maxForcedLayout > 30 ? ` ⚠ forced layout: ${fmtMs(maxForcedLayout)}` : "";
        parts.push(`### Frame ${idx + 1}${poor}${forcedFlag}`, "");
        parts.push(`- **Duration**: ${fmtMs(f.duration)}`);
        parts.push(`- **Blocking Duration**: ${fmtMs(f.blockingDuration)}`);
        parts.push(`- **Render Start**: ${fmtMs(f.startTime)}`);
        parts.push("");
        if (f.scripts.length > 0) {
          parts.push("**Scripts:**", "");
          for (const s of f.scripts.slice(0, 5)) {
            const fn = s.sourceFunctionName || "(anonymous)";
            parts.push(`- \`${fn}\` — ${fmtMs(s.duration)}`);
            if (s.invoker) parts.push(`  - Invoker: ${s.invoker}`);
            if (s.sourceURL) parts.push(`  - Source: ${s.sourceURL}`);
          }
          parts.push("");
          // Top-3 by duration with their forced-layout cost — surfaces which scripts
          // forced layout work and lets users target rendering hotpaths.
          const ranked = [...f.scripts]
            .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
            .slice(0, 3);
          if (ranked.length > 0) {
            parts.push("**Scripts (sorted by duration):**", "");
            for (const s of ranked) {
              const fn = s.sourceFunctionName || "(anonymous)";
              const fl = s.forcedStyleAndLayoutDuration ?? 0;
              const flBit = fl > 0 ? ` — forced layout ${fmtMs(fl)}` : "";
              parts.push(`- \`${fn}\` — ${fmtMs(s.duration)}${flBit}`);
            }
            parts.push("");
          }
        }
      });
    }

    if (perf.resources && perf.resources.length > 0) {
      parts.push("## Resources", "");
      const totalBytes = perf.resources.reduce((s, r) => s + (r.transferSize || 0), 0);
      parts.push(`${perf.resources.length} resources loaded — ${fmtBytes(totalBytes)} transferred.`);
      parts.push("");
      const slowest = topByDuration(perf.resources, 10);
      if (slowest.length > 0) {
        parts.push("### Slowest Resources", "");
        for (const r of slowest) {
          parts.push(
            `- ${fmtMs(r.duration)} — ${r.name} (${r.initiatorType || "—"}, ${fmtBytes(r.transferSize)})`,
          );
        }
        parts.push("");
      }
      const largest = topBySize(perf.resources, 10);
      if (largest.length > 0 && largest.some((r) => r.transferSize > 0)) {
        parts.push("### Largest Resources", "");
        for (const r of largest) {
          parts.push(
            `- ${fmtBytes(r.transferSize)} — ${r.name} (${r.initiatorType || "—"}, ${fmtMs(r.duration)})`,
          );
        }
        parts.push("");
      }
    }
  }

  const net = input.network;
  if (net && net.issues) {
    parts.push("## Network", "");
    parts.push(`${net.requests.length} request(s) captured.`);
    parts.push("");
    const issues = net.issues;
    const issueLines: string[] = [];
    if (issues.failedRequests.length > 0) {
      issueLines.push(`- **HTTP failures (4xx/5xx)**: ${issues.failedRequests.length}`);
      for (const f of issues.failedRequests.slice(0, 10)) {
        issueLines.push(`  - ${f.status} ${f.method} ${f.url}`);
      }
    }
    if (issues.networkFailures.length > 0) {
      issueLines.push(`- **Network failures (DNS/TCP/aborted)**: ${issues.networkFailures.length}`);
      for (const f of issues.networkFailures.slice(0, 10)) {
        issueLines.push(`  - ${f.method} ${f.url} — ${f.reason}`);
      }
    }
    if (issues.duplicates.length > 0) {
      issueLines.push(`- **Duplicate request groups**: ${issues.duplicates.length}`);
    }
    if (issues.mixedContent.length > 0) {
      issueLines.push(`- **Mixed-content resources**: ${issues.mixedContent.length}`);
    }
    if (issues.corsErrors.length > 0) {
      issueLines.push(`- **CORS errors**: ${issues.corsErrors.length}`);
    }
    if (issueLines.length > 0) {
      parts.push("### Issues", "");
      parts.push(...issueLines);
      parts.push("");
    }
  }

  const con = input.console;
  if (con && con.summary.total > 0) {
    parts.push("## Console", "");
    parts.push(
      `${con.summary.total} message(s) — ${con.summary.errorCount} error(s), ${con.summary.warningCount} warning(s).`,
    );
    if (con.summary.redactionDisabled) {
      parts.push("");
      parts.push("> ⚠ Redaction is disabled — captured text may contain credentials/PII.");
    }
    parts.push("");
    if (con.summary.errorCount > 0 || con.summary.warningCount > 0) {
      const issues = con.messages.filter((m) => m.type === "error" || m.type === "warning").slice(0, 20);
      if (issues.length > 0) {
        parts.push("### Errors & warnings", "");
        for (const m of issues) {
          parts.push(`- **${m.type}**: ${m.text}`);
        }
        parts.push("");
      }
    }
  }

  const a11y = input.accessibility;
  if (a11y) {
    parts.push("## Accessibility", "");
    parts.push(`Standard: ${a11y.standard}. Engines: ${a11y.summary.dualEngine ? "axe-core + IBM Equal Access" : "axe-core"}.`);
    parts.push(
      `${a11y.summary.violations} violation(s), ${a11y.summary.passes} pass(es), ${a11y.summary.incomplete} incomplete.`,
    );
    parts.push("");
    if (a11y.violations.length > 0) {
      const groups: Record<string, typeof a11y.violations> = {
        critical: [],
        serious: [],
        moderate: [],
        minor: [],
      };
      for (const v of a11y.violations) groups[v.impact]?.push(v);
      for (const impact of ["critical", "serious", "moderate", "minor"] as const) {
        const list = groups[impact];
        if (!list || list.length === 0) continue;
        parts.push(`### ${impact[0]!.toUpperCase()}${impact.slice(1)} (${list.length})`, "");
        const shown = list.slice(0, a11yCap);
        for (const v of shown) {
          parts.push(`- **${v.ruleId}** — ${v.help}${v.engine === "equal-access" ? " *(equal-access)*" : ""}`);
          if (v.helpUrl) parts.push(`  - ${v.helpUrl}`);
        }
        if (list.length > a11yCap) {
          parts.push(`- ...and ${list.length - a11yCap} more — see audit.md`);
        }
        parts.push("");
      }
    }
  }

  return parts.join("\n");
};

const topByDuration = (resources: ResourceTiming[], n: number): ResourceTiming[] =>
  [...resources].sort((a, b) => b.duration - a.duration).slice(0, n);

const topBySize = (resources: ResourceTiming[], n: number): ResourceTiming[] =>
  [...resources].sort((a, b) => b.transferSize - a.transferSize).slice(0, n);
