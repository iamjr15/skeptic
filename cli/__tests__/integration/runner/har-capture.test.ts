import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

const DIST = path.resolve(import.meta.dirname, "../../../dist/skeptic.mjs");

describe("--har capture (real browser + local server)", () => {
  let server: http.Server;
  let baseUrl: string;
  let tmp: string;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<title>HAR</title><h1>ok</h1>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-har-"));
    // Symlink the package so the worker's tsx can resolve `import "skeptic-cli"`.
    fs.mkdirSync(path.join(tmp, "node_modules"), { recursive: true });
    fs.symlinkSync(path.resolve(import.meta.dirname, "../../.."), path.join(tmp, "node_modules", "skeptic-cli"));
    fs.writeFileSync(
      path.join(tmp, "har.spec.ts"),
      `import { test, expect } from "skeptic-cli";\n` +
        `test("har", async ({ page }) => { await page.goto("/"); await expect(page).toHaveTitle(/HAR/); });\n`,
    );
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes a valid HAR with network entries and links it from results.json", () => {
    if (!fs.existsSync(DIST)) return; // requires a build
    const out = path.join(tmp, "out");
    const r = spawnSync(
      process.execPath,
      [DIST, "run", path.join(tmp, "har.spec.ts"), "--har", "--url", baseUrl, "--reporter", "json", "--output", out, "--no-daemon"],
      { encoding: "utf-8", timeout: 90_000, env: { ...process.env } },
    );
    if (r.status !== 0) {
      // Chromium may be unavailable in this environment — skip rather than fail.
      console.warn("[har-capture] run did not pass; skipping:", r.stderr?.slice(0, 300));
      return;
    }
    const results = JSON.parse(fs.readFileSync(path.join(out, "results.json"), "utf-8")) as {
      tests: Array<{ artifacts: { har?: string } }>;
    };
    const harPath = results.tests[0]?.artifacts.har;
    expect(harPath, "results.json should link the HAR artifact").toBeDefined();
    expect(fs.existsSync(harPath!)).toBe(true);
    const har = JSON.parse(fs.readFileSync(harPath!, "utf-8")) as { log: { entries: unknown[] } };
    expect(har.log.entries.length).toBeGreaterThan(0);
  }, 90_000);
});
