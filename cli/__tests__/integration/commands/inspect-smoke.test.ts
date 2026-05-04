import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { ExecutionContext } from "../../../src/executor/context.js";
import { snapshot } from "../../../src/api/snapshot.js";

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../fixtures/observability/bundle4-cursor/index.html",
);

// Browser launched in beforeAll (NOT at module top-level) so it doesn't pile
// onto the other smoke tests' Chromium boots during the parallel run — that
// caused tsx ESM-resolver hiccups in MCP/ACP server tests.
describe("inspect smoke (cursor-interactive heuristic)", () => {
  let browser: Browser | null = null;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[inspect-smoke] chromium launch failed; tests will be skipped:", err);
      browser = null;
    }
    const html = fs.readFileSync(FIXTURE_PATH, "utf-8");
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (browser) await browser.close();
  });

  it("captures the <div onclick> via cursor-interactive but excludes the <button>", async () => {
    if (!browser) return; // chromium unavailable — soft-skip
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      const ctx = new ExecutionContext(page, baseUrl);
      const tree = await snapshot(page, ctx, {
        viewportAware: false,
        includeCursorInteractive: true,
      });

      // The <button> shows up as ARIA, not cursor-interactive.
      const cursorEntries = [...tree.refs.values()].filter((e) => e.kind === "cursor-interactive");
      const buttonInCursor = cursorEntries.some((e) => /Real button/i.test(e.name));
      expect(buttonInCursor).toBe(false);

      // The button is in the ARIA snapshot.
      const ariaEntries = [...tree.refs.values()].filter((e) => e.kind === "aria");
      const buttonInAria = ariaEntries.some((e) => e.role === "button" && /Real button/i.test(e.name));
      expect(buttonInAria).toBe(true);

      // Dedupe invariant: the `<div onclick>` must appear EXACTLY ONCE across both
      // ref kinds. Playwright's ARIA snapshot may pick it up as `generic [cursor=pointer]`,
      // OR our cursor-interactive pass may mint a `div "Click me"` ref — but never both.
      // We count ref-bearing lines that mention the div's text in the rendered YAML.
      const refLinesMentioningDiv = tree.yaml
        .split("\n")
        .filter((l) => /\[ref=e\d+\]/.test(l) && /Click me/i.test(l));
      expect(refLinesMentioningDiv).toHaveLength(1);
    } finally {
      await context.close();
    }
  }, 30_000);

  it("rendered YAML carries [ref=eN] markers and reaches the cursor-pointer div", async () => {
    if (!browser) return;
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      const ctx = new ExecutionContext(page, baseUrl);
      const tree = await snapshot(page, ctx, {
        viewportAware: false,
        includeCursorInteractive: true,
      });

      // The rendered tree carries multiple [ref=eN] markers (ARIA picks up the
      // header, the div, and the button at minimum).
      const refMarkers = tree.yaml.match(/\[ref=e\d+\]/g) ?? [];
      expect(refMarkers.length).toBeGreaterThanOrEqual(3);
      expect(tree.stats.lines).toBe(tree.yaml.split("\n").length);
      expect(tree.stats.characters).toBe(tree.yaml.length);
      expect(tree.stats.estimatedTokens).toBe(Math.ceil(tree.yaml.length / 4));
      expect(tree.stats.renderedRefs).toBe(new Set(refMarkers.map((m) => m.slice(5, -1))).size);
      expect(tree.stats.totalRefs).toBe(tree.refs.size);
      expect(tree.stats.interactiveRefs).toBeGreaterThanOrEqual(1);
      expect(tree.stats.renderedInteractiveRefs).toBeGreaterThanOrEqual(1);

      // The cursor-pointer div surfaces SOMEWHERE in the YAML (Playwright's
      // ARIA snapshot annotates it with `[cursor=pointer]`); the dedupe pass
      // ensures it doesn't get a second cursor-interactive entry on top.
      expect(tree.yaml).toMatch(/Click me/);
    } finally {
      await context.close();
    }
  }, 30_000);

  it("uses the first matching selector instead of surfacing a strict-mode stack", async () => {
    if (!browser) return;
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      const ctx = new ExecutionContext(page, baseUrl);
      const tree = await snapshot(page, ctx, {
        selector: "h1, button",
        viewportAware: false,
        includeCursorInteractive: false,
      });

      expect(tree.yaml).toContain("bundle4-cursor");
      expect(tree.yaml).not.toContain("Real button");
      expect(tree.stats.totalRefs).toBeGreaterThanOrEqual(1);
    } finally {
      await context.close();
    }
  }, 30_000);
});
