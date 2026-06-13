import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseAxeDescribe, screenFromDescribe, deriveRole } from "../../../src/driver/mobile/axe-describe-parse.js";
import { resolveBySelectorHint } from "../../../src/driver/mobile/simctl-resolve.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/mobile");
const describeJson = readFileSync(join(fixtures, "axe-describe-ui.json"), "utf8");

describe("axe-describe-parse (real iOS Settings fixture)", () => {
  const { capture, nodes } = parseAxeDescribe(describeJson, { bundleId: "com.apple.Preferences" });

  it("derives skeptic roles from AXe element types", () => {
    expect(deriveRole({ type: "Button" })).toBe("button");
    expect(deriveRole({ type: "StaticText" })).toBe("text");
    expect(deriveRole({ type: "TextField" })).toBe("textbox");
    expect(deriveRole({ type: "Slider" })).toBe("slider");
    expect(deriveRole({ type: "Heading" })).toBe("heading");
  });

  it("mints refs for interactive controls with names + center taps", () => {
    expect(capture.entries.length).toBeGreaterThan(5);
    const general = capture.entries.find((e) => e.role === "button" && e.name === "General");
    expect(general).toBeTruthy();
    const node = nodes.get(general!.ref)!;
    // Settings "General" cell center, in points (button frame 16,395 370x56).
    expect(node.center).toEqual({ x: 201, y: 423 });
    expect(node.enabled).toBe(true);
  });

  it("uses the stable AXUniqueId as the selectorHint when present", () => {
    const apple = capture.entries.find((e) => e.name.startsWith("Apple Account"));
    expect(apple?.selectorHint).toBe("id=com.apple.settings.primaryAppleAccount");
  });

  it("falls back to label= then type= for the selectorHint", () => {
    const general = capture.entries.find((e) => e.name === "General")!;
    // General has no AXUniqueId in the fixture → label= hint.
    expect(general.selectorHint === "id=com.apple.settings.general" || general.selectorHint === "label=General").toBe(true);
  });

  it("folds a cell's child StaticText into the button name (no duplicate text ref)", () => {
    // The "General" StaticText is claimed by the General button, so it doesn't get its own text entry.
    const generalTexts = capture.entries.filter((e) => e.role === "text" && e.name === "General");
    expect(generalTexts.length).toBe(0);
  });

  it("reads the screen size from the Application root frame", () => {
    expect(screenFromDescribe(describeJson)).toEqual({ width: 402, height: 874 });
  });

  it("resolveBySelectorHint resolves by id, label, and bare name", () => {
    const general = capture.entries.find((e) => e.name === "General")!;
    expect(resolveBySelectorHint("label=General", capture.entries, nodes)?.center).toEqual({ x: 201, y: 423 });
    expect(resolveBySelectorHint("General", capture.entries, nodes)?.center).toEqual({ x: 201, y: 423 });
    expect(resolveBySelectorHint(general.selectorHint, capture.entries, nodes)?.center).toEqual({ x: 201, y: 423 });
    expect(resolveBySelectorHint("label=DoesNotExist", capture.entries, nodes)).toBeNull();
  });

  it("tolerates malformed JSON without throwing", () => {
    const { capture: empty } = parseAxeDescribe("not json", {});
    expect(empty.entries).toEqual([]);
  });
});
