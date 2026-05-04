import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import type { Page } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import type {
  AccessibilitySnapshot,
  AccessibilityViolation,
  Collector,
  CollectorName,
} from "../types.js";
import type { ExecutionContext } from "../../executor/context.js";
import { logger } from "../../utils/logger.js";

interface AxeViolationNode {
  target: string | string[];
  html: string;
  failureSummary?: string;
}

interface AxeViolationResult {
  id: string;
  impact: "critical" | "serious" | "moderate" | "minor" | null;
  help: string;
  helpUrl?: string;
  nodes: AxeViolationNode[];
}

interface AxeAnalysisResult {
  violations: AxeViolationResult[];
  passes: unknown[];
  incomplete: unknown[];
}

export interface AccessibilityCollectorOptions {
  dualEngine: boolean;
  htmlSnippetLimit: number;
}

export interface AuditInvocation {
  standard: "WCAG2A" | "WCAG2AA" | "WCAG21A" | "WCAG21AA" | "WCAG22AA";
  include?: string[];
  exclude?: string[];
  impacts?: Array<"critical" | "serious" | "moderate" | "minor">;
}

const STANDARD_TO_AXE_TAGS: Record<AuditInvocation["standard"], string[]> = {
  WCAG2A: ["wcag2a"],
  WCAG2AA: ["wcag2a", "wcag2aa"],
  WCAG21A: ["wcag2a", "wcag21a"],
  WCAG21AA: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
  WCAG22AA: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"],
};

const IBM_SEVERITY_TO_IMPACT = {
  VIOLATION: "serious",
  RECOMMENDATION: "moderate",
  INFORMATION: "minor",
} as const satisfies Record<string, "serious" | "moderate" | "minor">;

/**
 * Map our axe-derived WCAG standard names to IBM Equal Access version-level rulesets.
 * IBM's profile granularity is coarser than axe's — it has version-level rulesets
 * ("WCAG 2.0 (A,AA)", "WCAG 2.1 (A,AA)", "WCAG 2.2 (A,AA)") rather than separate A/AA
 * rule subsets. Both A and AA variants of the same WCAG version map to the same IBM
 * profile; IBM's per-rule applicability metadata handles the conformance-level filtering.
 * See https://github.com/IBMa/equal-access/tree/main-4.x/accessibility-checker-engine.
 */
const STANDARD_TO_IBM_PROFILE: Record<AuditInvocation["standard"], string> = {
  WCAG2A: "WCAG_2_0",
  WCAG2AA: "WCAG_2_0",
  WCAG21A: "WCAG_2_1",
  WCAG21AA: "WCAG_2_1",
  WCAG22AA: "WCAG_2_2",
};

const IMPACT_ORDER: Record<"critical" | "serious" | "moderate" | "minor", number> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
};

interface EngineRunResult {
  violations: AccessibilityViolation[];
  passes: number;
  incomplete: number;
  erroredReason?: string;
}

interface IbmRawResult {
  ruleId?: string;
  value?: [string, string];
  message?: string;
  path?: { dom?: string };
  snippet?: string;
}

export class AccessibilityCollector implements Collector {
  readonly name: CollectorName = "accessibility";
  private page: Page | null = null;
  private lastSnapshot: AccessibilitySnapshot | undefined;
  private equalAccessLoaded: "unknown" | "yes" | "no" = "unknown";
  private readonly options: AccessibilityCollectorOptions;
  private readonly htmlSnippetLimit: number;

  constructor(options: AccessibilityCollectorOptions) {
    this.options = options;
    this.htmlSnippetLimit = options.htmlSnippetLimit;
  }

  private truncateHtml(html: string): string {
    if (this.htmlSnippetLimit <= 0) return "";
    if (html.length <= this.htmlSnippetLimit) return html;
    return html.slice(0, this.htmlSnippetLimit) + "…";
  }

  async attach(page: Page, _ctx: ExecutionContext): Promise<void> {
    this.page = page;
    if (this.options.dualEngine) {
      await this.tryLoadEqualAccess();
    }
  }

  async audit(invocation: AuditInvocation): Promise<AccessibilitySnapshot> {
    // Engines requested for THIS invocation. Always includes "axe"; includes
    // "equal-access" only when dualEngine is configured AND the optional peer is loaded.
    const enginesRequested: Array<"axe" | "equal-access"> = ["axe"];
    const ibmRequested = this.options.dualEngine && this.equalAccessLoaded === "yes";
    if (ibmRequested) enginesRequested.push("equal-access");

    // Page-closed branch: every requested engine is implicitly errored. Populate the
    // structured error fields so the handler reports `status: "error"` rather than a
    // false-pass on a closed page.
    if (!this.page || this.page.isClosed()) {
      const reason = "page closed or unavailable before audit";
      const empty: AccessibilitySnapshot = {
        violations: [],
        summary: {
          violations: 0,
          passes: 0,
          incomplete: 0,
          dualEngine: ibmRequested,
          enginesRequested,
          enginesErrored: enginesRequested.map((engine) => ({ engine, reason })),
        },
        standard: invocation.standard,
      };
      this.lastSnapshot = empty;
      return empty;
    }

    const axeResult = await this.runAxe(invocation);
    const ibmResult: EngineRunResult | null = ibmRequested
      ? await this.runEqualAccess(invocation)
      : null;

    const axeRuleIds = new Set(axeResult.violations.map((v) => v.ruleId));
    const merged: AccessibilityViolation[] = [
      ...axeResult.violations,
      ...(ibmResult?.violations.filter((v) => !axeRuleIds.has(v.ruleId)) ?? []),
    ];

    merged.sort((a, b) => IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact]);

    const enginesErrored: Array<{ engine: "axe" | "equal-access"; reason: string }> = [];
    if (axeResult.erroredReason) {
      enginesErrored.push({ engine: "axe", reason: axeResult.erroredReason });
    }
    if (ibmResult?.erroredReason) {
      enginesErrored.push({ engine: "equal-access", reason: ibmResult.erroredReason });
    }

    const snap: AccessibilitySnapshot = {
      violations: merged,
      summary: {
        violations: merged.length,
        passes: axeResult.passes + (ibmResult?.passes ?? 0),
        incomplete: axeResult.incomplete + (ibmResult?.incomplete ?? 0),
        dualEngine: ibmRequested,
        enginesRequested,
        enginesErrored,
      },
      standard: invocation.standard,
    };
    this.lastSnapshot = snap;
    return snap;
  }

  async snapshot(): Promise<AccessibilitySnapshot | undefined> {
    return this.lastSnapshot;
  }

  async detach(): Promise<void> {
    this.page = null;
  }

  private async runAxe(invocation: AuditInvocation): Promise<EngineRunResult> {
    if (!this.page) {
      return { violations: [], passes: 0, incomplete: 0, erroredReason: "page not attached" };
    }
    try {
      let builder = new AxeBuilder({ page: this.page });
      builder = builder.withTags(STANDARD_TO_AXE_TAGS[invocation.standard]);
      if (invocation.include) {
        for (const sel of invocation.include) builder = builder.include(sel);
      }
      if (invocation.exclude) {
        for (const sel of invocation.exclude) builder = builder.exclude(sel);
      }
      const result = (await builder.analyze()) as unknown as AxeAnalysisResult;
      const violations = result.violations.map<AccessibilityViolation>((v) => ({
        ruleId: v.id,
        impact: (v.impact ?? "minor") as AccessibilityViolation["impact"],
        engine: "axe",
        help: v.help,
        helpUrl: v.helpUrl,
        nodes: v.nodes.map((n) => ({
          target: Array.isArray(n.target) ? n.target.map(String) : [String(n.target)],
          html: this.truncateHtml(n.html),
          failureSummary: n.failureSummary,
        })),
      }));
      return {
        violations,
        passes: result.passes.length,
        incomplete: result.incomplete.length,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`[a11y:axe] audit failed: ${reason}`);
      return { violations: [], passes: 0, incomplete: 0, erroredReason: reason };
    }
  }

  private async tryLoadEqualAccess(): Promise<void> {
    if (this.equalAccessLoaded !== "unknown") return;
    try {
      const req = createRequire(import.meta.url);
      req.resolve("accessibility-checker-engine/ace.js");
      this.equalAccessLoaded = "yes";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
        this.equalAccessLoaded = "no";
        logger.info(
          `[a11y] accessibility-checker-engine not installed — running axe-core only. Install with: npm i accessibility-checker-engine`,
        );
      } else {
        this.equalAccessLoaded = "no";
        logger.warn(
          `[a11y] accessibility-checker-engine resolve failed (unexpected): ${err instanceof Error ? err.message : String(err)} — falling back to axe-core only`,
        );
      }
    }
  }

  private async runEqualAccess(
    invocation: AuditInvocation,
  ): Promise<EngineRunResult> {
    const empty: EngineRunResult = { violations: [], passes: 0, incomplete: 0 };
    if (this.equalAccessLoaded !== "yes" || !this.page) {
      return { ...empty, erroredReason: "engine not loaded" };
    }
    try {
      const acePath = await this.resolveAceScriptPath();
      if (!acePath) return { ...empty, erroredReason: "ace.js path not resolvable" };
      const aceScript = await readFile(acePath, "utf-8");
      const ibmProfile = STANDARD_TO_IBM_PROFILE[invocation.standard];

      const raw = await this.page.evaluate(
        // The callback runs IN THE BROWSER, where `document` and `globalThis` are
        // available at runtime. TS compiles this file server-side (lib: ES2022, no DOM),
        // so we reach for `document` via a loose cast on globalThis rather than
        // importing dom types globally.
        async ({ script, profile }) => {
          const g = globalThis as unknown as {
            ace?: {
              Checker: new () => {
                check(
                  doc: unknown,
                  profiles: string[],
                ): Promise<{ results: unknown[] }>;
              };
            };
            document?: unknown;
          };
          if (!g.ace) {
            // eslint-disable-next-line no-new-func
            new Function(script)();
          }
          if (!g.ace || !g.document) return { results: [] };
          const checker = new g.ace.Checker();
          const report = await checker.check(g.document, [profile]);
          // Strip `node: Element` from each result — live DOM refs can't cross the
          // page.evaluate serialization boundary (structured clone rejects them).
          return {
            results: (report.results as Array<{ node?: unknown } & Record<string, unknown>>).map(
              ({ node: _node, ...rest }) => rest,
            ),
          };
        },
        { script: aceScript, profile: ibmProfile },
      );

      const results = (raw as { results: IbmRawResult[] }).results ?? [];
      const violations: AccessibilityViolation[] = [];
      let passes = 0;
      let incomplete = 0;

      const pushViolation = (
        r: IbmRawResult,
        impact: "serious" | "moderate" | "minor",
      ) => {
        violations.push({
          ruleId: String(r.ruleId),
          impact,
          engine: "equal-access",
          help: String(r.message ?? r.ruleId),
          nodes: r.path?.dom
            ? [{ target: [String(r.path.dom)], html: this.truncateHtml(String(r.snippet ?? "")) }]
            : [],
        });
      };

      for (const r of results) {
        const kind = r.value?.[0];
        const level = r.value?.[1];
        if (kind === "VIOLATION") {
          if (level === "FAIL") {
            pushViolation(r, IBM_SEVERITY_TO_IMPACT.VIOLATION);
          } else if (level === "POTENTIAL") {
            incomplete++;
          }
        } else if (kind === "RECOMMENDATION") {
          pushViolation(r, IBM_SEVERITY_TO_IMPACT.RECOMMENDATION);
        } else if (kind === "INFORMATION") {
          pushViolation(r, IBM_SEVERITY_TO_IMPACT.INFORMATION);
        } else if (kind === "PASS") {
          passes++;
        }
        // Ignore result kinds that are not actionable findings.
      }
      return { violations, passes, incomplete };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`[a11y:equal-access] audit failed: ${reason}`);
      return { violations: [], passes: 0, incomplete: 0, erroredReason: reason };
    }
  }

  private async resolveAceScriptPath(): Promise<string | null> {
    try {
      const req = createRequire(import.meta.url);
      return req.resolve("accessibility-checker-engine/ace.js");
    } catch {
      return null;
    }
  }
}
