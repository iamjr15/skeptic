import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import {
  parseGfxinfo,
  parseMeminfo,
  parseLaunchTimings,
  findAccessibilityIssues,
  minTouchTargetPx,
  parseNetstatsForUid,
} from "../../../src/driver/mobile/device-evidence.js";
import { detectBlankCapture } from "../../../src/driver/mobile/adb-session.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/mobile");
const read = (name: string) => readFileSync(join(fixtures, name), "utf8");

describe("device-evidence — performance parsers (real emulator fixtures)", () => {
  it("parseGfxinfo reads frame totals, jank, percentiles, missed-vsync", () => {
    const f = parseGfxinfo(read("gfxinfo.txt"));
    expect(f).not.toBeNull();
    expect(f!.totalFrames).toBeGreaterThan(0);
    expect(f!.jankyPercent).toBeGreaterThanOrEqual(0);
    // Percentiles are non-decreasing and read from the non-gpu lines.
    expect(f!.percentiles.p50).toBeGreaterThan(0);
    expect(f!.percentiles.p99).toBeGreaterThanOrEqual(f!.percentiles.p50);
    expect(f!.missedVsync).toBeGreaterThanOrEqual(0);
  });

  it("parseGfxinfo returns null when no frames were rendered", () => {
    expect(parseGfxinfo("** Graphics info **\nno frames\n")).toBeNull();
  });

  it("does NOT read the 'gpu percentile' lines as frame percentiles", () => {
    const raw = "50th percentile: 16ms\n90th percentile: 18ms\n95th percentile: 18ms\n99th percentile: 31ms\n50th gpu percentile: 13ms\nTotal frames rendered: 100\nJanky frames: 2 (2.00%)\n";
    expect(parseGfxinfo(raw)!.percentiles).toEqual({ p50: 16, p90: 18, p95: 18, p99: 31 });
  });

  it("parseMeminfo reads TOTAL PSS / RSS", () => {
    const m = parseMeminfo(read("meminfo.txt"));
    expect(m).not.toBeNull();
    expect(m!.totalPssKb).toBeGreaterThan(0);
    expect(m!.totalRssKb).toBeGreaterThan(0);
  });

  it("parseLaunchTimings reads TotalTime / WaitTime", () => {
    const l = parseLaunchTimings(read("am-start-w.txt"));
    expect(l.totalTimeMs).not.toBeNull();
    expect(l.waitTimeMs).not.toBeNull();
  });

  it("parseLaunchTimings nulls a missing field", () => {
    expect(parseLaunchTimings("Status: ok\n")).toEqual({ totalTimeMs: null, waitTimeMs: null });
  });
});

describe("device-evidence — accessibility heuristics", () => {
  const minPx = minTouchTargetPx(420); // 48dp @ 420dpi = 126px

  it("48dp threshold scales with density", () => {
    expect(minTouchTargetPx(160)).toBe(48);
    expect(minTouchTargetPx(420)).toBe(126);
    expect(minTouchTargetPx(0)).toBe(48); // falls back to mdpi
  });

  it("flags an unlabeled clickable, a small touch target, and an NAF node — and passes a clean one", () => {
    const xml = `<?xml version="1.0"?><hierarchy>
      <node class="android.widget.ImageButton" clickable="true" content-desc="" text="" bounds="[0,0][200,200]"/>
      <node class="android.widget.Button" clickable="true" content-desc="Tiny" text="" bounds="[0,300][40,330]"/>
      <node class="android.view.View" clickable="false" NAF="true" content-desc="" text="" bounds="[0,400][100,500]"/>
      <node class="android.widget.Button" clickable="true" content-desc="Search" text="" bounds="[0,600][300,800]"/>
    </hierarchy>`;
    const { issues, checked } = findAccessibilityIssues(xml, minPx);
    const rules = issues.map((i) => i.rule);
    expect(rules).toContain("unlabeled-clickable"); // ImageButton, no label
    expect(rules).toContain("small-touch-target"); // 40x30 < 126
    expect(rules).toContain("not-accessibility-friendly"); // NAF
    expect(checked).toBe(3); // three clickable nodes evaluated
    // The labeled, large "Search" button produces no issue.
    expect(issues.find((i) => i.className === "Button" && i.detail.includes("Search"))).toBeUndefined();
  });

  it("a clickable container labeled only by a child still counts as labeled", () => {
    const xml = `<?xml version="1.0"?><hierarchy>
      <node class="android.widget.LinearLayout" clickable="true" content-desc="" text="" bounds="[0,0][500,200]">
        <node class="android.widget.TextView" clickable="false" content-desc="" text="Open settings" bounds="[10,10][400,100]"/>
      </node>
    </hierarchy>`;
    const { issues } = findAccessibilityIssues(xml, minPx);
    expect(issues.find((i) => i.rule === "unlabeled-clickable")).toBeUndefined();
  });
});

describe("device-evidence — degraded network", () => {
  it("sums rb=/tb= scoped to the target uid only", () => {
    const raw = [
      "uid=10000 set=DEFAULT tag=0x0 rb=5 tb=5",
      "uid=10216 set=DEFAULT tag=0x0 rb=1000 tb=2000",
      "uid=10216 set=FOREGROUND tag=0x0 rb=500 tb=300",
      "uid=99999 set=DEFAULT tag=0x0 rb=7 tb=7",
    ].join("\n");
    expect(parseNetstatsForUid(raw, 10216)).toEqual({ rxBytes: 1500, txBytes: 2300 });
  });

  it("returns null when the uid is absent", () => {
    expect(parseNetstatsForUid("uid=1 rb=1 tb=1", 10216)).toBeNull();
  });
});

describe("blank-capture detection (prevents silent blank screencaps)", () => {
  const pngOf = (fill: (x: number, y: number) => [number, number, number]): Buffer => {
    const png = new PNG({ width: 40, height: 40 });
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 40; x++) {
        const o = (y * 40 + x) * 4;
        const [r, g, b] = fill(x, y);
        png.data[o] = r;
        png.data[o + 1] = g;
        png.data[o + 2] = b;
        png.data[o + 3] = 255;
      }
    }
    return PNG.sync.write(png);
  };

  it("flags an all-white (uncomposited GPU) frame with an actionable diagnostic", () => {
    const diags = detectBlankCapture(pngOf(() => [255, 255, 255]));
    expect(diags).toHaveLength(1);
    expect(diags[0]!.kind).toBe("blank-screenshot");
    expect(diags[0]!.message).toMatch(/swiftshader_indirect/);
  });

  it("stays silent for a varied (real) frame", () => {
    const diags = detectBlankCapture(pngOf((x, y) => [x * 6, y * 6, (x + y) * 3]));
    expect(diags).toHaveLength(0);
  });
});
