import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseUiAutomator, deriveRole } from "../../../src/driver/mobile/uiautomator-parse.js";

const node = (attrs: Record<string, string>, children = ""): string => {
  const a = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return children ? `<node ${a}>${children}</node>` : `<node ${a} />`;
};
const hierarchy = (inner: string): string =>
  `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0">${inner}</hierarchy>`;

const FULL = { bounds: "[0,0][100,100]", enabled: "true", password: "false", checkable: "false", clickable: "false", "long-clickable": "false", scrollable: "false" };

describe("deriveRole", () => {
  it("maps widget classes + flags to roles", () => {
    expect(deriveRole({ class: "android.widget.Button" })).toBe("button");
    expect(deriveRole({ class: "android.widget.EditText" })).toBe("textbox");
    expect(deriveRole({ class: "android.widget.EditText", "resource-id": "x:id/search_box" })).toBe("searchbox");
    expect(deriveRole({ class: "android.widget.CheckBox" })).toBe("checkbox");
    expect(deriveRole({ class: "androidx.appcompat.widget.SwitchCompat" })).toBe("switch");
    expect(deriveRole({ class: "android.widget.SeekBar" })).toBe("slider");
    expect(deriveRole({ class: "androidx.recyclerview.widget.RecyclerView" })).toBe("list");
    expect(deriveRole({ class: "android.webkit.WebView" })).toBe("webview");
    expect(deriveRole({ class: "android.widget.TextView" })).toBe("text");
    expect(deriveRole({ class: "android.widget.LinearLayout", clickable: "true" })).toBe("button");
  });
});

describe("parseUiAutomator", () => {
  it("mints refs for a clickable row and folds its child text into the name", () => {
    const xml = hierarchy(
      node({ ...FULL, class: "android.widget.LinearLayout", clickable: "true", bounds: "[0,0][1080,200]" },
        node({ ...FULL, class: "android.widget.TextView", text: "Network & internet", bounds: "[20,40][500,90]" }) +
        node({ ...FULL, class: "android.widget.TextView", text: "Wi-Fi, mobile", bounds: "[20,100][500,150]" }),
      ),
    );
    const { capture, nodes } = parseUiAutomator(xml, { packageName: "com.x" });
    // One ref: the clickable container, named by its first child text. Children folded.
    expect(capture.entries).toHaveLength(1);
    expect(capture.entries[0]).toMatchObject({ role: "button", name: "Network & internet", kind: "aria" });
    expect(nodes.get("e1")!.center).toEqual({ x: 540, y: 100 });
  });

  it("derives selectorHint priority res > desc > text > class", () => {
    const xml = hierarchy(
      node({ ...FULL, class: "android.widget.Button", "resource-id": "com.x:id/ok", text: "OK", clickable: "true" }) +
      node({ ...FULL, class: "android.widget.ImageButton", "content-desc": "Close", clickable: "true", bounds: "[0,0][50,50]" }) +
      node({ ...FULL, class: "android.widget.Button", text: "Plain", clickable: "true", bounds: "[0,0][50,50]" }),
    );
    const { capture } = parseUiAutomator(xml);
    expect(capture.entries.map((e) => e.selectorHint)).toEqual(["res=com.x:id/ok", "desc=Close", "text=Plain"]);
  });

  it("computes nth + matchCountAtSnapshot per (role,name) group", () => {
    const xml = hierarchy(
      node({ ...FULL, class: "android.widget.Button", text: "Item", clickable: "true" }) +
      node({ ...FULL, class: "android.widget.Button", text: "Item", clickable: "true", bounds: "[0,200][100,300]" }),
    );
    const { capture } = parseUiAutomator(xml);
    expect(capture.entries.map((e) => `${e.nth}/${e.matchCountAtSnapshot}`)).toEqual(["0/2", "1/2"]);
  });

  it("never leaks masked password text into the name", () => {
    const xml = hierarchy(
      node({ ...FULL, class: "android.widget.EditText", text: "hunter2", password: "true", "resource-id": "com.x:id/pw", clickable: "true" }),
    );
    const { capture } = parseUiAutomator(xml);
    expect(capture.entries[0]!.name).not.toContain("hunter2");
    expect(capture.entries[0]!.role).toBe("textbox");
  });

  it("flags off-viewport refs by center vs screen rect", () => {
    const xml = hierarchy(
      node({ ...FULL, class: "android.widget.Button", text: "On", clickable: "true", bounds: "[0,0][100,100]" }) +
      node({ ...FULL, class: "android.widget.Button", text: "Off", clickable: "true", bounds: "[0,3000][100,3100]" }),
    );
    const { capture } = parseUiAutomator(xml, { screen: { width: 1080, height: 2400 } });
    expect(capture.offViewportRefs?.has("e2")).toBe(true);
    expect(capture.offViewportRefs?.has("e1")).toBe(false);
  });

  it("parses a real emulator Settings dump into sensible clickable rows", () => {
    const fixture = path.resolve(import.meta.dirname, "../../fixtures/mobile/settings-dump.xml");
    if (!fs.existsSync(fixture)) return; // fixture only present where captured
    const xml = fs.readFileSync(fixture, "utf8");
    const { capture, nodes } = parseUiAutomator(xml, {
      packageName: "com.android.settings",
      screen: { width: 1080, height: 2400 },
    });
    expect(capture.entries.length).toBeGreaterThan(5);
    const names = capture.entries.map((e) => e.name);
    expect(names).toContain("Network & internet");
    // every clickable ref has a tap coordinate
    for (const e of capture.entries) {
      if (nodes.get(e.ref)?.clickable) expect(nodes.get(e.ref)!.center).toBeDefined();
    }
    // every ref has a non-empty, resolvable hint (res=/desc=/text=/class=)
    for (const e of capture.entries) {
      expect(e.selectorHint).toMatch(/^(res|desc|text|class)=/);
      expect(e.selectorHint.length).toBeGreaterThan(5);
    }
  });
});
