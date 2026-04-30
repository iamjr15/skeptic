import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { ExecutionContext } from "../../../src/executor/context.js";
import { snapshot } from "../../../src/api/snapshot.js";
import { captureAnnotatedScreenshot } from "../../../src/api/screenshot.js";

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../fixtures/observability/bundle4-cursor/index.html",
);

/**
 * Live smoke for the annotation pipeline. We don't exec the CLI binary because
 * `npm test` can't depend on a built `dist/skeptic.mjs`; instead we drive the
 * exported `captureAnnotatedScreenshot` against a real Chromium + the same
 * bundle4-cursor fixture the inspect-smoke test uses. This proves the same code
 * path the CLI flag triggers writes a non-empty PNG and returns a labeled ladder.
 */
describe("inspect --annotated smoke", () => {
  let browser: Browser | null = null;
  let server: http.Server;
  let baseUrl: string;
  let outDir: string;

  beforeAll(async () => {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[inspect-annotated-smoke] chromium launch failed; tests will be skipped:", err);
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
    outDir = await mkdtemp(path.join(tmpdir(), "skeptic-annot-smoke-"));
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (browser) await browser.close();
    if (outDir) await rm(outDir, { recursive: true, force: true });
  });

  it("writes an annotated PNG and emits a [N] @eN ladder per labeled ref", async () => {
    if (!browser) return; // chromium unavailable — soft-skip
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      const ctx = new ExecutionContext(page, baseUrl);

      // Same snapshot the CLI would run before the annotation pipeline. This
      // populates the registry that the YAML emitter reads from.
      const tree = await snapshot(page, ctx, {
        viewportAware: false,
        includeCursorInteractive: true,
      });

      const outPath = path.join(outDir, "annotated.png");
      const result = await captureAnnotatedScreenshot(page, outPath, {
        fullPage: false,
        scope: "body",
      });

      // PNG written and non-empty.
      const buf = await readFile(outPath);
      expect(buf.length).toBeGreaterThan(0);
      // PNG magic bytes — sanity check that we wrote actual image data.
      expect(buf.slice(0, 4).toString("hex")).toBe("89504e47");

      // Annotation map: at least the visible ARIA `button` ref + the cursor-pointer
      // div should have been resolved to a bbox and labeled.
      const ann = result.annotations ?? [];
      expect(ann.length).toBeGreaterThan(0);
      // Labels start at 1 and are monotonic.
      expect(ann[0]!.label).toBe(1);
      for (let i = 1; i < ann.length; i++) {
        expect(ann[i]!.label).toBe(ann[i - 1]!.label + 1);
      }
      // Each entry has the documented PII-safe shape — NO `name` field.
      for (const e of ann) {
        expect(Object.keys(e)).not.toContain("name");
        expect(e.boundingBox.width).toBeGreaterThan(0);
        expect(e.boundingBox.height).toBeGreaterThan(0);
      }

      // Stdout-equivalent: simulate the `[1] @eN role "name"` ladder the CLI emits
      // against the registry the snapshot built. This is what
      // `skeptic inspect <url> --annotated --annotate-output …` prints.
      const lines = ann.map((a) => {
        const refEntry = tree.refs.get(a.ref);
        const namePart = refEntry?.name ? ` "${refEntry.name}"` : ` ""`;
        return `[${a.label}] @${a.ref} ${a.role}${namePart}`;
      });
      // Smoke: the first line is well-formed and references e1+ refs.
      expect(lines[0]).toMatch(/^\[1\] @e\d+ \w+ ".*"$/);

      // Annotation-map diagnostic shape: kind === "annotation-map", meta.entries
      // mirrors result.annotations, no `name` field anywhere.
      const diag = result.diagnostics.find((d) => d.kind === "annotation-map");
      expect(diag).toBeDefined();
      const metaEntries = (diag?.meta?.entries ?? []) as Record<string, unknown>[];
      expect(metaEntries.length).toBe(ann.length);
      for (const e of metaEntries) {
        expect(Object.keys(e)).not.toContain("name");
      }
    } finally {
      await context.close();
    }
  }, 30_000);
});
