import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { PRODUCT_NAME } from "../constants.js";
import { logger } from "../utils/logger.js";

export const DEFAULT_MARKER = "<!-- skeptic-qa-results -->";
const GH_TIMEOUT_MS = 15_000;

export interface CommentCommandOptions {
  results?: string;
  pr?: string;
  marker?: string;
  runUrl?: string;
  dryRun?: boolean;
  config?: string;
}

export interface ResultsShape {
  total: number;
  passed: number;
  failed: number;
  duration_ms: number;
  tests: Array<{
    name: string;
    file: string;
    status: string;
    steps: Array<{ status: string; error?: string }>;
  }>;
}

export function isValidResults(value: unknown): value is ResultsShape {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (typeof r["total"] !== "number") return false;
  if (typeof r["passed"] !== "number") return false;
  if (typeof r["failed"] !== "number") return false;
  if (typeof r["duration_ms"] !== "number") return false;
  if (!Array.isArray(r["tests"])) return false;
  return true;
}

export function buildCommentBody(
  results: ResultsShape,
  runUrl: string | null,
  marker: string = DEFAULT_MARKER,
): string {
  const status = results.failed > 0 ? "❌" : "✅";
  const escapePipe = (s: string): string => s.replace(/\|/g, "\\|");
  const lines: string[] = [
    marker,
    `## ${status} ${PRODUCT_NAME} test results`,
    "",
    `| Total | Passed | Failed | Duration |`,
    `|-------|--------|--------|----------|`,
    `| ${results.total} | ${results.passed} | ${results.failed} | ${(results.duration_ms / 1000).toFixed(1)}s |`,
    "",
  ];

  if (results.failed > 0) {
    lines.push("### Failed Tests");
    for (const test of results.tests) {
      if (test.status === "passed") continue;
      const failedStep = test.steps.find((s) => s.status !== "passed");
      const errMsg = failedStep?.error ?? "unknown error";
      lines.push(`- **${escapePipe(test.name)}** (${escapePipe(test.file)}): ${escapePipe(errMsg)}`);
    }
    lines.push("");
  }

  if (runUrl) {
    lines.push(`> [Download full report](${runUrl})`);
  }

  return lines.filter((l) => l !== null && l !== undefined).join("\n");
}

function deriveRunUrlFromEnv(): string | null {
  const server = process.env["GITHUB_SERVER_URL"];
  const repo = process.env["GITHUB_REPOSITORY"];
  const runId = process.env["GITHUB_RUN_ID"];
  if (server && repo && runId) return `${server}/${repo}/actions/runs/${runId}`;
  return null;
}

function detectPrNumberFromGitRef(): string | null {
  const ref = process.env["GITHUB_REF"];
  if (!ref) return null;
  const match = /^refs\/pull\/(\d+)\/(merge|head)$/.exec(ref);
  return match ? match[1]! : null;
}

export function detectPrNumber(): string | null {
  const fromRef = detectPrNumberFromGitRef();
  if (fromRef) return fromRef;
  try {
    const out = execFileSync("gh", ["pr", "view", "--json", "number", "-q", ".number"], {
      encoding: "utf-8",
      timeout: GH_TIMEOUT_MS,
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export function findExistingComment(prNumber: string, marker: string): string | null {
  const out = execFileSync(
    "gh",
    ["api", `repos/{owner}/{repo}/issues/${prNumber}/comments?per_page=100`],
    { encoding: "utf-8", timeout: GH_TIMEOUT_MS },
  );
  const parsed = JSON.parse(out) as Array<{ id?: number; body?: string }>;
  if (!Array.isArray(parsed)) return null;
  const match = parsed.find((c) => typeof c.body === "string" && c.body.includes(marker));
  return match && typeof match.id === "number" ? String(match.id) : null;
}

export async function runComment(opts: CommentCommandOptions): Promise<void> {
  const resultsPath = path.resolve(opts.results ?? "./skeptic-output/results.json");
  const marker = opts.marker ?? DEFAULT_MARKER;

  if (!fs.existsSync(resultsPath)) {
    logger.warn(`skeptic comment: results file not found at ${resultsPath} — skipping`);
    return;
  }

  let results: ResultsShape;
  try {
    const raw = fs.readFileSync(resultsPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isValidResults(parsed)) {
      logger.warn("skeptic comment: results.json has unexpected shape — skipping");
      return;
    }
    results = parsed;
  } catch {
    logger.warn("skeptic comment: results.json is not valid JSON — skipping");
    return;
  }

  const runUrl = opts.runUrl ?? deriveRunUrlFromEnv();
  const body = buildCommentBody(results, runUrl, marker);

  if (opts.dryRun) {
    process.stdout.write(body + "\n");
    return;
  }

  try {
    const prNumber = opts.pr ?? detectPrNumber();
    if (!prNumber) {
      logger.info("skeptic comment: no PR detected — skipping");
      return;
    }

    let existingId: string | null = null;
    try {
      existingId = findExistingComment(prNumber, marker);
    } catch (err) {
      if (isENOENT(err)) {
        logger.warn(
          "skeptic comment: 'gh' CLI not found — skipping PR comment. Install: https://cli.github.com",
        );
        return;
      }
      logger.warn(
        "skeptic comment: gh CLI not authenticated or GitHub API unreachable — skipping",
      );
      return;
    }

    const tempfile = path.join(os.tmpdir(), `skeptic-comment-${Date.now()}-${process.pid}.md`);
    fs.writeFileSync(tempfile, body, "utf-8");
    try {
      if (existingId) {
        execFileSync(
          "gh",
          [
            "api",
            `repos/{owner}/{repo}/issues/comments/${existingId}`,
            "-X",
            "PATCH",
            "-F",
            `body=@${tempfile}`,
          ],
          { encoding: "utf-8", timeout: GH_TIMEOUT_MS },
        );
        logger.success(`skeptic comment: updated comment on PR #${prNumber}`);
      } else {
        execFileSync(
          "gh",
          ["pr", "comment", String(prNumber), "--body-file", tempfile],
          { encoding: "utf-8", timeout: GH_TIMEOUT_MS },
        );
        logger.success(`skeptic comment: posted comment on PR #${prNumber}`);
      }
    } finally {
      try {
        fs.unlinkSync(tempfile);
      } catch {
        // best-effort cleanup; never fails the command
      }
    }
  } catch (err) {
    if (isENOENT(err)) {
      logger.warn(
        "skeptic comment: 'gh' CLI not found — skipping PR comment. Install: https://cli.github.com",
      );
      return;
    }
    const errClass = err instanceof Error ? err.name : "UnknownError";
    logger.warn(`skeptic comment: failed to post — ${errClass}`);
  }
}

function isENOENT(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && (err as { code?: string }).code === "ENOENT",
  );
}
