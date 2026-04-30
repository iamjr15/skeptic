// AI_EXPOSED_COMMANDS used to enumerate YAML step commands the AI could suggest.
// In the TS-pivot the AI generates fixture-API calls (page.goto, click, etc.)
// instead — B5.5 rewrites every prompt that referenced this list. Until then
// the placeholder keeps prompts.ts compiling without dragging in YAML schema.
export const AI_EXPOSED_COMMANDS: readonly string[] = [];
const AI_COMMANDS_LIST = "(see skeptic-cli fixture API)";

// === CACHE BOUNDARY MARKER ===
//
// Each cacheable prompt is split into two exports:
//   - `<NAME>_STATIC_PREFIX` — the constant text up to (but not including)
//     the first dynamic placeholder. Contains ZERO placeholders, so when we
//     start passing it to the provider's cache mechanism the cache key is
//     stable across calls.
//   - `<name>DynamicSuffix(args)` — a function returning the entire
//     remainder of the prompt with every placeholder substituted.
//
// The combined `<NAME>_PROMPT` export is retained for backwards
// compatibility with `.replace(placeholder, value)` consumers
// (assertion-evaluator.ts, flow-generator.ts). Concatenating the prefix
// with the suffix (called with literal placeholder strings) reproduces the
// exact byte sequence the consumers know today.
//
// Today's prompts sit below the 1024-token minimum for explicit prompt
// caching on Gemini (`cachedContents`) and Anthropic
// (`cache_control: { type: "ephemeral" }`), so wiring those APIs would be
// a no-op. OpenAI's automatic caching kicks in at >1024 tokens. When
// prompts grow (e.g. when guidance bodies start being included verbatim),
// the AI clients can switch to passing `_STATIC_PREFIX` to the cache
// mechanism while still appending the dynamic suffix per call. The
// placeholder-free prefix invariant guarantees a single cache key per
// prompt — this is the property the structural split exists to preserve.

// VISUAL_ASSERTION_PROMPT is fully static (no placeholders). The
// `STATIC_PREFIX` re-export keeps the contract uniform; no `dynamicSuffix`
// function is needed.
export const VISUAL_ASSERTION_PROMPT = `You are a QA engineer reviewing screenshots from an automated E2E test.

Analyze the screenshot for potential visual issues:
- Layout problems (overlapping elements, broken alignment, unexpected spacing)
- Missing or broken elements (images not loaded, icons missing, empty containers)
- Text rendering issues (truncated text, wrong font size, unreadable text)
- Color and contrast problems (text hard to read, poor contrast ratios)
- Responsive issues (content overflowing, elements cut off)
- Empty states shown unexpectedly
- Error messages or warning banners visible
- Console errors visible in the UI

Respond with ONLY a valid JSON object (no markdown fences):
{
  "passed": true/false,
  "confidence": 0.0-1.0,
  "issues": [
    {
      "type": "layout|rendering|content|accessibility|error",
      "severity": "low|medium|high|critical",
      "description": "Brief description of the issue"
    }
  ],
  "summary": "One-line summary of the overall assessment"
}

If the page looks correct with no issues, return passed: true with an empty issues array.`;

export const VISUAL_ASSERTION_STATIC_PREFIX = VISUAL_ASSERTION_PROMPT;

// ASSERT_WITH_AI: prefix ends just before the opening quote of the
// assertion line. Single-placeholder prompt; suffix takes (assertion).
export const ASSERT_WITH_AI_STATIC_PREFIX = `You are a QA engineer reviewing a screenshot from an automated E2E test.

The user asserts: `;

// === CACHE BOUNDARY ===

export const assertWithAiDynamicSuffix = (assertion: string): string =>
  `"${assertion}"

Examine the screenshot and determine if this assertion passes or fails.
Consider both the literal meaning and the intent behind the assertion.

Respond with ONLY a valid JSON object (no markdown fences):
{
  "passed": true/false,
  "confidence": 0.0-1.0,
  "issues": [
    {
      "type": "assertion",
      "severity": "high",
      "description": "Why the assertion failed (only if it failed)"
    }
  ],
  "summary": "One-line explanation of the result"
}`;

export const ASSERT_WITH_AI_PROMPT =
  ASSERT_WITH_AI_STATIC_PREFIX + assertWithAiDynamicSuffix("{assertion}");

// EXTRACT_TEXT: prefix ends just before the opening quote of the query
// line. Single-placeholder prompt; suffix takes (query).
export const EXTRACT_TEXT_STATIC_PREFIX = `You are a data extraction assistant analyzing a screenshot.

Extract the following from the screenshot: `;

// === CACHE BOUNDARY ===

export const extractTextDynamicSuffix = (query: string): string =>
  `"${query}"

Return ONLY the extracted text, nothing else. If the requested information is not visible in the screenshot, return an empty string.`;

export const EXTRACT_TEXT_PROMPT =
  EXTRACT_TEXT_STATIC_PREFIX + extractTextDynamicSuffix("{query}");

// GENERATE_FROM_DIFF: three placeholder occurrences (`{baseUrl}` in the
// intro and again inside the YAML example, plus `{diff}` at the end). The
// prefix MUST end before the first `{baseUrl}` so the cache key doesn't
// depend on the project URL. The suffix carries everything from
// `Base URL:` onward, substituting both placeholders.
export const GENERATE_FROM_DIFF_STATIC_PREFIX = `You are an adversarial QA engineer generating E2E test flows from code changes. Your goal is to BREAK the application, not just confirm it works. Think like a malicious user and a thorough QA engineer combined.

`;

// === CACHE BOUNDARY ===

export const generateFromDiffDynamicSuffix = (
  args: { baseUrl: string; diff: string },
): string =>
  `Base URL: ${args.baseUrl}

For each changed feature, generate test flows that probe:
- Empty inputs and missing required fields
- Boundary values (0, -1, MAX_INT, extremely long strings >1000 chars)
- XSS strings in text inputs (e.g. <script>alert(1)</script>)
- SQL injection patterns in search/filter fields
- Double-submission (click submit twice rapidly)
- Back-button mid-flow (navigate back during multi-step processes)
- Invalid data formats (wrong email format, future dates, unicode, emoji, RTL text)
- State corruption (skip required steps, revisit completed steps)

ALSO generate one happy-path flow verifying the core functionality.
Prioritize error handling and edge cases over happy-path tests.

The YAML format uses a two-document structure with --- delimiter. The first document is metadata, the second is a step array:
\`\`\`yaml
url: ${args.baseUrl}
name: Flow Name
description: What this flow tests
tags: [smoke]
---
- navigate: /path
- click: "Button text or selector"
- type: "text to type"
- assertVisible: "expected text"
- back: true
- doubleClick: "selector"
- hover: "selector"
- screenshot: screenshot-name
\`\`\`

Available commands: ${AI_COMMANDS_LIST}

Generate focused, adversarial test flows that cover and stress-test the changed functionality. Each flow should be a complete, runnable test.

Use bare-string selectors (text content, labels, test-ids). Relational selector objects (with fields like below/above/childOf) are reserved for human-authored flows — do not generate them.

Respond with ONLY the YAML content. If generating multiple flows, separate them with a blank line and then a line containing only "===FLOW_SEPARATOR===".

Code changes:
${args.diff}`;

export const GENERATE_FROM_DIFF_PROMPT =
  GENERATE_FROM_DIFF_STATIC_PREFIX +
  generateFromDiffDynamicSuffix({ baseUrl: "{baseUrl}", diff: "{diff}" });

// GENERATE_FROM_DESCRIPTION: same shape as GENERATE_FROM_DIFF — three
// placeholder occurrences (`{baseUrl}` twice, `{description}` once). Prefix
// is the intro paragraph; suffix carries the rest with both fields
// substituted.
export const GENERATE_FROM_DESCRIPTION_STATIC_PREFIX = `You are an adversarial QA engineer generating E2E test flows from a description. Your goal is to BREAK the described feature, not just confirm it works.

`;

// === CACHE BOUNDARY ===

export const generateFromDescriptionDynamicSuffix = (
  args: { baseUrl: string; description: string },
): string =>
  `Base URL: ${args.baseUrl}

Generate test flows for: "${args.description}"

Include:
1. One happy-path flow verifying the core functionality
2. Edge case flows: empty inputs, boundary values, special characters (unicode, emoji, RTL)
3. Error path flows: invalid data, missing required fields, wrong formats
4. Abuse flows: XSS attempts (<script>alert(1)</script>), rapid double-clicks, back-button navigation mid-flow

The YAML format uses a two-document structure with --- delimiter:
\`\`\`yaml
url: ${args.baseUrl}
name: Flow Name
description: What this flow tests
tags: [smoke]
---
- navigate: /path
- click: "Button text or selector"
- type: "text to type"
- assertVisible: "expected text"
- back: true
- doubleClick: "selector"
- hover: "selector"
- screenshot: result
\`\`\`

Available commands: ${AI_COMMANDS_LIST}

Use descriptive selectors (text content, labels, test-ids) rather than brittle CSS selectors. Stick to bare-string selectors; relational selector objects (below/above/childOf/etc.) are reserved for human-authored flows.

Respond with ONLY the YAML content for a single flow (one metadata document + one steps document, separated by ---). Do NOT generate multiple flows.`;

export const GENERATE_FROM_DESCRIPTION_PROMPT =
  GENERATE_FROM_DESCRIPTION_STATIC_PREFIX +
  generateFromDescriptionDynamicSuffix({
    baseUrl: "{baseUrl}",
    description: "{description}",
  });

// NOTE: ANALYZE_FAILURE_PROMPT is exported for future use; the live code
// path in assertion-evaluator.ts builds its own inline prompt for
// analyzeFailure rather than using this constant. Either wire this in (and
// delete the inline version) or remove the export. Out of scope for the
// cache-boundary structural split.
export const ANALYZE_FAILURE_PROMPT = `You are a QA engineer analyzing a test failure.

This test step failed:
Command: {command}
Args: {args}
Error: {error}

A screenshot of the page state at the time of failure is attached.

Analyze the screenshot and the error to determine:
1. What likely went wrong
2. Whether this is a test issue or an application bug
3. Suggested fix (note: if the error mentions an ARIA ref like "@e1" being stale or not found, the fix is almost always to insert an \`- ariaSnapshot: true\` step before the failing action)

Respond with a concise analysis (2-4 sentences).`;
