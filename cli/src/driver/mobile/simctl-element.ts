import type { IosTools } from "./ios-tools.js";
import type { IosNode } from "./axe-describe-parse.js";
import type { Box, DriverElement, DriverElementWaitOptions } from "../types.js";

// Common key names → USB HID keycodes for `axe key`.
const KEYCODES: Record<string, string> = {
  Enter: "40",
  Return: "40",
  Tab: "43",
  Backspace: "42",
  Delete: "42",
  Escape: "41",
  Space: "44",
  ArrowUp: "82",
  ArrowDown: "81",
  ArrowLeft: "80",
  ArrowRight: "79",
};

/**
 * An action target backed by a parsed `axe describe-ui` node. Like the Android
 * element it's a coordinate snapshot: actions tap/type at the node's last-known
 * center via `axe` HID injection. The session re-snapshots before resolving.
 */
export class IosSimDriverElement implements DriverElement {
  constructor(
    private readonly tools: IosTools,
    private readonly udid: string,
    private readonly node: IosNode,
  ) {}

  private tap(x: number, y: number): Promise<string> {
    return this.tools.axe(["tap", "-x", String(x), "-y", String(y), "--udid", this.udid]);
  }

  async click(): Promise<void> {
    await this.tap(this.node.center.x, this.node.center.y);
  }

  async fill(text: string): Promise<void> {
    await this.click(); // focus the field
    await this.clearField();
    await this.typeText(text);
  }

  async type(text: string): Promise<void> {
    await this.typeText(text);
  }

  async press(key: string): Promise<void> {
    const code = KEYCODES[key] ?? (/^\d+$/.test(key) ? key : null);
    if (!code) throw new Error(`[axeKey] unsupported key "${key}" (use a name like Enter/Backspace or an HID keycode)`);
    await this.tools.axe(["key", code, "--udid", this.udid]);
  }

  hover(): Promise<void> {
    // iOS has no hover; a no-op keeps the DriverElement contract total.
    return Promise.resolve();
  }

  async check(): Promise<void> {
    await this.click();
  }

  async uncheck(): Promise<void> {
    await this.click();
  }

  selectOption(): Promise<void> {
    // Pickers open on tap; the agent then taps the option ref. Tapping is the analog.
    return this.click();
  }

  scrollIntoView(): Promise<void> {
    return Promise.resolve();
  }

  waitFor(_opts?: DriverElementWaitOptions): Promise<void> {
    return Promise.resolve();
  }

  boundingBox(): Promise<Box | null> {
    const b = this.node.bounds;
    return Promise.resolve({ x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1 });
  }

  textContent(): Promise<string | null> {
    return Promise.resolve(this.node.value ?? null);
  }

  isVisible(): Promise<boolean> {
    // describe-ui only returns on-screen elements; positive area ⇒ visible.
    const b = this.node.bounds;
    return Promise.resolve(b.x2 > b.x1 && b.y2 > b.y1);
  }

  isEnabled(): Promise<boolean> {
    return Promise.resolve(this.node.enabled);
  }

  isChecked(): Promise<boolean> {
    const v = (this.node.value ?? "").toString().toLowerCase();
    return Promise.resolve(v === "1" || v === "true" || v === "on");
  }

  inputValue(): Promise<string> {
    return Promise.resolve((this.node.value ?? "").toString());
  }

  private async typeText(text: string): Promise<void> {
    if (text.length === 0) return;
    await this.tools.axe(["type", text, "--udid", this.udid]);
  }

  private async clearField(): Promise<void> {
    // Select-all (Cmd+A: modifier 227, key 4) then Backspace (42). Best-effort —
    // not every field honors Cmd+A, so failures are swallowed and fill() proceeds.
    await this.tools.axe(["key-combo", "--modifiers", "227", "--key", "4", "--udid", this.udid]).catch(() => {});
    await this.tools.axe(["key", "42", "--udid", this.udid]).catch(() => {});
  }
}
