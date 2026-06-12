import type { Locator } from "playwright";
import type { Box, DriverElement, DriverElementWaitOptions } from "../types.js";

/** Wraps a Playwright `Locator` — lazy, auto-waiting, re-resolving on each action. */
export class PlaywrightDriverElement implements DriverElement {
  constructor(private readonly locator: Locator) {}

  click(): Promise<void> {
    return this.locator.click();
  }

  fill(text: string): Promise<void> {
    return this.locator.fill(text);
  }

  type(text: string): Promise<void> {
    // `Locator.type` is deprecated; `pressSequentially` is the modern equivalent.
    return this.locator.pressSequentially(text);
  }

  press(key: string): Promise<void> {
    return this.locator.press(key);
  }

  hover(): Promise<void> {
    return this.locator.hover();
  }

  check(): Promise<void> {
    return this.locator.check();
  }

  uncheck(): Promise<void> {
    return this.locator.uncheck();
  }

  async selectOption(value: string | string[]): Promise<void> {
    await this.locator.selectOption(value);
  }

  scrollIntoView(): Promise<void> {
    return this.locator.scrollIntoViewIfNeeded();
  }

  waitFor(opts?: DriverElementWaitOptions): Promise<void> {
    return this.locator.waitFor({
      ...(opts?.state ? { state: opts.state } : {}),
      ...(opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    });
  }

  boundingBox(): Promise<Box | null> {
    return this.locator.boundingBox();
  }

  textContent(): Promise<string | null> {
    return this.locator.textContent();
  }

  isVisible(): Promise<boolean> {
    return this.locator.isVisible();
  }

  isEnabled(): Promise<boolean> {
    return this.locator.isEnabled();
  }

  isChecked(): Promise<boolean> {
    return this.locator.isChecked();
  }

  inputValue(): Promise<string> {
    return this.locator.inputValue();
  }
}
