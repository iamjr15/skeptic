import { describe, it, expect } from "vitest";
import { skepticConfigSchema } from "../../../src/config/schema.js";

describe("notifications schema", () => {
  it("accepts valid slack-only config", () => {
    const parsed = skepticConfigSchema.parse({
      notifications: {
        slack: { webhookUrl: "https://hooks.slack.com/services/T/B/X" },
      },
    });
    expect(parsed.notifications?.slack?.webhookUrl).toBe("https://hooks.slack.com/services/T/B/X");
    expect(parsed.notifications?.slack?.onFailure).toBe(true);
    expect(parsed.notifications?.slack?.onSuccess).toBe(false);
    expect(parsed.notifications?.slack?.mention).toEqual([]);
    expect(parsed.notifications?.webhook).toBeUndefined();
  });

  it("accepts valid webhook-only config", () => {
    const parsed = skepticConfigSchema.parse({
      notifications: {
        webhook: { url: "https://example.com/hook" },
      },
    });
    expect(parsed.notifications?.webhook?.url).toBe("https://example.com/hook");
    expect(parsed.notifications?.webhook?.onFailure).toBe(true);
    expect(parsed.notifications?.webhook?.onSuccess).toBe(false);
    expect(parsed.notifications?.webhook?.headers).toEqual({});
    expect(parsed.notifications?.slack).toBeUndefined();
  });

  it("accepts both slack and webhook together", () => {
    const parsed = skepticConfigSchema.parse({
      notifications: {
        slack: {
          webhookUrl: "https://hooks.slack.com/services/T/B/X",
          mention: ["<!here>", "<@U123>"],
          onSuccess: true,
        },
        webhook: {
          url: "https://example.com/hook",
          headers: { "X-Custom": "v1" },
          onFailure: false,
        },
      },
    });
    expect(parsed.notifications?.slack?.mention).toEqual(["<!here>", "<@U123>"]);
    expect(parsed.notifications?.slack?.onSuccess).toBe(true);
    expect(parsed.notifications?.webhook?.headers).toEqual({ "X-Custom": "v1" });
    expect(parsed.notifications?.webhook?.onFailure).toBe(false);
  });

  it("treats notifications as optional (undefined when omitted)", () => {
    const parsed = skepticConfigSchema.parse({});
    expect(parsed.notifications).toBeUndefined();
  });

  it("rejects slack config missing webhookUrl", () => {
    const result = skepticConfigSchema.safeParse({
      notifications: { slack: { mention: ["<!here>"] } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "notifications.slack.webhookUrl")).toBe(true);
    }
  });

  it("rejects empty webhookUrl", () => {
    const result = skepticConfigSchema.safeParse({
      notifications: { slack: { webhookUrl: "" } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects webhook with non-URL `url`", () => {
    const result = skepticConfigSchema.safeParse({
      notifications: { webhook: { url: "not-a-url" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "notifications.webhook.url")).toBe(true);
    }
  });

  it("does not accept a `channel` field on slack (not part of schema)", () => {
    const parsed = skepticConfigSchema.parse({
      notifications: {
        slack: {
          webhookUrl: "https://hooks.slack.com/services/T/B/X",
          channel: "#extra-field",
        },
      },
    });
    // zod strips unknown keys by default — the channel field never makes it into the parsed config.
    expect((parsed.notifications?.slack as Record<string, unknown> | undefined)?.["channel"]).toBeUndefined();
  });
});
