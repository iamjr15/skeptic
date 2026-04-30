export type AIProvider = "gemini" | "openai" | "anthropic";

export const ENV_KEY_BY_PROVIDER: Record<AIProvider, string> = {
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

/**
 * Result of an AI call. `retryCount` is the number of transient retries that
 * `withRetry` performed before success; 0 means the first attempt worked.
 * Surfacing this lets step handlers add a `StepResult.warnings` entry like
 * "AI retried 2× before success" so users can see when CI was rescued.
 */
export interface AIResult {
  text: string;
  retryCount: number;
}

export interface AIClient {
  readonly provider: AIProvider;
  analyzeImage(imageBuffer: Buffer, prompt: string, temperature?: number): Promise<AIResult>;
  generateText(prompt: string, system?: string, temperature?: number): Promise<AIResult>;
}
