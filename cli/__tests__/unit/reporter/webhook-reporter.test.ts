import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebhookReporter, buildWebhookPayload } from "../../../src/reporter/webhook-reporter.js";
import type { RunSummary } from "../../../src/reporter/types.js";
import type { WebhookNotificationConfig } from "../../../src/config/schema.js";
import { logger } from "../../../src/utils/logger.js";

const SECRET_URL = "https://hooks.example.com/SECRET-TOKEN-XYZ";

function makeConfig(overrides: Partial<WebhookNotificationConfig> = {}): WebhookNotificationConfig {
  return {
    url: SECRET_URL,
    headers: {},
    onFailure: true,
    onSuccess: false,
    ...overrides,
  };
}

function makeSummary(failed = 0): RunSummary {
  const tests = [];
  for (let i = 0; i < 1; i++) {
    tests.push({
      name: `Pass Flow ${i + 1}`,
      file: `tests/pass-${i + 1}.yaml`,
      status: "passed" as const,
      duration_ms: 100,
      steps: [],
      artifacts: {},
    });
  }
  for (let i = 0; i < failed; i++) {
    tests.push({
      name: `Fail Flow ${i + 1}`,
      file: `tests/fail-${i + 1}.yaml`,
      status: "failed" as const,
      duration_ms: 200,
      steps: [{ command: "click", args: {}, status: "failed" as const, duration_ms: 50, error: `Element ${i + 1} missing` }],
      artifacts: {},
    });
  }
  return {
    total: tests.length,
    passed: tests.filter((f) => f.status === "passed").length,
    failed: tests.filter((f) => f.status !== "passed").length,
    duration_ms: 5000,
    tests,
  };
}

describe("WebhookReporter gating", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts on failure when onFailure: true (default)", async () => {
    const reporter = new WebhookReporter(makeConfig());
    await reporter.onRunComplete(makeSummary(1));
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("skips on success when onSuccess: false (default)", async () => {
    const reporter = new WebhookReporter(makeConfig());
    await reporter.onRunComplete(makeSummary(0));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts on success when onSuccess: true", async () => {
    const reporter = new WebhookReporter(makeConfig({ onSuccess: true }));
    await reporter.onRunComplete(makeSummary(0));
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("skips on failure when onFailure: false", async () => {
    const reporter = new WebhookReporter(makeConfig({ onFailure: false }));
    await reporter.onRunComplete(makeSummary(1));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("buildWebhookPayload contract", () => {
  it("flat shape with status/total/passed/failed/duration_ms/runUrl/flows", () => {
    const payload = buildWebhookPayload(makeSummary(2), "https://ci.example/run/42");
    expect(payload).toMatchObject({
      status: "failed",
      total: expect.any(Number),
      passed: expect.any(Number),
      failed: 2,
      duration_ms: 5000,
      runUrl: "https://ci.example/run/42",
    });
    expect(Array.isArray(payload.tests)).toBe(true);
  });

  it("status reflects pass/fail correctly", () => {
    expect(buildWebhookPayload(makeSummary(0)).status).toBe("passed");
    expect(buildWebhookPayload(makeSummary(1)).status).toBe("failed");
  });

  it("flows[].error captures first failed step's error or null", () => {
    const payload = buildWebhookPayload(makeSummary(1));
    const failedFlow = payload.tests.find((f) => f.status === "failed");
    expect(failedFlow?.error).toBe("Element 1 missing");
    const passedFlow = payload.tests.find((f) => f.status === "passed");
    expect(passedFlow?.error).toBeNull();
  });

  it("runUrl defaults to null when undefined", () => {
    const payload = buildWebhookPayload(makeSummary(0));
    expect(payload.runUrl).toBeNull();
  });

  it("appends shard suffix to flows[].name + populates shardId field under sharding", () => {
    const summary: RunSummary = {
      total: 2,
      passed: 1,
      failed: 1,
      duration_ms: 5000,
      tests: [
        {
          name: "Login Flow",
          file: "tests/login.yaml",
          status: "passed",
          duration_ms: 1000,
          steps: [{ command: "navigate", args: "/", status: "passed", duration_ms: 100 }],
          shardId: 0,
        },
        {
          name: "Login Flow",
          file: "tests/login.yaml",
          status: "failed",
          duration_ms: 1100,
          steps: [{ command: "click", args: "Submit", status: "failed", duration_ms: 200, error: "boom" }],
          shardId: 1,
        },
      ],
    };
    const payload = buildWebhookPayload(summary);
    expect(payload.tests[0]!.name).toBe("Login Flow [shard 1]");
    expect(payload.tests[0]!.shardId).toBe(0);
    expect(payload.tests[1]!.name).toBe("Login Flow [shard 2]");
    expect(payload.tests[1]!.shardId).toBe(1);
  });

  it("omits shardId field when not in a sharded run (back-compat)", () => {
    const payload = buildWebhookPayload(makeSummary(0));
    for (const f of payload.tests) {
      expect(f.shardId).toBeUndefined();
      expect(f.name).not.toContain("[shard ");
    }
  });
});

describe("WebhookReporter HTTP failure handling + LOG HYGIENE", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes custom headers in request but never logs them", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const config = makeConfig({ headers: { "X-Auth-Token": "MY-AUTH-SECRET" } });
    const reporter = new WebhookReporter(config);
    await reporter.onRunComplete(makeSummary(1));

    const callInit = fetchSpy.mock.calls[0]![1] as RequestInit | undefined;
    const sentHeaders = callInit?.headers as Record<string, string> | undefined;
    expect(sentHeaders?.["X-Auth-Token"]).toBe("MY-AUTH-SECRET");

    // 200 — no warn at all
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("logs HTTP status only on non-2xx response (no URL leak, no header leak)", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 503 }));
    const config = makeConfig({ headers: { "X-Auth-Token": "MY-AUTH-SECRET" } });
    const reporter = new WebhookReporter(config);
    await reporter.onRunComplete(makeSummary(1));
    expect(warnSpy).toHaveBeenCalledOnce();
    const argsText = warnSpy.mock.calls.flat().map(String).join(" ");
    expect(argsText).toContain("503");
    expect(argsText).not.toContain("hooks.example.com");
    expect(argsText).not.toContain("SECRET-TOKEN-XYZ");
    expect(argsText).not.toContain("MY-AUTH-SECRET");
  });

  it("strong log hygiene: TypeError whose message contains the secret URL is NEVER logged", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new TypeError(`fetch failed for ${SECRET_URL}`), { name: "TypeError" }),
    );
    const reporter = new WebhookReporter(makeConfig());
    await reporter.onRunComplete(makeSummary(1));
    const argsText = warnSpy.mock.calls.flat().map(String).join(" ");
    expect(argsText).toContain("TypeError");
    expect(argsText).not.toContain("hooks.example.com");
    expect(argsText).not.toContain("SECRET-TOKEN-XYZ");
  });

  it("does not throw when fetch rejects (graceful degradation)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const reporter = new WebhookReporter(makeConfig());
    await expect(reporter.onRunComplete(makeSummary(1))).resolves.toBeUndefined();
  });
});
