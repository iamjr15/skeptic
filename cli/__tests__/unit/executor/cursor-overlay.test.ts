import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { CURSOR_OVERLAY_SOURCE } from "../../../src/executor/cursor-overlay.js";

interface CursorAPI {
  hide: () => void;
  show: () => void;
  isVisible: () => boolean;
  setCommandLabel: (cmd: string, opts?: { persistent?: boolean }) => void;
  clearCommandLabel: () => void;
  recordAction: (cmd: string, x?: number, y?: number) => void;
  __actionLog: { n: number; command: string; x: number; y: number }[];
}

interface MockGlobal {
  __skepticCursor?: CursorAPI;
  innerWidth: number;
  innerHeight: number;
  setTimeout: (...args: unknown[]) => number;
  clearTimeout: (...args: unknown[]) => void;
}

interface TooltipProbe {
  textContent: string;
  hasShowClass: () => boolean;
  hasHiddenClass: () => boolean;
}

interface SandboxResult {
  ctx: vm.Context;
  globals: MockGlobal;
  tooltipProbe: TooltipProbe;
  setTimeoutCalls: Array<{ ms: number }>;
}

const buildSandbox = (): SandboxResult => {
  // Hand-built minimal DOM stub. We're not exercising the visual layer here — only
  // the public API surface and storage/log invariants. Anything the IIFE actually calls
  // gets a no-op stub that returns plausibly-shaped objects.
  const elements = new Map<string, ElementStub>();
  const storage = new Map<string, string>();

  type ElementStub = {
    id?: string;
    style: { cssText: string; transform: string; left: string; top: string };
    classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean };
    appendChild: (child: ElementStub) => ElementStub;
    insertAdjacentHTML: (where: string, html: string) => void;
    querySelector: (sel: string) => ElementStub | null;
    remove: () => void;
    addEventListener: (...args: unknown[]) => void;
    setAttribute: (...args: unknown[]) => void;
    attachShadow: (opts: unknown) => ElementStub;
    getElementById: (id: string) => ElementStub | null;
    innerHTML: string;
    textContent: string;
    offsetWidth: number;
    children: ElementStub[];
    classes: Set<string>;
  };

  const makeEl = (id?: string): ElementStub => {
    const classes = new Set<string>();
    const el: ElementStub = {
      id,
      style: { cssText: "", transform: "", left: "", top: "" },
      classList: {
        add: (c) => { classes.add(c); },
        remove: (c) => { classes.delete(c); },
        contains: (c) => classes.has(c),
      },
      appendChild: (child) => { el.children.push(child); return child; },
      insertAdjacentHTML: () => { /* noop */ },
      querySelector: () => null,
      remove: () => { /* noop */ },
      addEventListener: () => { /* noop */ },
      setAttribute: () => { /* noop */ },
      attachShadow: () => makeEl(),
      getElementById: (childId) => elements.get(childId) ?? null,
      innerHTML: "",
      textContent: "",
      offsetWidth: 0,
      children: [],
      classes,
    };
    return el;
  };

  const cursor = makeEl("cursor");
  const ripple = makeEl("ripple");
  const tooltip = makeEl("tooltip");
  const host = makeEl("__skeptic-cursor-host");
  // Intercept getElementById on the shadow root so the IIFE finds these.
  const root = makeEl();
  root.getElementById = (id) => {
    if (id === "cursor") return cursor;
    if (id === "ripple") return ripple;
    if (id === "tooltip") return tooltip;
    return null;
  };
  host.attachShadow = () => root;
  elements.set("__skeptic-cursor-host", host);

  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    body: {
      appendChild: (el: ElementStub) => { if (el.id) elements.set(el.id, el); return el; },
    },
    createElement: () => makeEl(),
    addEventListener: () => { /* noop */ },
    elementFromPoint: () => null,
  };

  const sessionStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v); },
    removeItem: (k: string) => { storage.delete(k); },
  };

  const setTimeoutCalls: Array<{ ms: number }> = [];
  const trackedSetTimeout = (_fn: unknown, ms: number): number => {
    setTimeoutCalls.push({ ms });
    return setTimeoutCalls.length;
  };
  const globals: MockGlobal = {
    innerWidth: 1024,
    innerHeight: 768,
    setTimeout: trackedSetTimeout as unknown as MockGlobal["setTimeout"],
    clearTimeout: () => {},
  };
  const ctx = vm.createContext({
    window: globals,
    document,
    sessionStorage,
    requestAnimationFrame: (fn: () => void) => { fn(); return 0; },
    setTimeout: trackedSetTimeout,
    clearTimeout: () => {},
    getComputedStyle: () => ({ cursor: "pointer" }),
    JSON,
    Math,
    isFinite,
    String,
  });
  // Make `window` references in the IIFE resolve to globals.
  (ctx as { window: MockGlobal }).window = globals;
  const tooltipProbe: TooltipProbe = {
    get textContent() { return tooltip.textContent; },
    hasShowClass: () => tooltip.classes.has("show"),
    hasHiddenClass: () => tooltip.classes.has("hidden"),
  };
  return { ctx, globals, tooltipProbe, setTimeoutCalls };
};

describe("cursor-overlay source", () => {
  it("exposes hide / show / isVisible / setCommandLabel / clearCommandLabel / recordAction on window.__skepticCursor", () => {
    const { ctx, globals } = buildSandbox();
    vm.runInContext(CURSOR_OVERLAY_SOURCE, ctx);
    const api = globals.__skepticCursor;
    expect(api).toBeDefined();
    expect(typeof api?.hide).toBe("function");
    expect(typeof api?.show).toBe("function");
    expect(typeof api?.isVisible).toBe("function");
    expect(typeof api?.setCommandLabel).toBe("function");
    expect(typeof api?.clearCommandLabel).toBe("function");
    expect(typeof api?.recordAction).toBe("function");
  });

  it("isVisible reflects hide/show state transitions", () => {
    const { ctx, globals } = buildSandbox();
    vm.runInContext(CURSOR_OVERLAY_SOURCE, ctx);
    const api = globals.__skepticCursor!;
    expect(api.isVisible()).toBe(true);
    api.hide();
    expect(api.isVisible()).toBe(false);
    api.show();
    expect(api.isVisible()).toBe(true);
  });

  it("recordAction appends to the action log capped at 50 entries (FIFO)", () => {
    const { ctx, globals } = buildSandbox();
    vm.runInContext(CURSOR_OVERLAY_SOURCE, ctx);
    const api = globals.__skepticCursor!;
    for (let i = 0; i < 60; i++) api.recordAction("click", 100 + i, 200);
    expect(api.__actionLog.length).toBe(50);
    // FIFO: the first 10 entries should have been dropped; the surviving entries'
    // counters monotonically increase.
    expect(api.__actionLog[0]?.n).toBeGreaterThan(10);
    expect(api.__actionLog[49]?.n).toBe(60);
  });

  it("recordAction with no coords falls back to viewport center", () => {
    const { ctx, globals } = buildSandbox();
    vm.runInContext(CURSOR_OVERLAY_SOURCE, ctx);
    const api = globals.__skepticCursor!;
    api.recordAction("click");
    const last = api.__actionLog[api.__actionLog.length - 1];
    expect(last?.x).toBe(Math.round(globals.innerWidth / 2));
    expect(last?.y).toBe(Math.round(globals.innerHeight / 2));
  });

  it("source string declares the __skeptic-glow keyframe and the five cursor shapes", () => {
    expect(CURSOR_OVERLAY_SOURCE).toContain("__skeptic-glow");
    // Every cursor shape (pointer / text / grab / move / not-allowed) must be present
    // in the SHAPES table inside the IIFE.
    for (const shape of ["pointer", "text", "grab", "move", "not-allowed"]) {
      expect(CURSOR_OVERLAY_SOURCE).toContain(`'${shape}'`);
    }
  });

  it("sessionStorage persistence key + tooltip command-name plumbing exist", () => {
    expect(CURSOR_OVERLAY_SOURCE).toContain("__skeptic_cursor_state");
    expect(CURSOR_OVERLAY_SOURCE).toContain("setCommandLabel");
    expect(CURSOR_OVERLAY_SOURCE).toContain("clearCommandLabel");
    expect(CURSOR_OVERLAY_SOURCE).toContain("recordAction");
    // PII-safety guard: no `step.args` interpolation; the label is passed by name only.
    expect(CURSOR_OVERLAY_SOURCE).not.toContain("step.args");
  });

  describe("B7 — persistent narration tooltip", () => {
    it("setCommandLabel writes the text and toggles the show class", () => {
      const { ctx, globals, tooltipProbe } = buildSandbox();
      vm.runInContext(CURSOR_OVERLAY_SOURCE, ctx);
      const api = globals.__skepticCursor!;
      api.setCommandLabel("Running accessibility audit");
      expect(tooltipProbe.textContent).toBe("Running accessibility audit");
      expect(tooltipProbe.hasShowClass()).toBe(true);
    });

    it("setCommandLabel(label, { persistent: true }) does NOT schedule the auto-fade timer", () => {
      const { ctx, globals, setTimeoutCalls } = buildSandbox();
      vm.runInContext(CURSOR_OVERLAY_SOURCE, ctx);
      const api = globals.__skepticCursor!;
      // Filter out persist-storage timer (PERSIST_DEBOUNCE_MS=500) from the fade timer
      // (TOOLTIP_FADE_MS=1500). Only the fade timer matters here.
      const fadeTimerCount = () => setTimeoutCalls.filter((c) => c.ms === 1500).length;

      const before = fadeTimerCount();
      api.setCommandLabel("Running accessibility audit", { persistent: true });
      expect(fadeTimerCount()).toBe(before);
      // Sanity: a non-persistent call DOES schedule a fade.
      api.setCommandLabel("Capturing screenshot");
      expect(fadeTimerCount()).toBe(before + 1);
    });

    it("calling setCommandLabel a second time replaces the first label's text", () => {
      const { ctx, globals, tooltipProbe } = buildSandbox();
      vm.runInContext(CURSOR_OVERLAY_SOURCE, ctx);
      const api = globals.__skepticCursor!;
      api.setCommandLabel("Running accessibility audit", { persistent: true });
      expect(tooltipProbe.textContent).toBe("Running accessibility audit");
      api.setCommandLabel("Taking annotated screenshot", { persistent: true });
      expect(tooltipProbe.textContent).toBe("Taking annotated screenshot");
    });

    it("clearCommandLabel hides the tooltip and empties its text", () => {
      const { ctx, globals, tooltipProbe } = buildSandbox();
      vm.runInContext(CURSOR_OVERLAY_SOURCE, ctx);
      const api = globals.__skepticCursor!;
      api.setCommandLabel("Running accessibility audit", { persistent: true });
      expect(tooltipProbe.hasShowClass()).toBe(true);
      api.clearCommandLabel();
      expect(tooltipProbe.hasShowClass()).toBe(false);
      expect(tooltipProbe.textContent).toBe("");
    });

    it("setCommandLabel truncates labels above 80 chars (sentence-form bumped from 40)", () => {
      const { ctx, globals, tooltipProbe } = buildSandbox();
      vm.runInContext(CURSOR_OVERLAY_SOURCE, ctx);
      const api = globals.__skepticCursor!;
      const longLabel = "a".repeat(120);
      api.setCommandLabel(longLabel);
      expect(tooltipProbe.textContent.length).toBe(80);
    });

    it("setCommandLabel ignores non-string input (defensive)", () => {
      const { ctx, globals, tooltipProbe } = buildSandbox();
      vm.runInContext(CURSOR_OVERLAY_SOURCE, ctx);
      const api = globals.__skepticCursor!;
      // @ts-expect-error — runtime guard test
      api.setCommandLabel(undefined);
      expect(tooltipProbe.textContent).toBe("");
    });
  });

  it("source string still declares clearCommandLabel + viewport-edge flip plumbing", () => {
    // Sanity guards so a future refactor cannot silently drop the persistent
    // tooltip behaviour. The viewport-flip uses offsetWidth/offsetHeight.
    expect(CURSOR_OVERLAY_SOURCE).toContain("clearCommandLabel");
    expect(CURSOR_OVERLAY_SOURCE).toContain("offsetWidth");
    expect(CURSOR_OVERLAY_SOURCE).toContain("offsetHeight");
  });
});
