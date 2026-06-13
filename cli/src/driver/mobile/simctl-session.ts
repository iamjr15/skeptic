import * as fs from "node:fs";
import * as path from "node:path";
import type { IosTools } from "./ios-tools.js";
import { parseAxeDescribe, screenFromDescribe, type IosNode } from "./axe-describe-parse.js";
import { IosSimDriverElement } from "./simctl-element.js";
import { resolveBySelectorHint } from "./simctl-resolve.js";
import { detectBlankCapture } from "./adb-session.js";
import type { Collector } from "../../observability/types.js";
import type { ScreenshotOptions, ScreenshotResult } from "../../api/screenshot.js";
import type { AriaRefEntry } from "../../executor/aria-ref-types.js";
import type { CaptureOptions, CaptureResult, DriverElement, DriverOpenOptions, DriverSession } from "../types.js";

/**
 * iOS-simulator `DriverSession` over `simctl` (lifecycle / screenshot / logs) and
 * `axe` (accessibility tree + HID tap/type). `snapshot()` produces the same
 * CaptureResult the web/Android paths do — from `axe describe-ui` — and refs
 * resolve to screen taps. The driver-less analog of the Android adb driver.
 */
export class IosSimDriverSession implements DriverSession {
  private nodes = new Map<string, IosNode>();
  private lastEntries: AriaRefEntry[] = [];
  private lastYaml: string | null = null;
  private currentTarget = "";
  private bundleId = "";
  private screen: { width: number; height: number } | null = null;

  constructor(
    private readonly tools: IosTools,
    private readonly udid: string,
    private readonly artifactDir: string,
  ) {}

  async open(target: string, _opts?: DriverOpenOptions): Promise<void> {
    this.currentTarget = target;
    if (target.includes("://")) {
      await this.tools.simctl(["openurl", this.udid, target]);
    } else {
      this.bundleId = target;
      // Terminate first so the launch starts at the app's root — a running app would
      // otherwise just foreground at its current screen (non-deterministic for specs).
      await this.tools.simctl(["terminate", this.udid, target]).catch(() => {});
      await this.tools.simctl(["launch", this.udid, target]);
    }
    this.invalidate();
    await this.wait(800);
  }

  url(): string {
    return this.bundleId || this.currentTarget;
  }

  title(): Promise<string> {
    // The foreground bundle isn't cheaply queryable on iOS; the launched bundle is the best handle.
    return Promise.resolve(this.bundleId || this.currentTarget);
  }

  async snapshot(_opts?: CaptureOptions): Promise<CaptureResult> {
    const json = await this.describeStable();
    if (!this.screen) this.screen = screenFromDescribe(json);
    const { capture, nodes } = parseAxeDescribe(json, {
      ...(this.bundleId ? { bundleId: this.bundleId } : {}),
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
        `[iosRef:not_found] {"ref":"${id}","available":${JSON.stringify([...this.nodes.keys()])},"hasSnapshot":${this.lastYaml !== null}}`,
      );
    }
    return new IosSimDriverElement(this.tools, this.udid, node);
  }

  async resolveSelector(selector: string): Promise<DriverElement> {
    const node = resolveBySelectorHint(selector, this.lastEntries, this.nodes);
    if (!node) throw new Error(`[iosSelector:not_found] no node matches "${selector}" in the last snapshot`);
    return new IosSimDriverElement(this.tools, this.udid, node);
  }

  async screenshot(name: string, opts?: ScreenshotOptions): Promise<ScreenshotResult> {
    if (opts?.annotate) {
      throw new Error(
        "[iosScreenshot:annotate_unsupported] [ios-sim] annotated screenshots are not supported on the mobile driver yet; " +
          "use the web driver or take a plain screenshot.",
      );
    }
    fs.mkdirSync(this.artifactDir, { recursive: true });
    const file = path.join(this.artifactDir, `${name.replace(/[^a-zA-Z0-9_-]/g, "_")}.png`);
    await this.tools.axe(["screenshot", "--udid", this.udid, "--output", file]);
    const png = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
    return { path: file, diagnostics: png.length > 0 ? detectBlankCapture(png) : [] };
  }

  async scroll(opts: { dx?: number; dy?: number }): Promise<void> {
    if (!this.screen) this.screen = (await this.snapshotScreen()) ?? this.screen;
    const w = this.screen?.width ?? 402;
    const h = this.screen?.height ?? 874;
    const cx = Math.round(w / 2);
    const dy = opts.dy ?? 400;
    const y1 = Math.round(h * 0.6);
    await this.tools.axe([
      "swipe", "--start-x", String(cx), "--start-y", String(y1),
      "--end-x", String(cx), "--end-y", String(y1 - dy), "--duration", "0.3", "--udid", this.udid,
    ]);
  }

  wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  attachCollectors(_collectors: Collector[]): Promise<void> {
    return Promise.resolve();
  }

  async collectEvidence(): Promise<Record<string, unknown>> {
    // iOS evidence is deliberately thin (the device exposes far less to an
    // unprivileged host than Android): a bounded, best-effort console from the
    // unified log. Perf/a11y/network parity is a documented follow-up.
    const raw = await this.tools
      .simctl(["spawn", this.udid, "log", "show", "--last", "8s", "--style", "compact"], 20_000)
      .catch(() => "");
    const messages = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && (this.bundleId === "" || l.includes(this.bundleId)))
      .slice(-200)
      .map((line) => ({ type: logLevel(line), text: line, timestamp: Date.now() }));
    return {
      console: {
        messages,
        summary: {
          total: messages.length,
          errorCount: messages.filter((m) => m.type === "error").length,
          warningCount: messages.filter((m) => m.type === "warning").length,
          infoCount: messages.filter((m) => m.type === "info").length,
          redactionDisabled: false,
        },
      },
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

  /**
   * `describe-ui`, re-dumping until two consecutive trees are positionally stable
   * (or a cap). iOS launch + large-title/navigation animations move elements for
   * ~1-2s, so a single dump can capture stale coordinates that no longer match
   * where the element IS by tap time. Mirrors the web visual-settle's intent.
   */
  private async describeStable(): Promise<string> {
    let json = await this.tools.axe(["describe-ui", "--udid", this.udid]);
    let sig = treeSignature(json);
    for (let i = 0; i < 5; i++) {
      await this.wait(300);
      const next = await this.tools.axe(["describe-ui", "--udid", this.udid]);
      json = next;
      const nextSig = treeSignature(next);
      if (nextSig === sig) break; // two consecutive identical layouts → settled
      sig = nextSig;
    }
    return json;
  }

  private async snapshotScreen(): Promise<{ width: number; height: number } | null> {
    const json = await this.tools.axe(["describe-ui", "--udid", this.udid]).catch(() => "");
    return json ? screenFromDescribe(json) : null;
  }
}

/** Positional signature of a describe-ui tree: `label@x,y` for every labelled
 *  element. Equal across two dumps ⇒ the layout has stopped animating. */
const treeSignature = (json: string): string => {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown> | Array<Record<string, unknown>>;
    const sig: string[] = [];
    const walk = (n: Record<string, unknown>): void => {
      const f = n["frame"] as { x: number; y: number } | undefined;
      const label = n["AXLabel"];
      if (typeof label === "string" && label && f) sig.push(`${label}@${Math.round(f.x)},${Math.round(f.y)}`);
      for (const c of (n["children"] as Array<Record<string, unknown>> | undefined) ?? []) walk(c);
    };
    for (const r of Array.isArray(parsed) ? parsed : [parsed]) walk(r);
    return sig.join("|");
  } catch {
    return String(json.length);
  }
};

const logLevel = (line: string): string => {
  if (/\bError\b|\bFault\b/.test(line)) return "error";
  if (/\bWarning\b/.test(line)) return "warning";
  if (/\bInfo\b/.test(line)) return "info";
  return "log";
};
