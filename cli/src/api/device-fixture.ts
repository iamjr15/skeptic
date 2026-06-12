import type { DriverSession, DriverElement } from "../driver/types.js";
import type { ExecutionContext } from "../executor/context.js";
import type { ScreenshotResult } from "./screenshot.js";
import type { ActionEvent, SkepticFixture } from "./fixture.js";

// The mobile spec surface: what `test("…", async ({ device }) => {})` drives under
// `--platform android`. A thin, ergonomic wrapper over the platform-agnostic
// DriverSession (snapshot → ref → act) — distinct from the web `page` fixture
// because uiautomator refs aren't Playwright locators. Targets accept an `@eN`
// ref from the last snapshot OR a selectorHint (`res=`/`desc=`/`text=`/`class=`).

export interface DeviceRef {
  ref: string;
  role: string;
  name: string;
  selectorHint: string;
}

export interface DeviceSnapshot {
  /** ARIA-style YAML tree of the current screen. */
  yaml: string;
  /** Interactive refs minted this snapshot, each with a stable selectorHint. */
  refs: DeviceRef[];
  /** True when any ref matches `query` (exact selectorHint, or a substring of the
   *  selectorHint / accessible name / `role:name`). */
  has(query: string): boolean;
  /** The `@eN` ref of the first match, or throws with the available refs. */
  ref(query: string): string;
}

export interface DeviceApi {
  /** Launch an app by package name or open a deep link (`scheme://…`). */
  open(target: string): Promise<void>;
  /** Dump the current screen into refs + selectorHints. Re-call after every screen change. */
  snapshot(): Promise<DeviceSnapshot>;
  click(target: string): Promise<void>;
  /** Alias for click (mobile vocabulary). */
  tap(target: string): Promise<void>;
  fill(target: string, text: string): Promise<void>;
  type(target: string, text: string): Promise<void>;
  press(target: string, key: string): Promise<void>;
  hover(target: string): Promise<void>;
  check(target: string): Promise<void>;
  uncheck(target: string): Promise<void>;
  select(target: string, value: string): Promise<void>;
  /** Scroll an element into view (`target`) or pan the viewport (`{dx,dy}`). */
  scroll(targetOrPan?: string | { dx?: number; dy?: number }): Promise<void>;
  /** Capture a device screencap; returns the file path. */
  screenshot(name: string): Promise<string>;
  is(state: "visible" | "enabled" | "checked", target: string): Promise<boolean>;
  get(query: "text" | "value", target: string): Promise<string | null>;
  wait(ms: number): Promise<void>;
}

const matchesRef = (r: DeviceRef, query: string): boolean =>
  r.selectorHint === query ||
  r.selectorHint.includes(query) ||
  (r.name.length > 0 && r.name.includes(query)) ||
  `${r.role}:${r.name}`.includes(query);

const toDeviceSnapshot = (capture: { yaml: string; entries: Array<{ ref: string; role: string; name: string; selectorHint?: string }> }): DeviceSnapshot => {
  const refs: DeviceRef[] = capture.entries.map((e) => ({
    ref: e.ref,
    role: e.role,
    name: e.name,
    selectorHint: e.selectorHint ?? "",
  }));
  return {
    yaml: capture.yaml,
    refs,
    has: (query) => refs.some((r) => matchesRef(r, query)),
    ref: (query) => {
      const hit = refs.find((r) => matchesRef(r, query));
      if (!hit) {
        throw new Error(
          `no ref matches "${query}". Available: ${refs.map((r) => r.selectorHint || `${r.role}:${r.name}`).join(", ") || "(none)"}`,
        );
      }
      return `@${hit.ref}`;
    },
  };
};

/** Build the `device`-bearing fixture for one Android test. Mirrors `buildFixture`'s
 *  `runAction` contract (abort gate + action markers) so the runner's hook/timeout
 *  machinery works unchanged; web-only fields throw a clear error if a spec misuses them. */
export const buildDeviceFixture = (
  session: DriverSession,
  ctx: ExecutionContext,
  options: { onAction?: (event: ActionEvent) => void } = {},
): SkepticFixture => {
  const onAction = options.onAction ?? (() => {});

  const runAction = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    if (ctx.abortReason !== null && !ctx.inTeardown) {
      const message = `[skeptic] aborted: ${ctx.abortReason}`;
      onAction({ label, status: "failed", error: message });
      throw new Error(message);
    }
    const started = performance.now();
    onAction({ label, status: "started" });
    try {
      const result = await fn();
      onAction({ label, status: "completed", durationMs: Math.round(performance.now() - started) });
      return result;
    } catch (err) {
      onAction({ label, status: "failed", durationMs: Math.round(performance.now() - started), error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  };

  const resolve = (target: string): Promise<DriverElement> =>
    target.startsWith("@") ? session.resolveRef(target.slice(1)) : session.resolveSelector(target);

  const screenshotResult = async (name: string): Promise<ScreenshotResult> => {
    const r = await session.screenshot(name);
    ctx.addScreenshot(r.path);
    return r;
  };

  const device: DeviceApi = {
    open: (t) => runAction("device.open", () => session.open(t)),
    snapshot: () => runAction("snapshot", async () => toDeviceSnapshot(await session.snapshot())),
    click: (t) => runAction("proxy.click", async () => (await resolve(t)).click()),
    tap: (t) => runAction("proxy.tap", async () => (await resolve(t)).click()),
    fill: (t, text) => runAction("proxy.fill", async () => (await resolve(t)).fill(text)),
    type: (t, text) => runAction("proxy.type", async () => (await resolve(t)).type(text)),
    press: (t, key) => runAction("proxy.press", async () => (await resolve(t)).press(key)),
    hover: (t) => runAction("proxy.hover", async () => (await resolve(t)).hover()),
    check: (t) => runAction("proxy.check", async () => (await resolve(t)).check()),
    uncheck: (t) => runAction("proxy.uncheck", async () => (await resolve(t)).uncheck()),
    select: (t, value) => runAction("proxy.selectOption", async () => (await resolve(t)).selectOption(value)),
    scroll: (arg) =>
      runAction("proxy.scroll", async () => {
        if (typeof arg === "string") return (await resolve(arg)).scrollIntoView();
        return session.scroll(arg ?? {});
      }),
    screenshot: (name) => runAction("screenshot", async () => (await screenshotResult(name)).path),
    is: (state, t) =>
      runAction(`device.is.${state}`, async () => {
        const el = await resolve(t);
        return state === "visible" ? el.isVisible() : state === "enabled" ? el.isEnabled() : el.isChecked();
      }),
    get: (query, t) =>
      runAction(`device.get.${query}`, async () => {
        const el = await resolve(t);
        return query === "value" ? el.inputValue() : el.textContent();
      }),
    wait: (ms) => runAction("wait", () => session.wait(ms)),
  };

  return {
    device,
    ctx,
    runAction,
    // `fixture.screenshot(name)` works on both platforms; android routes to the device screencap.
    screenshot: (name: string) => runAction("screenshot", () => screenshotResult(name)),
    page: webOnly("page"),
    snapshot: webOnly("snapshot"),
    settle: webOnly("settle"),
    observability: webOnly("observability"),
  } as unknown as SkepticFixture;
};

/** A Proxy that throws a clear error on any access — used for web-only fixture fields
 *  under `--platform android` (and the `device` field on web). */
export const unavailable = (field: string, requiredPlatform: "web" | "android"): never =>
  new Proxy(
    {},
    {
      get() {
        throw new Error(
          `the \`${field}\` fixture is only available under --platform ${requiredPlatform}` +
            (requiredPlatform === "android"
              ? " (web specs use `page`)"
              : " (android specs use `device`)"),
        );
      },
      apply() {
        throw new Error(`the \`${field}\` fixture is only available under --platform ${requiredPlatform}`);
      },
    },
  ) as never;

const webOnly = (field: string): never => unavailable(field, "web");
