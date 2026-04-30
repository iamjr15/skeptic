import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PNG } from "pngjs";
import {
  ProviderError,
  classifyError,
  withRetry,
  downscalePng,
} from "../../../src/ai/retry-policy.js";

// All retry sleeps go through setTimeout — fake them so the suite runs in ms,
// not seconds. Each test that triggers retries must `await vi.runAllTimersAsync()`
// after the await-able call begins.
function makeRetryablePromise<T>(
  fn: () => Promise<T>,
  opts: Parameters<typeof withRetry<T>>[1] = {},
): Promise<{ value: T; retryCount: number }> {
  return withRetry(fn, opts);
}

describe("retry-policy", () => {
  describe("classifyError", () => {
    it("413 (payload too large) → context-length, regardless of provider", () => {
      for (const provider of ["gemini", "openai", "anthropic"] as const) {
        const err = new ProviderError("too large", provider, 413, {});
        expect(classifyError(err).kind).toBe("context-length");
      }
    });

    describe("gemini", () => {
      it("429 → rate-limit, propagates retryAfterMs", () => {
        const err = new ProviderError("rate limited", "gemini", 429, {}, 1500);
        const c = classifyError(err);
        expect(c.kind).toBe("rate-limit");
        expect(c.retryAfterMs).toBe(1500);
      });

      it("400 with input-token-limit message → context-length", () => {
        const err = new ProviderError("rejected", "gemini", 400, {
          error: { message: "Request exceeds the input token limit." },
        });
        expect(classifyError(err).kind).toBe("context-length");
      });

      it("400 without context-length pattern → fatal", () => {
        const err = new ProviderError("bad request", "gemini", 400, {
          error: { message: "Invalid input format." },
        });
        expect(classifyError(err).kind).toBe("fatal");
      });

      it("500 → overload", () => {
        const err = new ProviderError("server error", "gemini", 500, {});
        expect(classifyError(err).kind).toBe("overload");
      });

      it("503 → overload", () => {
        const err = new ProviderError("unavailable", "gemini", 503, {});
        expect(classifyError(err).kind).toBe("overload");
      });
    });

    describe("anthropic", () => {
      it("429 → rate-limit", () => {
        const err = new ProviderError("rate limited", "anthropic", 429, {}, 800);
        const c = classifyError(err);
        expect(c.kind).toBe("rate-limit");
        expect(c.retryAfterMs).toBe(800);
      });

      it("529 → overload (Anthropic-specific code)", () => {
        const err = new ProviderError("overloaded", "anthropic", 529, {
          error: { type: "overloaded_error" },
        });
        expect(classifyError(err).kind).toBe("overload");
      });

      it("503 → overload", () => {
        const err = new ProviderError("unavailable", "anthropic", 503, {});
        expect(classifyError(err).kind).toBe("overload");
      });

      it("400 + invalid_request_error + length pattern → context-length", () => {
        const err = new ProviderError("too long", "anthropic", 400, {
          error: {
            type: "invalid_request_error",
            message: "input length 250000 exceeds the model's maximum",
          },
        });
        expect(classifyError(err).kind).toBe("context-length");
      });

      it("400 invalid_request_error WITHOUT length pattern → fatal", () => {
        const err = new ProviderError("bad request", "anthropic", 400, {
          error: { type: "invalid_request_error", message: "Missing required field." },
        });
        expect(classifyError(err).kind).toBe("fatal");
      });

      it("400 with non-invalid_request_error type → fatal", () => {
        const err = new ProviderError("auth", "anthropic", 400, {
          error: { type: "authentication_error", message: "input length far exceeds" },
        });
        expect(classifyError(err).kind).toBe("fatal");
      });
    });

    describe("openai", () => {
      it("429 + rate_limit_exceeded code → rate-limit", () => {
        const err = new ProviderError("rate limited", "openai", 429, {
          error: { code: "rate_limit_exceeded" },
        }, 2000);
        const c = classifyError(err);
        expect(c.kind).toBe("rate-limit");
        expect(c.retryAfterMs).toBe(2000);
      });

      it("429 WITHOUT rate_limit_exceeded code → fatal (auth/quota issues)", () => {
        // Per OpenAI docs, 429 without `rate_limit_exceeded` code can mean
        // billing/quota issues that shouldn't auto-retry. The classifier
        // explicitly requires the code match.
        const err = new ProviderError("quota", "openai", 429, {
          error: { code: "insufficient_quota" },
        });
        expect(classifyError(err).kind).toBe("fatal");
      });

      it("400 + context_length_exceeded → context-length", () => {
        const err = new ProviderError("too large", "openai", 400, {
          error: { code: "context_length_exceeded" },
        });
        expect(classifyError(err).kind).toBe("context-length");
      });

      it("400 with other code → fatal", () => {
        const err = new ProviderError("bad request", "openai", 400, {
          error: { code: "invalid_value" },
        });
        expect(classifyError(err).kind).toBe("fatal");
      });

      it("500 → overload", () => {
        const err = new ProviderError("server error", "openai", 500, {});
        expect(classifyError(err).kind).toBe("overload");
      });
    });

    it("401 (auth) → fatal across all providers", () => {
      for (const provider of ["gemini", "openai", "anthropic"] as const) {
        const err = new ProviderError("unauthorized", provider, 401, {});
        expect(classifyError(err).kind).toBe("fatal");
      }
    });

    it("404 → fatal", () => {
      const err = new ProviderError("not found", "openai", 404, {});
      expect(classifyError(err).kind).toBe("fatal");
    });

    it("malformed body (non-object) doesn't crash classifier", () => {
      const err = new ProviderError("err", "anthropic", 400, "raw text");
      expect(classifyError(err).kind).toBe("fatal");
    });
  });

  describe("downscalePng", () => {
    function makePng(width: number, height: number, color = [255, 128, 64, 255]): Buffer {
      const png = new PNG({ width, height });
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          png.data[idx] = color[0]!;
          png.data[idx + 1] = color[1]!;
          png.data[idx + 2] = color[2]!;
          png.data[idx + 3] = color[3]!;
        }
      }
      return PNG.sync.write(png);
    }

    it("halves dimensions of a 4x4 PNG to 2x2", () => {
      const input = makePng(4, 4);
      const out = downscalePng(input);
      expect(out).not.toBeNull();
      const decoded = PNG.sync.read(out!);
      expect(decoded.width).toBe(2);
      expect(decoded.height).toBe(2);
    });

    it("preserves color values via nearest-neighbor sampling", () => {
      const input = makePng(2, 2, [10, 20, 30, 200]);
      const out = downscalePng(input)!;
      const decoded = PNG.sync.read(out);
      // 2x2 → 1x1; the single output pixel should match the source.
      expect(decoded.data[0]).toBe(10);
      expect(decoded.data[1]).toBe(20);
      expect(decoded.data[2]).toBe(30);
      expect(decoded.data[3]).toBe(200);
    });

    it("clamps minimum dimension to 1 (does not produce a 0×0 PNG)", () => {
      const input = makePng(1, 1);
      const out = downscalePng(input);
      expect(out).not.toBeNull();
      const decoded = PNG.sync.read(out!);
      expect(decoded.width).toBe(1);
      expect(decoded.height).toBe(1);
    });

    it("returns null for an unparseable buffer", () => {
      expect(downscalePng(Buffer.from("not a png"))).toBeNull();
      expect(downscalePng(Buffer.alloc(0))).toBeNull();
    });
  });

  describe("withRetry", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns retryCount=0 when the first attempt succeeds", async () => {
      const fn = vi.fn().mockResolvedValue("ok");
      const result = await withRetry(fn);
      expect(result).toEqual({ value: "ok", retryCount: 0 });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries on transient errors and reports retryCount", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new ProviderError("rate", "openai", 429, {
          error: { code: "rate_limit_exceeded" },
        }))
        .mockResolvedValueOnce("ok");

      const promise = withRetry(fn);
      // First attempt fails immediately; second attempt is delayed by 250ms
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result).toEqual({ value: "ok", retryCount: 1 });
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("uses exponential backoff (250, 500ms) when no Retry-After header", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new ProviderError("o", "anthropic", 503, {}))
        .mockRejectedValueOnce(new ProviderError("o", "anthropic", 503, {}))
        .mockResolvedValueOnce("ok");

      const promise = withRetry(fn);

      // attempt 0 fails → wait 250ms
      await vi.advanceTimersByTimeAsync(249);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fn).toHaveBeenCalledTimes(2);

      // attempt 1 fails → wait 500ms
      await vi.advanceTimersByTimeAsync(499);
      expect(fn).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fn).toHaveBeenCalledTimes(3);

      const result = await promise;
      expect(result.retryCount).toBe(2);
    });

    it("honors Retry-After (retryAfterMs) over the default backoff", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(
          new ProviderError("rate", "anthropic", 429, {}, 5_000),
        )
        .mockResolvedValueOnce("ok");

      const promise = withRetry(fn);

      // The default backoff for attempt 0 would be 250ms. Retry-After (5000) wins.
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fn).toHaveBeenCalledTimes(2);

      await promise;
    });

    it("throws the last error after exhausting all attempts", async () => {
      const err = new ProviderError("rate", "openai", 429, {
        error: { code: "rate_limit_exceeded" },
      });
      const fn = vi.fn().mockRejectedValue(err);

      // Attach the rejection assertion BEFORE running timers, otherwise vitest
      // sees an unhandled rejection in the brief window before .rejects subscribes.
      const promise = withRetry(fn);
      const assertion = expect(promise).rejects.toBe(err);
      await vi.runAllTimersAsync();
      await assertion;
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("throws fatal errors immediately, without retrying", async () => {
      const err = new ProviderError("auth", "openai", 401, {});
      const fn = vi.fn().mockRejectedValue(err);

      await expect(withRetry(fn)).rejects.toBe(err);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("throws non-ProviderError errors immediately", async () => {
      const err = new TypeError("boom");
      const fn = vi.fn().mockRejectedValue(err);

      await expect(withRetry(fn)).rejects.toBe(err);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("respects a custom maxAttempts", async () => {
      const err = new ProviderError("o", "anthropic", 503, {});
      const fn = vi.fn().mockRejectedValue(err);

      const promise = withRetry(fn, { maxAttempts: 2 });
      const assertion = expect(promise).rejects.toBe(err);
      await vi.runAllTimersAsync();
      await assertion;
      expect(fn).toHaveBeenCalledTimes(2);
    });

    describe("context-length recovery", () => {
      const ctxErr = () =>
        new ProviderError("too large", "openai", 400, {
          error: { code: "context_length_exceeded" },
        });

      it("calls onContextLengthError once and retries when it returns true", async () => {
        const onContext = vi.fn().mockResolvedValue(true);
        const fn = vi
          .fn()
          .mockRejectedValueOnce(ctxErr())
          .mockResolvedValueOnce("ok");

        const promise = withRetry(fn, { onContextLengthError: onContext });
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result).toEqual({ value: "ok", retryCount: 1 });
        expect(onContext).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledTimes(2);
      });

      it("throws when onContextLengthError returns false (payload not fixable)", async () => {
        const onContext = vi.fn().mockResolvedValue(false);
        const err = ctxErr();
        const fn = vi.fn().mockRejectedValue(err);

        await expect(withRetry(fn, { onContextLengthError: onContext })).rejects.toBe(err);
        expect(onContext).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledTimes(1);
      });

      it("throws when no onContextLengthError hook is provided", async () => {
        const err = ctxErr();
        const fn = vi.fn().mockRejectedValue(err);

        await expect(withRetry(fn)).rejects.toBe(err);
        expect(fn).toHaveBeenCalledTimes(1);
      });

      it("calls onContextLengthError at most once even on repeated context-length errors", async () => {
        // After downscaling, the next attempt also reports context-length —
        // shouldn't loop forever. The `contextLengthHandled` flag means we throw
        // on the second context-length error.
        const onContext = vi.fn().mockResolvedValue(true);
        const err = ctxErr();
        const fn = vi.fn().mockRejectedValue(err);

        const promise = withRetry(fn, { onContextLengthError: onContext });
        const assertion = expect(promise).rejects.toBe(err);
        await vi.runAllTimersAsync();
        await assertion;
        expect(onContext).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledTimes(2);
      });
    });
  });
});

// Quiet "imported but unused" if we ever drop the helper.
void makeRetryablePromise;
