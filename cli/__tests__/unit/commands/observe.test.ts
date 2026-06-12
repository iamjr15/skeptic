import { describe, it, expect } from "vitest";
import { observeShowsLiveConsole } from "../../../src/commands/observe.js";

describe("observe --no-tui (#3)", () => {
  it("shows the live console reporter by default (commander leaves tui undefined)", () => {
    expect(observeShowsLiveConsole({})).toBe(true);
  });

  it("shows it with --tui (tui: true)", () => {
    expect(observeShowsLiveConsole({ tui: true })).toBe(true);
  });

  it("suppresses it with --no-tui (commander sets tui: false)", () => {
    // Regression: the old code read a non-existent `noTui` key (always undefined),
    // so --no-tui never suppressed the console reporter.
    expect(observeShowsLiveConsole({ tui: false })).toBe(false);
  });
});
