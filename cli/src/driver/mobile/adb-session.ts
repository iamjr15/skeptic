import * as fs from "node:fs";
import * as path from "node:path";
import type { Adb } from "./adb.js";
import { parseUiAutomator, type NativeNode } from "./uiautomator-parse.js";
import { AndroidAdbDriverElement } from "./adb-element.js";
import { resolveBySelectorHint } from "./adb-resolve.js";
import {
  buildMobilePerformance,
  buildMobileAccessibility,
  buildMobileNetwork,
  parseLaunchTimings,
  resolveAppUid,
} from "./device-evidence.js";
import { detectBlankFrame } from "../../executor/visual-settle.js";
import type { Collector, MobilePerformanceSnapshot } from "../../observability/types.js";
import type { StepDiagnostic } from "../../executor/types.js";
import type { ScreenshotOptions, ScreenshotResult } from "../../api/screenshot.js";
import type { AriaRefEntry } from "../../executor/aria-ref-types.js";
import type { CaptureOptions, CaptureResult, DriverElement, DriverOpenOptions, DriverSession, VideoRecordResult } from "../types.js";

const DUMP_RETRIES = 8;
// Total wall-clock budget for one snapshot's dump. A healthy device dumps in
// ~1-3s; capping the retry loop means an unresponsive device fails fast with a
// clear diagnostic instead of hanging for minutes (8 × per-call timeout).
const DUMP_BUDGET_MS = 30_000;

/** Android `DriverSession` over adb. `snapshot()` produces the same CaptureResult
 *  the web path does (from a uiautomator dump); refs resolve to screen taps. */
export class AndroidAdbDriverSession implements DriverSession {
  private nodes = new Map<string, NativeNode>();
  private lastEntries: AriaRefEntry[] = [];
  private lastYaml: string | null = null;
  private currentTarget = "";
  private packageName = "";
  private screen: { width: number; height: number } | null = null;
  private density: number | null = null;
  private lastXml: string | null = null;
  private lastLaunch: MobilePerformanceSnapshot["launch"] = { totalTimeMs: null, waitTimeMs: null };

  constructor(
    private readonly adb: Adb,
    private readonly serial: string,
    private readonly artifactDir: string,
  ) {}

  async open(target: string, _opts?: DriverOpenOptions): Promise<void> {
    this.currentTarget = target;
    if (target.includes("://")) {
      await this.adb.text(["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", target]);
    } else {
      this.packageName = target;
      // Resolve the launcher activity, then `am start -n` (reliable). Fall back to
      // monkey only if resolution yields nothing (monkey is finicky on slow devices).
      const resolved = await this.adb
        .text(["shell", "cmd", "package", "resolve-activity", "--brief", target])
        .catch(() => "");
      const component = resolved
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.includes("/"))
        .pop();
      if (component) {
        // `-W` blocks until launch completes and prints TotalTime/WaitTime, feeding
        // the MobilePerformanceSnapshot launch timings.
        const out = await this.adb.text(["shell", "am", "start", "-W", "-n", component]);
        this.lastLaunch = parseLaunchTimings(out);
      } else {
        await this.adb
          .text(["shell", "monkey", "-p", target, "-c", "android.intent.category.LAUNCHER", "1"])
          .catch(() => {});
      }
    }
    this.invalidate();
    await this.wait(800);
  }

  url(): string {
    return this.packageName || this.currentTarget;
  }

  title(): Promise<string> {
    return this.foregroundPackage();
  }

  async snapshot(_opts?: CaptureOptions): Promise<CaptureResult> {
    if (!this.screen) this.screen = await this.fetchScreen();
    const xml = await this.dumpWithRetry();
    const pkg = this.packageName || (await this.foregroundPackage());
    const { capture, nodes } = parseUiAutomator(xml, {
      ...(pkg ? { packageName: pkg } : {}),
      ...(this.screen ? { screen: this.screen } : {}),
    });
    this.nodes = nodes;
    this.lastEntries = capture.entries;
    this.lastYaml = capture.yaml;
    this.lastXml = xml; // reused by the accessibility collector (no extra dump)
    return capture;
  }

  async resolveRef(ref: string): Promise<DriverElement> {
    const id = ref.startsWith("@") ? ref.slice(1) : ref;
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(
        `[adbRef:not_found] {"ref":"${id}","available":${JSON.stringify([...this.nodes.keys()])},"hasSnapshot":${this.lastYaml !== null}}`,
      );
    }
    return new AndroidAdbDriverElement(this.adb, node);
  }

  async resolveSelector(selector: string): Promise<DriverElement> {
    const node = resolveBySelectorHint(selector, this.lastEntries, this.nodes);
    if (!node) throw new Error(`[adbSelector:not_found] no node matches "${selector}" in the last snapshot`);
    return new AndroidAdbDriverElement(this.adb, node);
  }

  async screenshot(name: string, opts?: ScreenshotOptions): Promise<ScreenshotResult> {
    // A device screencap is inherently full-screen, so `fullPage` is a no-op here.
    // `annotate` (numbered-badge overlay) is a web-only pipeline; fail loudly
    // rather than silently returning an un-annotated PNG that looks correct.
    if (opts?.annotate) {
      throw new Error(
        "[adbScreenshot:annotate_unsupported] [android] annotated screenshots are not supported on the mobile driver yet; " +
          "use the web driver or take a plain screenshot (a device screencap is always full-screen, so --full is implied).",
      );
    }
    const png = await this.adb.bytes(["exec-out", "screencap", "-p"]);
    fs.mkdirSync(this.artifactDir, { recursive: true });
    const file = path.join(this.artifactDir, `${name.replace(/[^a-zA-Z0-9_-]/g, "_")}.png`);
    fs.writeFileSync(file, png);
    return { path: file, diagnostics: detectBlankCapture(png) };
  }

  async recordVideo(durationSec: number): Promise<VideoRecordResult> {
    // screenrecord blocks on-device for the whole limit (its own cap is 180s); we cap
    // at 20s so the recording + pull fits inside the session RPC's 30s budget.
    const dur = Math.max(1, Math.min(20, Math.round(durationSec || 3)));
    const remote = "/sdcard/skeptic-record.mp4";
    const budget = (dur + 10) * 1000;
    await this.adb.text(["shell", "screenrecord", "--time-limit", String(dur), remote], budget).catch(() => {});
    fs.mkdirSync(this.artifactDir, { recursive: true });
    const local = path.join(this.artifactDir, "recording.mp4");
    const bytes = await this.adb.bytes(["exec-out", "cat", remote], budget).catch(() => Buffer.alloc(0));
    fs.writeFileSync(local, bytes);
    await this.adb.text(["shell", "rm", remote]).catch(() => {});
    // A composited recording is comfortably above ~20KB even for a static screen; a
    // tinier file means the GPU surface wasn't captured (see detectBlankCapture).
    return { path: local, bytes: bytes.length, durationSec: dur, degraded: bytes.length < 20_000 };
  }

  async scroll(opts: { dx?: number; dy?: number }): Promise<void> {
    if (!this.screen) this.screen = await this.fetchScreen();
    const w = this.screen?.width ?? 1080;
    const h = this.screen?.height ?? 2400;
    const cx = Math.round(w / 2);
    const dy = opts.dy ?? 600;
    const y1 = Math.round(h * 0.6);
    await this.adb.text(["shell", "input", "swipe", String(cx), String(y1), String(cx), String(y1 - dy), "300"]);
  }

  wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Mobile sessions ignore web collectors (they need a Page); evidence comes from
  // logcat on demand via collectEvidence. Kept total to satisfy DriverSession.
  attachCollectors(_collectors: Collector[]): Promise<void> {
    return Promise.resolve();
  }

  async collectEvidence(): Promise<Record<string, unknown>> {
    const pkg = this.packageName || (await this.foregroundPackage());
    // Gather the four device-evidence streams concurrently — each is an independent
    // adb pull, so wall-clock is the slowest (~the a11y dump), not their sum.
    const [console, performance, accessibility, network] = await Promise.all([
      this.collectConsole(pkg),
      buildMobilePerformance(this.adb, pkg, this.lastLaunch),
      this.collectAccessibility(),
      pkg ? resolveAppUid(this.adb, pkg).then((uid) => buildMobileNetwork(this.adb, uid)) : buildMobileNetwork(this.adb, null),
    ]);
    return { console, performance, accessibility, network };
  }

  private async collectConsole(pkg: string): Promise<unknown> {
    const pid = pkg ? (await this.adb.text(["shell", "pidof", "-s", pkg]).catch(() => "")).trim() : "";
    const args = pid
      ? ["shell", "logcat", "-d", "-v", "brief", `--pid=${pid}`]
      : ["shell", "logcat", "-d", "-v", "brief", "-t", "200"];
    const raw = await this.adb.text(args).catch(() => "");
    const messages = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-200)
      .map((line) => ({ type: logcatLevel(line), text: line, timestamp: Date.now() }));
    // Shape-compatible with the web ConsoleSnapshot.summary so shared reporters render it.
    return {
      messages,
      summary: {
        total: messages.length,
        errorCount: messages.filter((m) => m.type === "error").length,
        warningCount: messages.filter((m) => m.type === "warning").length,
        infoCount: messages.filter((m) => m.type === "info").length,
        redactionDisabled: false,
      },
    };
  }

  private async collectAccessibility(): Promise<unknown> {
    if (this.density === null) this.density = await this.fetchDensity();
    // Reuse the last snapshot's dump when present; otherwise pull a fresh one.
    const xml = this.lastXml ?? (await this.dumpWithRetry().catch(() => ""));
    if (!xml) return { platform: "android", issues: [], summary: { issues: 0, checked: 0, minTouchTargetPx: 0, note: "no uiautomator dump available" } };
    return buildMobileAccessibility(xml, this.density ?? 160);
  }

  detachCollectors(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.invalidate();
    return Promise.resolve();
  }

  private invalidate(): void {
    this.nodes = new Map();
    this.lastEntries = [];
    this.lastYaml = null;
    this.lastXml = null;
  }

  private async dumpWithRetry(): Promise<string> {
    const start = Date.now();
    const deadline = start + DUMP_BUDGET_MS;
    let lastErr = "";
    let attempts = 0;
    while (attempts < DUMP_RETRIES && Date.now() < deadline) {
      attempts++;
      await this.adb.text(["shell", "uiautomator", "dump", "/sdcard/skeptic-dump.xml"]).catch((e) => {
        lastErr = String(e);
      });
      const xml = await this.adb.text(["shell", "cat", "/sdcard/skeptic-dump.xml"]).catch((e) => {
        lastErr = String(e);
        return "";
      });
      // The transient "null root node" / idle-wait failure resolves on retry.
      if (xml.includes("<hierarchy") && xml.length > 100) return xml;
      await this.wait(400 + attempts * 200);
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    throw new Error(
      `[adbDump] uiautomator dump returned no usable hierarchy after ${attempts} attempt(s) in ${elapsed}s. ` +
        "The device looks unresponsive — check `adb devices`, device load/disk, and (for emulators) the GPU mode." +
        (lastErr ? ` Last error: ${lastErr}` : ""),
    );
  }

  private async fetchScreen(): Promise<{ width: number; height: number } | null> {
    const out = await this.adb.text(["shell", "wm", "size"]).catch(() => "");
    const m = /(\d+)x(\d+)/.exec(out);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  }

  private async fetchDensity(): Promise<number> {
    const out = await this.adb.text(["shell", "wm", "density"]).catch(() => "");
    const m = /(?:Override|Physical) density:\s*(\d+)/.exec(out);
    return m ? Number(m[1]) : 160;
  }

  private async foregroundPackage(): Promise<string> {
    const out = await this.adb.text(["shell", "dumpsys", "window"]).catch(() => "");
    return /mCurrentFocus=Window\{[^ ]+ [^ ]+ ([\w.]+)\//.exec(out)?.[1] ?? "";
  }
}

// A real Android frame always carries a varied status/nav bar, so a near-uniform
// capture means the device/emulator GPU isn't compositing into screencap (the
// classic headless emulator with the wrong `-gpu` mode — frames come back blank).
// The web blank detector ANDs variance with an 8KB byte floor, but a full-screen
// blank PNG clears that floor, so on mobile we key on the pixel-variance signal
// alone and surface the remediation instead of silently writing a blank image.
const MOBILE_NEAR_UNIFORM = 8; // matches visual-settle's PIXEL_VARIANCE_THRESHOLD
export const detectBlankCapture = (png: Buffer): StepDiagnostic[] => {
  const { meta } = detectBlankFrame(png);
  if (meta.channelRange >= MOBILE_NEAR_UNIFORM) return [];
  return [
    {
      kind: "blank-screenshot",
      message:
        `[android] captured frame is near-uniform (pixel channel range ${meta.channelRange}) — the device/emulator ` +
        "GPU is not compositing into screencap, so this image is blank. For a headless emulator relaunch with " +
        "`-gpu swiftshader_indirect` (software rendering) or without `-no-window`; on a physical device make sure " +
        "the screen is on and unlocked. `skeptic doctor` reports the device state.",
      meta,
    },
  ];
};

const logcatLevel = (line: string): string => {
  const m = /^([VDIWEF])\//.exec(line);
  switch (m?.[1]) {
    case "E":
    case "F":
      return "error";
    case "W":
      return "warning";
    case "I":
      return "info";
    default:
      return "log";
  }
};
