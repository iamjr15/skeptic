import { PNG } from "pngjs";
import { logger } from "../utils/logger.js";

/**
 * Structured provider error. All AI clients throw this (instead of bare
 * `Error`) so `classifyError` can read status + body without parsing free-form
 * messages. `provider` is for log/telemetry attribution; `body` is the parsed
 * JSON response (or raw text fallback) so `classifyError` can inspect
 * provider-specific shapes (Gemini's `error.message`, Anthropic's
 * `error.type`, OpenAI's `error.code`).
 */
export type AIProvider = "gemini" | "anthropic" | "openai";

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: AIProvider,
    public readonly status: number,
    public readonly body: unknown,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type ErrorKind = "rate-limit" | "overload" | "context-length" | "fatal";

export interface ErrorClassification {
  kind: ErrorKind;
  retryAfterMs?: number | null;
}

const CONTEXT_LENGTH_PATTERNS: Record<AIProvider, RegExp> = {
  // Gemini surfaces the limit in body.error.message prose.
  gemini: /(exceeds|over).*(input.token.limit|maximum.context|content.too.large)/i,
  // Anthropic uses error.type === "invalid_request_error" plus a length-y message.
  anthropic: /input length .* exceeds/i,
  // OpenAI gives error.code === "context_length_exceeded" — handled directly.
  openai: /(context_length_exceeded|maximum context length)/i,
};

/** Inspect a `ProviderError` and classify what recovery (if any) applies. */
export function classifyError(err: ProviderError): ErrorClassification {
  const { provider, status, body, retryAfterMs } = err;
  const bodyMessage = readMessage(body);

  // Universal: payload-too-large recovers via downscale.
  if (status === 413) return { kind: "context-length" };

  if (provider === "gemini") {
    if (status === 429) return { kind: "rate-limit", retryAfterMs };
    if (status === 400 && CONTEXT_LENGTH_PATTERNS.gemini.test(bodyMessage)) {
      return { kind: "context-length" };
    }
    if (status >= 500) return { kind: "overload", retryAfterMs };
  }

  if (provider === "anthropic") {
    if (status === 429) return { kind: "rate-limit", retryAfterMs };
    if (status === 529 || status === 503) return { kind: "overload", retryAfterMs };
    const errorType = readErrorType(body);
    if (
      status === 400 &&
      errorType === "invalid_request_error" &&
      CONTEXT_LENGTH_PATTERNS.anthropic.test(bodyMessage)
    ) {
      return { kind: "context-length" };
    }
  }

  if (provider === "openai") {
    if (status === 429 && readErrorCode(body) === "rate_limit_exceeded") {
      return { kind: "rate-limit", retryAfterMs };
    }
    if (status === 400 && readErrorCode(body) === "context_length_exceeded") {
      return { kind: "context-length" };
    }
    if (status >= 500) return { kind: "overload", retryAfterMs };
  }

  return { kind: "fatal" };
}

interface WithRetryOptions {
  maxAttempts?: number;
  /**
   * Called once when classifyError says `context-length`. Returns true if it
   * mutated the request payload (e.g. downscaled an image) — only then is
   * retry useful. Returns false → caller treats as fatal (no point retrying
   * the same payload).
   */
  onContextLengthError?: () => Promise<boolean>;
}

/**
 * Wrap a provider call so transient failures (rate-limit, overload,
 * context-length-with-fixable-payload) retry silently. The user only sees
 * fatal failures or final exhaustion of attempts. Returns the raw value plus
 * the count of retries that were needed (0 if first attempt succeeded) so the
 * caller can surface a "AI retried 2x" warning on the StepResult.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: WithRetryOptions = {},
): Promise<{ value: T; retryCount: number }> {
  const maxAttempts = opts.maxAttempts ?? 3;
  let contextLengthHandled = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const value = await fn();
      return { value, retryCount: attempt };
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      const c = classifyError(err);
      if (c.kind === "fatal") throw err;
      if (attempt === maxAttempts - 1) throw err;

      if (c.kind === "context-length") {
        if (contextLengthHandled || !opts.onContextLengthError) throw err;
        const fixed = await opts.onContextLengthError();
        contextLengthHandled = true;
        if (!fixed) throw err;
        // Retry immediately, no backoff (the payload changed).
        logger.debug(`[ai-retry] context-length: downscaled payload, retrying`);
        continue;
      }

      const baseDelay = 250 * Math.pow(2, attempt); // 250, 500, 1000ms
      const delay = c.retryAfterMs ?? baseDelay;
      logger.debug(
        `[ai-retry] ${err.provider} ${c.kind} (status ${err.status}): waiting ${delay}ms before attempt ${attempt + 2}/${maxAttempts}`,
      );
      await sleep(delay);
    }
  }

  // Unreachable — the loop either returns or throws.
  throw new Error("withRetry: loop exited without resolution");
}

/**
 * Nearest-neighbor 2× downscale. Returns null if the buffer can't be parsed
 * as PNG; the caller treats null as "no retry possible". Pure JS — uses
 * `pngjs` (already a runtime dep for visual diff). Keeps web-vitals/sharp
 * out of the picture.
 */
export function downscalePng(input: Buffer): Buffer | null {
  try {
    const src = PNG.sync.read(input);
    const w2 = Math.max(1, Math.floor(src.width / 2));
    const h2 = Math.max(1, Math.floor(src.height / 2));
    const dst = new PNG({ width: w2, height: h2 });
    for (let y = 0; y < h2; y++) {
      for (let x = 0; x < w2; x++) {
        const sx = x * 2;
        const sy = y * 2;
        const si = (sy * src.width + sx) * 4;
        const di = (y * w2 + x) * 4;
        dst.data[di] = src.data[si]!;
        dst.data[di + 1] = src.data[si + 1]!;
        dst.data[di + 2] = src.data[si + 2]!;
        dst.data[di + 3] = src.data[si + 3]!;
      }
    }
    return PNG.sync.write(dst);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readMessage(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const b = body as { error?: { message?: unknown; type?: unknown; code?: unknown } };
  const msg = b.error?.message;
  return typeof msg === "string" ? msg : "";
}

function readErrorType(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const t = (body as { error?: { type?: unknown } }).error?.type;
  return typeof t === "string" ? t : "";
}

function readErrorCode(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const c = (body as { error?: { code?: unknown } }).error?.code;
  return typeof c === "string" ? c : "";
}
