import * as fs from "node:fs";
import * as path from "node:path";
import type { Adb } from "./adb.js";
import { parseUiAutomator, type NativeNode } from "./uiautomator-parse.js";
import { AndroidAdbDriverElement } from "./adb-element.js";
import { resolveBySelectorHint } from "./adb-resolve.js";
import type { Collector } from "../../observability/types.js";
import type { ScreenshotOptions, ScreenshotResult } from "../../api/screenshot.js";
import type { AriaRefEntry } from "../../executor/aria-ref-types.js";
import type { CaptureOptions, CaptureResult, DriverElement, DriverOpenOptions, DriverSession } from "../types.js";

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
        await this.adb.text(["shell", "am", "start", "-n", component]);
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
    return { path: file, diagnostics: [] };
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
    return {
      console: { messages, summary: { total: messages.length, errorCount: messages.filter((m) => m.type === "error").length } },
    };
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

  private async foregroundPackage(): Promise<string> {
    const out = await this.adb.text(["shell", "dumpsys", "window"]).catch(() => "");
    return /mCurrentFocus=Window\{[^ ]+ [^ ]+ ([\w.]+)\//.exec(out)?.[1] ?? "";
  }
}

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
