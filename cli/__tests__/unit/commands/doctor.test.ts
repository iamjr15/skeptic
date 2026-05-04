import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectDoctorReport } from "../../../src/commands/doctor.js";

describe("doctor command", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("collects a structured quick report without launching a browser", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-doctor-"));
    const daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-doctor-daemon-"));
    vi.stubEnv("SKEPTIC_DAEMON_DIR", daemonDir);
    try {
      fs.writeFileSync(
        path.join(cwd, "skeptic.config.yaml"),
        [
          "tests: tests/**/*.spec.ts",
          "browser:",
          "  engine: chromium",
          "  headless: true",
          "output:",
          "  dir: skeptic-output",
          "safety:",
          "  allowedDomains:",
          "    - example.com",
          "",
        ].join("\n"),
      );

      const report = await collectDoctorReport({ cwd, quick: true, fix: true });
      expect(report.product).toBe("skeptic");
      expect(report.cwd).toBe(cwd);
      expect(report.checks.some((check) => check.id === "config" && check.status === "pass")).toBe(true);
      expect(report.checks.some((check) => check.id === "home-dir" && check.status === "pass")).toBe(true);
      expect(report.checks.some((check) => check.id === "playwright-launch")).toBe(false);
      expect(report.summary.fail).toBeGreaterThanOrEqual(0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(daemonDir, { recursive: true, force: true });
    }
  });
});
