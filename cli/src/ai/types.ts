export interface AIAssertionResult {
  passed: boolean;
  confidence: number;
  issues: AIIssue[];
  summary: string;
  /**
   * Number of transient retries `withRetry` performed before success
   * (rate-limit, overload, context-length downscale). 0 if first attempt
   * worked. Step handlers surface non-zero counts via
   * `appendWarning(result, "AI retried Nx before success")`. Optional
   * because tests / mocks don't always set it.
   */
  retryCount?: number;
}

export interface AIIssue {
  type: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
}

export interface AIExtractionResult {
  text: string;
  confidence: number;
  retryCount?: number;
}

export interface AIFlowGenerationResult {
  flows: string[];
}
