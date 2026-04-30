import { PRODUCT_NAME } from "../constants.js";
import type { Reporter, RunSummary, TestResult, StepResult, TestIdentifier } from "./types.js";
import { formatTestDisplayName } from "./types.js";
import type { SlackNotificationConfig } from "../config/schema.js";
import { logger } from "../utils/logger.js";

const HTTP_TIMEOUT_MS = 10_000;
const MAX_FAILED_FLOWS_LISTED = 5;

export class SlackReporter implements Reporter {
  private readonly config: SlackNotificationConfig;
  private readonly runUrl: string | undefined;

  constructor(config: SlackNotificationConfig, runUrl?: string) {
    this.config = config;
    this.runUrl = runUrl;
  }

  onTestStart(_flow: TestIdentifier): void {}
  onStepComplete(_step: StepResult, _index: number, _total: number, _flow: TestIdentifier): void {}
  onTestComplete(_result: TestResult, _flow: TestIdentifier): void {}

  async onRunComplete(summary: RunSummary): Promise<void> {
    const failed = summary.failed > 0;
    if (failed && !this.config.onFailure) return;
    if (!failed && !this.config.onSuccess) return;

    const payload = buildSlackPayload(summary, this.config, this.runUrl);
    try {
      const res = await fetch(this.config.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!res.ok) {
        // Status code is safe — never contains URL or secrets.
        logger.warn(`Slack notification failed: HTTP ${res.status}`);
      }
    } catch (err) {
      // CRITICAL: never log err.message or String(err) — Node's fetch error messages
      // can include the request URL ("fetch failed for https://hooks.slack.com/...").
      // err.name is a fixed class identifier ("TimeoutError"/"TypeError"/"AbortError")
      // that never carries user data.
      const errClass = err instanceof Error ? err.name : "UnknownError";
      logger.warn(`Slack notification failed: ${errClass}`);
    }
  }
}

interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  fields?: Array<{ type: string; text: string }>;
  elements?: Array<{ type: string; text: string }>;
}

interface SlackPayload {
  text: string;
  blocks: SlackBlock[];
}

export function buildSlackPayload(
  summary: RunSummary,
  config: SlackNotificationConfig,
  runUrl?: string,
): SlackPayload {
  const failed = summary.failed > 0;
  const emoji = failed ? "❌" : "✅";
  const headerLabel = failed
    ? `${emoji} ${PRODUCT_NAME} tests failed: ${summary.failed} flow${summary.failed === 1 ? "" : "s"}`
    : `${emoji} ${PRODUCT_NAME} tests passed`;

  const mentionsLine = config.mention.length > 0 ? config.mention.join(" ") : "";
  const fallbackText = mentionsLine ? `${mentionsLine} ${headerLabel}` : headerLabel;

  const blocks: SlackBlock[] = [];

  // Mentions go in a mrkdwn section block — header blocks are plain_text and don't notify.
  if (mentionsLine) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: mentionsLine },
    });
  }

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: headerLabel },
  });

  blocks.push({
    type: "section",
    fields: [
      { type: "mrkdwn", text: `*Total*\n${summary.total}` },
      { type: "mrkdwn", text: `*Passed*\n${summary.passed}` },
      { type: "mrkdwn", text: `*Failed*\n${summary.failed}` },
      { type: "mrkdwn", text: `*Duration*\n${(summary.duration_ms / 1000).toFixed(1)}s` },
    ],
  });

  if (failed) {
    const failedFlows = summary.tests.filter((f) => f.status !== "passed");
    const lines = failedFlows
      .slice(0, MAX_FAILED_FLOWS_LISTED)
      .map((f) => `• ${formatTestDisplayName(f, summary.tests)}`);
    if (failedFlows.length > MAX_FAILED_FLOWS_LISTED) {
      lines.push(`_…and ${failedFlows.length - MAX_FAILED_FLOWS_LISTED} more_`);
    }
    if (lines.length > 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n") },
      });
    }
  }

  if (runUrl) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `<${runUrl}|View run>` }],
    });
  }

  return { text: fallbackText, blocks };
}
