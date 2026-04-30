import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, loadConfigWithMeta } from "../../../src/config/loader.js";

const FIXTURES = path.resolve(import.meta.dirname, "../../fixtures/configs");

describe("loadConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads config from a minimal YAML file", () => {
    const config = loadConfig({ configPath: path.join(FIXTURES, "minimal.yaml") });

    expect(config.url).toBe("http://localhost:3000");
    expect(config.tests).toBe("tests/**/*.yaml");
  });

  it("applies schema defaults for missing fields", () => {
    const config = loadConfig({ configPath: path.join(FIXTURES, "minimal.yaml") });

    // Browser defaults
    expect(config.browser.headless).toBe(true);
    expect(config.browser.timeout).toBe(30_000);
    expect(config.browser.viewport).toEqual({ width: 1280, height: 720 });
    expect(config.browser.engine).toBe("chromium");

    // Auth defaults
    expect(config.auth.cookies).toBe(false);

    // Execution defaults
    expect(config.execution.retries).toBe(0);
    expect(config.execution.bail).toBe(false);
    expect(config.execution.screenshotOnFailure).toBe(true);

    // Output defaults
    expect(config.output.reporters).toEqual(["console"]);

  });

  it("loads full config with all options", () => {
    const config = loadConfig({ configPath: path.join(FIXTURES, "full.yaml") });

    expect(config.url).toBe("http://localhost:4000");
    expect(config.browser.headless).toBe(false);
    expect(config.browser.slowMo).toBe(100);
    expect(config.browser.timeout).toBe(15000);
    expect(config.browser.device).toBe("macbook_pro_14");
    expect(config.auth.cookies).toBe(true);
    expect(config.execution.retries).toBe(2);
    expect(config.execution.bail).toBe(true);
    expect(config.output.reporters).toEqual(["console", "json", "junit"]);
    expect(config.output.verbose).toBe(true);
    expect(config.env).toEqual({ APP_ENV: "test", API_KEY: "test-key-123" });
  });

  it("merges CLI overrides on top of config file", () => {
    const config = loadConfig({
      configPath: path.join(FIXTURES, "minimal.yaml"),
      overrides: {
        browser: { timeout: 5000 },
        execution: { retries: 3 },
      },
    });

    expect(config.browser.timeout).toBe(5000);
    expect(config.execution.retries).toBe(3);
    // Original values preserved
    expect(config.url).toBe("http://localhost:3000");
  });

  it("uses defaults when no config file exists", () => {
    const config = loadConfig({ configPath: undefined });

    expect(config.browser.headless).toBe(true);
    expect(config.browser.timeout).toBe(30_000);
    expect(config.output.reporters).toEqual(["console"]);
  });

  it("interpolates environment variables in config values", () => {
    vi.stubEnv("TEST_BASE_URL", "http://staging.example.com");

    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `skeptic-test-config-${Date.now()}.yaml`);
    fs.writeFileSync(tmpFile, 'url: ${TEST_BASE_URL}\ntests: "**/*.yaml"\n', "utf-8");

    try {
      const config = loadConfig({ configPath: tmpFile });
      expect(config.url).toBe("http://staging.example.com");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("throws on invalid config schema", () => {
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `skeptic-bad-config-${Date.now()}.yaml`);
    fs.writeFileSync(tmpFile, "browser:\n  timeout: -1\n", "utf-8");

    try {
      expect(() => loadConfig({ configPath: tmpFile })).toThrow("Invalid config");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("applies SKEPTIC_URL env override", () => {
    vi.stubEnv("SKEPTIC_URL", "http://env-override.example.com");

    const config = loadConfig({ configPath: path.join(FIXTURES, "minimal.yaml") });
    expect(config.url).toBe("http://env-override.example.com");
  });

  it("applies SKEPTIC_HEADED env override", () => {
    vi.stubEnv("SKEPTIC_HEADED", "1");

    const config = loadConfig({ configPath: path.join(FIXTURES, "minimal.yaml") });
    expect(config.browser.headless).toBe(false);
  });

  it("applies SKEPTIC_TIMEOUT env override", () => {
    vi.stubEnv("SKEPTIC_TIMEOUT", "5000");

    const config = loadConfig({ configPath: path.join(FIXTURES, "minimal.yaml") });
    expect(config.browser.timeout).toBe(5000);
  });

  it("applies SKEPTIC_COOKIES env override", () => {
    vi.stubEnv("SKEPTIC_COOKIES", "1");

    const config = loadConfig({ configPath: path.join(FIXTURES, "minimal.yaml") });
    expect(config.auth.cookies).toBe(true);
  });
});

describe("loadConfigWithMeta", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns the absolute configPath when --config is explicit", () => {
    const explicit = path.join(FIXTURES, "minimal.yaml");
    const { config, configPath } = loadConfigWithMeta({ configPath: explicit });
    expect(configPath).toBe(path.resolve(explicit));
    expect(config.url).toBe("http://localhost:3000");
  });

  it("returns configPath: null when no config file is found via walk-up", () => {
    // Point cwd at an isolated empty tmp dir so walk-up can't find a config.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-cfg-empty-"));
    // Use /tmp ancestor that has no skeptic.config.yaml (os.tmpdir() doesn't).
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    try {
      const { config, configPath } = loadConfigWithMeta();
      expect(configPath).toBeNull();
      // Schema defaults still apply
      expect(config.tests).toBe("tests/**/*.spec.ts");
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("finds a config via walk-up from a nested cwd", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-cfg-walkup-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "skeptic.config.yaml"),
        "url: http://walkup.example\n",
      );
      const nested = path.join(tmp, "sub", "nested");
      fs.mkdirSync(nested, { recursive: true });

      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(nested);
      try {
        const { config, configPath } = loadConfigWithMeta();
        expect(configPath).toBe(path.join(tmp, "skeptic.config.yaml"));
        expect(config.url).toBe("http://walkup.example");
      } finally {
        cwdSpy.mockRestore();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("loadConfig delegates to loadConfigWithMeta (same config payload)", () => {
    const explicit = path.join(FIXTURES, "minimal.yaml");
    const viaWrapper = loadConfig({ configPath: explicit });
    const viaMeta = loadConfigWithMeta({ configPath: explicit }).config;
    expect(viaWrapper).toEqual(viaMeta);
  });

  describe("SKEPTIC_AI_PROVIDER and SKEPTIC_AI_API_KEY env overrides", () => {
    afterEach(() => {
      delete process.env["SKEPTIC_AI_PROVIDER"];
      delete process.env["SKEPTIC_AI_API_KEY"];
    });

    it("SKEPTIC_AI_PROVIDER overrides ai.provider in config file", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-aienv-"));
      try {
        fs.writeFileSync(
          path.join(tmp, "skeptic.config.yaml"),
          "ai:\n  provider: gemini\n",
          "utf-8",
        );
        process.env["SKEPTIC_AI_PROVIDER"] = "openai";
        const config = loadConfig({ configPath: path.join(tmp, "skeptic.config.yaml") });
        expect(config.ai.provider).toBe("openai");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("SKEPTIC_AI_API_KEY overrides ai.apiKey even when YAML interpolated to empty", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-aienv-"));
      try {
        // Simulate the README scenario: config has $GEMINI_API_KEY but the env var is not set,
        // so interpolateEnvDeep produces "" before validation.
        delete process.env["GEMINI_API_KEY"];
        fs.writeFileSync(
          path.join(tmp, "skeptic.config.yaml"),
          "ai:\n  provider: openai\n  apiKey: ${GEMINI_API_KEY}\n",
          "utf-8",
        );
        process.env["SKEPTIC_AI_API_KEY"] = "real-openai-secret";
        const config = loadConfig({ configPath: path.join(tmp, "skeptic.config.yaml") });
        expect(config.ai.apiKey).toBe("real-openai-secret");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("SKEPTIC_AI_PROVIDER invalid value rejected by zod (same shape as --provider)", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-aienv-"));
      try {
        fs.writeFileSync(path.join(tmp, "skeptic.config.yaml"), "ai:\n  provider: gemini\n", "utf-8");
        process.env["SKEPTIC_AI_PROVIDER"] = "claude";  // not a valid AIProvider
        expect(() => loadConfig({ configPath: path.join(tmp, "skeptic.config.yaml") })).toThrow(
          /ai\.provider/,
        );
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("env vars unset → no override applied; config file values preserved", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-aienv-"));
      try {
        fs.writeFileSync(
          path.join(tmp, "skeptic.config.yaml"),
          "ai:\n  provider: anthropic\n  apiKey: literal-key\n",
          "utf-8",
        );
        const config = loadConfig({ configPath: path.join(tmp, "skeptic.config.yaml") });
        expect(config.ai.provider).toBe("anthropic");
        expect(config.ai.apiKey).toBe("literal-key");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
