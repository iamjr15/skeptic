import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BrowserMcpSession } from "./browser-session.js";
import { errorToolResult, imageToolResult, jsonToolResult } from "./results.js";

interface RegisterBrowserMcpToolsOptions {
  cwd: string;
}

type Handler<TArgs> = (args: TArgs) => Promise<CallToolResult>;

const waitUntilSchema = z
  .enum(["load", "domcontentloaded", "networkidle", "commit"])
  .optional();

const standardSchema = z
  .enum(["WCAG2A", "WCAG2AA", "WCAG21A", "WCAG21AA", "WCAG22AA"])
  .optional();

const impactSchema = z.enum(["critical", "serious", "moderate", "minor"]);

export const registerBrowserMcpTools = (
  server: McpServer,
  options: RegisterBrowserMcpToolsOptions,
): void => {
  const session = new BrowserMcpSession(options.cwd);
  const safe = <TArgs>(handler: Handler<TArgs>): Handler<TArgs> =>
    async (args: TArgs): Promise<CallToolResult> => {
      try {
        return await handler(args);
      } catch (err) {
        return errorToolResult(err, session.safety);
      }
    };

  server.registerTool(
    "browser_open",
    {
      title: "Open a browser page",
      description:
        "Launch or reuse a Playwright browser session and navigate to a URL. " +
        "Honors skeptic.config.yaml browser/auth/safety settings, including allowedDomains and cookie injection.",
      inputSchema: {
        url: z.string().url(),
        browser: z.enum(["chromium", "firefox", "webkit"]).optional(),
        headed: z.boolean().optional(),
        waitUntil: waitUntilSchema,
        cookies: z.boolean().optional(),
        snapshot: z
          .boolean()
          .optional()
          .describe("Also return a compact interactive ARIA snapshot after navigation."),
      },
    },
    safe(async (args) => {
      const info = await session.open(args);
      if (args.snapshot) {
        return jsonToolResult(
          { ...info, snapshot: await session.snapshot({ interactive: true, compact: true }) },
          session.safety,
          "skeptic-browser-open",
        );
      }
      return jsonToolResult(info, session.safety, "skeptic-browser-open");
    }),
  );

  server.registerTool(
    "browser_snapshot",
    {
      title: "Capture an ARIA snapshot",
      description:
        "Return Skeptic's agent-browser-compatible ARIA snapshot with stable [ref=eN] handles, " +
        "cursor-interactive fallbacks, stats, and ref metadata for follow-up actions.",
      inputSchema: {
        interactive: z.boolean().optional(),
        compact: z.boolean().optional(),
        selector: z.string().optional(),
        fullPage: z.boolean().optional(),
      },
    },
    safe(async (args) =>
      jsonToolResult(
        await session.snapshot(args),
        session.safety,
        "skeptic-browser-snapshot",
      ),
    ),
  );

  server.registerTool(
    "browser_playwright",
    {
      title: "Run Playwright code",
      description:
        "Execute async JavaScript with globals page, context, browser, and ref('@eN'). " +
        "The return value is safely serialized inline and written to a resultFile for large outputs.",
      inputSchema: {
        code: z
          .string()
          .describe("Async-capable JavaScript body. Use `return` to provide a result."),
        snapshotAfter: z.boolean().optional(),
      },
    },
    safe(async (args) =>
      jsonToolResult(
        await session.runPlaywright(args),
        session.safety,
        "skeptic-browser-playwright",
      ),
    ),
  );

  server.registerTool(
    "browser_screenshot",
    {
      title: "Capture a screenshot",
      description:
        "Capture a PNG screenshot, an annotated screenshot with numbered ref badges, or a snapshot-only response. " +
        "PNG results include the image content and the saved artifact path.",
      inputSchema: {
        mode: z.enum(["screenshot", "annotated", "snapshot"]).optional(),
        fullPage: z.boolean().optional(),
        selector: z.string().optional(),
      },
    },
    safe(async (args) => {
      const result = await session.screenshot(args);
      if (args.mode === "snapshot") {
        return jsonToolResult(result, session.safety, "skeptic-browser-snapshot");
      }
      const filePath = result["path"];
      if (typeof filePath !== "string") {
        return jsonToolResult(result, session.safety, "skeptic-browser-screenshot");
      }
      return imageToolResult(filePath, result, session.safety);
    }),
  );

  server.registerTool(
    "browser_console_logs",
    {
      title: "Read browser console logs",
      description:
        "Return captured console messages, with Skeptic's URL/secret redaction enabled by config. " +
        "Can filter by message type and clear the read cursor after returning.",
      inputSchema: {
        type: z.string().optional(),
        clear: z.boolean().optional(),
      },
    },
    safe(async (args) =>
      jsonToolResult(
        await session.consoleLogs(args),
        session.safety,
        "skeptic-browser-console",
      ),
    ),
  );

  server.registerTool(
    "browser_network_requests",
    {
      title: "Read browser network requests",
      description:
        "Return captured network requests plus automatic issue detection for HTTP failures, network failures, " +
        "duplicate requests, mixed content, and CORS-like failures.",
      inputSchema: {
        method: z.string().optional(),
        url: z.string().optional(),
        resourceType: z.string().optional(),
        clear: z.boolean().optional(),
      },
    },
    safe(async (args) =>
      jsonToolResult(
        await session.networkRequests(args),
        session.safety,
        "skeptic-browser-network",
      ),
    ),
  );

  server.registerTool(
    "browser_performance_metrics",
    {
      title: "Collect browser performance metrics",
      description:
        "Return Core Web Vitals, navigation timing, LoAF/script attribution, resource timing, network issues, " +
        "console summary, and a perf-trace.md artifact path.",
      inputSchema: {},
    },
    safe(async () =>
      jsonToolResult(
        await session.performanceMetrics(),
        session.safety,
        "skeptic-browser-performance",
      ),
    ),
  );

  server.registerTool(
    "browser_accessibility_audit",
    {
      title: "Run accessibility audit",
      description:
        "Run axe-core, and IBM Equal Access when configured and installed, against the current page. " +
        "Returns sorted violations with CSS targets, HTML snippets, WCAG standard, and engine metadata.",
      inputSchema: {
        selector: z.string().optional(),
        exclude: z.array(z.string()).optional(),
        standard: standardSchema,
        impacts: z.array(impactSchema).optional(),
      },
    },
    safe(async (args) =>
      jsonToolResult(
        await session.accessibilityAudit(args),
        session.safety,
        "skeptic-browser-a11y",
      ),
    ),
  );

  server.registerTool(
    "browser_close",
    {
      title: "Close the browser session",
      description: "Close the MCP-owned browser session and release collectors/artifacts.",
      inputSchema: {},
    },
    safe(async () =>
      jsonToolResult(await session.close(), session.safety, "skeptic-browser-close"),
    ),
  );
};
