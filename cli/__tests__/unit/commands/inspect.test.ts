import { describe, it, expect } from "vitest";
import {
  buildSelectorHint,
  discoverCdpUrl,
} from "../../../src/commands/inspect.js";
import type { AriaRefEntry } from "../../../src/executor/aria-ref-types.js";

describe("buildSelectorHint", () => {
  it("returns the entry's selectorHint verbatim when present (cursor-interactive)", () => {
    const entry: AriaRefEntry = {
      ref: "e5",
      kind: "cursor-interactive",
      role: "div",
      name: "Click me",
      nth: 0,
      scopeSelector: "body",
      selectorHint: "testid=primary-cta",
      matchCountAtSnapshot: 1,
    };
    expect(buildSelectorHint(entry)).toBe("testid=primary-cta");
  });

  it("emits role=ROLE:NAME when ARIA entry has a stable accessible name", () => {
    const entry: AriaRefEntry = {
      ref: "e1",
      kind: "aria",
      role: "link",
      name: "GitHub",
      nth: 0,
      scopeSelector: "body",
      matchCountAtSnapshot: 1,
    };
    expect(buildSelectorHint(entry)).toBe("role=link:GitHub");
  });

  it("falls back to css=a[href*=...] for icon-only links", () => {
    const entry: AriaRefEntry = {
      ref: "e6",
      kind: "aria",
      role: "link",
      name: "",
      nth: 0,
      scopeSelector: "body",
      href: "https://github.com/iamjr15",
      matchCountAtSnapshot: 1,
    };
    expect(buildSelectorHint(entry)).toBe('css=a[href*="github.com"]');
  });

  it("emits bare role=ROLE for nameless non-link refs", () => {
    const entry: AriaRefEntry = {
      ref: "e7",
      kind: "aria",
      role: "navigation",
      name: "",
      nth: 0,
      scopeSelector: "body",
      matchCountAtSnapshot: 1,
    };
    expect(buildSelectorHint(entry)).toBe("role=navigation");
  });
});

describe("discoverCdpUrl", () => {
  it("returns ws:// URLs verbatim", async () => {
    expect(await discoverCdpUrl("ws://localhost:9222/devtools/browser/abc")).toBe(
      "ws://localhost:9222/devtools/browser/abc",
    );
  });

  it("returns wss:// URLs verbatim", async () => {
    expect(await discoverCdpUrl("wss://chrome.example/devtools/browser/x")).toBe(
      "wss://chrome.example/devtools/browser/x",
    );
  });

  it("falls back to /devtools/browser when discovery endpoints are unreachable", async () => {
    // Use a port unlikely to be in use locally — discovery will fail, fallback fires.
    const ws = await discoverCdpUrl("127.0.0.1:1");
    expect(ws).toBe("ws://127.0.0.1:1/devtools/browser");
  });

  it("brackets IPv6 addresses in the fallback URL", async () => {
    const ws = await discoverCdpUrl("[::1]:1");
    expect(ws).toBe("ws://[::1]:1/devtools/browser");
  });
});

describe("inspect CLI surface", () => {
  it("loads the runInspect export without crashing", async () => {
    const mod = await import("../../../src/commands/inspect.js");
    expect(typeof mod.runInspect).toBe("function");
  });
});
