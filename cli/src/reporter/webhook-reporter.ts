import type { Reporter, RunSummary, TestResult, StepResult, TestIdentifier } from "./types.js";
import { formatTestDisplayName } from "./types.js";
import type { WebhookNotificationConfig } from "../config/schema.js";
import { logger } from "../utils/logger.js";

const HTTP_TIMEOUT_MS = 10_000;

export class WebhookReporter implements Reporter {
  private readonly config: WebhookNotificationConfig;
  private readonly runUrl: string | undefined;

  constructor(config: WebhookNotificationConfig, runUrl?: string) {
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

    const payload = buildWebhookPayload(summary, this.runUrl);
    try {
      const res = await fetch(this.config.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.config.headers },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!res.ok) logger.warn(`Webhook notification failed: HTTP ${res.status}`);
    } catch (err) {
      // Same hygiene rule as SlackReporter — never log err.message (may carry URL or headers).
      const errClass = err instanceof Error ? err.name : "UnknownError";
      logger.warn(`Webhook notification failed: ${errClass}`);
    }
  }
}

export interface WebhookPayloadTest {
  name: string;
  file: string;
  status: string;
  duration_ms: number;
  error: string | null;
  /** Zero-based shard index when run under sharding. Omitted for non-sharded runs.
   *  Consumers can pivot/group by shard programmatically without parsing the suffix
   *  out of `name`. */
  shardId?: number;
}

export interface WebhookPayload {
  status: "passed" | "failed";
  total: number;
  passed: number;
  failed: number;
  duration_ms: number;
  runUrl: string | null;
  tests: WebhookPayloadTest[];
}

export function buildWebhookPayload(summary: RunSummary, runUrl?: string): WebhookPayload {
  return {
    status: summary.failed > 0 ? "failed" : "passed",
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    duration_ms: summary.duration_ms,
    runUrl: runUrl ?? null,
    tests: summary.tests.map((f) => ({
      name: formatTestDisplayName(f, summary.tests),
      file: f.file,
      status: f.status,
      duration_ms: f.duration_ms,
      error: f.steps.find((s) => s.status !== "passed")?.error ?? null,
      ...(f.shardId !== undefined ? { shardId: f.shardId } : {}),
    })),
  };
}
