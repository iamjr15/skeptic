import { describe, expect, it } from "vitest";
import {
  parsePromptToToolCall,
  helpMessage,
  type ToolDispatch,
} from "../../../src/commands/acp-prompt-parser.js";

const dispatch = (prompt: string): ToolDispatch | null => parsePromptToToolCall(prompt);

describe("acp-prompt-parser (B1.5: spec-glob)", () => {
  it("returns null for empty / whitespace prompts", () => {
    expect(dispatch("")).toBeNull();
    expect(dispatch("   ")).toBeNull();
  });

  it("routes single .spec.ts paths to run_test{file}", () => {
    expect(dispatch("run tests/login.spec.ts")).toEqual({
      tool: "run_test",
      args: { file: "tests/login.spec.ts" },
      title: "Run tests/login.spec.ts",
    });
    expect(dispatch("test tests/login.spec.ts")).toMatchObject({
      tool: "run_test",
      args: { file: "tests/login.spec.ts" },
    });
  });

  it("routes glob-bearing .spec.ts paths through run_test{pattern}", () => {
    expect(dispatch("run tests/**/*.spec.ts")).toEqual({
      tool: "run_test",
      args: { pattern: "tests/**/*.spec.ts" },
      title: "Run tests matching tests/**/*.spec.ts",
    });
  });

  it("routes 'run tests matching <glob>' phrasing to run_test", () => {
    expect(dispatch("run tests matching 'tests/**/*.spec.ts'")).toMatchObject({
      tool: "run_test",
      args: { pattern: "tests/**/*.spec.ts" },
    });
  });

  it("routes 'validate <spec>' to validate_tests{files: [..]}", () => {
    expect(dispatch("validate tests/login.spec.ts")).toEqual({
      tool: "validate_tests",
      args: { files: ["tests/login.spec.ts"] },
      title: "Validate tests/login.spec.ts",
    });
  });

  it("routes 'validate tests matching <glob>' to validate_tests{pattern}", () => {
    expect(dispatch("validate tests matching tests/**/*.spec.ts")).toMatchObject({
      tool: "validate_tests",
      args: { pattern: "tests/**/*.spec.ts" },
    });
  });

  it("routes 'generate a test that <desc>' to generate_test{description}", () => {
    expect(dispatch("generate a test that smoke-tests the homepage")).toEqual({
      tool: "generate_test",
      args: { description: "smoke-tests the homepage" },
      title: "Generate test",
    });
  });

  it("routes 'list tests' bare and with pattern", () => {
    expect(dispatch("list tests")).toEqual({
      tool: "list_tests",
      args: {},
      title: "List tests",
    });
    expect(dispatch("list tests tests/**/*.spec.ts")).toMatchObject({
      tool: "list_tests",
      args: { pattern: "tests/**/*.spec.ts" },
    });
  });

  it("routes 'list devices' to list_devices", () => {
    expect(dispatch("list devices")).toEqual({
      tool: "list_devices",
      args: {},
      title: "List devices",
    });
  });

  it("routes 'load guidance for <domain>' to load_guidance", () => {
    expect(dispatch("load guidance for accessibility")).toMatchObject({
      tool: "load_guidance",
      args: { domain: "accessibility" },
    });
  });

  it("never returns a YAML-shaped tool name", () => {
    const yamlInputs = [
      "run flows/login.yaml",
      "validate flows/login.yaml",
      "list flows",
      "generate a flow that does X",
    ];
    for (const input of yamlInputs) {
      const result = dispatch(input);
      if (result) {
        expect(result.tool).not.toMatch(/_flow|^list_flows$|^run_flow$|^generate_flow$|^validate_flow$/);
      }
    }
  });

  it("returns null for unrecognized prompts", () => {
    expect(dispatch("just chatting")).toBeNull();
    expect(dispatch("hello there")).toBeNull();
  });

  it("helpMessage references *.spec.ts (not YAML)", () => {
    const help = helpMessage();
    expect(help).toContain("*.spec.ts");
    expect(help).not.toContain("flow.yaml");
    expect(help).not.toContain(".yaml");
  });
});
