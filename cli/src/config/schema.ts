import { z } from "zod";
import { DEVICE_PROFILE_IDS } from "./device-profiles.js";
import { OUTPUT_DIR_DEFAULT, CONFIG_FILENAME } from "../constants.js";

/** Browser engine configuration. */
const BrowserConfigSchema = z.object({
  engine: z.enum(["chromium", "firefox", "webkit"]).default("chromium"),
  headless: z.boolean().default(true),
  slowMo: z.number().min(0).default(0),
  timeout: z.number().positive().default(30_000),
  viewport: z
    .object({
      width: z.number().min(1).default(1280),
      height: z.number().min(1).default(720),
    })
    .default({}),
  device: z
    .string()
    .refine((d) => DEVICE_PROFILE_IDS.includes(d), {
      message: `Invalid device profile. Valid profiles: ${DEVICE_PROFILE_IDS.join(", ")}`,
    })
    .optional(),
});

/** Auth configuration (cookie extraction). */
const AuthConfigSchema = z.object({
  cookies: z.boolean().default(false),
  browsers: z.array(z.string()).default([]),
});

/** Execution configuration (retries, parallelism, bail). */
const ExecutionConfigSchema = z.object({
  retries: z.number().min(0).default(0),
  bail: z.boolean().default(false),
  screenshotOnFailure: z.boolean().default(true),
  parallel: z.number().min(1).default(1),
  grep: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

/** Output configuration (reporters, output dir). */
const OutputConfigSchema = z.object({
  dir: z.string().default(OUTPUT_DIR_DEFAULT),
  reporters: z
    .array(z.enum(["console", "html", "json", "junit"]))
    .default(["console"]),
  open: z.boolean().default(false),
  verbose: z.boolean().default(false),
});

/**
 * Observability configuration. The active collector set is the union of this
 * list, reporter-aware defaults, and collectors declared by tests.
 */
const ObservabilityConfigSchema = z.object({
  collectors: z
    .array(z.enum(["performance", "network", "accessibility", "console"]))
    .default([]),
  networkCaptureLimit: z.number().int().min(0).default(500),
  duplicateWindowMs: z.number().int().positive().default(500),
  accessibilityDualEngine: z.boolean().default(false),
  accessibilityHtmlSnippetLimit: z.number().int().min(0).default(500),
  /**
   * Reporter-aware default-on policy. `passive` auto-attaches perf+net+console when an HTML
   * reporter is active. `full` also auto-attaches accessibility (with auto-audit). `none`
   * disables the policy entirely. The merge is done in `commands/test.ts` where reporter
   * formats are in scope; the registry stays reporter-agnostic.
   */
  defaultsForReports: z.enum(["none", "passive", "full"]).default("passive"),
  consoleCaptureLimit: z.number().int().min(0).default(200),
  consoleRedaction: z.boolean().default(true),
  /**
   * When true, the engine fires `AccessibilityCollector.audit()` once per test before
   * `onTestComplete`. `--observability` flips this on.
   */
  autoAccessibilityAudit: z.boolean().default(false),
  accessibilityStandard: z
    .enum(["WCAG2A", "WCAG2AA", "WCAG21A", "WCAG21AA", "WCAG22AA"])
    .default("WCAG21AA"),
  accessibilityImpacts: z
    .array(z.enum(["critical", "serious", "moderate", "minor"]))
    .optional(),
  /**
   * Per-impact-bucket cap for the `perf-trace.md` Accessibility section. The
   * full per-test `audit.md` sidecar always lists every rule regardless of
   * this cap. Default 100 covers common pages without truncation; bump it
   * higher (or to 0 for "show all in perf-trace.md") for compliance work.
   */
  accessibilityMaxRulesPerImpact: z.number().int().min(0).default(100),
  /** Default fullPage for screenshot steps when a step omits the option. */
  fullPageScreenshots: z.boolean().default(false),
  /** Default blank-frame mode for screenshot steps. Per-step overrides win. */
  blankFrameDetection: z.enum(["off", "warn", "fail"]).default("warn"),
});

/** Safety controls for agent-driven browser work. */
const SafetyConfigSchema = z.object({
  /**
   * Empty means unrestricted. Entries accept exact hostnames, URLs whose host is
   * used, "*" for unrestricted, or "*.example.com" for a domain and children.
   */
  allowedDomains: z.array(z.string()).default([]),
  /**
   * Optional JSON policy file, resolved relative to the working directory:
   * { "default": "allow"|"deny", "allow": ["browser_open"], "deny": [...] }.
   */
  actionPolicy: z.string().optional(),
  /**
   * Actions that require interactive confirmation. MCP/browser sessions fail
   * closed for these because there is no safe prompt channel in stdio tools.
   */
  confirmActions: z.array(z.string()).default([]),
  /** Maximum characters returned inline from agent-facing JSON/text tools. */
  maxOutputChars: z.number().int().min(0).default(120_000),
  /** Wrap inline tool output in XML-ish boundaries for prompt-injection hygiene. */
  contentBoundaries: z.boolean().default(false),
});

/** Notifications: workspace alerts on run completion. */
const NotificationTriggerBase = {
  onSuccess: z.boolean().default(false),
  onFailure: z.boolean().default(true),
};

const SlackNotificationSchema = z.object({
  webhookUrl: z.string().min(1, "notifications.slack.webhookUrl is required"),
  // `channel` intentionally omitted — modern Slack incoming webhooks bind to a single channel
  // at creation time and ignore overrides. Use a different webhook URL to target another channel.
  mention: z.array(z.string()).default([]),
  ...NotificationTriggerBase,
});

const WebhookNotificationSchema = z.object({
  url: z.string().url("notifications.webhook.url must be a valid URL"),
  headers: z.record(z.string()).default({}),
  ...NotificationTriggerBase,
});

const NotificationsSchema = z.object({
  slack: SlackNotificationSchema.optional(),
  webhook: WebhookNotificationSchema.optional(),
});

/** AI configuration. */
const AIConfigSchema = z.object({
  provider: z.enum(["gemini", "openai", "anthropic"]).default("gemini"),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  maxRequestsPerMinute: z.number().default(55),
  baseBranch: z.string().default("main"),
  excludePaths: z
    .array(z.string())
    .default(["*.env*", "secrets/", "*.key", "*.pem"]),
});

/** Top-level skeptic.config.yaml schema. */
export const skepticConfigSchema = z.object({
  url: z.string().optional(),
  tests: z.union([z.string(), z.array(z.string())]).default("tests/**/*.spec.ts"),
  browser: BrowserConfigSchema.default({}),
  auth: AuthConfigSchema.default({}),
  execution: ExecutionConfigSchema.default({}),
  output: OutputConfigSchema.default({}),
  ai: AIConfigSchema.default({}),
  observability: ObservabilityConfigSchema.default({}),
  safety: SafetyConfigSchema.default({}),
  notifications: NotificationsSchema.optional(),
  env: z.record(z.string()).default({}),
});

export type skepticConfig = z.infer<typeof skepticConfigSchema>;
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;
export type OutputConfig = z.infer<typeof OutputConfigSchema>;
export type AIConfig = z.infer<typeof AIConfigSchema>;
export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;
export type SafetyConfig = z.infer<typeof SafetyConfigSchema>;
export type SlackNotificationConfig = z.infer<typeof SlackNotificationSchema>;
export type WebhookNotificationConfig = z.infer<typeof WebhookNotificationSchema>;
export type NotificationsConfig = z.infer<typeof NotificationsSchema>;

/** The config filename — re-exported for convenience. */
export { CONFIG_FILENAME };
