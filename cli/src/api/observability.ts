import type { AccessibilityCollector } from "../observability/collectors/accessibility-collector.js";
import type { ConsoleCollector } from "../observability/collectors/console-collector.js";
import type { NetworkCollector } from "../observability/collectors/network-collector.js";
import type { PerformanceCollector } from "../observability/collectors/performance-collector.js";
import type {
  AccessibilitySnapshot,
  ConsoleSnapshot,
  NetworkSnapshot,
  PerformanceSnapshot,
} from "../observability/types.js";

export interface PerfThresholds {
  /** Largest Contentful Paint, e.g. "<2500ms". */
  lcp?: string;
  /** Cumulative Layout Shift, e.g. "<0.1". */
  cls?: string;
  /** Interaction to Next Paint, e.g. "<200ms". */
  inp?: string;
  /** First Contentful Paint, e.g. "<1800ms". */
  fcp?: string;
  /** Time to First Byte, e.g. "<800ms". */
  ttfb?: string;
}

export interface NetworkAssertOpts {
  /** URL substrings or regexes that should be ignored. */
  allow?: Array<string | RegExp>;
}

export interface ConsoleAssertOpts {
  allow?: Array<string | RegExp>;
}

export interface AxeAuditOpts {
  standard?: "WCAG2A" | "WCAG2AA" | "WCAG21A" | "WCAG21AA" | "WCAG22AA";
  include?: string[];
  exclude?: string[];
  impacts?: Array<"critical" | "serious" | "moderate" | "minor">;
}

export interface ObservabilityFixture {
  expectPerformance(thresholds: PerfThresholds): Promise<void>;
  expectNoNetworkErrors(opts?: NetworkAssertOpts): Promise<void>;
  expectNoConsoleErrors(opts?: ConsoleAssertOpts): Promise<void>;
  expectAccessible(opts?: AxeAuditOpts): Promise<void>;
  snapshot(): Promise<{
    performance?: PerformanceSnapshot;
    network?: NetworkSnapshot;
    console?: ConsoleSnapshot;
    accessibility?: AccessibilitySnapshot;
  }>;
}

export interface ObservabilityFixtureInput {
  runAction: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  collectors: {
    performance?: PerformanceCollector;
    network?: NetworkCollector;
    console?: ConsoleCollector;
    accessibility?: AccessibilityCollector;
  };
}

const COMPARATOR_RE = /^([<>]=?)\s*([0-9.]+)\s*(ms)?$/i;

const parseThreshold = (raw: string): { op: "<" | "<=" | ">" | ">="; value: number } => {
  const match = COMPARATOR_RE.exec(raw.trim());
  if (!match) {
    throw new Error(`[skeptic] threshold "${raw}" must look like "<2500ms" or "<0.1"`);
  }
  return { op: match[1] as "<" | "<=" | ">" | ">=", value: Number(match[2]) };
};

const compare = (actual: number, op: "<" | "<=" | ">" | ">=", expected: number): boolean => {
  switch (op) {
    case "<": return actual < expected;
    case "<=": return actual <= expected;
    case ">": return actual > expected;
    case ">=": return actual >= expected;
  }
};

const ensureCollector = <T>(collector: T | undefined, name: string): T => {
  if (!collector) {
    throw new Error(
      `[skeptic] observability.expect${name}() needs the "${name.toLowerCase()}" collector. ` +
        `Pass --observability or test.use({ collectors: ["${name.toLowerCase()}"] }).`,
    );
  }
  return collector;
};

const matchesAllow = (value: string, allow: Array<string | RegExp> | undefined): boolean => {
  if (!allow || allow.length === 0) return false;
  return allow.some((pattern) =>
    typeof pattern === "string" ? value.includes(pattern) : pattern.test(value),
  );
};

export const buildObservabilityFixture = (
  input: ObservabilityFixtureInput,
): ObservabilityFixture => {
  const { runAction, collectors } = input;

  return {
    expectPerformance: (thresholds) =>
      runAction("observability.expectPerformance", async () => {
        const collector = ensureCollector(collectors.performance, "Performance");
        const snap = await collector.snapshot();
        const failures: string[] = [];
        const checks: Array<{ key: keyof PerfThresholds; metric: keyof PerformanceSnapshot }> = [
          { key: "lcp", metric: "lcp" },
          { key: "cls", metric: "cls" },
          { key: "inp", metric: "inp" },
          { key: "fcp", metric: "fcp" },
          { key: "ttfb", metric: "ttfb" },
        ];
        for (const { key, metric } of checks) {
          const raw = thresholds[key];
          if (raw === undefined) continue;
          const { op, value } = parseThreshold(raw);
          const actual = snap[metric];
          if (typeof actual !== "number") {
            failures.push(`${key}: not measured (collector returned ${actual === null ? "null" : typeof actual})`);
            continue;
          }
          if (!compare(actual, op, value)) {
            failures.push(`${key}: ${actual} ${op} ${value} failed`);
          }
        }
        if (failures.length > 0) {
          throw new Error(`[skeptic] performance thresholds violated:\n  - ${failures.join("\n  - ")}`);
        }
      }),

    expectNoNetworkErrors: (opts) =>
      runAction("observability.expectNoNetworkErrors", async () => {
        const collector = ensureCollector(collectors.network, "Network");
        const snap = await collector.snapshot();
        const offenders: string[] = [];
        const allow = opts?.allow;
        for (const failed of snap.issues.failedRequests) {
          if (matchesAllow(failed.url, allow)) continue;
          offenders.push(`${failed.method} ${failed.url} → ${failed.status}`);
        }
        for (const failure of snap.issues.networkFailures) {
          if (matchesAllow(failure.url, allow)) continue;
          offenders.push(`${failure.method} ${failure.url}: ${failure.reason}`);
        }
        if (offenders.length > 0) {
          throw new Error(
            `[skeptic] network errors detected:\n  - ${offenders.join("\n  - ")}`,
          );
        }
      }),

    expectNoConsoleErrors: (opts) =>
      runAction("observability.expectNoConsoleErrors", async () => {
        const collector = ensureCollector(collectors.console, "Console");
        const snap = await collector.snapshot();
        const allow = opts?.allow;
        const errors = snap.messages.filter(
          (m) => m.type === "error" && !matchesAllow(m.text, allow),
        );
        if (errors.length > 0) {
          throw new Error(
            `[skeptic] ${errors.length} console error(s):\n  - ${errors
              .slice(0, 5)
              .map((e) => e.text.slice(0, 200))
              .join("\n  - ")}`,
          );
        }
      }),

    expectAccessible: (opts) =>
      runAction("observability.expectAccessible", async () => {
        const collector = ensureCollector(collectors.accessibility, "Accessibility");
        const audit = await collector.audit({
          standard: opts?.standard ?? "WCAG21AA",
          ...(opts?.include ? { include: opts.include } : {}),
          ...(opts?.exclude ? { exclude: opts.exclude } : {}),
          ...(opts?.impacts ? { impacts: opts.impacts } : {}),
        });
        if (audit.summary.violations > 0) {
          const top = audit.violations
            .slice(0, 5)
            .map((v) => `${v.ruleId} (${v.impact}): ${v.help}`);
          throw new Error(
            `[skeptic] ${audit.summary.violations} a11y violation(s):\n  - ${top.join("\n  - ")}`,
          );
        }
      }),

    snapshot: () =>
      runAction("observability.snapshot", async () => {
        const out: {
          performance?: PerformanceSnapshot;
          network?: NetworkSnapshot;
          console?: ConsoleSnapshot;
          accessibility?: AccessibilitySnapshot;
        } = {};
        if (collectors.performance) out.performance = await collectors.performance.snapshot();
        if (collectors.network) out.network = await collectors.network.snapshot();
        if (collectors.console) out.console = await collectors.console.snapshot();
        if (collectors.accessibility) {
          const a11ySnap = await collectors.accessibility.snapshot();
          if (a11ySnap !== undefined) out.accessibility = a11ySnap;
        }
        return out;
      }),
  };
};
