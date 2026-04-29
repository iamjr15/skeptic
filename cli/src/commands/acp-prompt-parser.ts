/**
 * Heuristic regex dispatcher for ACP prompts. The B1.5 TS-pivot rewrites the
 * tool surface from YAML to TypeScript spec files: `*.yaml` → `*.spec.ts`,
 * `run_flow` → `run_test`, `validate_flow` → `validate_tests`, etc. The regex
 * shapes are otherwise unchanged so existing editor integrations keep working.
 *
 * Realpath sandboxing (lessons.md #20) lives in `acp.ts:boundResolveFlows` and
 * is invoked by the dispatcher in `acp.ts` *after* the parser returns — the
 * parser never touches the filesystem itself.
 */
export interface ToolDispatch {
  tool:
    | "run_test"
    | "validate_tests"
    | "list_tests"
    | "generate_test"
    | "list_devices"
    | "load_guidance";
  args: Record<string, unknown>;
  title: string;
}

const SPEC_PATTERN = String.raw`\S+\.spec\.[mc]?[jt]sx?`;

const RUN_SPEC_RE = new RegExp(String.raw`^\s*(?:run|test)\s+(?:test\s+)?(${SPEC_PATTERN})\s*$`, "i");
const VALIDATE_SPEC_RE = new RegExp(String.raw`^\s*validate\s+(?:tests?\s+)?(${SPEC_PATTERN})\s*$`, "i");
const RUN_TESTS_GLOB_RE =
  /^\s*(?:run|test)\s+(?:tests?\s+matching\s+)?["']?([^"']*\*[^"']*)["']?\s*$/i;
const VALIDATE_GLOB_RE = /^\s*validate\s+(?:tests?\s+matching\s+)?["']?([^"']*\*[^"']*)["']?\s*$/i;
const GENERATE_RE = /^\s*generate\s+(?:a\s+)?test\s+(?:that\s+|to\s+|for\s+)?(.+)$/i;
const LIST_TESTS_RE = /^\s*list\s+tests?\s*(.*)?$/i;
const LIST_DEV_RE = /^\s*list\s+devices?\s*$/i;
const GUIDANCE_RE = /^\s*load\s+(?:guidance\s+(?:for|on)\s+|guidance\s+)?(\w+)\s*$/i;

export function parsePromptToToolCall(prompt: string): ToolDispatch | null {
  const trimmed = prompt.trim();
  if (!trimmed) return null;

  let m: RegExpMatchArray | null;

  if ((m = trimmed.match(VALIDATE_SPEC_RE)) && m[1]) {
    return { tool: "validate_tests", args: { files: [m[1]] }, title: `Validate ${m[1]}` };
  }
  if ((m = trimmed.match(VALIDATE_GLOB_RE)) && m[1]) {
    const pattern = m[1].trim();
    return { tool: "validate_tests", args: { pattern }, title: `Validate tests matching ${pattern}` };
  }
  if ((m = trimmed.match(RUN_SPEC_RE)) && m[1]) {
    const arg = m[1];
    // A literal `.spec.ts` path that contains glob metachars (`*`, `?`) is a
    // pattern, not a single spec file. Reroute through the pattern arm so the
    // dispatcher expands the glob via boundResolveFlows.
    if (/[*?]/.test(arg)) {
      return { tool: "run_test", args: { pattern: arg }, title: `Run tests matching ${arg}` };
    }
    return { tool: "run_test", args: { file: arg }, title: `Run ${arg}` };
  }
  if ((m = trimmed.match(RUN_TESTS_GLOB_RE)) && m[1]) {
    const pattern = m[1].trim();
    return { tool: "run_test", args: { pattern }, title: `Run tests matching ${pattern}` };
  }
  if ((m = trimmed.match(GENERATE_RE)) && m[1]) {
    return {
      tool: "generate_test",
      args: { description: m[1].trim() },
      title: "Generate test",
    };
  }
  if ((m = trimmed.match(LIST_TESTS_RE))) {
    const arg = m[1]?.trim();
    return {
      tool: "list_tests",
      args: arg ? { pattern: arg } : {},
      title: "List tests",
    };
  }
  if (LIST_DEV_RE.test(trimmed)) {
    return { tool: "list_devices", args: {}, title: "List devices" };
  }
  if ((m = trimmed.match(GUIDANCE_RE)) && m[1]) {
    return {
      tool: "load_guidance",
      args: { domain: m[1] },
      title: `Load ${m[1]} guidance`,
    };
  }

  return null;
}

export function helpMessage(): string {
  return [
    "skeptic recognizes these prompt shapes:",
    "  run tests/login.spec.ts                — execute a single spec file",
    "  test tests/login.spec.ts               — alias for `run`",
    "  run tests matching tests/**/*.spec.ts  — execute every spec matching the glob",
    "  validate tests/login.spec.ts           — typecheck + import-only sanity (no run)",
    "  generate a test that <desc>            — produce a *.spec.ts via the configured AI provider",
    "  list tests                             — list specs in the project",
    "  list tests tests/**/*.spec.ts          — list specs matching a glob",
    "  list devices                           — list available device profiles",
    "  load guidance for <domain>             — load domain-specific testing guidance",
  ].join("\n");
}
