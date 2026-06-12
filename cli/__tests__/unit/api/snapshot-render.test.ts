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

  it("compact mode is flat: drops pure-structural wrappers and removes orphaned indentation", () => {
    const raw = [
      "- generic [ref=e1]:",
      "  - navigation [ref=e2]:",
      '    - button "Menu" [ref=e3]',
    ].join("\n");

    const rendered = renderSnapshotYaml(
      raw,
      [
        entry("e1", "generic"),
        entry("e2", "navigation"),
        entry("e3", "button", "Menu"),
      ],
      { interactive: false, compact: true },
    );

    // generic + nameless navigation wrappers are dropped entirely (not merely
    // ref-stripped), and the surviving button is flattened to column 0.
    expect(rendered).toBe('- button "Menu" [ref=e3]');
  });

  it("annotates off-viewport refs inline while keeping the ref token parseable", () => {
    const raw = [
      '- button "Visible" [ref=e1]',
      '- button "Below the fold" [ref=e2]',
    ].join("\n");

    const rendered = renderSnapshotYaml(
      raw,
      [entry("e1", "button", "Visible"), entry("e2", "button", "Below the fold")],
      { interactive: false, compact: false, offViewportRefs: new Set(["e2"]) },
    );

    expect(rendered).toContain('button "Below the fold" [ref=e2] [off-viewport]');
    // The in-viewport ref is left untouched.
    expect(rendered).toContain('- button "Visible" [ref=e1]');
    expect(rendered).not.toContain("[ref=e1] [off-viewport]");
    // Ref token stays intact so a byRef lookup of the annotated line still parses.
    expect(refsOf(rendered)).toEqual(["e1", "e2"]);
  });

  it("keeps off-viewport annotation through compact mode for high-signal refs", () => {
    const raw = ['- link "Footer" [ref=e1]', "  - /url: /footer"].join("\n");
    const rendered = renderSnapshotYaml(
      raw,
      [entry("e1", "link", "Footer", "/footer")],
      { interactive: false, compact: true, offViewportRefs: new Set(["e1"]) },
    );
    expect(rendered).toContain('link "Footer" [ref=e1] [off-viewport]');
    expect(rendered).toContain("/url: /footer");
  });
});

const refsOf = (text: string): string[] =>
  [...text.matchAll(/\[ref=(e\d+)\]/g)].map((m) => m[1]!);

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
