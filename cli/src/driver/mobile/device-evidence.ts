import { XMLParser } from "fast-xml-parser";
import type { Adb } from "./adb.js";
import type {
  MobilePerformanceSnapshot,
  MobileAccessibilitySnapshot,
  MobileAccessibilityIssue,
  MobileNetworkSnapshot,
} from "../../observability/types.js";

// Device evidence for the Android adb driver: parallels the four web collectors
// (performance / accessibility / network / console) using on-demand `dumpsys`
// pulls instead of page hooks. All parsers are pure + exported so they can be
// unit-tested against captured fixtures without a device.

// ── Performance: dumpsys gfxinfo + meminfo + `am start -W` ──────────────────

/** Parse `dumpsys gfxinfo <pkg>` frame stats. Returns null when the package
 *  rendered no frames (no "Total frames rendered" line). */
export const parseGfxinfo = (raw: string): MobilePerformanceSnapshot["frames"] => {
  const total = /Total frames rendered:\s*(\d+)/.exec(raw);
  if (!total) return null;
  const janky = /Janky frames:\s*(\d+)\s*\(([\d.]+)%\)/.exec(raw);
  // "50th percentile: 16ms" — the `(?!gpu)` guard skips the separate
  // "50th gpu percentile:" lines that follow.
  const pct = (n: number): number => {
    const m = new RegExp(`${n}th percentile:\\s*(\\d+)ms`).exec(raw);
    return m ? Number(m[1]) : 0;
  };
  // A trailing colon distinguishes "Number Frame deadline missed: 14" from the
  // "(legacy)" variant, so the non-legacy counter is read.
  const counter = (label: string): number => {
    const m = new RegExp(`${label}:\\s*(\\d+)`).exec(raw);
    return m ? Number(m[1]) : 0;
  };
  return {
    totalFrames: Number(total[1]),
    jankyFrames: janky ? Number(janky[1]) : 0,
    jankyPercent: janky ? Number(janky[2]) : 0,
    percentiles: { p50: pct(50), p90: pct(90), p95: pct(95), p99: pct(99) },
    missedVsync: counter("Number Missed Vsync"),
    deadlineMissed: counter("Number Frame deadline missed"),
  };
};

/** Parse `dumpsys meminfo <pkg>` TOTAL PSS / RSS (KB). */
export const parseMeminfo = (raw: string): MobilePerformanceSnapshot["memory"] => {
  const pss = /TOTAL PSS:\s*(\d+)/.exec(raw);
  const rss = /TOTAL RSS:\s*(\d+)/.exec(raw);
  if (!pss && !rss) return null;
  return { totalPssKb: pss ? Number(pss[1]) : 0, totalRssKb: rss ? Number(rss[1]) : 0 };
};

/** Parse `am start -W` launch timings (ms). Null when a field is absent — e.g. the
 *  activity was already foregrounded so TotalTime is 0 / WaitTime only. */
export const parseLaunchTimings = (raw: string): MobilePerformanceSnapshot["launch"] => {
  const total = /TotalTime:\s*(\d+)/.exec(raw);
  const wait = /WaitTime:\s*(\d+)/.exec(raw);
  return {
    totalTimeMs: total ? Number(total[1]) : null,
    waitTimeMs: wait ? Number(wait[1]) : null,
  };
};

export const buildMobilePerformance = async (
  adb: Adb,
  pkg: string,
  launch: MobilePerformanceSnapshot["launch"],
): Promise<MobilePerformanceSnapshot> => {
  const [gfx, mem] = await Promise.all([
    adb.text(["shell", "dumpsys", "gfxinfo", pkg]).catch(() => ""),
    adb.text(["shell", "dumpsys", "meminfo", pkg]).catch(() => ""),
  ]);
  return {
    platform: "android",
    launch,
    frames: parseGfxinfo(gfx),
    memory: parseMeminfo(mem),
  };
};

// ── Accessibility: uiautomator structural heuristics ────────────────────────

interface FlatNode {
  className: string;
  resourceId: string;
  contentDesc: string;
  text: string;
  clickable: boolean;
  naf: boolean;
  bounds: { x1: number; y1: number; x2: number; y2: number } | null;
  children: FlatNode[];
}

const a11yParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name) => name === "node",
});

const parseBounds = (b: string | undefined): FlatNode["bounds"] => {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(b ?? "");
  return m ? { x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) } : null;
};

const toFlat = (node: Record<string, unknown>): FlatNode => ({
  className: String(node["class"] ?? ""),
  resourceId: String(node["resource-id"] ?? ""),
  contentDesc: String(node["content-desc"] ?? "").trim(),
  text: String(node["text"] ?? "").trim(),
  clickable: node["clickable"] === "true",
  naf: node["NAF"] === "true",
  bounds: parseBounds(node["bounds"] as string | undefined),
  children: ((node["node"] as Array<Record<string, unknown>> | undefined) ?? []).map(toFlat),
});

/** A node has an accessible label if it (or any descendant) carries text or a
 *  content-desc — TalkBack would have something to announce. */
const hasLabel = (n: FlatNode): boolean =>
  n.contentDesc.length > 0 || n.text.length > 0 || n.children.some(hasLabel);

const shortClass = (cls: string): string => cls.split(".").pop() || cls;

/**
 * Structural a11y heuristics over a uiautomator dump. STRUCTURAL ONLY — uiautomator
 * exposes no pixels, so there is no color-contrast check (web axe's largest category
 * has no mobile analog; the summary note says so honestly).
 */
export const findAccessibilityIssues = (
  xml: string,
  minTouchTargetPx: number,
): { issues: MobileAccessibilityIssue[]; checked: number } => {
  const root = a11yParser.parse(xml) as { hierarchy?: { node?: unknown[] } };
  const issues: MobileAccessibilityIssue[] = [];
  let checked = 0;

  const visit = (n: FlatNode): void => {
    if (n.clickable) {
      checked += 1;
      const base = {
        className: shortClass(n.className),
        ...(n.resourceId ? { resourceId: n.resourceId } : {}),
        bounds: n.bounds ?? { x1: 0, y1: 0, x2: 0, y2: 0 },
      };
      if (!hasLabel(n)) {
        issues.push({
          ...base,
          rule: "unlabeled-clickable",
          impact: "serious",
          detail: "clickable element has no text or content-desc — a screen reader announces nothing",
        });
      }
      if (n.bounds) {
        const w = n.bounds.x2 - n.bounds.x1;
        const h = n.bounds.y2 - n.bounds.y1;
        if (w > 0 && h > 0 && (w < minTouchTargetPx || h < minTouchTargetPx)) {
          issues.push({
            ...base,
            rule: "small-touch-target",
            impact: "moderate",
            detail: `touch target ${w}×${h}px is below the ${minTouchTargetPx}px (48dp) minimum`,
          });
        }
      }
    }
    if (n.naf) {
      issues.push({
        className: shortClass(n.className),
        ...(n.resourceId ? { resourceId: n.resourceId } : {}),
        bounds: n.bounds ?? { x1: 0, y1: 0, x2: 0, y2: 0 },
        rule: "not-accessibility-friendly",
        impact: "minor",
        detail: "uiautomator flagged this node NAF (not accessibility-friendly)",
      });
    }
    n.children.forEach(visit);
  };

  for (const top of root.hierarchy?.node ?? []) visit(toFlat(top as Record<string, unknown>));
  return { issues, checked };
};

/** 48dp minimum touch target in px for the device density (default mdpi=160). */
export const minTouchTargetPx = (densityDpi: number): number =>
  Math.round((48 * (densityDpi || 160)) / 160);

export const buildMobileAccessibility = (
  xml: string,
  densityDpi: number,
): MobileAccessibilitySnapshot => {
  const minPx = minTouchTargetPx(densityDpi);
  const { issues, checked } = findAccessibilityIssues(xml, minPx);
  return {
    platform: "android",
    issues,
    summary: {
      issues: issues.length,
      checked,
      minTouchTargetPx: minPx,
      note: "structural uiautomator heuristics only — no color-contrast check (no pixel access on the dump)",
    },
  };
};

// ── Network: degraded by default (per-uid totals; no per-request without a proxy) ──

/** Parse a uid's cumulative rx/tx bytes from `dumpsys netstats detail`. The detail
 *  block lists `rb=<rxBytes> ... tb=<txBytes>` lines under each `uid=<n>` ident;
 *  we sum every line scoped to the target uid. Returns null when the uid is absent. */
export const parseNetstatsForUid = (
  raw: string,
  uid: number,
): MobileNetworkSnapshot["totals"] => {
  let rx = 0;
  let tx = 0;
  let found = false;
  const lines = raw.split("\n");
  let inUid = false;
  for (const line of lines) {
    const uidMatch = /uid=(-?\d+)/.exec(line);
    if (uidMatch) inUid = Number(uidMatch[1]) === uid;
    if (!inUid) continue;
    const rb = /\brb=(\d+)/.exec(line);
    const tb = /\btb=(\d+)/.exec(line);
    if (rb) {
      rx += Number(rb[1]);
      found = true;
    }
    if (tb) {
      tx += Number(tb[1]);
      found = true;
    }
  }
  return found ? { rxBytes: rx, txBytes: tx } : null;
};

const NETWORK_NOTE =
  "Android exposes only per-uid byte totals to an unprivileged client — never per-request " +
  "URLs/methods/status. For per-request capture run with an instrumenting proxy (opt-in, fragile " +
  "under TLS pinning / Android-7+ user-CA distrust).";

export const buildMobileNetwork = async (
  adb: Adb,
  uid: number | null,
): Promise<MobileNetworkSnapshot> => {
  let totals: MobileNetworkSnapshot["totals"] = null;
  if (uid !== null) {
    const raw = await adb.text(["shell", "dumpsys", "netstats", "detail"]).catch(() => "");
    totals = parseNetstatsForUid(raw, uid);
  }
  return { platform: "android", degraded: true, totals, requests: [], note: NETWORK_NOTE };
};

/** Resolve a package's Linux uid from `adb shell ps -A` (`u0_aNNN` → 10000+NNN). */
export const resolveAppUid = async (adb: Adb, pkg: string): Promise<number | null> => {
  const out = await adb.text(["shell", "ps", "-A"]).catch(() => "");
  const line = out.split("\n").find((l) => l.trim().endsWith(` ${pkg}`) || l.includes(` ${pkg}\r`));
  const m = line ? /u\d+_a(\d+)/.exec(line) : null;
  return m ? 10000 + Number(m[1]) : null;
};
