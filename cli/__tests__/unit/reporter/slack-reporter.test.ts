import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SlackReporter, buildSlackPayload } from "../../../src/reporter/slack-reporter.js";
import type { RunSummary } from "../../../src/reporter/types.js";
import type { SlackNotificationConfig } from "../../../src/config/schema.js";
import { logger } from "../../../src/utils/logger.js";

const SECRET_HOOK = "https://hooks.slack.com/services/T123/B456/SECRET-TOKEN-XYZ";

function makeConfig(overrides: Partial<SlackNotificationConfig> = {}): SlackNotificationConfig {
  return {
    webhookUrl: SECRET_HOOK,
    mention: [],
    onFailure: true,
    onSuccess: false,
    ...overrides,
  };
}

function makeSummary(failed = 0, total = 2): RunSummary {
  const passed = total - failed;
  const tests = [];
  for (let i = 0; i < passed; i++) {
    tests.push({
      name: `Pass Test ${i + 1}`,
      file: `tests/pass-${i + 1}.spec.ts`,
      status: "passed" as const,
      duration_ms: 100,
      steps: [],
      artifacts: {},
    });
  }
  for (let i = 0; i < failed; i++) {
    tests.push({
      name: `Fail Test ${i + 1}`,
      file: `tests/fail-${i + 1}.spec.ts`,
      status: "failed" as const,
      duration_ms: 200,
      steps: [{ command: "click", args: {}, status: "failed" as const, duration_ms: 50, error: "boom" }],
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

describe("SlackReporter gating", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts on failure when onFailure: true (default)", async () => {
    const reporter = new SlackReporter(makeConfig());
    await reporter.onRunComplete(makeSummary(1));
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("skips on success when onSuccess: false (default)", async () => {
    const reporter = new SlackReporter(makeConfig());
    await reporter.onRunComplete(makeSummary(0));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts on success when onSuccess: true", async () => {
    const reporter = new SlackReporter(makeConfig({ onSuccess: true }));
    await reporter.onRunComplete(makeSummary(0));
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("skips on failure when onFailure: false", async () => {
    const reporter = new SlackReporter(makeConfig({ onFailure: false }));
    await reporter.onRunComplete(makeSummary(1));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("buildSlackPayload structure", () => {
  it("sets the top-level text fallback to the header label", () => {
    const payload = buildSlackPayload(makeSummary(2), makeConfig(), undefined);
    expect(payload.text).toContain("❌");
    expect(payload.text).toContain("failed");
  });

  it("uses ✅ on pass and ❌ on fail", () => {
    const passPayload = buildSlackPayload(makeSummary(0), makeConfig(), undefined);
    const failPayload = buildSlackPayload(makeSummary(2), makeConfig(), undefined);
    expect(passPayload.text).toContain("✅");
    expect(failPayload.text).toContain("❌");
  });

  it("includes summary fields (Total/Passed/Failed/Duration)", () => {
    const payload = buildSlackPayload(makeSummary(2), makeConfig(), undefined);
    const fieldsBlock = payload.blocks.find((b) => b.type === "section" && b.fields);
    expect(fieldsBlock).toBeDefined();
    const allText = fieldsBlock!.fields!.map((f) => f.text).join("\n");
    expect(allText).toContain("*Total*");
    expect(allText).toContain("*Passed*");
    expect(allText).toContain("*Failed*");
    expect(allText).toContain("*Duration*");
  });

  it("places mentions in a mrkdwn section block (NOT in the header)", () => {
    const config = makeConfig({ mention: ["<!here>", "<@U123>"] });
    const payload = buildSlackPayload(makeSummary(1), config, undefined);

    const headerBlock = payload.blocks.find((b) => b.type === "header");
    expect(headerBlock).toBeDefined();
    expect(headerBlock!.text!.type).toBe("plain_text");
    // Mentions must NOT appear in the header (header blocks don't notify)
    expect(headerBlock!.text!.text).not.toContain("<!here>");
    expect(headerBlock!.text!.text).not.toContain("<@U123>");

    // The mrkdwn section right above the header carries the mentions
    const mentionsBlock = payload.blocks.find(
      (b) => b.type === "section" && b.text?.type === "mrkdwn" && b.text.text.includes("<!here>"),
    );
    expect(mentionsBlock).toBeDefined();
    expect(mentionsBlock!.text!.text).toContain("<!here>");
    expect(mentionsBlock!.text!.text).toContain("<@U123>");
  });

  it("top-level text includes mentions for client-side notification fallback", () => {
    const config = makeConfig({ mention: ["<!here>"] });
    const payload = buildSlackPayload(makeSummary(1), config, undefined);
    expect(payload.text).toContain("<!here>");
  });

  it("includes runUrl context block when runUrl is provided", () => {
    const payload = buildSlackPayload(makeSummary(1), makeConfig(), "https://ci.example/run/42");
    const ctx = payload.blocks.find((b) => b.type === "context");
    expect(ctx).toBeDefined();
    expect(ctx!.elements!.some((e) => e.text.includes("https://ci.example/run/42"))).toBe(true);
  });

  it("omits the runUrl context block when runUrl is undefined", () => {
    const payload = buildSlackPayload(makeSummary(1), makeConfig(), undefined);
    expect(payload.blocks.find((b) => b.type === "context")).toBeUndefined();
  });

  it("truncates failed-test list at 5 with overflow indicator", () => {
    const payload = buildSlackPayload(makeSummary(7, 8, 7), makeConfig(), undefined);
    const failedBlocks = payload.blocks.filter(
      (b) => b.type === "section" && b.text?.type === "mrkdwn" && b.text.text.includes("•"),
    );
    expect(failedBlocks).toHaveLength(1);
    const text = failedBlocks[0]!.text!.text;
    const bullets = text.split("\n").filter((l) => l.startsWith("•"));
    expect(bullets).toHaveLength(5);
    expect(text).toContain("…and 2 more");
  });

  it("appends shardId suffix to failed-test bullet under sharding", () => {
    const summary: RunSummary = {
      total: 2,
      passed: 0,
      failed: 2,
      duration_ms: 1000,
      tests: [
        {
          name: "Login Test",
          file: "tests/login.spec.ts",
          status: "failed",
          duration_ms: 200,
          steps: [{ command: "click", args: {}, status: "failed", duration_ms: 50, error: "boom" }],
          shardId: 0,
        },
        {
          name: "Login Test",
          file: "tests/login.spec.ts",
          status: "failed",
          duration_ms: 210,
          steps: [{ command: "click", args: {}, status: "failed", duration_ms: 50, error: "boom" }],
          shardId: 1,
        },
      ],
    };
    const payload = buildSlackPayload(summary, makeConfig(), undefined);
    const failedBlocks = payload.blocks.filter(
      (b) => b.type === "section" && b.text?.type === "mrkdwn" && b.text.text.includes("•"),
    );
    expect(failedBlocks).toHaveLength(1);
    const text = failedBlocks[0]!.text!.text;
    expect(text).toContain("• Login Test [shard 1]");
    expect(text).toContain("• Login Test [shard 2]");
  });
});

describe("SlackReporter HTTP failure handling + LOG HYGIENE", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs HTTP status only on non-2xx response (no URL leak)", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    const reporter = new SlackReporter(makeConfig());
    await reporter.onRunComplete(makeSummary(1));
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledOnce();
    const argsText = warnSpy.mock.calls.flat().map(String).join(" ");
    expect(argsText).toContain("500");
    expect(argsText).not.toContain("hooks.slack.com");
    expect(argsText).not.toContain("SECRET-TOKEN-XYZ");
  });

  it("strong log hygiene: TypeError whose message contains the secret URL is NEVER logged", async () => {
    // Mimics Node's actual fetch error shape — the error message includes the URL.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new TypeError(`fetch failed for ${SECRET_HOOK}`), { name: "TypeError" }),
    );
    const reporter = new SlackReporter(makeConfig());
    await reporter.onRunComplete(makeSummary(1));
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledOnce();
    const argsText = warnSpy.mock.calls.flat().map(String).join(" ");
    expect(argsText).toContain("TypeError");
    expect(argsText).not.toContain("hooks.slack.com");
    expect(argsText).not.toContain("SECRET-TOKEN-XYZ");
  });

  it("strong log hygiene: AbortError (timeout) is logged by name, not message", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error(`The user aborted a request to ${SECRET_HOOK}`), { name: "AbortError" }),
    );
    const reporter = new SlackReporter(makeConfig());
    await reporter.onRunComplete(makeSummary(1));
    const argsText = warnSpy.mock.calls.flat().map(String).join(" ");
    expect(argsText).toContain("AbortError");
    expect(argsText).not.toContain(SECRET_HOOK);
  });

  it("does not throw when fetch rejects (graceful degradation)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const reporter = new SlackReporter(makeConfig());
    await expect(reporter.onRunComplete(makeSummary(1))).resolves.toBeUndefined();
  });
});
