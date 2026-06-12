import type { Adb } from "./adb.js";
import { isAsciiInput, escapeInputText } from "./adb.js";
import type { NativeNode } from "./uiautomator-parse.js";
import type { Box, DriverElement, DriverElementWaitOptions } from "../types.js";

const KEYCODES: Record<string, string> = {
  Enter: "KEYCODE_ENTER",
  Tab: "KEYCODE_TAB",
  Backspace: "KEYCODE_DEL",
  Escape: "KEYCODE_ESCAPE",
  ArrowUp: "KEYCODE_DPAD_UP",
  ArrowDown: "KEYCODE_DPAD_DOWN",
  ArrowLeft: "KEYCODE_DPAD_LEFT",
  ArrowRight: "KEYCODE_DPAD_RIGHT",
};

// Upper bound on backspaces issued to clear a focused field. NativeNode carries
// no text length, so we size the clear to a generous cap that covers realistic
// inputs (URLs, emails, long passwords); surplus backspaces on an emptied field
// are harmless no-ops.
const CLEAR_MAX_CHARS = 128;

/**
 * An action target backed by a parsed uiautomator node. Unlike the web Locator
 * (lazy, auto-waiting), this is a coordinate snapshot: actions tap/swipe at the
 * node's last-known center. The session re-verifies freshness before resolving.
 */
export class AndroidAdbDriverElement implements DriverElement {
  constructor(
    private readonly adb: Adb,
    private readonly node: NativeNode,
  ) {}

  async click(): Promise<void> {
    const { x, y } = this.node.center;
    await this.adb.text(["shell", "input", "tap", String(x), String(y)]);
  }

  async fill(text: string): Promise<void> {
    await this.click(); // focus the field
    await this.clearField();
    await this.typeAscii(text);
  }

  async type(text: string): Promise<void> {
    await this.typeAscii(text);
  }

  async press(key: string): Promise<void> {
    const code = KEYCODES[key] ?? (key.startsWith("KEYCODE_") ? key : null);
    if (!code) throw new Error(`[adbInput] unsupported key "${key}"`);
    await this.adb.text(["shell", "input", "keyevent", code]);
  }

  hover(): Promise<void> {
    // Android has no hover; a no-op keeps the DriverElement contract total.
    return Promise.resolve();
  }

  async check(): Promise<void> {
    await this.click();
  }

  async uncheck(): Promise<void> {
    await this.click();
  }

  selectOption(): Promise<void> {
    // Spinners open a list on tap; the agent then taps the option ref. Tapping
    // the spinner is the closest single-action analog.
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
    return Promise.resolve(null); // text comes from the snapshot, not a per-node read
  }

  isVisible(): Promise<boolean> {
    // uiautomator only dumps on-screen nodes; a node with positive area is visible.
    const b = this.node.bounds;
    return Promise.resolve(b.x2 > b.x1 && b.y2 > b.y1);
  }

  isEnabled(): Promise<boolean> {
    return Promise.resolve(this.node.enabled);
  }

  isChecked(): Promise<boolean> {
    // The parsed NativeNode doesn't retain the `checked` attribute; read the
    // checkbox/switch state from the next `skeptic snapshot` instead.
    return Promise.reject(
      new Error("[adbQuery:checked_unsupported] checked state isn't tracked by the Android driver; re-snapshot to read it"),
    );
  }

  inputValue(): Promise<string> {
    return Promise.reject(
      new Error("[adbQuery:value_unsupported] per-field value reads aren't supported on Android; read the field text from `skeptic snapshot`"),
    );
  }

  private async clearField(): Promise<void> {
    // Move the caret to the end, then backspace a bounded number of times so
    // multi-char values are fully cleared before fill() types the new value.
    // There is no portable select-all keyevent across IMEs, and `input keyevent`
    // accepts a batch of keycodes, so one MOVE_END + N×DEL call is the most
    // reliable cross-keyboard clear without an unbounded loop or busy-wait.
    const deletes = Array.from({ length: CLEAR_MAX_CHARS }, () => "KEYCODE_DEL");
    await this.adb
      .text(["shell", "input", "keyevent", "KEYCODE_MOVE_END", ...deletes])
      .catch(() => {});
  }

  private async typeAscii(text: string): Promise<void> {
    if (!isAsciiInput(text)) {
      throw new Error(
        `[adbInput:unicode_unsupported] adb input text is ASCII-only; "${"*".repeat(text.length)}" contains non-ASCII. ` +
          `Use a deep link / test seam to set this value, or enable the pushed-binary fast lane.`,
      );
    }
    if (text.length === 0) return;
    await this.adb.text(["shell", "input", "text", escapeInputText(text)]);
  }
}
