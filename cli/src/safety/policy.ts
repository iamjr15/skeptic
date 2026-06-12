import * as fs from "node:fs";
import * as path from "node:path";
import type { BrowserContext, Route } from "playwright";
import type { SafetyConfig } from "../config/schema.js";

type ActionDecision = "allow" | "deny";

export interface ActionPolicy {
  default?: ActionDecision;
  allow: string[];
  deny: string[];
  confirm: string[];
}

export interface SafetyRuntime {
  readonly allowedDomains: string[];
  readonly policy: ActionPolicy;
  readonly sourcePath?: string;
}

const DEFAULT_POLICY: ActionPolicy = {
  default: "allow",
  allow: [],
  deny: [],
  confirm: [],
};

const normalizeActionList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];

export const loadSafetyRuntime = (
  cwd: string,
  config: SafetyConfig,
): SafetyRuntime => {
  let policy: ActionPolicy = { ...DEFAULT_POLICY };
  let sourcePath: string | undefined;

  if (config.actionPolicy) {
    sourcePath = path.resolve(cwd, config.actionPolicy);
    const parsed = JSON.parse(fs.readFileSync(sourcePath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`safety.actionPolicy must contain a JSON object: ${sourcePath}`);
    }
    const raw = parsed as Record<string, unknown>;
    const rawDefault = raw["default"];
    policy = {
      default: rawDefault === "deny" ? "deny" : "allow",
      allow: normalizeActionList(raw["allow"]),
      deny: normalizeActionList(raw["deny"]),
      confirm: normalizeActionList(raw["confirm"]),
    };
  }

  return {
    allowedDomains: config.allowedDomains,
    policy: {
      ...policy,
      confirm: [...new Set([...policy.confirm, ...config.confirmActions])],
    },
    ...(sourcePath ? { sourcePath } : {}),
  };
};

const actionMatches = (pattern: string, action: string): boolean => {
  if (pattern === "*" || pattern === action) return true;
  if (pattern.endsWith("*")) return action.startsWith(pattern.slice(0, -1));
  return false;
};

export const assertActionAllowed = (
  runtime: SafetyRuntime,
  action: string,
): void => {
  if (runtime.policy.deny.some((pattern) => actionMatches(pattern, action))) {
    throw new Error(`safety policy denied action "${action}"`);
  }
  if (runtime.policy.confirm.some((pattern) => actionMatches(pattern, action))) {
    throw new Error(
      `safety policy requires confirmation for "${action}", but MCP browser tools are non-interactive`,
    );
  }
  const explicitlyAllowed = runtime.policy.allow.some((pattern) =>
    actionMatches(pattern, action),
  );
  if (runtime.policy.default === "deny" && !explicitlyAllowed) {
    throw new Error(`safety policy default-denied action "${action}"`);
  }
};

const normalizeDomainPattern = (pattern: string): string => {
  const trimmed = pattern.trim().toLowerCase();
  if (!trimmed) return "";
  if (trimmed === "*") return "*";
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return trimmed.replace(/^\.+/, "").replace(/\/.*$/, "");
  }
};

const hostnameMatchesPattern = (hostname: string, rawPattern: string): boolean => {
  const pattern = normalizeDomainPattern(rawPattern);
  if (!pattern || pattern === "*") return pattern === "*";
  const host = hostname.toLowerCase();
  if (pattern.startsWith("*.")) {
    const root = pattern.slice(2);
    return host === root || host.endsWith(`.${root}`);
  }
  return host === pattern;
};

/**
 * Non-http(s) schemes (`file:`, `chrome:`, `data:`, `blob:`, …) are denied by
 * default whenever an allowlist is active — a domain allowlist says nothing
 * about local-file or browser-internal access, so leaving them open would let
 * `file:///etc/passwd` bypass the allowlist entirely. A scheme only passes when
 * the catch-all `*` is allowlisted, or when an entry explicitly names the same
 * scheme (e.g. `file://`, `chrome://settings`). A bare hostname entry never
 * authorizes a non-http scheme.
 */
const schemeExplicitlyAllowed = (parsed: URL, allowedDomains: string[]): boolean =>
  allowedDomains.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) return false;
    if (pattern === "*") return true;
    const colon = pattern.indexOf(":");
    if (colon === -1) return false;
    if (`${pattern.slice(0, colon)}:` !== parsed.protocol) return false;
    const rest = pattern.slice(colon + 1).replace(/^\/+/, "");
    if (!rest) return true;
    const host = rest.replace(/[/?#].*$/, "");
    return host === "" || host === parsed.hostname.toLowerCase();
  });

export const isUrlAllowed = (targetUrl: string, allowedDomains: string[]): boolean => {
  if (allowedDomains.length === 0) return true;
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return allowedDomains.some((pattern) => hostnameMatchesPattern(parsed.hostname, pattern));
  }
  return schemeExplicitlyAllowed(parsed, allowedDomains);
};

export const assertUrlAllowed = (targetUrl: string, allowedDomains: string[]): void => {
  if (!isUrlAllowed(targetUrl, allowedDomains)) {
    throw new Error(
      `safety.allowedDomains blocked navigation/request to ${targetUrl}. Allowed: ${allowedDomains.join(", ") || "(none)"}`,
    );
  }
};

export const installDomainSafety = async (
  context: BrowserContext,
  allowedDomains: string[],
): Promise<void> => {
  if (allowedDomains.length === 0) return;

  await context.route("**/*", async (route: Route) => {
    const url = route.request().url();
    if (isUrlAllowed(url, allowedDomains)) {
      await route.continue();
    } else {
      await route.abort("blockedbyclient");
    }
  });

  await context.addInitScript({
    content: `
(() => {
  const allowed = ${JSON.stringify(allowedDomains)};
  const matches = (url) => {
    try {
      const parsed = new URL(url, location.href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return true;
      return allowed.some((pattern) => {
        const p = String(pattern).trim().toLowerCase();
        if (!p) return false;
        if (p === "*") return true;
        let host = p;
        try { host = new URL(p).hostname.toLowerCase(); } catch { host = p.replace(/^\\.+/, "").replace(/\\/.*$/, ""); }
        const target = parsed.hostname.toLowerCase();
        if (host.startsWith("*.")) {
          const root = host.slice(2);
          return target === root || target.endsWith("." + root);
        }
        return target === host;
      });
    } catch { return false; }
  };
  const block = (kind, url) => {
    if (!matches(url)) throw new Error("skeptic safety.allowedDomains blocked " + kind + " to " + url);
  };
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    block("WebSocket", url);
    return protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols);
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  const OriginalEventSource = window.EventSource;
  if (OriginalEventSource) {
    window.EventSource = function(url, init) {
      block("EventSource", url);
      return new OriginalEventSource(url, init);
    };
    window.EventSource.prototype = OriginalEventSource.prototype;
  }
  const originalBeacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
  if (originalBeacon) {
    navigator.sendBeacon = (url, data) => {
      block("sendBeacon", url);
      return originalBeacon(url, data);
    };
  }
})();
`,
  });
};
