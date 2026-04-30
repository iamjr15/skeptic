import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { chromium, type Browser } from "playwright";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

interface StubBehavior {
  attachThrows?: boolean;
  snapshotThrows?: boolean;
  detachThrows?: boolean;
  snapshotValue?: unknown;
}

interface StubSpec {
  name: "performance" | "network" | "accessibility";
  behavior: StubBehavior;
}

const { stubFactory } = vi.hoisted(() => {
  const state: { specs: StubSpec[]; spies: Map<string, { attach: ReturnType<typeof vi.fn>; snapshot: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> }> } = {
    specs: [],
    spies: new Map(),
  };
  return {
    stubFactory: {
      reset: () => {
        state.specs = [];
        state.spies.clear();
      },
      add: (spec: StubSpec) => {
        state.specs.push(spec);
        const spies = {
          attach: vi.fn(async () => {
            if (spec.behavior.attachThrows) throw new Error(`attach boom (${spec.name})`);
          }),
          snapshot: vi.fn(async () => {
            if (spec.behavior.snapshotThrows) throw new Error(`snapshot boom (${spec.name})`);
            // Distinguish "no value provided" (use default) from "explicit null/undefined"
            // so tests can assert on the null-snapshot omitted-from-metrics behavior.
            return "snapshotValue" in spec.behavior
              ? spec.behavior.snapshotValue
              : { stub: spec.name };
          }),
          detach: vi.fn(async () => {
            if (spec.behavior.detachThrows) throw new Error(`detach boom (${spec.name})`);
          }),
        };
        state.spies.set(spec.name, spies);
      },
      build: () => {
        return state.specs.map((spec) => {
          const spies = state.spies.get(spec.name)!;
          return {
            name: spec.name,
            attach: spies.attach,
            snapshot: spies.snapshot,
            detach: spies.detach,
          };
        });
      },
      spy: (name: StubSpec["name"]) => state.spies.get(name)!,
    },
  };
});

vi.mock("../../../src/observability/registry.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/observability/registry.js")>();
  return {
    ...actual,
    buildCollectors: vi.fn(() => stubFactory.build()),
  };
});

const { PlaywrightEngine } = await import("../../../src/executor/playwright-engine.js");
type TestInput = (typeof import("../../../src/executor/types.js"))["TestInput"] extends infer T ? T : never;

let browser: Browser | null = null;
try {
  browser = await chromium.launch({ headless: true });
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn("[engine-lifecycle] chromium launch failed; tests will be skipped:", err);
  browser = null;
}

describe.skipIf(!browser)("PlaywrightEngine collector lifecycle", () => {
  let server: http.Server;
  let baseUrl: string;
  let outputDir: string;

  beforeAll(async () => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-engine-lc-"));
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><html><body><h1>ok</h1></body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(outputDir, { recursive: true, force: true });
    if (browser) await browser.close();
  });

  beforeEach(() => stubFactory.reset());

  const runMinimalFlow = async (suffix: string): Promise<unknown> => {
    const engine = new PlaywrightEngine({
      outputDir: path.join(outputDir, suffix),
      observability: {
        collectors: ["performance"], // anything non-empty so registry builds something
        networkCaptureLimit: 500,
        duplicateWindowMs: 500,
        accessibilityDualEngine: false,
        accessibilityHtmlSnippetLimit: 500,
      },
    });
    await engine.launch();
    try {
      const input: TestInput = {
        url: baseUrl,
        name: `engine-lc-${suffix}`,
        file: path.join(outputDir, "virtual.spec.ts"),
        runFn: async (page) => {
          await page.goto(baseUrl);
        },
      };
      return await engine.runTest(input);
    } finally {
      await engine.close();
    }
  };

  it("attach → snapshot → detach called in order; metrics populated", async () => {
    stubFactory.add({ name: "performance", behavior: { snapshotValue: { stubMarker: 42 } } });
    const result = (await runMinimalFlow("a")) as { metrics?: Record<string, unknown> };

    const spies = stubFactory.spy("performance");
    expect(spies.attach).toHaveBeenCalledOnce();
    expect(spies.snapshot).toHaveBeenCalledOnce();
    expect(spies.detach).toHaveBeenCalledOnce();
    expect(result.metrics).toEqual({ performance: { stubMarker: 42 } });

    const attachOrder = spies.attach.mock.invocationCallOrder[0]!;
    const snapshotOrder = spies.snapshot.mock.invocationCallOrder[0]!;
    const detachOrder = spies.detach.mock.invocationCallOrder[0]!;
    expect(attachOrder).toBeLessThan(snapshotOrder);
    expect(snapshotOrder).toBeLessThan(detachOrder);
  }, 60_000);

  it("attach failure drops the collector; flow still runs; metrics omitted for that collector", async () => {
    stubFactory.add({ name: "performance", behavior: { attachThrows: true } });
    const result = (await runMinimalFlow("b")) as {
      status: string;
      metrics?: Record<string, unknown>;
    };

    const spies = stubFactory.spy("performance");
    expect(spies.attach).toHaveBeenCalledOnce();
    expect(spies.snapshot).not.toHaveBeenCalled();
    expect(spies.detach).not.toHaveBeenCalled();
    expect(result.metrics).toBeUndefined();
    expect(result.status).toBe("passed");
  }, 60_000);

  it("snapshot failure logs and skips that collector; siblings still populate", async () => {
    stubFactory.add({ name: "performance", behavior: { snapshotThrows: true } });
    stubFactory.add({ name: "network", behavior: { snapshotValue: { netOk: true } } });
    const result = (await runMinimalFlow("c")) as { metrics?: Record<string, unknown> };

    expect(result.metrics).toEqual({ network: { netOk: true } });
    expect(result.metrics).not.toHaveProperty("performance");
  }, 60_000);

  it("detach failure does not mask flow status", async () => {
    stubFactory.add({
      name: "performance",
      behavior: { detachThrows: true, snapshotValue: { ok: true } },
    });
    const result = (await runMinimalFlow("d")) as {
      status: string;
      metrics?: Record<string, unknown>;
    };
    expect(result.status).toBe("passed");
    expect(result.metrics).toEqual({ performance: { ok: true } });
  }, 60_000);

  it("null-valued snapshot is omitted from metrics", async () => {
    stubFactory.add({ name: "accessibility", behavior: { snapshotValue: null } });
    const result = (await runMinimalFlow("e")) as { metrics?: Record<string, unknown> };
    expect(result.metrics).toBeUndefined();
  }, 60_000);
});
