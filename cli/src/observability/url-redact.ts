/**
 * URL query-parameter redaction for token-shaped names.
 *
 * Two-tier matching, both case-insensitive after normalizing `-` and `_` to a single
 * underscore separator:
 *
 *   1. Exact match — full normalized name equals an entry in DEFAULT_REDACT_PARAMS.
 *   2. Suffix match — normalized name ends with `_<suffix>` for some entry in
 *      DEFAULT_REDACT_SUFFIXES. The leading separator is required so that names like
 *      `lookup` do not match `_key` (no separator before `key`).
 *
 * The bare `key` exact-match exists because Google APIs (Maps Static, etc.) document
 * `key=API_KEY` as the auth parameter; vendor-prefixed forms like `X-Amz-Key` are
 * caught by the suffix tier.
 *
 * Replacement uses a sentinel string `***` rather than length-preserving redaction —
 * transparency over fidelity.
 *
 * No-ops: URLs with no query string, `data:` URIs, `blob:` URIs.
 */

const REDACTED_VALUE = "***";

export const DEFAULT_REDACT_PARAMS: ReadonlySet<string> = new Set(
  [
    "token",
    "apikey",
    "api_key",
    "auth",
    "authorization",
    "secret",
    "password",
    "pwd",
    "access_token",
    "refresh_token",
    "bearer",
    "signature",
    "sig",
    "nonce",
    "csrf",
    "key",
    "private_key",
    "session",
    "sessionid",
    "session_id",
  ].map((s) => s.toLowerCase()),
);

const DEFAULT_REDACT_SUFFIXES: readonly string[] = [
  "signature",
  "credential",
  "security_token",
  "token",
  "secret",
  "key",
];

/** Normalize a query-param name: lowercase + treat `-` and `_` as equivalent (collapse to `_`). */
const normalize = (name: string): string => name.toLowerCase().replace(/-/g, "_");

const shouldRedact = (paramName: string): boolean => {
  const normalized = normalize(paramName);
  if (DEFAULT_REDACT_PARAMS.has(normalized)) return true;
  for (const suffix of DEFAULT_REDACT_SUFFIXES) {
    // require a separator before the suffix — `lookup` must not match `_key`
    if (normalized.endsWith("_" + suffix)) return true;
  }
  return false;
};

/**
 * Returns the URL with sensitive query-param values replaced by `***`.
 * Preserves the original key, fragment, host, path, and any non-sensitive query params.
 *
 * URLs without a `?` are returned unchanged. Non-HTTP(S) schemes (`data:`, `blob:`,
 * `mailto:`, etc.) are returned unchanged — they don't carry conventional query strings.
 */
export const redactUrl = (url: string): string => {
  // Fast paths
  if (typeof url !== "string" || url.length === 0) return url;
  if (!url.includes("?")) return url;
  if (url.startsWith("data:") || url.startsWith("blob:")) return url;

  // Split off fragment first so we don't lose it
  const fragmentIdx = url.indexOf("#");
  const fragment = fragmentIdx >= 0 ? url.slice(fragmentIdx) : "";
  const beforeFragment = fragmentIdx >= 0 ? url.slice(0, fragmentIdx) : url;

  const queryIdx = beforeFragment.indexOf("?");
  if (queryIdx < 0) return url;
  const prefix = beforeFragment.slice(0, queryIdx);
  const queryString = beforeFragment.slice(queryIdx + 1);

  if (queryString.length === 0) return url;

  const parts = queryString.split("&");
  let mutated = false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const eqIdx = part.indexOf("=");
    const rawName = eqIdx >= 0 ? part.slice(0, eqIdx) : part;
    if (rawName.length === 0) continue;
    // URL-decode the parameter name for matching (real-world params can be
    // encoded), but preserve the original encoded form on the output side
    // when the value isn't redacted.
    let decodedName: string;
    try {
      decodedName = decodeURIComponent(rawName);
    } catch {
      decodedName = rawName;
    }
    if (shouldRedact(decodedName)) {
      parts[i] = `${rawName}=${REDACTED_VALUE}`;
      mutated = true;
    }
  }

  if (!mutated) return url;
  return `${prefix}?${parts.join("&")}${fragment}`;
};

const CONSOLE_TEXT_LIMIT = 4 * 1024;
const REDACTED_TEXT = "[REDACTED]";

/** JWT-like compact tokens (header.payload.signature, base64url chunks). */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

/** `Bearer <token>` — token is 16+ url-safe chars (matches OAuth/JWT lengths). */
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}\b/gi;

/** key=value or "key":"value" forms for common credential names. `authorization`/`auth`
 *  are intentionally omitted — the BEARER_PATTERN handles `Authorization: Bearer …` more
 *  precisely; including them here would consume `Bearer` as the value and lose the prefix. */
const CREDENTIAL_KEYS = [
  "password",
  "passwd",
  "api[_-]?key",
  "secret",
  "token",
  "access[_-]?token",
  "refresh[_-]?token",
  "private[_-]?key",
  "session[_-]?id",
];
const CREDENTIAL_KV_PATTERN = new RegExp(
  String.raw`\b(${CREDENTIAL_KEYS.join("|")})\b\s*[:=]\s*("?)([^\s"&,;}]+)\2`,
  "gi",
);

const EMAIL_PATTERN = /\b[\w.+-]+@([\w-]+\.[\w.-]+)\b/g;
const URL_IN_TEXT = /(https?:\/\/[^\s'")]+)/g;

/**
 * Console-text redactor. Non-trivial because console messages are free-form text. Mask:
 *   - JWTs and Bearer tokens
 *   - common credential `key=value` / `"key":"value"` forms (value only — the key stays
 *     visible so diagnostics retain context)
 *   - email local-parts (keep the domain — useful for debugging)
 *   - URLs (delegate to `redactUrl` to scrub query-string secrets)
 *
 * After redaction, truncate to 4 KB. Default-on (Bundle 4 wires the
 * `observability.consoleRedaction` toggle). Opt-out logs a warning at startup.
 */
export const redactConsoleText = (text: string): string => {
  if (typeof text !== "string" || text.length === 0) return text;

  let out = text;
  out = out.replace(JWT_PATTERN, REDACTED_TEXT);
  out = out.replace(BEARER_PATTERN, `Bearer ${REDACTED_TEXT}`);
  out = out.replace(CREDENTIAL_KV_PATTERN, (_match, key: string, quote: string) => {
    return `${key}${quote ? "=" + quote : "="}${REDACTED_TEXT}${quote}`;
  });
  out = out.replace(EMAIL_PATTERN, (_match, domain: string) => `[EMAIL]@${domain}`);
  out = out.replace(URL_IN_TEXT, (match) => redactUrl(match));

  if (out.length > CONSOLE_TEXT_LIMIT) {
    out = out.slice(0, CONSOLE_TEXT_LIMIT) + "…";
  }
  return out;
};
