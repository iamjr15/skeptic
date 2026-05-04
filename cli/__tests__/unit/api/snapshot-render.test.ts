import { describe, expect, it } from "vitest";
import { computeSnapshotStats, renderSnapshotYaml } from "../../../src/api/snapshot.js";
import type { AriaRefEntry } from "../../../src/executor/aria-ref-types.js";

const entry = (ref: string, role: string, name = "", href?: string): AriaRefEntry => ({
  ref,
  kind: "aria",
  role,
  name,
  nth: 0,
  scopeSelector: "body",
  ...(href ? { href } : {}),
  matchCountAtSnapshot: 1,
});

const cursorEntry = (ref: string, role: string, name = ""): AriaRefEntry => ({
  ref,
  kind: "cursor-interactive",
  role,
  name,
  nth: 0,
  scopeSelector: "body",
  selectorHint: `text=${name}`,
  matchCountAtSnapshot: 1,
});

describe("renderSnapshotYaml", () => {
  it("compact mode hides low-signal refs but keeps actionable refs and URL continuations", () => {
    const raw = [
      "- generic [ref=e1]:",
      "  - list [ref=e2]:",
      "    - listitem [ref=e3]:",
      "      - link \"iPhone\" [ref=e4]:",
      "        - /url: /iphone/",
      "  - heading \"Apple\" [level=1] [ref=e5]",
    ].join("\n");

    const rendered = renderSnapshotYaml(
      raw,
      [
        entry("e1", "generic"),
        entry("e2", "list"),
        entry("e3", "listitem"),
        entry("e4", "link", "iPhone", "/iphone/"),
        entry("e5", "heading", "Apple"),
      ],
      { interactive: false, compact: true },
    );

    expect(rendered).toContain('link "iPhone" [ref=e4]');
    expect(rendered).toContain('heading "Apple" [level=1] [ref=e5]');
    expect(rendered).toContain("/url: /iphone/");
    expect(rendered).not.toContain("[ref=e2]");
    expect(rendered).not.toContain("[ref=e3]");
    expect(rendered.match(/\/url: \/iphone\//g)).toHaveLength(1);
  });
});

describe("computeSnapshotStats", () => {
  it("counts lines, characters, estimated tokens, captured refs, rendered refs, and interactive refs", () => {
    const entries = [
      entry("e1", "generic"),
      entry("e2", "button", "Submit"),
      entry("e3", "heading", "Title"),
      entry("e4", "link", "Docs", "/docs"),
      cursorEntry("e5", "div", "Custom click"),
    ];
    const rendered = [
      '- button "Submit" [ref=e2]',
      '- link "Docs" [ref=e4]',
      '  /url: /docs',
      '- div "Custom click" [ref=e5] clickable',
    ].join("\n");

    const stats = computeSnapshotStats(rendered, entries);

    expect(stats).toEqual({
      lines: 4,
      characters: rendered.length,
      estimatedTokens: Math.ceil(rendered.length / 4),
      totalRefs: 5,
      renderedRefs: 3,
      interactiveRefs: 3,
      renderedInteractiveRefs: 3,
      ariaRefs: 4,
      cursorInteractiveRefs: 1,
    });
  });

  it("uses Expect-compatible empty-output line and token counts", () => {
    const stats = computeSnapshotStats("", []);

    expect(stats.lines).toBe(1);
    expect(stats.characters).toBe(0);
    expect(stats.estimatedTokens).toBe(0);
    expect(stats.totalRefs).toBe(0);
    expect(stats.renderedRefs).toBe(0);
  });
});
