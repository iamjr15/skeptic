// AI_EXPOSED_COMMANDS used to enumerate YAML step commands the AI could suggest.
// In the TS-pivot the AI generates fixture-API calls (page.goto, click, etc.)
// instead — B5.5 rewrote every prompt that referenced this list. The constant
// is kept so historical references compile, but is no longer interpolated.
export const AI_EXPOSED_COMMANDS: readonly string[] = [];

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
// compatibility with `.replace(placeholder, value)` consumers.

// VISUAL_ASSERTION_PROMPT is fully static (no placeholders).
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

// Shared TS-spec example shown in both diff- and description-driven prompts so
// the LLM has a concrete shape to imitate. Lives outside the prefix so each
// prompt's prefix can stay 100% placeholder-free for cache-key stability.
const TS_SPEC_EXAMPLE = `\`\`\`ts
import { test, expect } from "skeptic-cli";

test("hero CTA navigates to signup", async ({ page, snapshot, screenshot }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/.+/);

  const tree = await snapshot(page);
  await tree.byRole("link", { name: "Get started" }).click();

  await expect(page).toHaveURL(/\\/signup/);
  await screenshot("after-cta-click", { fullPage: true });
});
\`\`\``;

const TS_SPEC_RULES = [
  "- Output a SINGLE TypeScript file. No markdown fences in the response, no commentary, no YAML.",
  '- The file MUST start with: import { test, expect } from "skeptic-cli";',
  '- Every action belongs inside `test("name", async ({ page, snapshot, screenshot }) => { ... })`.',
  "- Use `await page.goto(...)`, `await page.click(...)`, `await page.fill(...)`, `await page.hover(...)`, `await page.goBack()` for browser actions.",
  "- Use `await expect(page).toHaveURL(...)`, `await expect(page).toHaveTitle(...)`, and `await expect(locator).toBeVisible()` for assertions.",
  "- For ARIA-driven discovery, prefer `const tree = await snapshot(page); await tree.byRole(\"button\", { name: \"Submit\" }).click();`.",
  '- Use `await screenshot("name", { fullPage: true })` to checkpoint visual state.',
  "- Use literal string URLs in `page.goto(...)` whenever possible — coverage extraction skips template-literal and variable URLs.",
  "- Do NOT import anything other than `skeptic-cli`. Do NOT call `test.use({...})` unless absolutely required.",
  "- Selectors: prefer roles, labels, and visible text over brittle CSS.",
].join("\n");

// GENERATE_FROM_DIFF: prefix is the static intro paragraph. The suffix carries
// `Base URL: ...`, the full TS rule list, the example, and the diff body.
export const GENERATE_FROM_DIFF_STATIC_PREFIX = `You are an adversarial QA engineer generating a TypeScript end-to-end test for skeptic. Your goal is to BREAK the application as well as confirm it works. Think like a malicious user and a thorough QA engineer combined.

`;

// === CACHE BOUNDARY ===

export const generateFromDiffDynamicSuffix = (
  args: { baseUrl: string; diff: string },
): string =>
  `Base URL: ${args.baseUrl}

For the changed feature(s), produce ONE skeptic spec file that probes:
- Empty inputs and missing required fields
- Boundary values (0, -1, MAX_INT, extremely long strings >1000 chars)
- XSS strings in text inputs (e.g. <script>alert(1)</script>)
- SQL injection patterns in search/filter fields
- Double-submission (click submit twice rapidly)
- Back-button mid-flow (navigate back during multi-step processes)
- Invalid data formats (wrong email format, future dates, unicode, emoji, RTL text)
- State corruption (skip required steps, revisit completed steps)

ALSO include one happy-path \`test(...)\` that verifies the core functionality. Prefer multiple \`test(...)\` blocks in the same file over a monolithic flow.

Spec rules:
${TS_SPEC_RULES}

Example shape (follow this exactly — same imports, same fixture destructuring, same call style):
${TS_SPEC_EXAMPLE}

Respond with ONLY the TypeScript source — no fences, no prose.

Code changes:
${args.diff}`;

export const GENERATE_FROM_DIFF_PROMPT =
  GENERATE_FROM_DIFF_STATIC_PREFIX +
  generateFromDiffDynamicSuffix({ baseUrl: "{baseUrl}", diff: "{diff}" });

// GENERATE_FROM_DESCRIPTION: same shape — placeholder-free prefix, full
// suffix carrying the description, base URL, rules, and example.
export const GENERATE_FROM_DESCRIPTION_STATIC_PREFIX = `You are an adversarial QA engineer generating a TypeScript end-to-end test for skeptic from a natural-language description. Your goal is to BREAK the described feature, not just confirm it works.

`;

// === CACHE BOUNDARY ===

export const generateFromDescriptionDynamicSuffix = (
  args: { baseUrl: string; description: string },
): string =>
  `Base URL: ${args.baseUrl}

Generate a skeptic spec for: "${args.description}"

Include in the same file, as separate \`test(...)\` blocks:
1. One happy-path test verifying the core functionality.
2. One edge-case test (empty inputs, boundary values, special characters: unicode, emoji, RTL).
3. One error-path test (invalid data, missing required fields, wrong formats).
4. One abuse test (XSS payload, rapid double-clicks, or back-button mid-flow).

Spec rules:
${TS_SPEC_RULES}

Example shape (follow this exactly — same imports, same fixture destructuring, same call style):
${TS_SPEC_EXAMPLE}

Respond with ONLY the TypeScript source — no fences, no prose.`;

export const GENERATE_FROM_DESCRIPTION_PROMPT =
  GENERATE_FROM_DESCRIPTION_STATIC_PREFIX +
  generateFromDescriptionDynamicSuffix({
    baseUrl: "{baseUrl}",
    description: "{description}",
  });

// NOTE: ANALYZE_FAILURE_PROMPT is exported for future use; the live code
// path in assertion-evaluator.ts builds its own inline prompt for
// analyzeFailure rather than using this constant.
export const ANALYZE_FAILURE_PROMPT = `You are a QA engineer analyzing a test failure.

This test step failed:
Command: {command}
Args: {args}
Error: {error}

A screenshot of the page state at the time of failure is attached.

Analyze the screenshot and the error to determine:
1. What likely went wrong
2. Whether this is a test issue or an application bug
3. Suggested fix (note: if the error mentions an ARIA ref like "@e1" being stale or not found, the fix is almost always to insert an \`await snapshot(page)\` step before the failing action)

Respond with a concise analysis (2-4 sentences).`;
