export type Awaitable<T> = T | Promise<T>;

export interface AssertionOptions {
  timeout?: number;
}

export interface Locator {
  readonly __skepticLocator: true;
  click(): unknown;
  fill(value: string): unknown;
  type(value: string): unknown;
  press(key: string): unknown;
  check(): unknown;
  uncheck(): unknown;
}

export interface Page {
  open(url: string): unknown;
  goto(url: string): unknown;
  snapshot(options?: { interactive?: boolean }): unknown;
  screenshot(path?: string): unknown;
  click(target: string | Locator): unknown;
  fill(target: string | Locator, value: string): unknown;
  type(target: string | Locator, value: string): unknown;
  press(target: string | Locator, key: string): unknown;
  locator(selector: string): Locator;
  getByRole(role: string, options?: { name?: string; exact?: boolean }): Locator;
  getByText(text: string, options?: { exact?: boolean }): Locator;
  getByLabel(label: string): Locator;
  getByPlaceholder(placeholder: string): Locator;
  getByTestId(testId: string): Locator;
}

export type Platform = "web" | "android" | "ios-sim";

export interface Device extends Page {
  swipe(x1: number, y1: number, x2: number, y2: number, options?: { duration?: number }): unknown;
  scroll(direction?: "up" | "down" | "left" | "right"): unknown;
  screenrecord(path: string, options?: { duration?: number }): unknown;
}

export interface Fixtures {
  page: Page;
  device: Device;
  session?: string;
  evidence: Record<string, unknown>;
  skeptic: SkepticRuntime;
}

export interface TestUseOptions {
  /** A named session is intentionally shared across retry attempts. */
  session?: string;
  /** Selects the backend used by page/device semantic operations. */
  platform?: Platform;
  /** Explicit Android serial or iOS Simulator UDID. */
  device?: string;
  /** App package or bundle identifier recorded in the run target. */
  app?: string;
  /** Soft timeout for each test body; the process watchdog remains independent. */
  timeout?: number;
}

export interface TestFunction {
  (title: string, body: (fixtures: Fixtures) => Awaitable<void>): void;
  skip(title: string, body?: (fixtures: Fixtures) => Awaitable<void>): void;
  only(title: string, body: (fixtures: Fixtures) => Awaitable<void>): void;
  use(options: TestUseOptions): void;
}

export interface ValueMatchers<T> {
  readonly not: ValueMatchers<T> & UiMatchers;
  toBe(expected: T): void;
  toEqual(expected: unknown): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toContain(expected: unknown): void;
  toMatch(expected: string | RegExp): void;
  toBeGreaterThan(expected: number): void;
  toBeLessThan(expected: number): void;
  toThrow(expected?: string | RegExp): void;
}

export interface UiMatchers {
  readonly not: UiMatchers;
  toBeVisible(options?: AssertionOptions): void;
  toBeEnabled(options?: AssertionOptions): void;
  toBeChecked(options?: AssertionOptions): void;
  toHaveText(expected: string | RegExp, options?: AssertionOptions): void;
  toHaveValue(expected: unknown, options?: AssertionOptions): void;
  toHaveAttribute(name: string, expected: unknown, options?: AssertionOptions): void;
  toHaveCount(expected: number, options?: AssertionOptions): void;
  toMatchScreenshot(name: string, options?: AssertionOptions): void;
}

export interface SkepticRuntime {
  page: Page;
  device: Device;
  /** Returns only values explicitly allowed by `[env].pass`. */
  env(name: string): string | undefined;
}

export const test: TestFunction;
export function expect<T>(value: T): ValueMatchers<T> & (T extends Locator ? UiMatchers : object);
export function beforeAll(hook: (fixtures: Fixtures) => Awaitable<void>): void;
export function beforeEach(hook: (fixtures: Fixtures) => Awaitable<void>): void;
export function afterAll(hook: (fixtures: Fixtures) => Awaitable<void>): void;
export function afterEach(hook: (fixtures: Fixtures) => Awaitable<void>): void;
export const page: Page;
export const device: Device;
export const skeptic: SkepticRuntime;
