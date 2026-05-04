import type { Page, Request, Response } from "playwright";
import type {
  Collector,
  CollectorName,
  NetworkRequest,
  NetworkSnapshot,
} from "../types.js";
import type { ExecutionContext } from "../../executor/context.js";
import { logger } from "../../utils/logger.js";
import { redactUrl } from "../url-redact.js";

export interface NetworkCollectorOptions {
  captureLimit: number;
  duplicateWindowMs: number;
}

export class NetworkCollector implements Collector {
  readonly name: CollectorName = "network";
  private page: Page | null = null;
  private readonly requests: NetworkRequest[] = [];
  private readonly entryByRequest: Map<Request, NetworkRequest> = new Map();
  private readonly options: NetworkCollectorOptions;
  private onRequest?: (req: Request) => void;
  private onResponse?: (res: Response) => void;
  private onRequestFailed?: (req: Request) => void;
  private onRequestFinished?: (req: Request) => void;

  constructor(options: NetworkCollectorOptions) {
    this.options = options;
  }

  async attach(page: Page, _ctx: ExecutionContext): Promise<void> {
    this.page = page;

    this.onRequest = (req) => {
      if (this.options.captureLimit > 0 && this.requests.length >= this.options.captureLimit) {
        return;
      }
      let frameUrl: string | undefined;
      try {
        const raw = req.frame().url();
        frameUrl = redactUrl(raw);
      } catch {
        frameUrl = undefined;
      }
      const entry: NetworkRequest = {
        url: redactUrl(req.url()),
        method: req.method(),
        resourceType: req.resourceType(),
        timestamp: Date.now(),
        frameUrl,
      };
      this.requests.push(entry);
      this.entryByRequest.set(req, entry);
    };

    this.onResponse = (res) => {
      const entry = this.entryByRequest.get(res.request());
      if (entry) entry.status = res.status();
    };

    this.onRequestFailed = (req) => {
      const entry = this.entryByRequest.get(req);
      if (!entry) return;
      entry.failure = req.failure()?.errorText ?? "unknown failure";
    };

    this.onRequestFinished = (req) => {
      const entry = this.entryByRequest.get(req);
      if (!entry) return;
      try {
        const timing = req.timing();
        const duration = timing.responseEnd - timing.startTime;
        entry.duration = duration >= 0 ? Math.round(duration) : undefined;
      } catch {
        // timing throws if request never started; leave duration undefined
      }
    };

    page.on("request", this.onRequest);
    page.on("response", this.onResponse);
    page.on("requestfailed", this.onRequestFailed);
    page.on("requestfinished", this.onRequestFinished);
  }

  async snapshot(): Promise<NetworkSnapshot> {
    const requests = this.requests.slice();
    const issues = this.computeIssues();
    return {
      requests,
      issues,
      summary: this.computeSummary(requests, issues),
    };
  }

  async detach(): Promise<void> {
    if (this.page) {
      if (this.onRequest) this.page.off("request", this.onRequest);
      if (this.onResponse) this.page.off("response", this.onResponse);
      if (this.onRequestFailed) this.page.off("requestfailed", this.onRequestFailed);
      if (this.onRequestFinished) this.page.off("requestfinished", this.onRequestFinished);
    }
    logger.debug(`[net] detach — captured ${this.requests.length} request(s)`);
    this.page = null;
    this.entryByRequest.clear();
  }

  private computeIssues(): NetworkSnapshot["issues"] {
    const failedRequests: NetworkSnapshot["issues"]["failedRequests"] = [];
    const networkFailures: NetworkSnapshot["issues"]["networkFailures"] = [];

    for (const r of this.requests) {
      if (r.status !== undefined && r.status >= 400 && r.status < 600) {
        failedRequests.push({ url: r.url, method: r.method, status: r.status });
        continue;
      }
      if (r.status === undefined && r.failure !== undefined) {
        const lower = r.failure.toLowerCase();
        if (!lower.includes("cors") && !lower.includes("access-control")) {
          networkFailures.push({ url: r.url, method: r.method, reason: r.failure });
        }
      }
    }

    return {
      failedRequests,
      networkFailures,
      duplicates: this.findDuplicates(),
      mixedContent: this.findMixedContent(),
      corsErrors: this.findCorsErrors(),
    };
  }

  private computeSummary(
    requests: NetworkRequest[],
    issues: NetworkSnapshot["issues"],
  ): NonNullable<NetworkSnapshot["summary"]> {
    const resourceTypes: Record<string, number> = {};
    const methods: Record<string, number> = {};
    const statusCodes: Record<string, number> = {};
    for (const request of requests) {
      resourceTypes[request.resourceType] = (resourceTypes[request.resourceType] ?? 0) + 1;
      methods[request.method] = (methods[request.method] ?? 0) + 1;
      if (request.status !== undefined) {
        const key = String(request.status);
        statusCodes[key] = (statusCodes[key] ?? 0) + 1;
      }
    }
    const failedRequestCount = issues.failedRequests.length;
    const networkFailureCount = issues.networkFailures.length;
    const duplicateGroupCount = issues.duplicates.length;
    const mixedContentCount = issues.mixedContent.length;
    const corsErrorCount = issues.corsErrors.length;
    return {
      requestCount: requests.length,
      failedRequestCount,
      networkFailureCount,
      duplicateGroupCount,
      mixedContentCount,
      corsErrorCount,
      issueCount:
        failedRequestCount +
        networkFailureCount +
        duplicateGroupCount +
        mixedContentCount +
        corsErrorCount,
      captureLimit: this.options.captureLimit,
      truncated: this.options.captureLimit > 0 && requests.length >= this.options.captureLimit,
      resourceTypes,
      methods,
      statusCodes,
    };
  }

  private findDuplicates(): NetworkSnapshot["issues"]["duplicates"] {
    const buckets = new Map<string, NetworkRequest[]>();
    for (const r of this.requests) {
      const key = `${r.method}:${r.url}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
      }
      bucket.push(r);
    }

    const out: NetworkSnapshot["issues"]["duplicates"] = [];
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue;
      bucket.sort((a, b) => a.timestamp - b.timestamp);

      let windowCount = 1;

      for (let i = 1; i < bucket.length; i++) {
        const prev = bucket[i - 1]!;
        const cur = bucket[i]!;
        if (cur.timestamp - prev.timestamp < this.options.duplicateWindowMs) {
          windowCount++;
        } else {
          if (windowCount >= 2) {
            out.push({
              method: bucket[0]!.method,
              url: bucket[0]!.url,
              count: windowCount,
              windowMs: this.options.duplicateWindowMs,
            });
          }
          windowCount = 1;
        }
      }
      if (windowCount >= 2) {
        out.push({
          method: bucket[0]!.method,
          url: bucket[0]!.url,
          count: windowCount,
          windowMs: this.options.duplicateWindowMs,
        });
      }
    }
    return out;
  }

  private findMixedContent(): string[] {
    const out: string[] = [];
    for (const r of this.requests) {
      if (!r.frameUrl || !r.frameUrl.startsWith("https://")) continue;
      if (r.url.startsWith("data:") || r.url.startsWith("blob:")) continue;
      if (r.url.startsWith("http://")) out.push(r.url);
    }
    return out;
  }

  private findCorsErrors(): NetworkSnapshot["issues"]["corsErrors"] {
    const out: NetworkSnapshot["issues"]["corsErrors"] = [];
    for (const r of this.requests) {
      if (!r.failure) continue;
      const lower = r.failure.toLowerCase();
      if (lower.includes("cors") || lower.includes("access-control")) {
        out.push({ url: r.url, method: r.method, reason: r.failure });
      }
    }
    return out;
  }
}
