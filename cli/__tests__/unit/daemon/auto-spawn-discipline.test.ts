import { describe, it, expect } from "vitest";
import { commandUsesBrowser } from "../../../src/index.js";

// Plan §B10 invariant 8 — auto-spawn predicate stays narrow. Only `run`
// (without `--list` or `--no-daemon`) and `inspect` (without `--no-daemon`)
// trip auto-spawn. Every other command must return false.
describe("commandUsesBrowser predicate (auto-spawn discipline)", () => {
  it.each([
    ["init"],
    ["audit"],
    ["comment"],
    ["cookies"],
    ["browsers", "install"],
    ["mcp"],
    ["acp"],
    ["add", "github-action"],
    ["generate"],
    ["--help"],
    ["daemon", "start"],
    ["daemon", "stop"],
    ["daemon", "status"],
  ])("returns false for non-browser command %s", (...argv) => {
    expect(commandUsesBrowser(argv)).toBe(false);
  });

  it("returns true for `run`", () => {
    expect(commandUsesBrowser(["run"])).toBe(true);
    expect(commandUsesBrowser(["run", "tests/foo.spec.ts"])).toBe(true);
  });

  it("returns true for `inspect`", () => {
    expect(commandUsesBrowser(["inspect", "https://example.com"])).toBe(true);
  });

  it("returns false for `run --list`", () => {
    expect(commandUsesBrowser(["run", "--list"])).toBe(false);
  });

  it("returns false for `run --no-daemon`", () => {
    expect(commandUsesBrowser(["run", "--no-daemon"])).toBe(false);
  });

  it("returns false for `inspect --no-daemon`", () => {
    expect(commandUsesBrowser(["inspect", "https://example.com", "--no-daemon"])).toBe(false);
  });

  it("tolerates leading node + script path argv shape", () => {
    expect(commandUsesBrowser(["node", "/path/to/skeptic.mjs", "run"])).toBe(true);
    expect(commandUsesBrowser(["node", "/path/to/skeptic.mjs", "init"])).toBe(false);
  });
});
