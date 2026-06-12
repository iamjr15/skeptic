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
 * Redact sensitive values inside an `&`-joined `key=value` param string (a query string or
 * an OAuth-style fragment). Returns the rebuilt string and whether anything changed.
 */
const redactParamString = (paramString: string): { result: string; mutated: boolean } => {
  const parts = paramString.split("&");
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
  return { result: parts.join("&"), mutated };
};

/**
 * Returns the URL with sensitive values replaced by `***`, in BOTH the query string and the
 * URL fragment. Preserves the original key, host, path, and any non-sensitive params.
 *
 * The fragment is scrubbed because OAuth implicit-flow callbacks carry credentials there
 * (`#access_token=…&token_type=bearer`); the fragment is treated as a param string only when
 * it contains `=` (so plain anchors like `#section` are untouched).
 *
 * URLs with neither a `?` query nor a `key=value` fragment are returned unchanged. Non-HTTP(S)
 * schemes (`data:`, `blob:`) are returned unchanged — they don't carry conventional params.
 */
export const redactUrl = (url: string): string => {
  // Fast paths
  if (typeof url !== "string" || url.length === 0) return url;
  if (url.startsWith("data:") || url.startsWith("blob:")) return url;

  // Split off fragment first so we don't lose it.
  const fragmentIdx = url.indexOf("#");
  const beforeFragment = fragmentIdx >= 0 ? url.slice(0, fragmentIdx) : url;
  const fragment = fragmentIdx >= 0 ? url.slice(fragmentIdx + 1) : "";

  const queryIdx = beforeFragment.indexOf("?");
  const fragmentHasParams = fragment.includes("=");
  if (queryIdx < 0 && !fragmentHasParams) return url;

  let mutated = false;

  // --- query string ---
  let rebuiltBeforeFragment = beforeFragment;
  if (queryIdx >= 0) {
    const prefix = beforeFragment.slice(0, queryIdx);
    const queryString = beforeFragment.slice(queryIdx + 1);
    if (queryString.length > 0) {
      const r = redactParamString(queryString);
      if (r.mutated) {
        rebuiltBeforeFragment = `${prefix}?${r.result}`;
        mutated = true;
      }
    }
  }

  // --- fragment (OAuth implicit-flow tokens) ---
  let rebuiltFragment = fragmentIdx >= 0 ? `#${fragment}` : "";
  if (fragmentHasParams) {
    const r = redactParamString(fragment);
    if (r.mutated) {
      rebuiltFragment = `#${r.result}`;
      mutated = true;
    }
  }

  if (!mutated) return url;
  return `${rebuiltBeforeFragment}${rebuiltFragment}`;
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
// Matches `key=value`, `key: value`, and quoted JSON-body forms `"key":"value"` /
// `'key':'value'`. Groups: (1) optional key quote, (2) key, (3) separator incl. spaces,
// (4) optional value quote, (5) value. The back-references (\1, \4) keep open/close quotes
// balanced so we don't straddle adjacent JSON fields. The value class stops at quotes,
// whitespace, and JSON/query delimiters so only the secret is masked.
const CREDENTIAL_KV_PATTERN = new RegExp(
  String.raw`(["']?)\b(${CREDENTIAL_KEYS.join("|")})\b\1(\s*[:=]\s*)(["']?)([^\s"'&,;}]+)\4`,
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
  out = out.replace(
    CREDENTIAL_KV_PATTERN,
    (_match, keyQuote: string, key: string, sep: string, valueQuote: string) =>
      // Preserve the original key wrapping, separator, and value-quote style so JSON stays
      // well-formed (`"password":"[REDACTED]"`) and `k=v` stays `k=[REDACTED]`.
      `${keyQuote}${key}${keyQuote}${sep}${valueQuote}${REDACTED_TEXT}${valueQuote}`,
  );
  out = out.replace(EMAIL_PATTERN, (_match, domain: string) => `[EMAIL]@${domain}`);
  out = out.replace(URL_IN_TEXT, (match) => redactUrl(match));

  if (out.length > CONSOLE_TEXT_LIMIT) {
    out = out.slice(0, CONSOLE_TEXT_LIMIT) + "…";
  }
  return out;
};
